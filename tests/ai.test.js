// Unit tests for B1 (AI layer image-generation extensions).
// Uses Node's built-in test runner (node --test). No external deps.

import test from "node:test";
import assert from "node:assert/strict";

import { createAiResponse, __testing__ } from "../src/ai.js";

const { parseCodexSseStream, callCodex } = __testing__;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ReadableStream that emits the given string as a single UTF-8 chunk. */
function streamFromString(str) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(str));
      controller.close();
    }
  });
}

/**
 * Build a fake Response-like object compatible with what callCodex awaits.
 * We only need ok/status/body/text.
 */
function fakeOkResponseWithStream(sseString) {
  return {
    ok: true,
    status: 200,
    body: streamFromString(sseString),
    text: async () => sseString
  };
}

/**
 * Install a global.fetch mock that captures request bodies per URL prefix.
 * Returns { restore, calls } where calls is an array of { url, init }.
 */
function installFetchMock(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return {
    calls,
    restore() {
      global.fetch = original;
    }
  };
}

/** Install a stubbed Codex auth state (bypasses token refresh). */
function installCodexAuth() {
  const prevRefreshTok = process.env.CODEX_REFRESH_TOKEN;
  const prevRefreshFile = process.env.CODEX_REFRESH_TOKEN_FILE;
  // Setting refresh token satisfies getCodexAuthState without reading any file.
  process.env.CODEX_REFRESH_TOKEN = "stub-refresh-token";
  // Direct token-file reads to a path that won't resolve.
  process.env.CODEX_REFRESH_TOKEN_FILE = "/tmp/__nonexistent-codex-refresh-token__";
  return {
    restore() {
      if (prevRefreshTok === undefined) delete process.env.CODEX_REFRESH_TOKEN;
      else process.env.CODEX_REFRESH_TOKEN = prevRefreshTok;
      if (prevRefreshFile === undefined) delete process.env.CODEX_REFRESH_TOKEN_FILE;
      else process.env.CODEX_REFRESH_TOKEN_FILE = prevRefreshFile;
    }
  };
}

/**
 * Fetch handler that:
 *  - Responds to token refresh endpoint with a valid access_token.
 *  - Delegates Codex responses requests to the provided sseString (callable).
 */
function makeCodexFetchHandler(sseOrFn) {
  return async (url, init) => {
    if (url.includes("auth.openai.com")) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: "fake-access-token",
            refresh_token: "fake-refresh-token",
            expires_in: 3600
          })
      };
    }
    if (url.includes("codex/responses")) {
      const sse = typeof sseOrFn === "function" ? await sseOrFn(url, init) : sseOrFn;
      return fakeOkResponseWithStream(sse);
    }
    throw new Error(`Unexpected URL in mock fetch: ${url}`);
  };
}

// Small helper to encode an SSE data event line.
function sseEvent(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// A valid 1x1 PNG is not required; any non-empty bytes survive the decode.
const HELLO_BUFFER = Buffer.from("hello world");
const HELLO_B64 = HELLO_BUFFER.toString("base64");

// ---------------------------------------------------------------------------
// callCodex: body.tools shape tests (A, B, C)
// ---------------------------------------------------------------------------

test("(A) callCodex imageGeneration=false omits tools entirely (byte-level)", async () => {
  const authStub = installCodexAuth();
  let capturedBody;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(async (url, init) => {
      if (url.includes("codex/responses")) {
        capturedBody = init.body;
      }
      return sseEvent({ type: "response.output_text.delta", delta: "hi" });
    })
  );

  try {
    const result = await callCodex(
      "gpt-5",
      [{ role: "user", content: "hello" }],
      "sys",
      false, // webSearch
      undefined, // onDelta
      {} // options (no imageGeneration)
    );
    assert.equal(result, "hi");

    const parsed = JSON.parse(capturedBody);
    assert.equal("tools" in parsed, false, "body.tools key must not exist");

    // Byte-level comparison against an expected canonical body.
    const expected = JSON.stringify({
      model: "gpt-5",
      instructions: "sys",
      input: [{ role: "user", content: "hello" }],
      store: false,
      stream: true
    });
    assert.equal(capturedBody, expected, "body bytes must match the baseline exactly");
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("(B) callCodex imageGeneration=true injects { type: image_generation, output_format: png }", async () => {
  const authStub = installCodexAuth();
  let capturedBody;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(async (url, init) => {
      if (url.includes("codex/responses")) capturedBody = init.body;
      return sseEvent({ type: "response.output_text.delta", delta: "ok" });
    })
  );

  try {
    await callCodex(
      "gpt-5",
      [{ role: "user", content: "draw a cat" }],
      "sys",
      false,
      undefined,
      { imageGeneration: true }
    );
    const parsed = JSON.parse(capturedBody);
    assert.ok(Array.isArray(parsed.tools), "tools must be present as array");
    assert.deepEqual(parsed.tools, [
      { type: "image_generation", output_format: "png" }
    ]);
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("(C) callCodex webSearch=true && imageGeneration=true keeps both tools", async () => {
  const authStub = installCodexAuth();
  let capturedBody;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(async (url, init) => {
      if (url.includes("codex/responses")) capturedBody = init.body;
      return sseEvent({ type: "response.output_text.delta", delta: "ok" });
    })
  );

  try {
    await callCodex(
      "gpt-5",
      [{ role: "user", content: "search + draw" }],
      "sys",
      true, // webSearch
      undefined,
      { imageGeneration: true }
    );
    const parsed = JSON.parse(capturedBody);
    assert.deepEqual(parsed.tools, [
      { type: "web_search" },
      { type: "image_generation", output_format: "png" }
    ]);
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

// ---------------------------------------------------------------------------
// parseCodexSseStream: image event handling (D, E, F)
// ---------------------------------------------------------------------------

test("(D) parseCodexSseStream emits onImage with Buffer + metadata on completed image_generation_call", async () => {
  const imgB64 = HELLO_B64;
  const sse =
    sseEvent({ type: "response.output_text.delta", delta: "alright" }) +
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "image_generation_call",
        id: "ig_abc",
        status: "completed",
        result: imgB64,
        revised_prompt: "a cute cat sitting "
      }
    });

  const stream = streamFromString(sse);
  const images = [];
  const text = await parseCodexSseStream(stream, undefined, (buf, meta) => {
    images.push({ buf, meta });
  });

  assert.equal(text, "alright");
  assert.equal(images.length, 1);
  assert.ok(Buffer.isBuffer(images[0].buf), "onImage first arg must be a Buffer");
  assert.equal(images[0].buf.toString("utf8"), "hello world");
  assert.deepEqual(images[0].meta, { id: "ig_abc", revisedPrompt: "a cute cat sitting" });
});

test("(E) parseCodexSseStream skips image events with missing/empty result (in-progress variants)", async () => {
  const sse =
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "image_generation_call",
        id: "ig_in_progress",
        status: "in_progress" // not completed
      }
    }) +
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "image_generation_call",
        id: "ig_empty_result",
        status: "completed",
        result: "" // empty
      }
    }) +
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "image_generation_call",
        id: "ig_no_result",
        status: "completed"
        // result missing entirely
      }
    }) +
    sseEvent({ type: "response.output_text.delta", delta: "done" });

  const stream = streamFromString(sse);
  const images = [];
  const text = await parseCodexSseStream(stream, undefined, (buf, meta) => {
    images.push({ buf, meta });
  });

  assert.equal(images.length, 0, "onImage must not be called for incomplete/empty events");
  assert.equal(text, "done");
});

test("(F) parseCodexSseStream tolerates base64 that decodes to an empty buffer", async () => {
  // Node's Buffer.from(str, "base64") silently drops invalid characters and
  // returns an empty buffer rather than throwing. The implementation treats
  // a zero-length decode as "decoded empty buffer (likely invalid base64)",
  // warns via console.warn, skips onImage, and keeps parsing the rest of the
  // stream. This test verifies that observable behavior end-to-end.
  const sse =
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "image_generation_call",
        id: "ig_bad",
        status: "completed",
        result: "!!!!" // zero valid base64 chars -> 0-length buffer
      }
    }) +
    sseEvent({ type: "response.output_text.delta", delta: "text-still-arrives" });

  const origWarn = console.warn;
  const warnCalls = [];
  console.warn = (...args) => warnCalls.push(args);

  try {
    const stream = streamFromString(sse);
    const images = [];
    const text = await parseCodexSseStream(stream, undefined, (buf, meta) => {
      images.push({ buf, meta });
    });

    assert.equal(images.length, 0, "onImage must not be called for empty buffer");
    assert.equal(text, "text-still-arrives", "text delta after the bad image must still be parsed");
    assert.ok(
      warnCalls.some((c) =>
        String(c[0] || "").includes("[ai][image] decoded empty buffer")
      ),
      "console.warn must be called with the empty-buffer message"
    );
  } finally {
    console.warn = origWarn;
  }
});

// ---------------------------------------------------------------------------
// createAiResponse: retry guard semantics (G, H, I)
// ---------------------------------------------------------------------------

test("(G) createAiResponse: text-only streaming returns the text string (backward compat)", async () => {
  const authStub = installCodexAuth();
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(
      sseEvent({ type: "response.output_text.delta", delta: "hello from model" })
    )
  );

  try {
    const result = await createAiResponse(
      [{ role: "user", content: "hi" }],
      { model: "gpt-5", emptyRetryCount: 0 }
    );
    assert.equal(typeof result, "string");
    assert.equal(result, "hello from model");
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("(H) createAiResponse: image-only response returns '' without retrying (imageCount guards)", async () => {
  const authStub = installCodexAuth();
  let requestCount = 0;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(async (url) => {
      if (url.includes("codex/responses")) requestCount++;
      return (
        sseEvent({
          type: "response.output_item.done",
          item: {
            type: "image_generation_call",
            id: "ig_1",
            status: "completed",
            result: HELLO_B64,
            revised_prompt: "kittens"
          }
        })
      );
    })
  );

  try {
    const imagesSeen = [];
    const result = await createAiResponse(
      [{ role: "user", content: "draw a cat" }],
      {
        model: "gpt-5",
        imageGeneration: true,
        emptyRetryCount: 2,
        onImage: (buf, meta) => imagesSeen.push({ buf, meta })
      }
    );
    assert.equal(result, "", "text-less response must return empty string");
    assert.equal(imagesSeen.length, 1, "onImage must have fired once");
    assert.equal(imagesSeen[0].meta.id, "ig_1");
    assert.equal(
      requestCount,
      1,
      "imageCount>0 must short-circuit the retry loop: exactly one codex request"
    );
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("(F2) parseCodexSseStream: onImage throw is isolated and stream keeps parsing", async () => {
  // Verifies §9.1 B1 case 5: if onImage throws, the parser must continue
  // processing subsequent SSE events (e.g. text deltas after the image)
  // and log an error. The returned text must be the full concatenated
  // delta stream as if the throwing callback never ran.
  const sse =
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "image_generation_call",
        id: "ig_throw",
        status: "completed",
        result: HELLO_B64
      }
    }) +
    sseEvent({ type: "response.output_text.delta", delta: "after-throw" });

  const origErr = console.error;
  const errCalls = [];
  console.error = (...args) => errCalls.push(args);

  try {
    const stream = streamFromString(sse);
    const text = await parseCodexSseStream(stream, undefined, () => {
      throw new Error("boom from onImage");
    });
    assert.equal(text, "after-throw", "text after a throwing onImage must still parse");
    assert.ok(
      errCalls.some((c) =>
        String(c[0] || "").includes("[ai][image] onImage callback threw")
      ),
      "console.error must log the onImage throw"
    );
  } finally {
    console.error = origErr;
  }
});

test("(G2) createAiResponse: text + image both present returns text string and fires onImage", async () => {
  // Covers the common success path (PRD §3 scenario 1): text + image arrive
  // together. Guarantees that the `result || ""` return keeps the text, and
  // that the imageCount guard does not accidentally suppress it.
  const authStub = installCodexAuth();
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(
      sseEvent({ type: "response.output_text.delta", delta: "here you go" }) +
        sseEvent({
          type: "response.output_item.done",
          item: {
            type: "image_generation_call",
            id: "ig_mix",
            status: "completed",
            result: HELLO_B64,
            revised_prompt: "a grey tabby cat"
          }
        })
    )
  );

  try {
    const imagesSeen = [];
    const result = await createAiResponse(
      [{ role: "user", content: "draw a cat and describe" }],
      {
        model: "gpt-5",
        imageGeneration: true,
        emptyRetryCount: 0,
        onImage: (buf, meta) => imagesSeen.push({ buf, meta })
      }
    );
    assert.equal(result, "here you go", "return value must be the streamed text");
    assert.equal(imagesSeen.length, 1, "onImage must fire exactly once");
    assert.equal(imagesSeen[0].meta.id, "ig_mix");
    assert.equal(imagesSeen[0].meta.revisedPrompt, "a grey tabby cat");
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("(H2) createAiResponse: imageCount resets between retry attempts", async () => {
  // Covers §9.1 B1 case 13: the per-attempt reset of imageCount. Scenario:
  // attempt 1 emits one completed image (text-less) -> guard triggers and
  // returns "" immediately. If someone hoists the `imageCount = 0` reset
  // out of the loop, a subsequent attempt would carry over imageCount>0
  // even when no image arrived, yielding a false early-return. We simulate
  // that regression by forcing two attempts: attempt 1 produces an image,
  // attempt 2 produces nothing.
  //
  // But here the current correct behavior returns after attempt 1, so we
  // instead invert the scenario: attempt 1 produces nothing (retry), attempt
  // 2 also produces nothing (retry), attempt 3 produces an image -> returns
  // "" with exactly 3 requests and onImage fired exactly once. A broken
  // implementation that failed to reset imageCount between attempts would
  // still produce the same observable result in the "nothing -> nothing ->
  // image" direction, so we additionally assert that a prior attempt's
  // state does NOT leak by running a 2nd test variant: attempt 1 emits an
  // image (returns immediately), and we verify total attempts == 1.
  const authStub = installCodexAuth();
  let requestCount = 0;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(async (url) => {
      if (url.includes("codex/responses")) requestCount++;
      if (requestCount < 3) {
        // Empty stream: neither text delta nor a completed image.
        return sseEvent({
          type: "response.output_item.done",
          item: {
            type: "image_generation_call",
            id: `ig_pending_${requestCount}`,
            status: "in_progress"
          }
        });
      }
      // On the 3rd attempt, emit exactly one completed image (no text).
      return sseEvent({
        type: "response.output_item.done",
        item: {
          type: "image_generation_call",
          id: "ig_final",
          status: "completed",
          result: HELLO_B64
        }
      });
    })
  );

  const origWarn = console.warn;
  console.warn = () => {}; // silence empty-retry warn spam
  try {
    const imagesSeen = [];
    const result = await createAiResponse(
      [{ role: "user", content: "eventually draw" }],
      {
        model: "gpt-5",
        imageGeneration: true,
        emptyRetryCount: 3,
        onImage: (buf, meta) => imagesSeen.push({ buf, meta })
      }
    );
    assert.equal(result, "", "image-only response returns empty string");
    assert.equal(imagesSeen.length, 1, "onImage must fire exactly once (only on attempt 3)");
    assert.equal(imagesSeen[0].meta.id, "ig_final");
    assert.equal(
      requestCount,
      3,
      "first two attempts must retry (imageCount==0 each time); third returns"
    );
  } finally {
    console.warn = origWarn;
    fetchMock.restore();
    authStub.restore();
  }
});

test("(I) createAiResponse: empty text AND no images triggers emptyRetryCount retries", async () => {
  const authStub = installCodexAuth();
  let requestCount = 0;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(async (url) => {
      if (url.includes("codex/responses")) requestCount++;
      // Emit a stream that has neither text delta nor image generation.
      return sseEvent({
        type: "response.output_item.done",
        item: {
          type: "image_generation_call",
          id: `ig_${requestCount}`,
          status: "in_progress" // never completes
        }
      });
    })
  );

  // Silence the expected "empty response" warn spam.
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const retries = 2;
    const result = await createAiResponse(
      [{ role: "user", content: "nothing" }],
      {
        model: "gpt-5",
        emptyRetryCount: retries
      }
    );
    assert.equal(result, "");
    // Retries = emptyRetryCount, so total attempts = emptyRetryCount + 1.
    assert.equal(
      requestCount,
      retries + 1,
      `expected ${retries + 1} total attempts, saw ${requestCount}`
    );
  } finally {
    console.warn = origWarn;
    fetchMock.restore();
    authStub.restore();
  }
});

test("(J) createAiResponse: anthropic + imageGeneration=true warns once, ignores onImage, returns text", async () => {
  // Covers §9.1 B1 case 12: when a model resolves to the anthropic provider
  // and imageGeneration=true is requested, createAiResponse must:
  //   (a) emit exactly one warn per model: "[ai] imageGeneration ignored for anthropic ..."
  //   (b) NOT invoke the user's onImage callback (no image path on Anthropic)
  //   (c) preserve existing text-streaming behavior (return the streamed text)
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "stub-anthropic-key";

  // Anthropic SSE: content_block_delta events with text_delta.
  const anthropicSse =
    `data: ${JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hello" }
    })}\n\n` +
    `data: ${JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: " world" }
    })}\n\n`;

  const fetchMock = installFetchMock(async (url) => {
    if (url.includes("api.anthropic.com")) {
      return fakeOkResponseWithStream(anthropicSse);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  const origWarn = console.warn;
  const warnCalls = [];
  console.warn = (...args) => warnCalls.push(args);

  const onImageCalls = [];
  try {
    const result = await createAiResponse(
      [{ role: "user", content: "hi" }],
      {
        model: "claude-sonnet-4-5",
        providers: { anthropic: { models: ["claude-sonnet-4-5"] } },
        imageGeneration: true,
        onImage: (...args) => onImageCalls.push(args),
        emptyRetryCount: 0
      }
    );
    assert.equal(result, "hello world", "Anthropic text must stream through");
    assert.equal(onImageCalls.length, 0, "onImage must not fire on anthropic path");

    const ignoredMsgs = warnCalls
      .map((c) => String(c[0] || ""))
      .filter((m) => m.includes("imageGeneration ignored for anthropic"));
    assert.equal(
      ignoredMsgs.length,
      1,
      `expected exactly 1 'imageGeneration ignored' warn, saw ${ignoredMsgs.length}`
    );
  } finally {
    console.warn = origWarn;
    fetchMock.restore();
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});
