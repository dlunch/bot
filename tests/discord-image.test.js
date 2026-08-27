// Unit tests for B3 (Discord image delivery helpers).
// Uses Node's built-in test runner (node --test). No external deps.

import test from "node:test";
import assert from "node:assert/strict";

import {
  deliverDiscordImages,
  sanitizeFilenameId
} from "../src/connectors/discord.js";
import { AttachmentBuilder } from "discord.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake Discord message with a spyable channel.send. */
function makeFakeMessage({ sendImpl, inThread = false } = {}) {
  const sendCalls = [];
  const channel = {
    isThread: () => inThread,
    async send(arg) {
      sendCalls.push(arg);
      if (typeof sendImpl === "function") {
        return sendImpl(arg, sendCalls.length);
      }
      return { id: `sent-${sendCalls.length}` };
    }
  };
  return {
    id: "src-msg-1",
    channel,
    sendCalls
  };
}

/** Muted console helper to avoid cluttering test output on expected errors. */
function silenceConsole() {
  const originalError = console.error;
  const originalLog = console.log;
  const errors = [];
  const logs = [];
  console.error = (...args) => errors.push(args);
  console.log = (...args) => logs.push(args);
  return {
    errors,
    logs,
    restore() {
      console.error = originalError;
      console.log = originalLog;
    }
  };
}

// ---------------------------------------------------------------------------
// (A) sanitizeFilenameId
// ---------------------------------------------------------------------------

test("(A) sanitizeFilenameId preserves alphanumerics/underscore/hyphen and replaces everything else", () => {
  assert.equal(sanitizeFilenameId("ig_abc123"), "ig_abc123");
  assert.equal(sanitizeFilenameId("ig_abc/123"), "ig_abc_123");
  assert.equal(sanitizeFilenameId("ig abc.png"), "ig_abc_png");
  assert.equal(sanitizeFilenameId("../../evil"), "______evil");
  assert.equal(sanitizeFilenameId(""), "unknown");
  assert.equal(sanitizeFilenameId(null), "unknown");
  assert.equal(sanitizeFilenameId(undefined), "unknown");
});

// ---------------------------------------------------------------------------
// (B) deliverDiscordImages with a single image
// ---------------------------------------------------------------------------

test("(B) deliverDiscordImages with one image calls channel.send once with correct payload", async () => {
  const message = makeFakeMessage();
  const buffer = Buffer.from("fake-png-bytes");
  const images = [
    { id: "ig_abc", buffer, revisedPrompt: "a friendly cat  " }
  ];

  const silence = silenceConsole();
  try {
    await deliverDiscordImages(message, { images });
  } finally {
    silence.restore();
  }

  assert.equal(message.sendCalls.length, 1);
  const payload = message.sendCalls[0];
  // Content is the trimmed revised_prompt.
  assert.equal(payload.content, "a friendly cat");
  // allowedMentions disables every mention category.
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  // Reply points at the original message with failIfNotExists:false.
  assert.deepEqual(payload.reply, {
    messageReference: "src-msg-1",
    failIfNotExists: false
  });
  // Exactly one AttachmentBuilder with the expected filename.
  assert.equal(Array.isArray(payload.files), true);
  assert.equal(payload.files.length, 1);
  assert.ok(payload.files[0] instanceof AttachmentBuilder);
  assert.equal(payload.files[0].name, "image-ig_abc.png");
});

test("(B2) deliverDiscordImages uses empty content when revisedPrompt is missing", async () => {
  const message = makeFakeMessage();
  const buffer = Buffer.from([0, 1, 2]);
  const images = [{ id: "ig_no_prompt", buffer }];

  const silence = silenceConsole();
  try {
    await deliverDiscordImages(message, { images });
  } finally {
    silence.restore();
  }

  assert.equal(message.sendCalls.length, 1);
  assert.equal(message.sendCalls[0].content, "");
});

test("deliverDiscordImages omits reply references for thread content and embeds", async () => {
  const message = makeFakeMessage({ inThread: true });
  const images = [
    { id: "short", buffer: Buffer.from("short"), revisedPrompt: "short prompt" },
    { id: "long", buffer: Buffer.from("long"), revisedPrompt: "x".repeat(2_001) }
  ];

  const silence = silenceConsole();
  try {
    await deliverDiscordImages(message, { images });
  } finally {
    silence.restore();
  }

  assert.equal(message.sendCalls.length, 2);
  assert.equal(Object.hasOwn(message.sendCalls[0], "reply"), false);
  assert.equal(Object.hasOwn(message.sendCalls[1], "reply"), false);
  assert.equal(message.sendCalls[1].embeds.length, 1);
});

// ---------------------------------------------------------------------------
// (C) deliverDiscordImages with multiple images
// ---------------------------------------------------------------------------

test("(C) deliverDiscordImages with multiple images sends one message per image with its own prompt", async () => {
  const message = makeFakeMessage();
  const images = [
    { id: "ig_1", buffer: Buffer.from("a"), revisedPrompt: "prompt-A" },
    { id: "ig/2", buffer: Buffer.from("b"), revisedPrompt: "prompt-B" },
    { id: "ig 3", buffer: Buffer.from("c") }
  ];

  const silence = silenceConsole();
  try {
    await deliverDiscordImages(message, { images });
  } finally {
    silence.restore();
  }

  assert.equal(message.sendCalls.length, 3);

  assert.equal(message.sendCalls[0].content, "prompt-A");
  assert.equal(message.sendCalls[0].files[0].name, "image-ig_1.png");
  assert.deepEqual(message.sendCalls[0].allowedMentions, { parse: [] });

  assert.equal(message.sendCalls[1].content, "prompt-B");
  assert.equal(message.sendCalls[1].files[0].name, "image-ig_2.png");

  assert.equal(message.sendCalls[2].content, "");
  assert.equal(message.sendCalls[2].files[0].name, "image-ig_3.png");
});

// ---------------------------------------------------------------------------
// (D) per-image failure -> fallback + subsequent images still attempted
// ---------------------------------------------------------------------------

test("(D) send failure on first image posts error fallback and continues to remaining images", async () => {
  const sendCalls = [];
  const channel = {
    isThread: () => false,
    async send(arg) {
      sendCalls.push(arg);
      // First call (primary upload for image 1) throws.
      if (sendCalls.length === 1) {
        throw new Error("boom-upload");
      }
      // Subsequent calls succeed (fallback + image 2 primary).
      return { id: `sent-${sendCalls.length}` };
    }
  };
  const message = { id: "src-msg-2", channel };

  const images = [
    { id: "ig_bad", buffer: Buffer.from("x"), revisedPrompt: "first" },
    { id: "ig_ok", buffer: Buffer.from("y"), revisedPrompt: "second" }
  ];

  const silence = silenceConsole();
  try {
    await deliverDiscordImages(message, { images });
  } finally {
    silence.restore();
  }

  // 1) Primary attempt for image 1 (threw)
  // 2) Fallback error message for image 1
  // 3) Primary attempt for image 2 (succeeded)
  assert.equal(sendCalls.length, 3);

  // Fallback message carries the image id + error reason and blocks mentions.
  assert.ok(sendCalls[1].content.includes("ig_bad"));
  assert.ok(sendCalls[1].content.includes("boom-upload"));
  assert.deepEqual(sendCalls[1].allowedMentions, { parse: [] });
  // Fallback should NOT carry any files attachment.
  assert.equal(sendCalls[1].files, undefined);

  // Second image was still attempted.
  assert.equal(sendCalls[2].content, "second");
  assert.equal(sendCalls[2].files[0].name, "image-ig_ok.png");

  // The failure was logged via console.error.
  assert.ok(
    silence.errors.some((args) =>
      String(args[0] || "").includes("[discord][image_upload] failed")
    )
  );
});

// ---------------------------------------------------------------------------
// (E) No images -> no send calls
// ---------------------------------------------------------------------------

test("(E) deliverDiscordImages with empty images performs no sends", async () => {
  const message = makeFakeMessage();
  await deliverDiscordImages(message, { images: [] });
  assert.equal(message.sendCalls.length, 0);

  // Also tolerates missing `images` entirely without throwing.
  await deliverDiscordImages(message, {});
  assert.equal(message.sendCalls.length, 0);

  // Also tolerates no opts arg.
  await deliverDiscordImages(message);
  assert.equal(message.sendCalls.length, 0);
});

// ---------------------------------------------------------------------------
// (F) Missing channel.send is handled gracefully
// ---------------------------------------------------------------------------

test("(F) deliverDiscordImages logs and returns when channel.send is unavailable", async () => {
  const message = { id: "m", channel: {} };
  const silence = silenceConsole();
  try {
    await deliverDiscordImages(message, {
      images: [{ id: "ig_x", buffer: Buffer.from("x") }]
    });
  } finally {
    silence.restore();
  }
  // No throw, error logged.
  assert.ok(
    silence.errors.some((args) =>
      String(args[0] || "").includes("missing channel.send")
    )
  );
});
