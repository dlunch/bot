// Unit tests for B2 (Slack image delivery helpers).
// Uses Node's built-in test runner. No external deps. No real Slack API calls.

import test from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeSlackMentions,
  sanitizeFilenameId,
  deliverSlackImages
} from "../src/connectors/slack.js";

// ---------------------------------------------------------------------------
// Helpers: mocks
// ---------------------------------------------------------------------------

/** Build a minimal Slack WebClient stub that records calls. */
function makeSlackClientMock(overrides = {}) {
  const calls = {
    filesUploadV2: [],
    postMessage: []
  };
  const client = {
    filesUploadV2: async (args) => {
      calls.filesUploadV2.push(args);
      if (typeof overrides.filesUploadV2 === "function") {
        return overrides.filesUploadV2(args, calls.filesUploadV2.length);
      }
      return { ok: true };
    },
    chat: {
      postMessage: async (args) => {
        calls.postMessage.push(args);
        if (typeof overrides.postMessage === "function") {
          return overrides.postMessage(args, calls.postMessage.length);
        }
        return { ok: true };
      }
    }
  };
  return { client, calls };
}

function makeImage(id, revisedPrompt) {
  return {
    id,
    buffer: Buffer.from(`pixel-bytes-${id}`),
    revisedPrompt
  };
}

// ---------------------------------------------------------------------------
// (A) sanitizeSlackMentions strips all documented mention/broadcast forms
// ---------------------------------------------------------------------------

test("(A) sanitizeSlackMentions strips all documented mention/broadcast forms", () => {
  // Broadcast tokens
  assert.equal(
    sanitizeSlackMentions("hey <!channel> everyone"),
    "hey (broadcast removed) everyone"
  );
  assert.equal(
    sanitizeSlackMentions("ping <!here|here> now"),
    "ping (broadcast removed) now"
  );
  assert.equal(
    sanitizeSlackMentions("<!everyone>"),
    "(broadcast removed)"
  );

  // User mentions
  assert.equal(
    sanitizeSlackMentions("hi <@U12345>"),
    "hi @U12345"
  );
  assert.equal(
    sanitizeSlackMentions("hi <@W67890|alice>"),
    "hi @W67890"
  );

  // Channel mentions
  assert.equal(
    sanitizeSlackMentions("see <#C99999|general>"),
    "see #C99999"
  );
  assert.equal(
    sanitizeSlackMentions("dm <#D12345>"),
    "dm #D12345"
  );

  // Usergroup (subteam) mentions
  assert.equal(
    sanitizeSlackMentions("team <!subteam^S55555|designers>"),
    "team @group-S55555"
  );

  // Plain @channel / @here / @everyone fallbacks (zero-width space inserted)
  assert.equal(
    sanitizeSlackMentions("plain @channel test"),
    "plain @\u200bchannel test"
  );
  assert.equal(
    sanitizeSlackMentions("@here @everyone"),
    "@\u200bhere @\u200beveryone"
  );

  // Combined
  const combined = sanitizeSlackMentions(
    "ping <!channel>, <@U111>, <#C222|room>, <!subteam^S333|x>, @everyone"
  );
  assert.ok(!combined.includes("<!channel>"));
  assert.ok(!combined.includes("<@U111>"));
  assert.ok(!combined.includes("<#C222"));
  assert.ok(!combined.includes("<!subteam^"));
  assert.ok(combined.includes("@\u200beveryone"));
});

// ---------------------------------------------------------------------------
// (B) sanitizeSlackMentions preserves ordinary content
// ---------------------------------------------------------------------------

test("(B) sanitizeSlackMentions preserves plain text, URLs, and emojis", () => {
  const input =
    "A cute cat with a hat. Visit https://example.com/cats?x=1 for more. 😺🐾";
  assert.equal(sanitizeSlackMentions(input), input);

  // Email addresses contain '@' but not the mention keywords, so they are
  // left alone by the plain @channel/@here/@everyone fallback rule.
  assert.equal(
    sanitizeSlackMentions("mail me at user@example.com"),
    "mail me at user@example.com"
  );

  // Non-strings are returned unchanged so callers can pass through undefined.
  assert.equal(sanitizeSlackMentions(undefined), undefined);
  assert.equal(sanitizeSlackMentions(null), null);
  assert.equal(sanitizeSlackMentions(""), "");
});

// ---------------------------------------------------------------------------
// (C) sanitizeFilenameId produces safe filenames
// ---------------------------------------------------------------------------

test("(C) sanitizeFilenameId replaces unsafe chars and handles edge cases", () => {
  assert.equal(sanitizeFilenameId("ig_abc"), "ig_abc");
  assert.equal(sanitizeFilenameId("ig_abc/123"), "ig_abc_123");
  assert.equal(sanitizeFilenameId("weird name!@#$"), "weird_name____");
  assert.equal(sanitizeFilenameId(""), "unknown");
  assert.equal(sanitizeFilenameId(undefined), "unknown");
  assert.equal(sanitizeFilenameId(null), "unknown");
  assert.equal(sanitizeFilenameId("with-hyphen_and_1"), "with-hyphen_and_1");
});

// ---------------------------------------------------------------------------
// (D) deliverSlackImages: happy path, sanitized initial_comment, correct args
// ---------------------------------------------------------------------------

test("(D) deliverSlackImages uploads each image with sanitized initial_comment and correct channel/thread/filename", async () => {
  const { client, calls } = makeSlackClientMock();
  const images = [
    makeImage("ig_abc", "관련 팀 <!channel> 고양이 <@U123>"),
    makeImage("ig_xyz/123", undefined)
  ];

  await deliverSlackImages(client, images, {
    channelId: "C999",
    threadTs: "1720000000.001",
    source: "app_mention",
    name: "testbot"
  });

  assert.equal(calls.filesUploadV2.length, 2);
  assert.equal(calls.postMessage.length, 0);

  const first = calls.filesUploadV2[0];
  assert.equal(first.channel_id, "C999");
  assert.equal(first.thread_ts, "1720000000.001");
  assert.equal(first.filename, "image-ig_abc.png");
  assert.equal(first.file, images[0].buffer);
  // Sanitized: must not contain raw mention tokens.
  assert.ok(!first.initial_comment.includes("<!channel>"));
  assert.ok(!first.initial_comment.includes("<@U123>"));
  assert.ok(first.initial_comment.includes("(broadcast removed)"));
  assert.ok(first.initial_comment.includes("@U123"));
  assert.equal(first.alt_txt, first.initial_comment);

  const second = calls.filesUploadV2[1];
  assert.equal(second.filename, "image-ig_xyz_123.png");
  // No revised prompt → initial_comment and alt_txt are undefined.
  assert.equal(second.initial_comment, undefined);
  assert.equal(second.alt_txt, undefined);
});

// ---------------------------------------------------------------------------
// (D2) deliverSlackImages passes thread_ts=undefined when not provided (DM top-level)
// ---------------------------------------------------------------------------

test("(D2) deliverSlackImages forwards thread_ts=undefined when omitted", async () => {
  const { client, calls } = makeSlackClientMock();
  await deliverSlackImages(client, [makeImage("ig_1", "a cat")], {
    channelId: "D777",
    threadTs: undefined,
    source: "message_im",
    name: "bot"
  });
  assert.equal(calls.filesUploadV2.length, 1);
  assert.equal(calls.filesUploadV2[0].thread_ts, undefined);
  assert.equal(calls.filesUploadV2[0].channel_id, "D777");
});

// ---------------------------------------------------------------------------
// (E) deliverSlackImages: upload failure path — error logged, others continue
// ---------------------------------------------------------------------------

test("(E) deliverSlackImages continues after a per-image failure and posts a fallback thread notice", async () => {
  const { client, calls } = makeSlackClientMock({
    filesUploadV2: async (_args, callIndex) => {
      if (callIndex === 1) {
        const err = new Error("boom");
        err.data = { error: "file_upload_failed" };
        throw err;
      }
      return { ok: true };
    }
  });

  const images = [
    makeImage("ig_fail", "cat"),
    makeImage("ig_ok", "dog")
  ];

  await deliverSlackImages(client, images, {
    channelId: "C100",
    threadTs: "ts.100",
    name: "bot"
  });

  // Both uploads attempted, even though the first one threw.
  assert.equal(calls.filesUploadV2.length, 2);

  // A single error notification chat.postMessage for the failed image.
  assert.equal(calls.postMessage.length, 1);
  const notice = calls.postMessage[0];
  assert.equal(notice.channel, "C100");
  assert.equal(notice.thread_ts, "ts.100");
  assert.ok(notice.text.includes("이미지 업로드 실패"));
  assert.ok(notice.text.includes("ig_fail"));
  assert.ok(notice.text.includes("file_upload_failed"));
});

// ---------------------------------------------------------------------------
// (F) No images → no upload calls (covers imageGeneration=false path)
// ---------------------------------------------------------------------------

test("(F) deliverSlackImages is a no-op for empty or missing image arrays", async () => {
  const { client, calls } = makeSlackClientMock();

  await deliverSlackImages(client, [], {
    channelId: "C1",
    threadTs: undefined
  });
  await deliverSlackImages(client, undefined, {
    channelId: "C1",
    threadTs: undefined
  });

  assert.equal(calls.filesUploadV2.length, 0);
  assert.equal(calls.postMessage.length, 0);
});

// ---------------------------------------------------------------------------
// (G) deliverSlackImages honours a custom withRetry wrapper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (E2) H-1: fallback chat.postMessage sanitizes mention tokens in image.id
//           and the reason string so a crafted model id / API error cannot
//           inject a broadcast mention through the failure notice.
// ---------------------------------------------------------------------------

test("(E2) deliverSlackImages failure fallback sanitizes id and reason against mention injection", async () => {
  const { client, calls } = makeSlackClientMock({
    filesUploadV2: async () => {
      const err = new Error("<!channel> injected via api string");
      // No err.data.error so fallback uses err.message.
      throw err;
    }
  });

  const images = [
    {
      // Crafted id containing Slack mention markup.
      id: "ig_<!channel>",
      buffer: Buffer.from("bytes"),
      revisedPrompt: "cat"
    }
  ];

  await deliverSlackImages(client, images, {
    channelId: "C100",
    threadTs: "ts.100",
    name: "bot"
  });

  assert.equal(calls.filesUploadV2.length, 1);
  assert.equal(calls.postMessage.length, 1);
  const notice = calls.postMessage[0];
  // Raw broadcast token must never appear in the rendered fallback text.
  assert.ok(
    !notice.text.includes("<!channel>"),
    `fallback leaked raw <!channel> token: ${notice.text}`
  );
  // Sanitized id should use the underscored form, and the reason string
  // should have its broadcast token neutralized.
  assert.ok(notice.text.includes("(broadcast removed)"));
  assert.ok(notice.text.includes("ig___channel_"));
  assert.equal(notice.parse, "none");
});

test("(G) deliverSlackImages wraps each upload with the provided withRetry function", async () => {
  const { client, calls } = makeSlackClientMock();
  const retryLabels = [];
  const withRetry = async (action, label) => {
    retryLabels.push(label);
    return action();
  };
  await deliverSlackImages(client, [makeImage("ig_a"), makeImage("ig_b")], {
    channelId: "C",
    threadTs: undefined,
    withRetry
  });
  assert.equal(calls.filesUploadV2.length, 2);
  assert.deepEqual(retryLabels, ["files_upload_v2", "files_upload_v2"]);
});
