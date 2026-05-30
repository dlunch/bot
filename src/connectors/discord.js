import { AttachmentBuilder, Client, EmbedBuilder, GatewayIntentBits, Partials } from "discord.js";
import { createAiResponse } from "../ai.js";
import { isTextLike, fetchTextAttachmentBlock, maxTextFilesInContext } from "./attachments.js";

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
      const replyRef = message?.id
        ? { messageReference: message.id, failIfNotExists: false }
        : undefined;

      let payload;
      if (rawPrompt.length <= discordContentMax) {
        payload = {
          content: rawPrompt,
          files: [attachment],
          allowedMentions: { parse: [] },
          reply: replyRef
        };
      } else {
        const embed = new EmbedBuilder()
          .setDescription(truncate(rawPrompt, discordEmbedDescriptionMax))
          .setImage(`attachment://${filename}`);
        payload = {
          embeds: [embed],
          files: [attachment],
          allowedMentions: { parse: [] },
          reply: replyRef
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

  const maxImagesInContext = 3;
  const maxImageBytes = 5 * 1024 * 1024;

  function hasImageAttachment(msg) {
    const attachments = msg?.attachments;
    if (!attachments || attachments.size === 0) {
      return false;
    }
    for (const attachment of attachments.values()) {
      if (typeof attachment?.contentType === "string" && attachment.contentType.startsWith("image/")) {
        return true;
      }
    }
    return false;
  }

  function hasTextAttachment(msg) {
    const attachments = msg?.attachments;
    if (!attachments || attachments.size === 0) {
      return false;
    }
    for (const attachment of attachments.values()) {
      if (
        typeof attachment?.contentType !== "string" ||
        !attachment.contentType.startsWith("image/")
      ) {
        if (isTextLike(attachment?.name, attachment?.contentType)) {
          return true;
        }
      }
    }
    return false;
  }

  async function enrichContextWithTextFiles(context, keptMessages) {
    // Text attachments carry no role restriction (unlike images), so inline
    // them into the message they belong to. Walk newest-first so the budget
    // favors the most recent files when a thread has many.
    let budget = maxTextFilesInContext;
    for (let i = keptMessages.length - 1; i >= 0 && budget > 0; i--) {
      const attachments = keptMessages[i]?.attachments;
      if (!attachments || attachments.size === 0) {
        continue;
      }
      const blocks = [];
      for (const attachment of attachments.values()) {
        if (budget <= 0) {
          break;
        }
        if (
          typeof attachment?.contentType === "string" &&
          attachment.contentType.startsWith("image/")
        ) {
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
          budget--;
        }
      }
      if (blocks.length) {
        const existing = typeof context[i].content === "string" ? context[i].content : "";
        context[i] = {
          ...context[i],
          content: [existing, ...blocks].filter(Boolean).join("\n\n")
        };
      }
    }
  }

  async function fetchDiscordImageAsDataUrl(attachment) {
    const contentType = attachment?.contentType;
    const url = attachment?.url;
    if (!url || typeof contentType !== "string" || !contentType.startsWith("image/")) {
      return null;
    }
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[discord][image_fetch] http ${res.status} id=${attachment.id}`);
        return null;
      }
      const ab = await res.arrayBuffer();
      if (ab.byteLength > maxImageBytes) {
        console.warn(`[discord][image_fetch] skipping large attachment id=${attachment.id} bytes=${ab.byteLength}`);
        return null;
      }
      const base64 = Buffer.from(ab).toString("base64");
      return `data:${contentType};base64,${base64}`;
    } catch (err) {
      console.warn(`[discord][image_fetch] failed id=${attachment?.id}`, err);
      return null;
    }
  }

  async function walkBotChunkForward(seedMessage, botUserId, maxLength) {
    // A long bot answer is split into multiple Discord messages (2000-char
    // cap). Each subsequent chunk replies to its predecessor, so given a bot
    // message we can walk forward in the channel to recover the rest.
    if (maxLength <= 0) {
      return [];
    }
    let fetched;
    try {
      fetched = await seedMessage.channel.messages.fetch({
        after: seedMessage.id,
        limit: Math.min(50, Math.max(maxLength * 2, 10))
      });
    } catch (err) {
      console.warn(`[discord][reply_chain] forward fetch failed id=${seedMessage.id}`, err);
      return [];
    }
    const sorted = [...fetched.values()].sort(
      (a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0)
    );
    const result = [];
    let lastId = seedMessage.id;
    for (const msg of sorted) {
      if (result.length >= maxLength) {
        break;
      }
      if (msg.author?.id !== botUserId) {
        continue;
      }
      if (msg?.reference?.messageId !== lastId) {
        continue;
      }
      result.push(msg);
      lastId = msg.id;
    }
    return result;
  }

  async function walkReplyChain(message, maxLength, botUserId) {
    // Walk backward from `message` following message.reference.messageId until
    // we run out of refs, the parent fetch fails, or we hit maxLength. Returns
    // chain in oldest-first order. For each bot message in the chain, also
    // pull in any forward chunks (long-answer continuations) so replying to
    // any single chunk still surfaces the rest.
    const chain = [message];
    let current = message;
    while (chain.length < maxLength) {
      const refId = current?.reference?.messageId;
      if (!refId) {
        break;
      }
      try {
        const parent = await current.channel.messages.fetch(refId);
        chain.push(parent);
        current = parent;
      } catch (err) {
        console.warn(`[discord][reply_chain] fetch failed id=${refId}`, err);
        break;
      }
    }
    chain.reverse();

    // Reserve the backward chain in full and only spend the leftover budget on
    // forward chunks. Otherwise older bot continuations could push out the
    // newest user turn (the triggering request), which always sits at the tail
    // of `chain`.
    let forwardBudget = Math.max(0, maxLength - chain.length);
    const seen = new Set(chain.map((m) => m.id));
    const result = [];
    for (let i = 0; i < chain.length; i++) {
      const msg = chain[i];
      result.push(msg);
      if (forwardBudget <= 0 || msg.author?.id !== botUserId) {
        continue;
      }
      // If the next chain message is already a continuation of this bot
      // message, its successors will be picked up from there — no need to
      // refetch and risk extra rate-limit pressure.
      const next = chain[i + 1];
      if (
        next &&
        next.author?.id === botUserId &&
        next?.reference?.messageId === msg.id
      ) {
        continue;
      }
      const forwardChunks = await walkBotChunkForward(msg, botUserId, forwardBudget);
      for (const fwd of forwardChunks) {
        if (seen.has(fwd.id)) {
          continue;
        }
        // Only include chunks that occurred before the next message in the
        // backward chain to preserve chronological ordering. Forward chunks
        // are already sorted ascending by timestamp (walkBotChunkForward),
        // so we can break early once we pass the cutoff.
        if (next && (fwd.createdTimestamp || 0) >= (next.createdTimestamp || 0)) {
          break;
        }
        seen.add(fwd.id);
        result.push(fwd);
        forwardBudget--;
        if (forwardBudget <= 0) {
          break;
        }
      }
    }
    return result;
  }

  async function buildContext(message, botUserId) {
    // Discord text channels mix unrelated conversations, so for non-thread,
    // non-DM channels we follow the reply chain instead of pulling the channel's
    // recent messages. Threads and DMs are isolated to a single conversation,
    // so the channel-wide fetch is fine there.
    const useReplyChain =
      typeof message.channel?.isThread === "function" &&
      !message.channel.isThread() &&
      message.channel.type !== 1; // ChannelType.DM === 1

    let messages;
    if (useReplyChain) {
      messages = await walkReplyChain(message, maxThreadHistory, botUserId);
    } else {
      const fetched = await message.channel.messages.fetch({ limit: maxThreadHistory });
      messages = [...fetched.values()].reverse();
    }
    const keptMessages = [];
    const context = [];

    for (const msg of messages) {
      if (msg.author?.bot && msg.author.id !== botUserId) {
        continue;
      }

      const baseText = cleanDiscordText(msg.content || "", botUserId);
      // Pull text out of any embeds (title + description). The bot itself
      // sometimes posts long revised_prompts as embed.description when they
      // exceed the 2000-char content limit, so without this the next turn's
      // context would lose what was generated last time.
      const embedTexts = [];
      for (const embed of msg.embeds || []) {
        if (embed?.title) embedTexts.push(embed.title);
        if (embed?.description) embedTexts.push(embed.description);
      }
      const text = [baseText, ...embedTexts].filter(Boolean).join("\n").trim();
      if (!text && !hasImageAttachment(msg) && !hasTextAttachment(msg)) {
        continue;
      }

      keptMessages.push(msg);
      context.push({
        role: msg.author?.id === botUserId ? "assistant" : "user",
        content: text
      });
    }

    // Inline text-file attachments before image enrichment, which rewrites the
    // last user turn's content into a parts array (where the string-append below
    // would no longer apply).
    await enrichContextWithTextFiles(context, keptMessages);

    // Collect the most-recent N images from thread history and attach them ALL
    // to the last user turn (which is the current request). See slack.js for
    // rationale (input_image on assistant role is not accepted).
    const collected = [];
    let budget = maxImagesInContext;
    for (let i = keptMessages.length - 1; i >= 0 && budget > 0; i--) {
      const attachments = keptMessages[i]?.attachments;
      if (!attachments || attachments.size === 0) {
        continue;
      }
      for (const attachment of attachments.values()) {
        if (budget <= 0) {
          break;
        }
        const dataUrl = await fetchDiscordImageAsDataUrl(attachment);
        if (dataUrl) {
          collected.unshift(dataUrl);
          budget--;
        }
      }
    }

    if (collected.length === 0) {
      return context;
    }

    let lastUserIdx = -1;
    for (let i = context.length - 1; i >= 0; i--) {
      if (context[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) {
      return context;
    }

    const enriched = [...context];
    const lastText = context[lastUserIdx].content;
    const parts = [];
    if (typeof lastText === "string" && lastText.trim()) {
      parts.push({ type: "input_text", text: lastText });
    }
    for (const url of collected) {
      parts.push({ type: "input_image", image_url: url });
    }
    enriched[lastUserIdx] = { role: "user", content: parts };
    return enriched;
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

  async function botHasMessagedInThread(channel, botUserId) {
    try {
      const fetched = await channel.messages.fetch({ limit: maxThreadHistory });
      for (const msg of fetched.values()) {
        if (msg.author?.id === botUserId) {
          return true;
        }
      }
      return false;
    } catch (error) {
      console.warn("[discord][thread_participation] fetch failed", error);
      return false;
    }
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
    const inThread =
      typeof message.channel?.isThread === "function" && message.channel.isThread();

    // In a thread the bot already participates in, treat every message as
    // directed at the bot so follow-ups don't each need an explicit mention.
    let shouldRespond = isDm || mentioned;
    if (!shouldRespond && inThread) {
      shouldRespond = await botHasMessagedInThread(message.channel, client.user.id);
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
    // response shows up first (per arch §7.2 UX decision).
    const collectedImages = [];
    const imageGenerationEnabled = config.imageGeneration === true;
    let imageProgressMessage = null;

    try {
      try {
        eyesReaction = await message.react("👀");
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

      const sendChunk = (text) => {
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
        // Chain subsequent chunks to the previous chunk so walkReplyChain can
        // recover the full answer when the user replies to any single chunk.
        return message.channel.send({
          content: text,
          allowedMentions: { parse: [], repliedUser: false },
          reply: { messageReference: ref.id, failIfNotExists: false }
        });
      };

      const postMessage = async (text) => {
        const content = capDiscordText(text);
        try {
          const reply = await sendChunk(content);
          return { reply, consumedLength: content === "." ? 0 : content.length };
        } catch (error) {
          if (!isDiscordTooLong(error) || content.length <= 1) {
            throw error;
          }

          const consumedLength = Math.floor(content.length / 2);
          const fallbackContent = content.slice(0, consumedLength) || ".";
          const reply = await sendChunk(fallbackContent);
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
