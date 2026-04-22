import SlackBolt from "@slack/bolt";
import { createAiResponse } from "../ai.js";

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

export async function startSlackBot(config, options) {
  const { maxThreadHistory, slackStreamUpdateMs } = options;
  const receiver = new SocketModeReceiver({
    appToken: config.appToken,
    pingPongLoggingEnabled: false,
    clientPingTimeoutMS: 30_000,
    serverPingTimeoutMS: 30_000
  });

  const app = new App({
    token: config.botToken,
    receiver
  });

  let botUserId = null;

  function cleanSlackText(text = "") {
    return text
      .replace(/<@[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

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

  function isDirectMessage(event) {
    return event.channel_type === "im";
  }

  const slackMaxLength = 20000;
  const slackRateLimitRetryCount = 3;
  const defaultSlackRetryAfterMs = 10_000;

  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function toSlackText(text = "") {
    if (!text.trim()) {
      return ".";
    }

    if (text.length <= slackMaxLength) {
      return text;
    }

    return text.slice(0, slackMaxLength);
  }

  function splitSlackText(text = "") {
    if (!text.trim()) {
      return ["."];
    }

    if (text.length <= slackMaxLength) {
      return [text];
    }

    const chunks = [];
    for (let i = 0; i < text.length; i += slackMaxLength) {
      chunks.push(text.slice(i, i + slackMaxLength));
    }
    return chunks;
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

  async function buildThreadContext(client, event) {
    if (isDirectMessage(event) && !event.thread_ts) {
      try {
        const history = await withSlackRetry(() => client.conversations.history({
          channel: event.channel,
          limit: maxThreadHistory
        }), "conversations_history");

        const messages = [...(history.messages || [])].reverse();
        const context = [];

        for (const message of messages) {
          if (message.subtype && message.subtype !== "bot_message") {
            continue;
          }

          const text = cleanSlackText(message.text);
          if (!text) {
            continue;
          }

          const isAssistant =
            (botUserId && message.user === botUserId) || Boolean(message.bot_id);

          context.push({
            role: isAssistant ? "assistant" : "user",
            content: text
          });
        }

        return context;
      } catch (error) {
        console.error("[slack][dm_context] history load failed, fallback to current message", error);
        const fallbackText = cleanSlackText(event.text || "");
        return fallbackText ? [{ role: "user", content: fallbackText }] : [];
      }
    }

    const threadTs = event.thread_ts || event.ts;
    const replies = await withSlackRetry(() => client.conversations.replies({
      channel: event.channel,
      ts: threadTs,
      limit: maxThreadHistory
    }), "conversations_replies");

    const messages = replies.messages || [];
    const context = [];

    for (const message of messages) {
      const text = cleanSlackText(message.text);
      if (!text) {
        continue;
      }

      const isAssistant =
        (botUserId && message.user === botUserId) || Boolean(message.bot_id);

      context.push({
        role: isAssistant ? "assistant" : "user",
        content: text
      });
    }

    return context;
  }

  async function hasBotReplyInThread(client, event) {
    if (!event.thread_ts) {
      return false;
    }

    const replies = await withSlackRetry(() => client.conversations.replies({
      channel: event.channel,
      ts: event.thread_ts,
      limit: maxThreadHistory
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
    const imageGenerationEnabled = config.imageGeneration === true;
    let imageProgressNoticeTs = null;

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

      const context = await buildThreadContext(client, event);
      const lastUserMessage = [...context].reverse().find((msg) => msg.role === "user");

      if (!lastUserMessage) {
        await withSlackRetry(() => say({
          text: "질문을 같이 보내주세요. 예: `@bot 오늘 할 일 정리해줘`",
          thread_ts: event.thread_ts || event.ts
        }), "prompt_say");
        return;
      }
      let lastUpdateAt = 0;

      const postMessage = async (text) => {
        const content = toSlackText(text);
        try {
          const reply = await withSlackRetry(() => client.chat.postMessage({
            channel: event.channel,
            ...(inDm ? {} : { thread_ts: threadTs }),
            text: content,
            parse: "none",
            mrkdwn: true
          }), "post_message");
          return { reply, consumedLength: content === "." ? 0 : content.length };
        } catch (error) {
          if (!isMsgTooLong(error) || content.length <= 1) {
            throw error;
          }

          const consumedLength = Math.floor(content.length / 2);
          const reply = await withSlackRetry(() => client.chat.postMessage({
            channel: event.channel,
            ...(inDm ? {} : { thread_ts: threadTs }),
            text: content.slice(0, consumedLength) || ".",
            parse: "none",
            mrkdwn: true
          }), "post_message");
          return { reply, consumedLength };
        }
      };

      const updateReply = async (text, force = false) => {
        if (!replyTs) {
          return 0;
        }

        const now = Date.now();
        if (!force && now - lastUpdateAt < slackStreamUpdateMs) {
          return;
        }

        const content = toSlackText(text);
        try {
          await withSlackRetry(() => client.chat.update({
            channel: event.channel,
            ts: replyTs,
            text: content,
            parse: "none",
            mrkdwn: true
          }), "chat_update");
          lastUpdateAt = now;
          return content === "." ? 0 : content.length;
        } catch (error) {
          if (!isMsgTooLong(error)) {
            throw error;
          }

          if (content.length <= 1) {
            throw error;
          }

          const consumedLength = Math.floor(content.length / 2);
          await withSlackRetry(() => client.chat.update({
            channel: event.channel,
            ts: replyTs,
            text: content.slice(0, consumedLength) || ".",
            parse: "none",
            mrkdwn: true
          }), "chat_update");
          lastUpdateAt = now;
          return consumedLength;
        }
      };

      const syncReply = async (force = false) => {
        while (true) {
          const currentText = streamedText.slice(currentMsgOffset);
          if (!currentText.trim()) {
            return;
          }

          let consumedLength = 0;
          if (replyTs) {
            consumedLength = await updateReply(currentText, force);
          } else {
            const result = await postMessage(currentText);
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

      if (!rawAnswer && !streamedText.trim() && collectedImages.length === 0) {
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
      // history still contains an assistant turn for the next round of
      // buildThreadContext to pick up.
      if (collectedImages.length > 0) {
        const uploadThreadTs = event.thread_ts || undefined;
        if (!streamedText.trim()) {
          try {
            await withSlackRetry(
              () =>
                client.chat.postMessage({
                  channel: event.channel,
                  thread_ts: uploadThreadTs,
                  text: "이미지를 생성했습니다.",
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

    } catch (error) {
      console.error(`[slack][${source}] error`, error);
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
