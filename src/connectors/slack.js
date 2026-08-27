import SlackBolt from "@slack/bolt";
import { createAiResponse } from "../ai.js";
import { isTextLike, fetchTextAttachmentBlock } from "./attachments.js";
import { attachImagesToLastUser, collectRecentContext } from "./context.js";
import { markdownChunk } from "./markdown-chunks.js";

const { App, SocketModeReceiver } = SlackBolt;

/**
 * Neutralize Slack mention/broadcast tokens that could be injected via
 * untrusted text (e.g. a model-generated revised_prompt). Strings that are
 * not strings are returned unchanged so callers can pass through optional
 * values without branching.
 *
 * Tokens handled:
 *   - Broadcast: <!channel>, <!here>, <!everyone> (optionally with |label)
 *   - User mention: <@U123456> / <@W123456>
 *   - Channel mention: <#C123456|name> (C/G/D prefixes)
 *   - Usergroup mention: <!subteam^S123456|name>
 *   - Plain text fallback: @channel / @here / @everyone without angle brackets
 */
export function sanitizeSlackMentions(text) {
  if (typeof text !== "string" || !text) {
    return text;
  }
  return text
    .replace(/<!(channel|here|everyone)(\|[^>]*)?>/gi, "(broadcast removed)")
    .replace(/<@([UW][A-Z0-9]+)(\|[^>]*)?>/g, "@$1")
    .replace(/<#([CGD][A-Z0-9]+)(\|[^>]*)?>/g, "#$1")
    .replace(/<!subteam\^([A-Z0-9]+)(\|[^>]*)?>/g, "@group-$1")
    .replace(/@(channel|here|everyone)\b/gi, "@\u200b$1");
}

/**
 * Sanitize a Codex item id so it is safe to use as a filename component.
 * Only alphanumerics, underscore, and hyphen are preserved.
 */
export function sanitizeFilenameId(id) {
  return String(id || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Upload each collected image to Slack as a new thread message. On per-image
 * failure the error is logged, a fallback text message is posted into the
 * same thread, and the loop continues with remaining images. No-op when the
 * images array is empty.
 *
 * @param {object} client - @slack/bolt WebClient (or compatible stub).
 * @param {Array<{id: string, buffer: Buffer, revisedPrompt?: string}>} images
 * @param {object} ctx
 * @param {string} ctx.channelId                - Slack channel id.
 * @param {string|undefined} ctx.threadTs       - Thread timestamp or undefined.
 * @param {string} [ctx.source]                 - Event source label for logs.
 * @param {string} [ctx.name]                   - Bot config name for logs.
 * @param {Function} [ctx.withRetry]            - Optional retry wrapper.
 */
export async function deliverSlackImages(client, images, ctx = {}) {
  if (!Array.isArray(images) || images.length === 0) {
    return;
  }
  const { channelId, threadTs, source = "image", name = "", withRetry } = ctx;
  const runWithRetry =
    typeof withRetry === "function" ? withRetry : async (fn) => fn();

  for (const image of images) {
    const safeComment = image?.revisedPrompt
      ? sanitizeSlackMentions(image.revisedPrompt)
      : undefined;
    const filename = `image-${sanitizeFilenameId(image?.id)}.png`;
    try {
      await runWithRetry(
        () =>
          client.filesUploadV2({
            channel_id: channelId,
            thread_ts: threadTs,
            initial_comment: safeComment,
            file: image.buffer,
            filename,
            alt_txt: safeComment
          }),
        "files_upload_v2"
      );
      console.log(
        `[slack][image_deliver] name=${name} source=${source} id=${image?.id}`
      );
    } catch (err) {
      console.error(
        `[slack][image_upload] failed name=${name} source=${source} id=${image?.id}`,
        err?.data || err
      );
      // H-1: image.id originates from the Codex model (trust boundary outside)
      // and `reason` is a free-form Slack API / HTTP error string. Apply the
      // same defenses used on success-path initial_comment/alt_txt (C-3) so a
      // crafted id or error string cannot inject broadcast/user mentions.
      const safeId = sanitizeFilenameId(image?.id);
      const safeReason = sanitizeSlackMentions(
        String(err?.data?.error || err?.message || "unknown")
      );
      try {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: sanitizeSlackMentions(
            `⚠️ 이미지 업로드 실패 (id=${safeId}): ${safeReason}`
          ),
          parse: "none",
          mrkdwn: true
        });
      } catch (notifyErr) {
        console.error(
          `[slack][image_upload] failure notice also failed id=${image?.id}`,
          notifyErr?.data || notifyErr
        );
      }
    }
  }
}

export async function deliverSlackFiles(client, files, ctx = {}) {
  if (!Array.isArray(files) || files.length === 0) return;
  const { channelId, threadTs, source = "file", name = "", withRetry } = ctx;
  const runWithRetry = typeof withRetry === "function" ? withRetry : async (fn) => fn();

  for (const file of files) {
    try {
      await runWithRetry(
        () => client.filesUploadV2({
          channel_id: channelId,
          thread_ts: threadTs,
          file: Buffer.from(file.content, "utf8"),
          filename: file.filename
        }),
        "files_upload_v2"
      );
      console.log(`[slack][file_deliver] name=${name} source=${source} filename=${file.filename}`);
    } catch (err) {
      console.error(
        `[slack][file_upload] failed name=${name} source=${source} filename=${file?.filename}`,
        err?.data || err
      );
      const safeReason = sanitizeSlackMentions(
        String(err?.data?.error || err?.message || "unknown")
      );
      try {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: sanitizeSlackMentions(`⚠️ 파일 첨부 실패 (${file?.filename}): ${safeReason}`),
          parse: "none",
          mrkdwn: true
        });
      } catch (notifyErr) {
        console.error(
          `[slack][file_upload] failure notice also failed filename=${file?.filename}`,
          notifyErr?.data || notifyErr
        );
      }
    }
  }
}

export async function* collectSlackDirectCandidates(event, loadPage, onError = console.error) {
  yield event;
  const seen = new Set([event.ts]);
  const cursors = new Set();
  let cursor;
  while (true) {
    let page;
    try {
      page = await loadPage({
        channel: event.channel,
        limit: 200,
        latest: event.ts,
        inclusive: true,
        cursor
      });
    } catch (error) {
      onError("[slack][dm_context] history load failed", error);
      return;
    }

    const pageMessages = [...(page.messages || [])].sort(
      (a, b) => Number(b.ts) - Number(a.ts)
    );
    for (const message of pageMessages) {
      if (seen.has(message.ts) || Number(message.ts) > Number(event.ts)) {
        continue;
      }
      seen.add(message.ts);
      yield message;
    }

    const nextCursor = page.response_metadata?.next_cursor?.trim();
    if (!nextCursor || cursors.has(nextCursor)) {
      return;
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export async function collectSlackThreadCandidates(event, loadPage) {
  const repliesByTimestamp = new Map([[event.ts, event]]);
  const cursors = new Set();
  let cursor;
  while (true) {
    const page = await loadPage({
      channel: event.channel,
      ts: event.thread_ts || event.ts,
      limit: 200,
      latest: event.ts,
      inclusive: true,
      cursor
    });
    for (const message of page.messages || []) {
      if (message.ts !== event.ts && Number(message.ts) <= Number(event.ts)) {
        repliesByTimestamp.set(message.ts, message);
      }
    }

    const nextCursor = page.response_metadata?.next_cursor?.trim();
    if (!nextCursor || cursors.has(nextCursor)) {
      break;
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }

  return [...repliesByTimestamp.values()].sort(
    (a, b) => Number(b.ts) - Number(a.ts)
  );
}

function isDirectMessage(event) {
  return event.channel_type === "im";
}

function hasSlackImageFile(message) {
  return Array.isArray(message?.files) && message.files.some(
    (file) => typeof file?.mimetype === "string" && file.mimetype.startsWith("image/")
  );
}

function isSlackTextFile(file) {
  if (typeof file?.mimetype === "string" && file.mimetype.startsWith("image/")) {
    return false;
  }
  return isTextLike(file?.name, file?.mimetype);
}

export async function materializeSlackMessage(message, botUserId, botToken) {
  if (
    message.subtype &&
    !["bot_message", "file_share", "thread_broadcast"].includes(message.subtype)
  ) {
    return null;
  }

  const content = (message.text || "")
    .replace(/<@[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const blocks = [];
  for (const file of message.files || []) {
    if (!isSlackTextFile(file)) {
      continue;
    }
    const block = await fetchTextAttachmentBlock({
      url: file?.url_private_download || file?.url_private,
      name: file?.name,
      headers: { Authorization: `Bearer ${botToken}` }
    });
    if (block) {
      blocks.push(block);
    }
  }

  const finalContent = [content, ...blocks].filter(Boolean).join("\n\n");
  if (!finalContent && !hasSlackImageFile(message)) {
    return null;
  }
  return {
    source: message,
    role: (botUserId && message.user === botUserId) || message.bot_id ? "assistant" : "user",
    content: finalContent
  };
}

async function fetchSlackImageAsDataUrl(file, botToken) {
  const maxImageBytes = 5 * 1024 * 1024;
  const fileUrl = file?.url_private_download || file?.url_private;
  if (
    !fileUrl ||
    typeof file?.mimetype !== "string" ||
    !file.mimetype.startsWith("image/")
  ) {
    return null;
  }
  try {
    const response = await fetch(fileUrl, {
      headers: { Authorization: `Bearer ${botToken}` }
    });
    if (!response.ok) {
      console.warn(`[slack][image_fetch] http ${response.status} file=${file.id}`);
      return null;
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxImageBytes) {
      console.warn(`[slack][image_fetch] skipping large file id=${file.id} bytes=${bytes.byteLength}`);
      return null;
    }
    return `data:${file.mimetype};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch (error) {
    console.warn(`[slack][image_fetch] failed id=${file?.id}`, error);
    return null;
  }
}

export async function buildSlackContext(client, event, options) {
  const { botUserId, botToken, maxContextBytes, withRetry } = options;
  if (isDirectMessage(event) && !event.thread_ts) {
    const selected = await collectRecentContext(
      collectSlackDirectCandidates(
        event,
        (params) => withRetry(
          () => client.conversations.history(params),
          "conversations_history"
        )
      ),
      maxContextBytes,
      (message) => materializeSlackMessage(message, botUserId, botToken)
    );
    const context = selected.map(({ role, content }) => ({ role, content }));
    return await attachImagesToLastUser(
      context,
      selected.map(({ source }) => source),
      (message) => message?.files || [],
      (file) => fetchSlackImageAsDataUrl(file, botToken)
    );
  }

  let messages;
  try {
    messages = await collectSlackThreadCandidates(
      event,
      (params) => withRetry(
        () => client.conversations.replies(params),
        "conversations_replies"
      )
    );
  } catch (error) {
    console.error("[slack][thread_context] history load failed, fallback to current message", error);
    messages = [event];
  }

  const selected = await collectRecentContext(
    messages,
    maxContextBytes,
    (message) => materializeSlackMessage(message, botUserId, botToken)
  );
  const context = selected.map(({ role, content }) => ({ role, content }));
  return await attachImagesToLastUser(
    context,
    selected.map(({ source }) => source),
    (message) => message?.files || [],
    (file) => fetchSlackImageAsDataUrl(file, botToken)
  );
}

export async function startSlackBot(config, options) {
  const { maxContextBytes, slackStreamUpdateMs } = options;
  const receiver = new SocketModeReceiver({
    appToken: config.appToken
  });

  // @slack/bolt v4.6 SocketModeReceiver ignores clientPingTimeout / serverPingTimeout
  // options (only appToken/logger/logLevel/clientOptions are forwarded to
  // SocketModeClient). Default clientPingTimeoutMS is 5000ms, which fires noisy
  // "pong wasn't received" warnings on slow startups/networks. Patch the
  // underlying SocketModeClient instance before start so the overrides land on
  // the websocket constructor. 30s matches what we originally intended.
  if (receiver.client) {
    receiver.client.clientPingTimeoutMS = 30_000;
    receiver.client.serverPingTimeoutMS = 30_000;
  }

  const app = new App({
    token: config.botToken,
    receiver
  });

  let botUserId = null;

  function isFromBot(event) {
    return (
      event.subtype === "bot_message" ||
      Boolean(event.bot_id) ||
      Boolean(botUserId && event.user === botUserId)
    );
  }

  function isMentioningBot(text = "") {
    return Boolean(botUserId && text.includes(`<@${botUserId}>`));
  }

  const slackMaxLength = 20000;
  const slackRateLimitRetryCount = 3;
  const defaultSlackRetryAfterMs = 10_000;

  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function isMsgTooLong(error) {
    return error?.data?.error === "msg_too_long";
  }

  function isRateLimited(error) {
    return (
      error?.statusCode === 429 ||
      error?.data?.error === "ratelimited" ||
      typeof error?.data?.retryAfter === "number" ||
      typeof error?.retryAfter === "number" ||
      typeof error?.headers?.["retry-after"] !== "undefined" ||
      String(error?.message || "").toLowerCase().includes("rate limit")
    );
  }

  function getRetryAfterMs(error) {
    const retryAfter =
      Number(error?.data?.retryAfter) ||
      Number(error?.retryAfter) ||
      Number(error?.headers?.["retry-after"]);

    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return retryAfter * 1000;
    }

    return defaultSlackRetryAfterMs;
  }

  async function withSlackRetry(action, label, maxAttempts = slackRateLimitRetryCount) {
    let attempt = 0;

    while (true) {
      try {
        return await action();
      } catch (error) {
        attempt += 1;
        if (!isRateLimited(error) || attempt >= maxAttempts) {
          throw error;
        }

        const retryAfterMs = getRetryAfterMs(error);
        console.warn(`[slack][${label}] rate limited, retrying in ${Math.ceil(retryAfterMs / 1000)}s`);
        await sleep(retryAfterMs);
      }
    }
  }

  async function hasBotReplyInThread(client, event) {
    if (!event.thread_ts) {
      return false;
    }

    const replies = await withSlackRetry(() => client.conversations.replies({
      channel: event.channel,
      ts: event.thread_ts,
      limit: 200,
      latest: event.ts,
      inclusive: true
    }), "thread_replies");

    return (replies.messages || []).some(
      (message) => botUserId && message.user === botUserId && message.ts !== event.ts
    );
  }

  async function handleConversationEvent({ event, client, say, source }) {
    let replyTs = null;
    const threadTs = event.thread_ts || event.ts;
    const inDm = isDirectMessage(event) && !event.thread_ts;
    let addedEyesReaction = false;
    let pendingUpdate = null;
    let streamedText = "";
    let currentMsgOffset = 0;
    let syncInFlight = Promise.resolve();
    // Collected image payloads from the AI layer's onImage callback. These
    // are buffered during streaming and delivered after text sync completes.
    const collectedImages = [];
    const collectedFiles = [];
    const imageGenerationEnabled = config.imageGeneration === true;
    let imageProgressNoticeTs = null;
    let fileProgressNoticeTs = null;

    try {
      try {
        await withSlackRetry(() => client.reactions.add({
          channel: event.channel,
          timestamp: event.ts,
          name: "eyes"
        }), "reaction_add");
        addedEyesReaction = true;
      } catch (error) {
        console.error("[slack][reaction_add] skipped", error?.data || error);
      }

      const context = await buildSlackContext(client, event, {
        botUserId,
        botToken: config.botToken,
        maxContextBytes,
        withRetry: withSlackRetry
      });
      const lastUserMessage = [...context].reverse().find((msg) => msg.role === "user");

      if (!lastUserMessage) {
        await withSlackRetry(() => say({
          text: "질문을 같이 보내주세요. 예: `@bot 오늘 할 일 정리해줘`",
          thread_ts: event.thread_ts || event.ts
        }), "prompt_say");
        return;
      }
      let lastUpdateAt = 0;

      const postMessage = async (source, offset) => {
        const chunk = markdownChunk(source, offset, slackMaxLength);
        const content = chunk.text;
        try {
          const reply = await withSlackRetry(() => client.chat.postMessage({
            channel: event.channel,
            ...(inDm ? {} : { thread_ts: threadTs }),
            text: content,
            parse: "none",
            mrkdwn: true
          }), "post_message");
          return { reply, consumedLength: chunk.consumedLength };
        } catch (error) {
          if (!isMsgTooLong(error) || content.length <= 1) {
            throw error;
          }

          const fallback = markdownChunk(source, offset, Math.floor(slackMaxLength / 2));
          const reply = await withSlackRetry(() => client.chat.postMessage({
            channel: event.channel,
            ...(inDm ? {} : { thread_ts: threadTs }),
            text: fallback.text,
            parse: "none",
            mrkdwn: true
          }), "post_message");
          return { reply, consumedLength: fallback.consumedLength };
        }
      };

      const updateReply = async (source, offset, force = false) => {
        if (!replyTs) {
          return 0;
        }

        const now = Date.now();
        if (!force && now - lastUpdateAt < slackStreamUpdateMs) {
          return;
        }

        const chunk = markdownChunk(source, offset, slackMaxLength);
        const content = chunk.text;
        try {
          await withSlackRetry(() => client.chat.update({
            channel: event.channel,
            ts: replyTs,
            text: content,
            parse: "none",
            mrkdwn: true
          }), "chat_update");
          lastUpdateAt = now;
          return chunk.consumedLength;
        } catch (error) {
          if (!isMsgTooLong(error)) {
            throw error;
          }

          if (content.length <= 1) {
            throw error;
          }

          const fallback = markdownChunk(source, offset, Math.floor(slackMaxLength / 2));
          await withSlackRetry(() => client.chat.update({
            channel: event.channel,
            ts: replyTs,
            text: fallback.text,
            parse: "none",
            mrkdwn: true
          }), "chat_update");
          lastUpdateAt = now;
          return fallback.consumedLength;
        }
      };

      const syncReply = async (force = false) => {
        while (true) {
          const currentText = streamedText.slice(currentMsgOffset);
          if (!currentText.length) {
            return;
          }
          if (!currentText.trim() && (replyTs || currentMsgOffset > 0)) {
            currentMsgOffset += currentText.length;
            return;
          }

          let consumedLength = 0;
          if (replyTs) {
            consumedLength = await updateReply(streamedText, currentMsgOffset, force);
          } else {
            const result = await postMessage(streamedText, currentMsgOffset);
            replyTs = result.reply.ts;
            lastUpdateAt = Date.now();
            consumedLength = result.consumedLength;
          }

          if (consumedLength >= currentText.length) {
            return;
          }

          currentMsgOffset += consumedLength;
          replyTs = null;
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
            console.error("[slack][message_update] error", error);
          }
        }, slackStreamUpdateMs);
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
          if (!evt?.firstEventInAttempt || fileProgressNoticeTs) {
            return;
          }
          try {
            const res = await withSlackRetry(
              () => client.chat.postMessage({
                channel: event.channel,
                thread_ts: inDm ? undefined : threadTs,
                text: "📎 파일 생성 중...",
                parse: "none",
                mrkdwn: true
              }),
              "file_progress_notice"
            );
            fileProgressNoticeTs = res?.ts;
          } catch (err) {
            console.error(
              `[slack][file_progress] failed name=${config.name} source=${source}`,
              err?.data || err
            );
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
              if (!evt?.firstEventInAttempt || imageProgressNoticeTs) {
                return;
              }
              try {
                const res = await withSlackRetry(
                  () =>
                    client.chat.postMessage({
                      channel: event.channel,
                      thread_ts: threadTs,
                      text: "🎨 이미지 생성 중...",
                      parse: "none",
                      mrkdwn: true
                    }),
                  "image_progress_notice"
                );
                imageProgressNoticeTs = res?.ts;
              } catch (err) {
                console.error(
                  `[slack][image_progress] failed name=${config.name} source=${source}`,
                  err?.data || err
                );
              }
            }
          : undefined,
        onDelta: async (_delta, fullText) => {
          streamedText = fullText;
          const currentText = streamedText.slice(currentMsgOffset);

          if (!replyTs || currentText.length > slackMaxLength) {
            if (pendingUpdate) {
              clearTimeout(pendingUpdate);
              pendingUpdate = null;
            }
            await runSyncReply(true);
            return;
          }

          if (Date.now() - lastUpdateAt >= slackStreamUpdateMs) {
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
          `[slack][${source}] empty response after retries models=${modelList}`
        );
        streamedText = `응답을 생성하지 못했어요 (모델 ${modelList}에서 빈 응답 반환). 잠시 후 다시 시도해주세요.`;
      } else {
        streamedText = rawAnswer || streamedText;
      }
      await runSyncReply(true);

      // Image delivery (M-5 + §6.2 E8): if we collected images during the
      // stream, post them AFTER the text reply has been synced. If there was
      // no text at all, post a small placeholder message first so the thread
      // history still contains an assistant turn for the next context build.
      if (collectedFiles.length > 0 || collectedImages.length > 0) {
        // In channels (and in thread replies), always anchor to the thread so
        // the placeholder + image attachments stay grouped with the original
        // question. In DMs with no thread context, post at the DM root like
        // the text reply does. Mirrors the `inDm ? {} : { thread_ts }` pattern
        // used for text replies elsewhere in this file.
        const uploadThreadTs = inDm ? undefined : threadTs;
        if (!streamedText.trim()) {
          try {
            await withSlackRetry(
              () =>
                client.chat.postMessage({
                  channel: event.channel,
                  thread_ts: uploadThreadTs,
                  text: collectedFiles.length > 0 ? "파일을 첨부했습니다." : "이미지를 생성했습니다.",
                  parse: "none",
                  mrkdwn: true
                }),
              "image_placeholder"
            );
          } catch (placeholderErr) {
            console.error(
              `[slack][image_placeholder] failed name=${config.name}`,
              placeholderErr?.data || placeholderErr
            );
          }
        }
        if (collectedFiles.length > 0) {
          await deliverSlackFiles(client, collectedFiles, {
            channelId: event.channel,
            threadTs: uploadThreadTs,
            source,
            name: config.name,
            withRetry: withSlackRetry
          });
        }
      }
      if (collectedImages.length > 0) {
        const uploadThreadTs = inDm ? undefined : threadTs;
        await deliverSlackImages(client, collectedImages, {
          channelId: event.channel,
          threadTs: uploadThreadTs,
          source,
          name: config.name,
          withRetry: withSlackRetry
        });
      }

      if (imageProgressNoticeTs) {
        try {
          await withSlackRetry(
            () =>
              client.chat.delete({
                channel: event.channel,
                ts: imageProgressNoticeTs
              }),
            "image_progress_cleanup"
          );
        } catch (err) {
          console.error(
            `[slack][image_progress] cleanup failed name=${config.name}`,
            err?.data || err
          );
        }
        imageProgressNoticeTs = null;
      }
      if (fileProgressNoticeTs) {
        try {
          await withSlackRetry(
            () => client.chat.delete({ channel: event.channel, ts: fileProgressNoticeTs }),
            "file_progress_cleanup"
          );
          fileProgressNoticeTs = null;
        } catch (err) {
          console.error(`[slack][file_progress] cleanup failed name=${config.name}`, err?.data || err);
        }
      }

    } catch (error) {
      console.error(`[slack][${source}] error`, error);
      if (collectedFiles.length > 0) {
        console.error(
          `[slack] dropped ${collectedFiles.length} partial files due to stream error name=${config.name} source=${source}`
        );
      }
      if (collectedImages.length > 0) {
        // Drop partially-collected images on stream error (H-2). We only log
        // the count so operators can correlate with upstream issues; we do
        // not upload the fragments because mixing a failure notice with a
        // subset of images harms UX and thread-history continuity.
        console.error(
          `[slack] dropped ${collectedImages.length} partial images due to stream error name=${config.name} source=${source}`
        );
      }
      if (replyTs) {
        const errorSuffix = "\n\n⚠️ 출력 중 에러가 발생했습니다.";
        let errorText;
        const currentStreamedText = streamedText.slice(currentMsgOffset);
        if (currentStreamedText.trim()) {
          const maxContent = slackMaxLength - errorSuffix.length;
          errorText = currentStreamedText.trim().slice(0, maxContent) + errorSuffix;
        } else {
          errorText = "에러가 발생했습니다. 잠시 후 다시 시도해주세요.";
        }
        try {
          await withSlackRetry(() => client.chat.update({
            channel: event.channel,
            ts: replyTs,
            text: errorText,
            parse: "none",
            mrkdwn: true
          }), "error_update");
        } catch (updateError) {
          if (isMsgTooLong(updateError)) {
            await withSlackRetry(() => client.chat.update({
              channel: event.channel,
              ts: replyTs,
              text: errorText.slice(0, Math.floor(errorText.length / 2)) || ".",
              parse: "none",
              mrkdwn: true
            }), "error_update");
          }
        }
        return;
      }

      if (inDm) {
        await withSlackRetry(() => client.chat.postMessage({
          channel: event.channel,
          text: "에러가 발생했습니다. 잠시 후 다시 시도해주세요.",
          parse: "none",
          mrkdwn: true
        }), "error_post_message");
        return;
      }

      await withSlackRetry(() => say({
        text: "에러가 발생했습니다. 잠시 후 다시 시도해주세요.",
        thread_ts: threadTs,
        parse: "none",
        mrkdwn: true
      }), "error_say");
    } finally {
      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
        pendingUpdate = null;
      }

      if (imageProgressNoticeTs) {
        try {
          await withSlackRetry(
            () =>
              client.chat.delete({
                channel: event.channel,
                ts: imageProgressNoticeTs
              }),
            "image_progress_cleanup"
          );
        } catch (err) {
          console.error(
            `[slack][image_progress] cleanup failed (finally) name=${config.name}`,
            err?.data || err
          );
        }
      }

      if (fileProgressNoticeTs) {
        try {
          await withSlackRetry(
            () => client.chat.delete({ channel: event.channel, ts: fileProgressNoticeTs }),
            "file_progress_cleanup"
          );
        } catch (err) {
          console.error(
            `[slack][file_progress] cleanup failed (finally) name=${config.name}`,
            err?.data || err
          );
        }
      }

      if (addedEyesReaction) {
        try {
          await withSlackRetry(() => client.reactions.remove({
            channel: event.channel,
            timestamp: event.ts,
            name: "eyes"
          }), "reaction_remove");
        } catch (error) {
          console.error("[slack][reaction_remove] skipped", error?.data || error);
        }
      }
    }
  }

  app.event("app_mention", async ({ event, client, say }) => {
    console.log("[slack][event] app_mention", {
      name: config.name,
      channel: event.channel,
      channel_type: event.channel_type,
      ts: event.ts
    });
    await handleConversationEvent({ event, client, say, source: "app_mention" });
  });

  app.event("message", async ({ event, client, say }) => {
    console.log("[slack][event] message", {
      name: config.name,
      subtype: event.subtype || null,
      channel: event.channel,
      channel_type: event.channel_type,
      thread_ts: event.thread_ts || null,
      ts: event.ts
    });

    if (event.subtype && event.subtype !== "thread_broadcast") {
      return;
    }

    if (isFromBot(event)) {
      return;
    }

    const inDm = isDirectMessage(event);

    if (inDm) {
      await handleConversationEvent({ event, client, say, source: "message_im" });
      return;
    }

    if (!event.thread_ts) {
      return;
    }

    if (isMentioningBot(event.text || "")) {
      return;
    }

    const shouldReply = await hasBotReplyInThread(client, event);
    if (!shouldReply) {
      return;
    }

    await handleConversationEvent({ event, client, say, source: "message" });
  });

  app.error((error) => {
    console.error("[slack][app_error]", error);
  });

  const auth = await withSlackRetry(() => app.client.auth.test({ token: config.botToken }), "auth_test");
  botUserId = auth.user_id || null;
  await app.start();
  console.log(
    `[slack] started name=${config.name} bot_user=${botUserId} models=${(config.models || []).join(",")} web_search=${config.webSearch} system_prompt=${config.systemPrompt ? "service" : "default"}`
  );

  return {
    async stop() {
      await app.stop();
      console.log(`[slack] stopped name=${config.name}`);
    }
  };
}
