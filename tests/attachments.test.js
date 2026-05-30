// Unit tests for text-attachment context support (attachments.js).
// Uses Node's built-in test runner (node --test). No external deps.

import test from "node:test";
import assert from "node:assert/strict";

import {
  isTextLike,
  fetchTextAttachmentBlock,
  maxTextFileChars
} from "../src/connectors/attachments.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake fetch Response whose body streams `text` in small chunks. */
function makeRes({ ok = true, status = 200, text = "", chunkSize = 8 } = {}) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let cancelled = false;
  return {
    ok,
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (cancelled || offset >= bytes.length) {
              return { done: true, value: undefined };
            }
            const end = Math.min(offset + chunkSize, bytes.length);
            const value = bytes.slice(offset, end);
            offset = end;
            return { done: false, value };
          },
          cancel() {
            cancelled = true;
            return Promise.resolve();
          }
        };
      }
    },
    async text() {
      return text;
    }
  };
}

function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original;
    });
}

function silenceConsole() {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  return {
    warnings,
    restore() {
      console.warn = originalWarn;
    }
  };
}

// ---------------------------------------------------------------------------
// (A) isTextLike
// ---------------------------------------------------------------------------

test("(A) isTextLike accepts text/* and allowlisted mimes, rejects images", () => {
  assert.equal(isTextLike("a.txt", "text/plain"), true);
  assert.equal(isTextLike("a.txt", "text/plain; charset=utf-8"), true);
  assert.equal(isTextLike("data.json", "application/json"), true);
  assert.equal(isTextLike("pic.png", "image/png"), false);
  assert.equal(isTextLike("clip.mp4", "video/mp4"), false);
});

test("(A2) isTextLike falls back to filename extension when mime is missing/generic", () => {
  // Discord/Slack frequently label code files as octet-stream or omit the type.
  assert.equal(isTextLike("script.js", "application/octet-stream"), true);
  assert.equal(isTextLike("main.py", undefined), true);
  assert.equal(isTextLike("notes.md", null), true);
  assert.equal(isTextLike("blob.bin", "application/octet-stream"), false);
  assert.equal(isTextLike("photo.png", "application/octet-stream"), false);
});

test("(A3) isTextLike handles extension-less dotfiles and bare names", () => {
  assert.equal(isTextLike("Dockerfile", undefined), true);
  assert.equal(isTextLike(".gitignore", undefined), true);
  assert.equal(isTextLike("README", undefined), false);
});

// ---------------------------------------------------------------------------
// (B) fetchTextAttachmentBlock
// ---------------------------------------------------------------------------

test("(B) returns null without a url", async () => {
  const block = await fetchTextAttachmentBlock({ name: "a.txt" });
  assert.equal(block, null);
});

test("(B2) formats a small file as a labeled block", async () => {
  await withFetch(
    async () => makeRes({ text: "hello world" }),
    async () => {
      const block = await fetchTextAttachmentBlock({ url: "http://x/a.txt", name: "a.txt" });
      assert.equal(block, "[attached file: a.txt]\nhello world");
    }
  );
});

test("(B3) truncates oversized content and marks the header", async () => {
  const big = "x".repeat(maxTextFileChars + 100);
  await withFetch(
    async () => makeRes({ text: big, chunkSize: 4096 }),
    async () => {
      const block = await fetchTextAttachmentBlock({ url: "http://x/big.log", name: "big.log" });
      assert.ok(block.startsWith(`[attached file: big.log (truncated to ${maxTextFileChars} chars)]\n`));
      const body = block.slice(block.indexOf("\n") + 1);
      assert.equal(body.length, maxTextFileChars);
    }
  );
});

test("(B4) returns null on non-ok response and logs a warning", async () => {
  const silence = silenceConsole();
  try {
    await withFetch(
      async () => makeRes({ ok: false, status: 403, text: "nope" }),
      async () => {
        const block = await fetchTextAttachmentBlock({ url: "http://x/a.txt", name: "a.txt" });
        assert.equal(block, null);
      }
    );
  } finally {
    silence.restore();
  }
  assert.ok(silence.warnings.some((a) => String(a[0] || "").includes("http 403")));
});

test("(B5) returns null for empty/whitespace-only content", async () => {
  await withFetch(
    async () => makeRes({ text: "   \n\t " }),
    async () => {
      const block = await fetchTextAttachmentBlock({ url: "http://x/blank.txt", name: "blank.txt" });
      assert.equal(block, null);
    }
  );
});

test("(B6) forwards auth headers to fetch", async () => {
  let seen;
  await withFetch(
    async (_url, opts) => {
      seen = opts;
      return makeRes({ text: "ok" });
    },
    async () => {
      await fetchTextAttachmentBlock({
        url: "http://x/a.txt",
        name: "a.txt",
        headers: { Authorization: "Bearer tok" }
      });
    }
  );
  assert.deepEqual(seen, { headers: { Authorization: "Bearer tok" } });
});
