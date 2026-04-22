import { AttachmentBuilder, Client, GatewayIntentBits, Partials } from "discord.js";
import { createAiResponse } from "../ai.js";

/**
 * Sanitize a Codex item id so it is safe to use as a filename component.
 * Only alphanumerics, underscore, and hyphen are preserved. Falsy ids fall
 * back to the literal string "unknown".
 */
export function sanitizeFilenameId(id) {
  return String(id || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Deliver collected images to a Discord channel as new messages. Each image
 * is sent as its own message so the (optional) revised_prompt maps 1:1 with
 * the attachment. All sends use `allowedMentions: { parse: [] }` (C-3) so
 * any `@here`/`@everyone`/user-mention substrings in `revisedPrompt` can
 * never trigger an actual notification.
 *
 * Per-image failures are isolated: the error is logged, a fallback text
 * message is posted to the same channel, and iteration continues with the
 * remaining images. A no-op when the images array is empty.
 *
 * @param {object} message - The originating Discord message (used for
 *   `message.channel.send` and as the reply reference so images land in the
 *   same thread/channel as the text response).
 * @param {{images: Array<{id: string, buffer: Buffer, revisedPrompt?: string}>}} opts
 */
export async function deliverDiscordImages(message, { images } = {}) {
  if (!Array.isArray(images) || images.length === 0) {
    return;
  }
  const channel = message?.channel;
  if (!channel || typeof channel.send !== "function") {
    console.error("[discord][image_upload] missing channel.send; cannot deliver images");
    return;
  }

  for (const image of images) {
    const content =
      typeof image?.revisedPrompt === "string" ? image.revisedPrompt.trim() : "";
    const filename = `image-${sanitizeFilenameId(image?.id)}.png`;
    try {
      const attachment = new AttachmentBuilder(image.buffer, { name: filename });
      await channel.send({
        content,
        files: [attachment],
        allowedMentions: { parse: [] },
        reply: message?.id
          ? { messageReference: message.id, failIfNotExists: false }
          : undefined
      });
      console.log(`[discord][image_deliver] id=${image?.id}`);
    } catch (err) {
      console.error(`[discord][image_upload] failed id=${image?.id}`, err);
      const reason = err?.message || "unknown";
      try {
        await channel.send({
          content: `⚠️ 이미지 업로드 실패 (id=${image?.id}): ${reason}`,
          allowedMentions: { parse: [] }
        });
      } catch (notifyErr) {
        console.error(
          `[discord][image_upload] failure notice also failed id=${image?.id}`,
          notifyErr
        );
      }
    }
  }
}

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
    // Collected image payloads from the AI layer's onImage callback. Buffered
    // during streaming and delivered after text sync completes so the text
    // response shows up first (per arch §7.2 UX decision).
    const collectedImages = [];
    const imageGenerationEnabled = config.imageGeneration === true;
    let imageProgressMessage = null;

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

      const rawAnswer = await createAiResponse(context, {
        models: config.models,
        providers: config.providers,
        webSearch: config.webSearch,
        systemPrompt: config.systemPrompt,
        imageGeneration: imageGenerationEnabled,
        onImage: imageGenerationEnabled
          ? (buffer, meta) => {
              collectedImages.push({
                id: meta?.id,
                buffer,
                revisedPrompt: meta?.revisedPrompt
              });
            }
          : undefined,
        onImageEvent: imageGenerationEnabled
          ? async (evt) => {
              if (!evt?.firstEventInAttempt || imageProgressMessage) {
                return;
              }
              try {
                imageProgressMessage = await message.channel.send({
                  content: "🎨 이미지 생성 중...",
                  allowedMentions: { parse: [] },
                  reply: message?.id
                    ? { messageReference: message.id, failIfNotExists: false }
                    : undefined
                });
              } catch (err) {
                console.error("[discord][image_progress] failed", err);
              }
            }
          : undefined,
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
      });

      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
        pendingUpdate = null;
      }

      if (!rawAnswer && !streamedText.trim() && collectedImages.length === 0) {
        const modelList = (config.models || []).join(", ") || "(none)";
        console.error(
          `[discord][message] empty response after retries models=${modelList}`
        );
        streamedText = `응답을 생성하지 못했어요 (모델 ${modelList}에서 빈 응답 반환). 잠시 후 다시 시도해주세요.`;
      } else {
        streamedText = rawAnswer || streamedText;
      }
      await runSyncReply(true);

      // Image delivery (post-text, arch §7.2). If we have images but no text,
      // post a placeholder message first (M-5) so thread history keeps an
      // assistant turn for continuity.
      if (collectedImages.length > 0) {
        if (!streamedText.trim()) {
          // H-2: reply w/ messageReference + failIfNotExists:false already
          // degrades silently when the original message is gone. If the send
          // still throws (network/rate-limit/perm), fall back to a plain
          // channel.send so the thread still gets the placeholder row that
          // buildContext needs for continuity (M-5).
          try {
            await message.channel.send({
              content: "이미지를 생성했습니다.",
              allowedMentions: { parse: [] },
              reply: { messageReference: message.id, failIfNotExists: false }
            });
          } catch (placeholderErr) {
            console.error(
              "[discord][image_placeholder] failed; retrying without reply ref",
              placeholderErr
            );
            try {
              await message.channel.send({
                content: "이미지를 생성했습니다.",
                allowedMentions: { parse: [] }
              });
            } catch (retryErr) {
              console.error(
                "[discord][image_placeholder] fallback also failed",
                retryErr
              );
            }
          }
        }
        await deliverDiscordImages(message, { images: collectedImages });
      }

      if (imageProgressMessage) {
        try {
          await imageProgressMessage.delete();
        } catch (err) {
          console.error("[discord][image_progress] cleanup failed", err);
        }
        imageProgressMessage = null;
      }
    } catch (error) {
      console.error("[discord][message] error", error);
      if (collectedImages.length > 0) {
        console.error(
          `[discord] dropped ${collectedImages.length} partial images due to stream error`
        );
      }
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

      if (imageProgressMessage) {
        try {
          await imageProgressMessage.delete();
        } catch (err) {
          console.error("[discord][image_progress] cleanup failed (finally)", err);
        }
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
    `[discord] started name=${config.name} bot_user=${client.user?.id} models=${(config.models || []).join(",")} web_search=${config.webSearch} system_prompt=${config.systemPrompt ? "service" : "default"}`
  );

  return {
    async stop() {
      client.destroy();
      console.log(`[discord] stopped name=${config.name}`);
    }
  };
}
