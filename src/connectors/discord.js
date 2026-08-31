import { AttachmentBuilder, Client, EmbedBuilder, GatewayIntentBits, Partials } from "discord.js";
import { createAiResponse } from "../ai.js";
import { isTextLike, fetchTextAttachmentBlock } from "./attachments.js";
import {
  attachImagesToUserTurns,
  collectRecentContext,
  CurrentUserImageLoadError
} from "./context.js";
import { markdownChunk } from "./markdown-chunks.js";

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
 * the attachment. All sends use `allowedMentions: { parse: [] }` so
 * any `@here`/`@everyone`/user-mention substrings in `revisedPrompt` can
 * never trigger an actual notification.
 *
 * Per-image failures are isolated: the error is logged, a fallback text
 * message is posted to the same channel, and iteration continues with the
 * remaining images. A no-op when the images array is empty.
 *
 * @param {object} message - The originating Discord message, used to select
 *   the destination channel and the non-thread reply reference.
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

  // Discord limits: message.content max 2000 chars, embed.description max 4096.
  // Codex's revised_prompt often overflows 2000, so when it does we fall back
  // to an embed (4x more space). Beyond 4096 we hard-truncate the embed text.
  const discordContentMax = 2000;
  const discordEmbedDescriptionMax = 4096;
  const truncate = (text, max) => {
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + "…";
  };

  for (const image of images) {
    const rawPrompt =
      typeof image?.revisedPrompt === "string" ? image.revisedPrompt.trim() : "";
    const filename = `image-${sanitizeFilenameId(image?.id)}.png`;
    try {
      const attachment = new AttachmentBuilder(image.buffer, { name: filename });
      const replyPayload = channel.isThread()
        ? {}
        : {
            reply: {
              messageReference: message.id,
              failIfNotExists: false
            }
          };

      let payload;
      if (rawPrompt.length <= discordContentMax) {
        payload = {
          content: rawPrompt,
          files: [attachment],
          allowedMentions: { parse: [] },
          ...replyPayload
        };
      } else {
        const embed = new EmbedBuilder()
          .setDescription(truncate(rawPrompt, discordEmbedDescriptionMax))
          .setImage(`attachment://${filename}`);
        payload = {
          embeds: [embed],
          files: [attachment],
          allowedMentions: { parse: [] },
          ...replyPayload
        };
      }
      await channel.send(payload);
      console.log(`[discord][image_deliver] id=${image?.id}`);
    } catch (err) {
      console.error(`[discord][image_upload] failed id=${image?.id}`, err);
      const reason = err?.message || "unknown";
      try {
        await channel.send({
          content: truncate(`⚠️ 이미지 업로드 실패 (id=${image?.id}): ${reason}`, discordContentMax),
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

export async function deliverDiscordFiles(message, { files } = {}) {
  if (!Array.isArray(files) || files.length === 0) return;
  const channel = message?.channel;
  if (!channel || typeof channel.send !== "function") {
    console.error("[discord][file_upload] missing channel.send; cannot deliver files");
    return;
  }

  for (const file of files) {
    try {
      const attachment = new AttachmentBuilder(Buffer.from(file.content, "utf8"), {
        name: file.filename
      });
      await channel.send({
        files: [attachment],
        allowedMentions: { parse: [] },
        ...(channel.isThread()
          ? {}
          : {
              reply: {
                messageReference: message.id,
                failIfNotExists: false
              }
            })
      });
      console.log(`[discord][file_deliver] filename=${file.filename}`);
    } catch (err) {
      console.error(`[discord][file_upload] failed filename=${file?.filename}`, err);
      try {
        await channel.send({
          content: `⚠️ 파일 첨부 실패 (${file?.filename}): ${err?.message || "unknown"}`.slice(0, 2000),
          allowedMentions: { parse: [] }
        });
      } catch (notifyErr) {
        console.error(
          `[discord][file_upload] failure notice also failed filename=${file?.filename}`,
          notifyErr
        );
      }
    }
  }
}

async function scanDiscordBotChunks(seedMessage, botUserId, cutoffTimestamp) {
  const result = [];
  let lastId = seedMessage.id;
  let cursor = seedMessage.id;
  while (true) {
    let fetched;
    try {
      fetched = await seedMessage.channel.messages.fetch({ after: cursor, limit: 100 });
    } catch (error) {
      console.warn(`[discord][reply_chain] forward fetch failed id=${seedMessage.id}`, error);
      break;
    }

    const page = [...fetched.values()].sort(
      (a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0)
    );
    let reachedCutoff = false;
    for (const message of page) {
      if ((message.createdTimestamp || 0) >= cutoffTimestamp) {
        reachedCutoff = true;
        break;
      }
      if (
        message.author?.id === botUserId &&
        message?.reference?.messageId === lastId
      ) {
        result.push(message);
        lastId = message.id;
      }
    }

    const nextCursor = page.at(-1)?.id;
    if (reachedCutoff || page.length < 100 || !nextCursor || nextCursor === cursor) {
      break;
    }
    cursor = nextCursor;
  }
  return result;
}

export async function* collectDiscordReplyCandidates(message, botUserId) {
  yield message;
  const seen = new Set([`${message.channelId}:${message.id}`]);
  let current = message;
  while (current.reference?.messageId) {
    let parent;
    try {
      parent = await current.fetchReference();
    } catch (error) {
      console.warn(
        `[discord][reply_chain] fetch failed id=${current.reference.messageId}`,
        error
      );
      break;
    }

    const parentKey = `${parent.channelId}:${parent.id}`;
    if (seen.has(parentKey)) {
      break;
    }

    if (parent.author?.id === botUserId) {
      const forwardChunks = await scanDiscordBotChunks(
        parent,
        botUserId,
        current.createdTimestamp || Number.POSITIVE_INFINITY
      );
      for (let index = forwardChunks.length - 1; index >= 0; index--) {
        const chunk = forwardChunks[index];
        const chunkKey = `${chunk.channelId}:${chunk.id}`;
        if (!seen.has(chunkKey)) {
          seen.add(chunkKey);
          yield chunk;
        }
      }
    }

    seen.add(parentKey);
    yield parent;
    current = parent;
  }
}

export async function* collectDiscordChannelCandidates(message) {
  yield message;
  const seen = new Set([`${message.channelId}:${message.id}`]);
  const snapshotTimestamp = message.createdTimestamp || Number.POSITIVE_INFINITY;
  let cursor = message.id;

  while (true) {
    let fetched;
    try {
      fetched = await message.channel.messages.fetch({ limit: 100, before: cursor });
    } catch (error) {
      console.warn("[discord][context] history fetch failed", error);
      return;
    }
    const page = [...fetched.values()].sort(
      (a, b) => (b.createdTimestamp || 0) - (a.createdTimestamp || 0)
    );
    for (const candidate of page) {
      const candidateKey = `${candidate.channelId}:${candidate.id}`;
      if (
        seen.has(candidateKey) ||
        (candidate.createdTimestamp || 0) > snapshotTimestamp
      ) {
        continue;
      }
      seen.add(candidateKey);
      yield candidate;
    }

    const nextCursor = page.at(-1)?.id;
    if (page.length < 100 || !nextCursor || nextCursor === cursor) {
      break;
    }
    cursor = nextCursor;
  }
}

export async function* collectDiscordThreadCandidates(message, botUserId) {
  const seen = new Set();
  for await (const candidate of collectDiscordChannelCandidates(message)) {
    const candidateKey = `${candidate.channelId}:${candidate.id}`;
    if (!seen.has(candidateKey)) {
      seen.add(candidateKey);
      yield candidate;
    }
  }

  let starter;
  try {
    starter = await message.channel.fetchStarterMessage();
  } catch (error) {
    console.warn("[discord][context] starter fetch failed", error);
    return;
  }
  if (!starter) {
    return;
  }

  let root = starter;
  if (starter.system) {
    try {
      root = await starter.fetchReference();
    } catch (error) {
      console.warn("[discord][context] starter reference fetch failed", error);
      return;
    }
  }

  for await (const candidate of collectDiscordReplyCandidates(root, botUserId)) {
    const candidateKey = `${candidate.channelId}:${candidate.id}`;
    if (!seen.has(candidateKey)) {
      seen.add(candidateKey);
      yield candidate;
    }
  }
}

function hasDiscordImageAttachment(message) {
  for (const attachment of message?.attachments?.values?.() || []) {
    const mediaType = typeof attachment?.contentType === "string"
      ? attachment.contentType.split(";", 1)[0].trim().toLowerCase()
      : "";
    if (mediaType.startsWith("image/")) {
      return true;
    }
  }
  return false;
}

export async function materializeDiscordMessage(message, botUserId) {
  if (message.system) {
    return null;
  }
  if (message.author?.bot && message.author.id !== botUserId) {
    return null;
  }

  const baseText = (message.content || "")
    .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
    .replace(/\s+/g, " ")
    .trim();
  const embedTexts = [];
  for (const embed of message.embeds || []) {
    if (embed?.title) embedTexts.push(embed.title);
    if (embed?.description) embedTexts.push(embed.description);
  }

  const role = message.author?.id === botUserId ? "assistant" : "user";
  const content = [baseText, ...embedTexts].filter(Boolean).join("\n").trim();
  const blocks = [];
  for (const attachment of message?.attachments?.values?.() || []) {
    const mediaType = typeof attachment?.contentType === "string"
      ? attachment.contentType.split(";", 1)[0].trim().toLowerCase()
      : "";
    if (mediaType.startsWith("image/")) {
      continue;
    }
    if (!isTextLike(attachment?.name, attachment?.contentType)) {
      continue;
    }
    const block = await fetchTextAttachmentBlock({
      url: attachment?.url,
      name: attachment?.name
    });
    if (block) {
      blocks.push(block);
    }
  }

  const finalContent = [content, ...blocks].filter(Boolean).join("\n\n");
  if (!finalContent && role === "assistant") {
    return null;
  }
  if (!finalContent && !hasDiscordImageAttachment(message)) {
    return null;
  }
  return {
    source: message,
    role,
    content: finalContent
  };
}

const supportedDiscordImageMediaTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp"
]);

function listDiscordImages(message) {
  const images = [];
  for (const attachment of message.attachments.values()) {
    const mediaType = typeof attachment?.contentType === "string"
      ? attachment.contentType.split(";", 1)[0].trim().toLowerCase()
      : "";
    if (supportedDiscordImageMediaTypes.has(mediaType)) {
      images.push({ source: attachment, mediaType });
    }
  }
  return images;
}

async function fetchDiscordImageAsDataUrl(candidate) {
  const maxImageBytes = 5 * 1024 * 1024;
  const attachment = candidate.source;
  const attachmentUrl = attachment?.url;
  if (!attachmentUrl) {
    return null;
  }
  try {
    const response = await fetch(attachmentUrl);
    if (!response.ok) {
      console.warn(`[discord][image_fetch] http ${response.status} id=${attachment.id}`);
      return null;
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxImageBytes) {
      console.warn(
        `[discord][image_fetch] skipping large attachment id=${attachment.id} bytes=${bytes.byteLength}`
      );
      return null;
    }
    return `data:${candidate.mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch (error) {
    console.warn(`[discord][image_fetch] failed id=${attachment?.id}`, error);
    return null;
  }
}

export async function buildDiscordContext(message, botUserId, maxContextBytes) {
  const inThread = message.channel.isThread();
  const candidates = inThread
    ? collectDiscordThreadCandidates(message, botUserId)
    : message.channel.type === 1
      ? collectDiscordChannelCandidates(message)
      : collectDiscordReplyCandidates(message, botUserId);
  const selected = await collectRecentContext(
    candidates,
    maxContextBytes,
    (candidate) => materializeDiscordMessage(candidate, botUserId)
  );
  const context = selected.map(({ role, content }) => ({ role, content }));

  return await attachImagesToUserTurns(
    context,
    selected.map(({ source }) => source),
    listDiscordImages,
    fetchDiscordImageAsDataUrl
  );
}

export async function startDiscordBot(config, options) {
  const { maxContextBytes, discordStreamUpdateMs } = options;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });

  const discordMaxLength = 2000;

  function isDiscordTooLong(error) {
    return error?.code === 50035 || String(error?.message || "").includes("2000 or fewer");
  }

  async function botParticipatesInThread(channel, botUserId) {
    try {
      const fetched = await channel.messages.fetch({ limit: 100 });
      for (const msg of fetched.values()) {
        if (
          !msg.system &&
          (msg.author?.id === botUserId || msg.mentions?.has?.(botUserId))
        ) {
          return true;
        }
      }
    } catch (error) {
      console.warn("[discord][thread_participation] fetch failed", error);
    }

    let current;
    try {
      current = await channel.fetchStarterMessage();
    } catch (error) {
      console.warn("[discord][thread_participation] starter fetch failed", error);
      return false;
    }

    const seen = new Set();
    while (current) {
      const currentKey = `${current.channelId}:${current.id}`;
      if (seen.has(currentKey)) {
        return false;
      }
      seen.add(currentKey);

      if (
        !current.system &&
        (current.author?.id === botUserId || current.mentions?.has?.(botUserId))
      ) {
        return true;
      }
      if (!current.reference?.messageId) {
        return false;
      }

      try {
        current = await current.fetchReference();
      } catch (error) {
        console.warn("[discord][thread_participation] reference fetch failed", error);
        return false;
      }
    }
    return false;
  }

  client.on("messageCreate", async (message) => {
    if (!client.user) {
      return;
    }

    if (message.system || message.author?.bot) {
      return;
    }

    const isDm = message.channel.type === 1;
    const mentioned = message.mentions.has(client.user);
    const inThread =
      typeof message.channel?.isThread === "function" && message.channel.isThread();

    // In a thread the bot already participates in, treat every message as
    // directed at the bot so follow-ups don't each need an explicit mention.
    let shouldRespond = isDm || mentioned;
    if (!shouldRespond && inThread) {
      shouldRespond = await botParticipatesInThread(message.channel, client.user.id);
    }
    // A reply to one of the bot's own messages is a conversation continuation.
    // Discord only adds the replied-to user to mentions when the reply ping is
    // on, so an explicit author check catches the ping-off case too.
    if (!shouldRespond && message.reference?.messageId) {
      try {
        const referenced = await message.fetchReference();
        shouldRespond = referenced?.author?.id === client.user.id;
      } catch (error) {
        console.warn("[discord][reply_ref] fetch failed", error);
      }
    }
    if (!shouldRespond) {
      return;
    }

    let replyMessage = null;
    let lastChunkMessage = null;
    let pendingUpdate = null;
    let lastUpdateAt = 0;
    let eyesReaction = null;
    let streamedText = "";
    let currentMsgOffset = 0;
    let syncInFlight = Promise.resolve();
    // Collected image payloads from the AI layer's onImage callback. Buffered
    // during streaming and delivered after text sync completes so the text
    // response shows up first.
    const collectedImages = [];
    const collectedFiles = [];
    const imageGenerationEnabled = config.imageGeneration === true;
    let imageProgressMessage = null;
    let fileProgressMessage = null;

    try {
      try {
        eyesReaction = await message.react("👀");
      } catch (error) {
        console.error("[discord][reaction_add] skipped", error);
      }

      const context = await buildDiscordContext(message, client.user.id, maxContextBytes);
      const lastUserMessage = [...context].reverse().find((msg) => msg.role === "user");
      if (!lastUserMessage) {
        if (inThread) {
          await message.channel.send({
            content: "질문을 같이 보내주세요.",
            allowedMentions: { parse: [] }
          });
        } else {
          await message.reply("질문을 같이 보내주세요.");
        }
        return;
      }

      const updateReply = async (source, offset, force = false) => {
        if (!replyMessage) {
          return 0;
        }

        const now = Date.now();
        if (!force && now - lastUpdateAt < discordStreamUpdateMs) {
          return;
        }

        const chunk = markdownChunk(source, offset, discordMaxLength);
        const content = chunk.text;
        try {
          await replyMessage.edit(content);
          lastUpdateAt = now;
          return chunk.consumedLength;
        } catch (error) {
          if (!isDiscordTooLong(error)) {
            throw error;
          }

          if (content.length <= 1) {
            throw error;
          }

          const fallback = markdownChunk(source, offset, Math.floor(discordMaxLength / 2));
          await replyMessage.edit(fallback.text);
          lastUpdateAt = now;
          return fallback.consumedLength;
        }
      };

      const sendChunk = (text) => {
        // In a thread the whole conversation is fetched as context, so reply
        // references (and chunk-to-chunk chaining) add only visual noise.
        if (inThread) {
          return message.channel.send({
            content: text,
            allowedMentions: { parse: [] }
          });
        }
        if (currentMsgOffset === 0) {
          return message.reply({
            content: text,
            allowedMentions: { parse: [] }
          });
        }
        const ref = lastChunkMessage;
        if (!ref?.id) {
          return message.channel.send({
            content: text,
            allowedMentions: { parse: [] }
          });
        }
        // Chain subsequent chunks to the previous chunk so reply-chain context can
        // recover the full answer when the user replies to any single chunk.
        return message.channel.send({
          content: text,
          allowedMentions: { parse: [], repliedUser: false },
          reply: { messageReference: ref.id, failIfNotExists: false }
        });
      };

      const postMessage = async (source, offset) => {
        const chunk = markdownChunk(source, offset, discordMaxLength);
        const content = chunk.text;
        try {
          const reply = await sendChunk(content);
          return { reply, consumedLength: chunk.consumedLength };
        } catch (error) {
          if (!isDiscordTooLong(error) || content.length <= 1) {
            throw error;
          }

          const fallback = markdownChunk(source, offset, Math.floor(discordMaxLength / 2));
          const reply = await sendChunk(fallback.text);
          return { reply, consumedLength: fallback.consumedLength };
        }
      };

      const syncReply = async (force = false) => {
        while (true) {
          const currentText = streamedText.slice(currentMsgOffset);
          if (!currentText.length) {
            return;
          }
          if (!currentText.trim() && (replyMessage || currentMsgOffset > 0)) {
            currentMsgOffset += currentText.length;
            return;
          }

          let consumedLength = 0;
          if (replyMessage) {
            consumedLength = await updateReply(streamedText, currentMsgOffset, force);
          } else {
            const result = await postMessage(streamedText, currentMsgOffset);
            replyMessage = result.reply;
            lastChunkMessage = result.reply;
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
        onFile: (file) => {
          collectedFiles.push(file);
        },
        onFileEvent: async (evt) => {
          if (!evt?.firstEventInAttempt || fileProgressMessage) {
            return;
          }
          try {
            fileProgressMessage = await message.channel.send({
              content: "📎 파일 생성 중...",
              allowedMentions: { parse: [] },
              ...(inThread
                ? {}
                : {
                    reply: {
                      messageReference: message.id,
                      failIfNotExists: false
                    }
                  })
            });
          } catch (err) {
            console.error("[discord][file_progress] failed", err);
          }
        },
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
                  ...(inThread
                    ? {}
                    : {
                        reply: {
                          messageReference: message.id,
                          failIfNotExists: false
                        }
                      })
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

      if (!rawAnswer && !streamedText.trim() && collectedImages.length === 0 && collectedFiles.length === 0) {
        const modelList = (config.models || []).join(", ") || "(none)";
        console.error(
          `[discord][message] empty response after retries models=${modelList}`
        );
        streamedText = `응답을 생성하지 못했어요 (모델 ${modelList}에서 빈 응답 반환). 잠시 후 다시 시도해주세요.`;
      } else {
        streamedText = rawAnswer || streamedText;
      }
      await runSyncReply(true);

      // Attachment delivery (post-text). If we have attachments but no text,
      // post a placeholder so history keeps an assistant turn for continuity.
      if (collectedFiles.length > 0 || collectedImages.length > 0) {
        if (!streamedText.trim()) {
          await message.channel.send({
            content: collectedFiles.length > 0 ? "파일을 첨부했습니다." : "이미지를 생성했습니다.",
            allowedMentions: { parse: [] },
            ...(inThread
              ? {}
              : {
                  reply: {
                    messageReference: message.id,
                    failIfNotExists: false
                  }
                })
          });
        }
        if (collectedFiles.length > 0) {
          await deliverDiscordFiles(message, { files: collectedFiles });
        }
      }
      if (collectedImages.length > 0) {
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
      if (fileProgressMessage) {
        try {
          await fileProgressMessage.delete();
          fileProgressMessage = null;
        } catch (err) {
          console.error("[discord][file_progress] cleanup failed", err);
        }
      }
    } catch (error) {
      console.error("[discord][message] error", error);
      const errorMessage = error instanceof CurrentUserImageLoadError
        ? "현재 요청의 이미지를 불러올 수 없어요. JPEG, PNG, GIF 또는 WebP 이미지를 다시 첨부해 주세요."
        : "에러가 발생했습니다. 잠시 후 다시 시도해주세요.";
      if (collectedFiles.length > 0) {
        console.error(
          `[discord] dropped ${collectedFiles.length} partial files due to stream error`
        );
      }
      if (collectedImages.length > 0) {
        console.error(
          `[discord] dropped ${collectedImages.length} partial images due to stream error`
        );
      }
      try {
        if (replyMessage) {
          const errorSuffix = error instanceof CurrentUserImageLoadError
            ? `\n\n⚠️ ${errorMessage}`
            : "\n\n⚠️ 출력 중 에러가 발생했습니다.";
          let errorText;
          const currentStreamedText = streamedText.slice(currentMsgOffset);
          if (currentStreamedText.trim()) {
            const maxContent = discordMaxLength - errorSuffix.length;
            errorText = currentStreamedText.trim().slice(0, maxContent) + errorSuffix;
          } else {
            errorText = errorMessage;
          }
          try {
            await replyMessage.edit(errorText);
          } catch (editError) {
            if (isDiscordTooLong(editError)) {
              await replyMessage.edit(errorText.slice(0, Math.floor(errorText.length / 2)) || ".");
            }
          }
        } else {
          if (inThread) {
            await message.channel.send({
              content: errorMessage,
              allowedMentions: { parse: [] }
            });
          } else {
            await message.reply(errorMessage);
          }
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

      if (fileProgressMessage) {
        try {
          await fileProgressMessage.delete();
        } catch (err) {
          console.error("[discord][file_progress] cleanup failed (finally)", err);
        }
      }

      if (eyesReaction) {
        try {
          await eyesReaction.users.remove(client.user.id);
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
