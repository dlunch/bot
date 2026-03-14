import { Client, GatewayIntentBits, Partials } from "discord.js";
import { createAiResponse } from "../ai.js";

export async function startDiscordBot(config, options) {
  const { maxThreadHistory, discordStreamUpdateMs } = options;
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

  const discordMaxLength = 2000;

  function capDiscordText(text = "") {
    if (!text.trim()) {
      return ".";
    }

    if (text.length <= discordMaxLength) {
      return text;
    }

    return text.slice(0, discordMaxLength);
  }

  function splitDiscordText(text = "") {
    if (!text.trim()) {
      return ["."];
    }

    if (text.length <= discordMaxLength) {
      return [text];
    }

    const chunks = [];
    for (let i = 0; i < text.length; i += discordMaxLength) {
      chunks.push(text.slice(i, i + discordMaxLength));
    }
    return chunks;
  }

  function isDiscordTooLong(error) {
    return error?.code === 50035 || String(error?.message || "").includes("2000 or fewer");
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
    let streamedText = "";
    let currentMsgOffset = 0;
    let syncInFlight = Promise.resolve();

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

      const updateReply = async (text, force = false) => {
        if (!replyMessage) {
          return 0;
        }

        const now = Date.now();
        if (!force && now - lastUpdateAt < discordStreamUpdateMs) {
          return;
        }

        const content = capDiscordText(text);
        try {
          await replyMessage.edit(content);
          lastUpdateAt = now;
          return content === "." ? 0 : content.length;
        } catch (error) {
          if (!isDiscordTooLong(error)) {
            throw error;
          }

          if (content.length <= 1) {
            throw error;
          }

          const consumedLength = Math.floor(content.length / 2);
          await replyMessage.edit(content.slice(0, consumedLength) || ".");
          lastUpdateAt = now;
          return consumedLength;
        }
      };

      const postMessage = async (text) => {
        const content = capDiscordText(text);
        const send = currentMsgOffset === 0 ? () => message.reply(content) : () => message.channel.send(content);
        try {
          const reply = await send();
          return { reply, consumedLength: content === "." ? 0 : content.length };
        } catch (error) {
          if (!isDiscordTooLong(error) || content.length <= 1) {
            throw error;
          }

          const consumedLength = Math.floor(content.length / 2);
          const fallbackContent = content.slice(0, consumedLength) || ".";
          const reply = currentMsgOffset === 0
            ? await message.reply(fallbackContent)
            : await message.channel.send(fallbackContent);
          return { reply, consumedLength };
        }
      };

      const syncReply = async (force = false) => {
        while (true) {
          const currentText = streamedText.slice(currentMsgOffset);
          if (!currentText.trim()) {
            return;
          }

          let consumedLength = 0;
          if (replyMessage) {
            consumedLength = await updateReply(currentText, force);
          } else {
            const result = await postMessage(currentText);
            replyMessage = result.reply;
            lastUpdateAt = Date.now();
            consumedLength = result.consumedLength;
          }

          if (consumedLength >= currentText.length) {
            return;
          }

          currentMsgOffset += consumedLength;
          replyMessage = null;
          lastUpdateAt = 0;
        }
      };

      const runSyncReply = async (force = false) => {
        const nextSync = syncInFlight.then(() => syncReply(force));
        syncInFlight = nextSync.catch(() => undefined);
        return nextSync;
      };

      const scheduleUpdate = () => {
        if (pendingUpdate) {
          return;
        }

        pendingUpdate = setTimeout(async () => {
          pendingUpdate = null;
          try {
            await runSyncReply(true);
          } catch (error) {
            console.error("[discord][message_update] error", error);
          }
        }, discordStreamUpdateMs);
      };

      const answer =
        (await createAiResponse(context, {
          model: config.model,
          webSearch: config.webSearch,
          systemPrompt: config.systemPrompt,
          onDelta: async (_delta, fullText) => {
            streamedText = fullText;
            const currentText = streamedText.slice(currentMsgOffset);

            if (!replyMessage || currentText.length > discordMaxLength) {
              if (pendingUpdate) {
                clearTimeout(pendingUpdate);
                pendingUpdate = null;
              }
              await runSyncReply(true);
              return;
            }

            if (Date.now() - lastUpdateAt >= discordStreamUpdateMs) {
              if (pendingUpdate) {
                clearTimeout(pendingUpdate);
                pendingUpdate = null;
              }
              await runSyncReply(true);
            } else {
              scheduleUpdate();
            }
          }
        })) || "응답을 생성하지 못했어요.";

      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
        pendingUpdate = null;
      }

      streamedText = answer || streamedText || "응답을 생성하지 못했어요.";
      await runSyncReply(true);
    } catch (error) {
      console.error("[discord][message] error", error);
      try {
        if (replyMessage) {
          const errorSuffix = "\n\n⚠️ 출력 중 에러가 발생했습니다.";
          let errorText;
          const currentStreamedText = streamedText.slice(currentMsgOffset);
          if (currentStreamedText.trim()) {
            const maxContent = discordMaxLength - errorSuffix.length;
            errorText = currentStreamedText.trim().slice(0, maxContent) + errorSuffix;
          } else {
            errorText = "에러가 발생했습니다. 잠시 후 다시 시도해주세요.";
          }
          try {
            await replyMessage.edit(errorText);
          } catch (editError) {
            if (isDiscordTooLong(editError)) {
              await replyMessage.edit(errorText.slice(0, Math.floor(errorText.length / 2)) || ".");
            }
          }
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
    `[discord] started name=${config.name} bot_user=${client.user?.id} model=${config.model || "default"} web_search=${config.webSearch} system_prompt=${config.systemPrompt ? "service" : "default"}`
  );

  return {
    async stop() {
      client.destroy();
      console.log(`[discord] stopped name=${config.name}`);
    }
  };
}
