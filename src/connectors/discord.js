import { Client, GatewayIntentBits, Partials } from "discord.js";
import { createAiResponse } from "../ai.js";

export async function startDiscordBot(config, options) {
  const { systemPromptInfo, maxThreadHistory, discordStreamUpdateMs } = options;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });

  function cleanDiscordText(text = "", botUserId) {
    return text.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").replace(/\s+/g, " ").trim();
  }

  async function buildContext(message, botUserId) {
    const fetched = await message.channel.messages.fetch({ limit: maxThreadHistory });
    const messages = [...fetched.values()].reverse();
    const context = [];

    for (const msg of messages) {
      if (msg.author?.bot && msg.author.id !== botUserId) {
        continue;
      }

      const text = cleanDiscordText(msg.content || "", botUserId);
      if (!text) {
        continue;
      }

      context.push({
        role: msg.author?.id === botUserId ? "assistant" : "user",
        content: text
      });
    }

    return context;
  }

  client.on("messageCreate", async (message) => {
    if (!client.user) {
      return;
    }

    if (message.author?.bot) {
      return;
    }

    const isDm = message.channel.type === 1;
    const mentioned = message.mentions.has(client.user);

    if (!isDm && !mentioned) {
      return;
    }

    let replyMessage = null;
    let pendingUpdate = null;
    let lastUpdateAt = 0;
    let addedReaction = false;

    try {
      try {
        await message.react("👀");
        addedReaction = true;
      } catch (error) {
        console.error("[discord][reaction_add] skipped", error);
      }

      const context = await buildContext(message, client.user.id);
      const lastUserMessage = [...context].reverse().find((msg) => msg.role === "user");
      if (!lastUserMessage) {
        await message.reply("질문을 같이 보내주세요.");
        return;
      }

      let streamedText = "";

      const updateReply = async (text, force = false) => {
        if (!replyMessage) {
          return;
        }

        const now = Date.now();
        if (!force && now - lastUpdateAt < discordStreamUpdateMs) {
          return;
        }

        await replyMessage.edit(text || ".");
        lastUpdateAt = now;
      };

      const scheduleUpdate = () => {
        if (pendingUpdate) {
          return;
        }

        pendingUpdate = setTimeout(async () => {
          pendingUpdate = null;
          try {
            await updateReply(streamedText, true);
          } catch (error) {
            console.error("[discord][message_update] error", error);
          }
        }, discordStreamUpdateMs);
      };

      const answer =
        (await createAiResponse(context, {
          model: config.model,
          webSearch: config.webSearch,
          onDelta: async (_delta, fullText) => {
            streamedText = fullText;
            if (!replyMessage && streamedText.trim()) {
              replyMessage = await message.reply(streamedText);
              lastUpdateAt = Date.now();
              return;
            }

            if (Date.now() - lastUpdateAt >= discordStreamUpdateMs) {
              await updateReply(streamedText, true);
            } else {
              scheduleUpdate();
            }
          }
        })) || "응답을 생성하지 못했어요.";

      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
        pendingUpdate = null;
      }

      const finalText = answer || streamedText || "응답을 생성하지 못했어요.";
      if (replyMessage) {
        await updateReply(finalText, true);
      } else {
        replyMessage = await message.reply(finalText);
      }
    } catch (error) {
      console.error("[discord][message] error", error);
      try {
        if (replyMessage) {
          await replyMessage.edit("에러가 발생했습니다. 잠시 후 다시 시도해주세요.");
        } else {
          await message.reply("에러가 발생했습니다. 잠시 후 다시 시도해주세요.");
        }
      } catch (innerError) {
        console.error("[discord][message] error reply failed", innerError);
      }
    } finally {
      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
        pendingUpdate = null;
      }

      if (addedReaction) {
        try {
          await message.reactions.resolve("👀")?.users.remove(client.user.id);
        } catch (error) {
          console.error("[discord][reaction_remove] skipped", error);
        }
      }
    }
  });

  client.on("error", (error) => {
    console.error("[discord][client_error]", error);
  });

  await client.login(config.botToken);
  console.log(
    `[discord] started name=${config.name} bot_user=${client.user?.id} model=${config.model || "default"} web_search=${config.webSearch} system_prompt_source=${systemPromptInfo.source}`
  );

  return {
    async stop() {
      client.destroy();
      console.log(`[discord] stopped name=${config.name}`);
    }
  };
}
