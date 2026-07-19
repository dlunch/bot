// Unit tests for the attach_file tool feature (blocks B1-B4).
// Uses Node's built-in test runner (node --test). No external deps.
// Mock helpers follow the same patterns as ai.test.js (not exported there,
// so they are intentionally duplicated).

import test from "node:test";
import assert from "node:assert/strict";

import { createAiResponse, __testing__ } from "../src/ai.js";

const { sanitizeAttachmentFilename, createAttachFileHandler, callCodex, callAnthropic } = __testing__;

// ---------------------------------------------------------------------------
// Mock helpers (patterns copied from ai.test.js)
// ---------------------------------------------------------------------------

function streamFromString(str) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(str));
      controller.close();
    }
  });
}

function fakeOkResponseWithStream(sseString) {
  return {
    ok: true,
    status: 200,
    body: streamFromString(sseString),
    text: async () => sseString
  };
}

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

function installCodexAuth() {
  const prevRefreshTok = process.env.CODEX_REFRESH_TOKEN;
  const prevRefreshFile = process.env.CODEX_REFRESH_TOKEN_FILE;
  process.env.CODEX_REFRESH_TOKEN = "stub-refresh-token";
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
      const res = typeof sseOrFn === "function" ? await sseOrFn(url, init) : sseOrFn;
      return typeof res === "string" ? fakeOkResponseWithStream(res) : res;
    }
    throw new Error(`Unexpected URL in mock fetch: ${url}`);
  };
}

function installAnthropicKey() {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "stub-anthropic-key";
  return {
    restore() {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  };
}

function sseEvent(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function silenceWarn() {
  const origWarn = console.warn;
  const warnCalls = [];
  console.warn = (...args) => warnCalls.push(args);
  return { warnCalls, restore: () => (console.warn = origWarn) };
}

const HELLO_B64 = Buffer.from("hello world").toString("base64");

const reasoningItem = { type: "reasoning", id: "rs_1", encrypted_content: "ENC_BLOB", summary: [] };
const round1MessageItem = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "Here is the script." }]
};
const attachArgs = { filename: "solution.py", content: "print('hi')\n" };
const functionCallItem = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_abc",
  name: "attach_file",
  arguments: JSON.stringify(attachArgs),
  status: "completed"
};

function codexToolCallRound1Sse() {
  return (
    sseEvent({ type: "response.output_text.delta", delta: "Here is the script." }) +
    sseEvent({ type: "response.output_item.done", item: reasoningItem }) +
    sseEvent({ type: "response.output_item.done", item: round1MessageItem }) +
    // arguments deltas must be consumed by the parser, not treated as text
    sseEvent({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"filename":' }) +
    sseEvent({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: functionCallItem.arguments }) +
    sseEvent({ type: "response.output_item.done", item: functionCallItem })
  );
}

// ---------------------------------------------------------------------------
// B2: Codex tool loop
// ---------------------------------------------------------------------------

test("B2 codex: function_call round is followed up with verbatim items + function_call_output", async () => {
  const authStub = installCodexAuth();
  const bodies = [];
  const fetchMock = installFetchMock(
    makeCodexFetchHandler((url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return codexToolCallRound1Sse();
      return sseEvent({ type: "response.output_text.delta", delta: "solution.py attached." });
    })
  );

  const files = [];
  const deltas = [];
  try {
    const result = await callCodex(
      "gpt-5",
      [{ role: "user", content: "write a script" }],
      "sys",
      false,
      (delta, fullText) => deltas.push({ delta, fullText }),
      { onFile: (file) => files.push(file) }
    );

    assert.equal(bodies.length, 2, "exactly one follow-up request");

    // Round 1 request: attach_file tool registered + reasoning include set.
    assert.deepEqual(bodies[0].include, ["reasoning.encrypted_content"]);
    const fnTools = bodies[0].tools.filter((t) => t.type === "function");
    assert.equal(fnTools.length, 1);
    assert.equal(fnTools[0].name, "attach_file");

    // Round 2 input: original input + verbatim collected items + output.
    assert.deepEqual(bodies[1].input, [
      { role: "user", content: "write a script" },
      reasoningItem,
      round1MessageItem,
      functionCallItem,
      {
        type: "function_call_output",
        call_id: "call_abc",
        output: 'File "solution.py" attached and delivered to the user.'
      }
    ]);

    assert.deepEqual(files, [attachArgs]);
    assert.equal(result, "Here is the script.\nsolution.py attached.");

    // onDelta continuity: round-2 fullText continues round-1 text across the
    // round boundary with a newline separator.
    const last = deltas[deltas.length - 1];
    assert.equal(last.fullText, "Here is the script.\nsolution.py attached.");
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("B2 codex: multi-round text survives without onDelta (M-2b)", async () => {
  const authStub = installCodexAuth();
  let calls = 0;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(() => {
      calls++;
      if (calls === 1) return codexToolCallRound1Sse();
      return sseEvent({ type: "response.output_text.delta", delta: "done" });
    })
  );

  try {
    const result = await callCodex(
      "gpt-5",
      [{ role: "user", content: "go" }],
      "sys",
      false,
      undefined, // no onDelta
      { onFile: () => {} }
    );
    assert.equal(result, "Here is the script.\ndone");
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("B2 codex: delta-less round merges fallback text (M-2a)", async () => {
  const authStub = installCodexAuth();
  let calls = 0;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(() => {
      calls++;
      if (calls === 1) return codexToolCallRound1Sse();
      // Round 2: no text delta at all, only a completed response payload.
      return sseEvent({
        type: "response.completed",
        response: {
          output: [{ type: "message", content: [{ type: "output_text", text: "All done." }] }]
        }
      });
    })
  );

  try {
    const result = await callCodex(
      "gpt-5",
      [{ role: "user", content: "go" }],
      "sys",
      false,
      undefined,
      { onFile: () => {} }
    );
    assert.equal(result, "Here is the script.\nAll done.");
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("B2 codex: output_item.done message text is preserved when onFile enables collection", async () => {
  const authStub = installCodexAuth();
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(() => sseEvent({
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "msg_only",
        role: "assistant",
        content: [{ type: "output_text", text: "delta-less answer" }]
      }
    }))
  );
  try {
    const result = await callCodex(
      "gpt-5",
      [{ role: "user", content: "go" }],
      "sys",
      false,
      undefined,
      { onFile: () => {} }
    );
    assert.equal(result, "delta-less answer");
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("B2 codex: tool follow-up preserves delta-less output_item.done message text", async () => {
  const authStub = installCodexAuth();
  let calls = 0;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(() => {
      calls++;
      if (calls === 1) return codexToolCallRound1Sse();
      return sseEvent({
        type: "response.output_item.done",
        item: {
          type: "message",
          id: "msg_final",
          role: "assistant",
          content: [{ type: "output_text", text: "attached without deltas" }]
        }
      });
    })
  );
  try {
    const result = await callCodex(
      "gpt-5",
      [{ role: "user", content: "go" }],
      "sys",
      false,
      undefined,
      { onFile: () => {} }
    );
    assert.equal(result, "Here is the script.\nattached without deltas");
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("B2 codex: round-2 failure returns partial text instead of throwing (M-1)", async () => {
  const authStub = installCodexAuth();
  let calls = 0;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(() => {
      calls++;
      if (calls === 1) return codexToolCallRound1Sse();
      return { ok: false, status: 429, text: async () => '{"error":{"message":"slow down"}}' };
    })
  );

  const warn = silenceWarn();
  try {
    const files = [];
    const result = await callCodex(
      "gpt-5",
      [{ role: "user", content: "go" }],
      "sys",
      false,
      undefined,
      { onFile: (f) => files.push(f) }
    );
    assert.equal(result, "Here is the script.");
    assert.equal(files.length, 1, "file from round 1 stays delivered");
    assert.ok(
      warn.warnCalls.some((c) => String(c[0] || "").includes("follow-up round")),
      "partial-success warn must be logged"
    );
  } finally {
    warn.restore();
    fetchMock.restore();
    authStub.restore();
  }
});

test("B2 codex: round-1 429 still throws RateLimitError (fallback path intact)", async () => {
  const authStub = installCodexAuth();
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(() => ({
      ok: false,
      status: 429,
      text: async () => '{"error":{"message":"limited"}}'
    }))
  );

  try {
    await assert.rejects(
      callCodex("gpt-5", [{ role: "user", content: "go" }], "sys", false, undefined, {
        onFile: () => {}
      }),
      /rate limited/
    );
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("B2 codex: endless function_call rounds stop at the loop cap", async () => {
  const authStub = installCodexAuth();
  let calls = 0;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(() => {
      calls++;
      return sseEvent({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: `fc_${calls}`,
          call_id: `call_${calls}`,
          name: "attach_file",
          arguments: JSON.stringify({ filename: `f${calls}.txt`, content: "x" })
        }
      });
    })
  );

  const warn = silenceWarn();
  try {
    await callCodex("gpt-5", [{ role: "user", content: "go" }], "sys", false, undefined, {
      onFile: () => {}
    });
    assert.equal(calls, 6, "requests must not exceed maxToolRounds + 1");
    assert.ok(
      warn.warnCalls.some((c) => String(c[0] || "").includes("round limit")),
      "loop-cap warn must be logged"
    );
  } finally {
    warn.restore();
    fetchMock.restore();
    authStub.restore();
  }
});

test("B2 codex: without onFile the request is unchanged (no tool, empty include, single request)", async () => {
  const authStub = installCodexAuth();
  const bodies = [];
  const fetchMock = installFetchMock(
    makeCodexFetchHandler((url, init) => {
      bodies.push(JSON.parse(init.body));
      return sseEvent({ type: "response.output_text.delta", delta: "plain" });
    })
  );

  try {
    const result = await callCodex(
      "gpt-5",
      [{ role: "user", content: "hi" }],
      "sys",
      false,
      undefined,
      {}
    );
    assert.equal(result, "plain");
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0].tools, []);
    assert.deepEqual(bodies[0].include, []);
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("B2 codex: function_call and image_generation_call coexist without interference", async () => {
  const authStub = installCodexAuth();
  let calls = 0;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(() => {
      calls++;
      if (calls === 1) {
        return (
          sseEvent({
            type: "response.output_item.done",
            item: {
              type: "image_generation_call",
              id: "ig_1",
              status: "completed",
              result: HELLO_B64
            }
          }) + codexToolCallRound1Sse()
        );
      }
      return sseEvent({ type: "response.output_text.delta", delta: "both delivered" });
    })
  );

  try {
    const files = [];
    const images = [];
    const result = await callCodex(
      "gpt-5",
      [{ role: "user", content: "draw and attach" }],
      "sys",
      false,
      undefined,
      {
        imageGeneration: true,
        onImage: (buf, meta) => images.push({ buf, meta }),
        onFile: (f) => files.push(f)
      }
    );
    assert.equal(files.length, 1);
    assert.equal(images.length, 1);
    assert.equal(images[0].meta.id, "ig_1");
    assert.equal(result, "Here is the script.\nboth delivered");
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

// ---------------------------------------------------------------------------
// B1: sanitizeAttachmentFilename
// ---------------------------------------------------------------------------

test("B1 sanitize: safe filenames pass through unchanged", () => {
  assert.equal(sanitizeAttachmentFilename("solution.py"), "solution.py");
  assert.equal(sanitizeAttachmentFilename("run.sh"), "run.sh");
  assert.equal(sanitizeAttachmentFilename("My-File_v2.txt"), "My-File_v2.txt");
});

test("B1 sanitize: Unicode letters and numbers are preserved", () => {
  assert.equal(sanitizeAttachmentFilename("보고서-한글.md"), "보고서-한글.md");
  assert.equal(sanitizeAttachmentFilename("日本語-café-١٢٣.txt"), "日本語-café-١٢٣.txt");
});

test("B1 sanitize: path segments are stripped", () => {
  assert.equal(sanitizeAttachmentFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeAttachmentFilename("a/b\\c.txt"), "c.txt");
  assert.equal(sanitizeAttachmentFilename("../임시/최종-보고서.md"), "최종-보고서.md");
});

test("B1 sanitize: leading dots removed", () => {
  assert.equal(sanitizeAttachmentFilename(".env"), "env");
  assert.equal(sanitizeAttachmentFilename("..x"), "x");
});

test("B1 sanitize: control chars, spaces and mention tokens become underscores", () => {
  const out = sanitizeAttachmentFilename("a b\tc<@U123>.txt");
  assert.equal(out, "a_b_c__U123_.txt");
  assert.ok(!/[^\p{L}\p{N}._-]/u.test(out), "only whitelisted chars may remain");
  assert.equal(
    sanitizeAttachmentFilename("보고서 <@U123> <@&R456> @everyone\n😀.md"),
    "보고서___U123_____R456___everyone__.md"
  );
});

test("B1 sanitize: empty/null/dots-only fall back to attachment.txt", () => {
  assert.equal(sanitizeAttachmentFilename(""), "attachment.txt");
  assert.equal(sanitizeAttachmentFilename(null), "attachment.txt");
  assert.equal(sanitizeAttachmentFilename("..."), "attachment.txt");
});

test("B1 sanitize: long names capped at 80 chars preserving extension", () => {
  const long = `${"a".repeat(100)}.py`;
  const out = sanitizeAttachmentFilename(long);
  assert.equal(out.length, 80);
  assert.ok(out.endsWith(".py"), "extension must be preserved");

  const noExt = "b".repeat(100);
  assert.equal(sanitizeAttachmentFilename(noExt), "b".repeat(80));

  assert.equal(sanitizeAttachmentFilename("a".repeat(79)).length, 79);
  assert.equal(sanitizeAttachmentFilename("a".repeat(80)).length, 80);
  assert.equal(sanitizeAttachmentFilename("a".repeat(81)).length, 80);

  const abnormalExtension = `x.${"e".repeat(100)}`;
  assert.equal(sanitizeAttachmentFilename(abnormalExtension).length, 80);
});

test("B1 sanitize: dangerous extensions are neutralized with .txt suffix", () => {
  assert.equal(sanitizeAttachmentFilename("page.html"), "page.html.txt");
  assert.equal(sanitizeAttachmentFilename("icon.SVG"), "icon.SVG.txt");
  assert.equal(sanitizeAttachmentFilename("run.sh"), "run.sh");
  assert.equal(sanitizeAttachmentFilename("solution.py"), "solution.py");
  assert.equal(sanitizeAttachmentFilename("page.html."), "page.html.txt");
  assert.equal(sanitizeAttachmentFilename("page.SvG.."), "page.SvG.txt");
  const longDangerous = sanitizeAttachmentFilename(`${"a".repeat(100)}.html`);
  assert.equal(longDangerous.length, 80);
  assert.ok(longDangerous.endsWith(".txt"), "dangerous extension remains neutralized after capping");
});

// ---------------------------------------------------------------------------
// B1: createAttachFileHandler
// ---------------------------------------------------------------------------

test("B1 handler: object args (Anthropic path) deliver sanitized payload", async () => {
  const seen = [];
  const handler = createAttachFileHandler((file) => seen.push(file));
  const result = await handler({ filename: "../dir/solution.py", content: "print(1)" });

  assert.equal(result.isError, false);
  assert.ok(result.output.includes("solution.py"), "success output names the file");
  assert.deepEqual(seen, [{ filename: "solution.py", content: "print(1)" }]);
});

test("B1 handler: JSON string args (Codex path) are parsed and delivered", async () => {
  const seen = [];
  const handler = createAttachFileHandler((file) => seen.push(file));
  const result = await handler(JSON.stringify({ filename: "a.txt", content: "hello" }));

  assert.equal(result.isError, false);
  assert.deepEqual(seen, [{ filename: "a.txt", content: "hello" }]);
});

test("B1 handler: invalid JSON string returns isError without calling onFile", async () => {
  const seen = [];
  const handler = createAttachFileHandler((file) => seen.push(file));
  const result = await handler("{not json");

  assert.equal(result.isError, true);
  assert.equal(seen.length, 0);
});

test("B1 handler: missing filename or content returns isError", async () => {
  const seen = [];
  const handler = createAttachFileHandler((file) => seen.push(file));

  const noFilename = await handler({ content: "x" });
  const noContent = await handler({ filename: "a.txt" });
  const emptyFilename = await handler({ filename: "   ", content: "x" });

  assert.equal(noFilename.isError, true);
  assert.equal(noContent.isError, true);
  assert.equal(emptyFilename.isError, true);
  assert.equal(seen.length, 0);
});

test("B1 handler: 6th file is rejected without calling onFile", async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const seen = [];
    const handler = createAttachFileHandler((file) => seen.push(file));
    for (let i = 0; i < 5; i++) {
      const r = await handler({ filename: `f${i}.txt`, content: "x" });
      assert.equal(r.isError, false);
    }
    const sixth = await handler({ filename: "f5.txt", content: "x" });
    assert.equal(sixth.isError, true);
    assert.equal(seen.length, 5, "onFile must not fire for the 6th file");
  } finally {
    console.warn = origWarn;
  }
});

test("B1 handler: content over 1MB is rejected without calling onFile", async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const seen = [];
    const handler = createAttachFileHandler((file) => seen.push(file));
    const big = "a".repeat(1024 * 1024 + 1);
    const result = await handler({ filename: "big.txt", content: big });

    assert.equal(result.isError, true);
    assert.equal(seen.length, 0);
  } finally {
    console.warn = origWarn;
  }
});

test("B1 handler: byte limit accepts exactly 1MB and counts UTF-8 bytes", async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const seen = [];
    const exactHandler = createAttachFileHandler((file) => seen.push(file));
    const exact = await exactHandler({ filename: "exact.txt", content: "a".repeat(1024 * 1024) });
    assert.equal(exact.isError, false);
    assert.equal(seen.length, 1);

    const utf8Handler = createAttachFileHandler(() => {});
    const multibyte = await utf8Handler({
      filename: "utf8.txt",
      content: "가".repeat(Math.floor(1024 * 1024 / 3) + 1)
    });
    assert.equal(multibyte.isError, true, "multibyte input must be limited by UTF-8 bytes");
  } finally {
    console.warn = origWarn;
  }
});

test("B1 handler: onFile throw is caught and reported as isError", async () => {
  const origErr = console.error;
  console.error = () => {};
  try {
    const handler = createAttachFileHandler(() => {
      throw new Error("connector boom");
    });
    const result = await handler({ filename: "a.txt", content: "x" });
    assert.equal(result.isError, true);
  } finally {
    console.error = origErr;
  }
});

// ---------------------------------------------------------------------------
// B3: Anthropic tool loop
// ---------------------------------------------------------------------------

function anthropicToolCallRound1Sse() {
  return (
    sseEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    sseEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Attaching now." }
    }) +
    sseEvent({ type: "content_block_stop", index: 0 }) +
    sseEvent({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "attach_file" }
    }) +
    sseEvent({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"filename":"solu' }
    }) +
    sseEvent({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: 'tion.py","content"' }
    }) +
    sseEvent({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: ':"print(1)"}' }
    }) +
    sseEvent({ type: "content_block_stop", index: 1 }) +
    sseEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } })
  );
}

function makeAnthropicFetchHandler(perCall) {
  return async (url, init) => {
    if (url.includes("api.anthropic.com")) {
      const res = await perCall(url, init);
      return typeof res === "string" ? fakeOkResponseWithStream(res) : res;
    }
    throw new Error(`Unexpected URL in mock fetch: ${url}`);
  };
}

test("B3 anthropic: tool_use round is followed up with assistant blocks + tool_result", async () => {
  const keyStub = installAnthropicKey();
  const bodies = [];
  const fetchMock = installFetchMock(
    makeAnthropicFetchHandler((url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return anthropicToolCallRound1Sse();
      return (
        sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }) +
        sseEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } })
      );
    })
  );

  const files = [];
  const deltas = [];
  try {
    const result = await callAnthropic(
      "claude-sonnet-4-5",
      [{ role: "user", content: "write a script" }],
      "sys",
      (delta, fullText) => deltas.push({ delta, fullText }),
      { onFile: (f) => files.push(f) }
    );

    assert.equal(bodies.length, 2, "exactly one follow-up request");

    assert.ok(Array.isArray(bodies[0].tools), "round 1 must register tools");
    assert.equal(bodies[0].tools.length, 1);
    assert.equal(bodies[0].tools[0].name, "attach_file");
    assert.ok(bodies[0].tools[0].input_schema, "anthropic tool needs input_schema");

    assert.deepEqual(bodies[1].messages, [
      { role: "user", content: "write a script" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Attaching now." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "attach_file",
            input: { filename: "solution.py", content: "print(1)" }
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: 'File "solution.py" attached and delivered to the user.'
          }
        ]
      }
    ]);

    assert.deepEqual(files, [{ filename: "solution.py", content: "print(1)" }]);
    assert.equal(result, "Attaching now.\nDone.");
    const last = deltas[deltas.length - 1];
    assert.equal(last.fullText, "Attaching now.\nDone.", "fullText spans rounds with separator");
  } finally {
    fetchMock.restore();
    keyStub.restore();
  }
});

test("B3 anthropic: CRLF-framed tool_use stream is parsed and followed up", async () => {
  const keyStub = installAnthropicKey();
  const bodies = [];
  const fetchMock = installFetchMock(
    makeAnthropicFetchHandler((url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return anthropicToolCallRound1Sse().replaceAll("\n", "\r\n");
      return (
        sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }) +
        sseEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } })
      ).replaceAll("\n", "\r\n");
    })
  );
  try {
    const files = [];
    const result = await callAnthropic(
      "claude-sonnet-4-5",
      [{ role: "user", content: "go" }],
      "sys",
      undefined,
      { onFile: (file) => files.push(file) }
    );
    assert.equal(result, "Attaching now.\nDone.");
    assert.deepEqual(files, [{ filename: "solution.py", content: "print(1)" }]);
    assert.equal(bodies.length, 2);
  } finally {
    fetchMock.restore();
    keyStub.restore();
  }
});

test("B3 anthropic: broken partial_json produces is_error tool_result without throwing", async () => {
  const keyStub = installAnthropicKey();
  const bodies = [];
  const fetchMock = installFetchMock(
    makeAnthropicFetchHandler((url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return (
          sseEvent({
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_bad", name: "attach_file" }
          }) +
          sseEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{broken" }
          }) +
          sseEvent({ type: "content_block_stop", index: 0 }) +
          sseEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } })
        );
      }
      return (
        sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } }) +
        sseEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } })
      );
    })
  );

  try {
    const files = [];
    const result = await callAnthropic(
      "claude-sonnet-4-5",
      [{ role: "user", content: "go" }],
      "sys",
      undefined,
      { onFile: (f) => files.push(f) }
    );
    assert.equal(result, "recovered");
    assert.equal(files.length, 0, "onFile must not fire for unparseable input");
    const toolResult = bodies[1].messages[2].content[0];
    assert.equal(toolResult.type, "tool_result");
    assert.equal(toolResult.tool_use_id, "toolu_bad");
    assert.equal(toolResult.is_error, true);
  } finally {
    fetchMock.restore();
    keyStub.restore();
  }
});

test("B3 anthropic: stop_reason end_turn does not trigger a follow-up even with tool_use blocks", async () => {
  const keyStub = installAnthropicKey();
  let calls = 0;
  const fetchMock = installFetchMock(
    makeAnthropicFetchHandler(() => {
      calls++;
      return (
        sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "cut off" } }) +
        sseEvent({
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_x", name: "attach_file" }
        }) +
        sseEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } })
      );
    })
  );

  try {
    const files = [];
    const result = await callAnthropic(
      "claude-sonnet-4-5",
      [{ role: "user", content: "go" }],
      "sys",
      undefined,
      { onFile: (f) => files.push(f) }
    );
    assert.equal(result, "cut off");
    assert.equal(calls, 1, "no follow-up request");
    assert.equal(files.length, 0);
  } finally {
    fetchMock.restore();
    keyStub.restore();
  }
});

test("B3 anthropic: without onFile the request body has no tools field", async () => {
  const keyStub = installAnthropicKey();
  const bodies = [];
  const fetchMock = installFetchMock(
    makeAnthropicFetchHandler((url, init) => {
      bodies.push(JSON.parse(init.body));
      return sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "plain" } });
    })
  );

  try {
    const result = await callAnthropic(
      "claude-sonnet-4-5",
      [{ role: "user", content: "hi" }],
      "sys",
      undefined,
      {}
    );
    assert.equal(result, "plain");
    assert.equal(bodies.length, 1);
    assert.ok(!("tools" in bodies[0]), "tools must be absent without onFile");
  } finally {
    fetchMock.restore();
    keyStub.restore();
  }
});

test("B3 anthropic: round-2 failure returns partial text instead of throwing (M-1)", async () => {
  const keyStub = installAnthropicKey();
  let calls = 0;
  const fetchMock = installFetchMock(
    makeAnthropicFetchHandler(() => {
      calls++;
      if (calls === 1) return anthropicToolCallRound1Sse();
      return { ok: false, status: 500, text: async () => '{"error":{"message":"boom"}}' };
    })
  );

  const warn = silenceWarn();
  try {
    const files = [];
    const result = await callAnthropic(
      "claude-sonnet-4-5",
      [{ role: "user", content: "go" }],
      "sys",
      undefined,
      { onFile: (f) => files.push(f) }
    );
    assert.equal(result, "Attaching now.");
    assert.equal(files.length, 1, "file from round 1 stays delivered");
    assert.ok(
      warn.warnCalls.some((c) => String(c[0] || "").includes("follow-up round")),
      "partial-success warn must be logged"
    );
  } finally {
    warn.restore();
    fetchMock.restore();
    keyStub.restore();
  }
});

test("B3 anthropic: tool_use-only stream (sparse blocks) assembles follow-up without error", async () => {
  const keyStub = installAnthropicKey();
  const bodies = [];
  const fetchMock = installFetchMock(
    makeAnthropicFetchHandler((url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        // Only index 1 is populated; index 0 never receives any delta -> hole.
        return (
          sseEvent({
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_s", name: "attach_file" }
          }) +
          sseEvent({
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"filename":"a.txt","content":"x"}' }
          }) +
          sseEvent({ type: "content_block_stop", index: 1 }) +
          sseEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } })
        );
      }
      return (
        sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "attached" } }) +
        sseEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } })
      );
    })
  );

  try {
    const files = [];
    const result = await callAnthropic(
      "claude-sonnet-4-5",
      [{ role: "user", content: "go" }],
      "sys",
      undefined,
      { onFile: (f) => files.push(f) }
    );
    assert.equal(result, "attached");
    assert.equal(files.length, 1);
    assert.deepEqual(bodies[1].messages[1], {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_s",
          name: "attach_file",
          input: { filename: "a.txt", content: "x" }
        }
      ]
    });
  } finally {
    fetchMock.restore();
    keyStub.restore();
  }
});

test("B3 anthropic: non-streaming response with stop_reason tool_use returns text and warns", async () => {
  const keyStub = installAnthropicKey();
  let calls = 0;
  const fetchMock = installFetchMock(
    makeAnthropicFetchHandler(() => {
      calls++;
      return {
        ok: true,
        status: 200,
        body: null,
        text: async () =>
          JSON.stringify({
            content: [{ type: "text", text: "plain answer" }],
            stop_reason: "tool_use"
          })
      };
    })
  );

  const warn = silenceWarn();
  try {
    const result = await callAnthropic(
      "claude-sonnet-4-5",
      [{ role: "user", content: "go" }],
      "sys",
      undefined,
      { onFile: () => {} }
    );
    assert.equal(result, "plain answer");
    assert.equal(calls, 1, "no tool loop on the non-streaming path");
    assert.ok(
      warn.warnCalls.some((c) => String(c[0] || "").includes("tool_use")),
      "discarded tool_use must be warned about"
    );
  } finally {
    warn.restore();
    fetchMock.restore();
    keyStub.restore();
  }
});

// ---------------------------------------------------------------------------
// B4: createAiResponse integration
// ---------------------------------------------------------------------------

test("B4 createAiResponse: onFile appends attach_file guidance to the system prompt (codex)", async () => {
  const authStub = installCodexAuth();
  const bodies = [];
  const fetchMock = installFetchMock(
    makeCodexFetchHandler((url, init) => {
      bodies.push(JSON.parse(init.body));
      return sseEvent({ type: "response.output_text.delta", delta: "ok" });
    })
  );

  try {
    await createAiResponse([{ role: "user", content: "hi" }], {
      model: "gpt-5",
      systemPrompt: "base prompt",
      emptyRetryCount: 0,
      onFile: () => {}
    });
    assert.ok(bodies[0].instructions.startsWith("base prompt"), "original prompt kept");
    assert.ok(bodies[0].instructions.includes("attach_file"), "guidance must be appended");
    assert.ok(
      bodies[0].instructions.includes("Before calling attach_file, first write and stream"),
      "guidance must require body text before the tool call"
    );
    assert.ok(
      bodies[0].instructions.includes("create a new code deliverable") &&
        bodies[0].instructions.includes("use attach_file regardless of length") &&
        bodies[0].instructions.includes("component, a configuration file, or a complete implementation"),
      "guidance must attach code deliverables intended to be saved and used"
    );
    assert.ok(
      bodies[0].instructions.includes("code explanations, code review, debugging explanations") &&
        bodies[0].instructions.includes("API usage examples") &&
        bodies[0].instructions.includes("short illustrative snippets"),
      "guidance must keep explanations and illustrative snippets inline"
    );
    assert.ok(
      bodies[0].instructions.includes("if they explicitly request inline output") &&
        bodies[0].instructions.includes("if they explicitly request a file or download"),
      "guidance must honor explicit inline and file output requests"
    );
    assert.ok(
      !bodies[0].instructions.includes("30 lines") &&
        !bodies[0].instructions.includes("1500 characters"),
      "guidance must not use an automatic length threshold"
    );
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("B4 createAiResponse: codex announces attach_file at output_item.added once per call", async () => {
  const authStub = installCodexAuth();
  let calls = 0;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(() => {
      calls++;
      if (calls > 1) {
        return sseEvent({ type: "response.output_text.delta", delta: "done" });
      }
      return sseEvent({
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_early", call_id: "call_early", name: "attach_file" }
      }) +
      sseEvent({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_early",
          call_id: "call_early",
          name: "attach_file",
          arguments: JSON.stringify({ filename: "early.txt", content: "x" })
        }
      });
    })
  );

  try {
    const events = [];
    await createAiResponse([{ role: "user", content: "file" }], {
      model: "gpt-5",
      emptyRetryCount: 0,
      onFile: () => {},
      onFileEvent: (event) => events.push(event)
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "response.output_item.added");
    assert.equal(events[0].firstEventInAttempt, true);
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("B4 createAiResponse: anthropic announces attach_file at content_block_start", async () => {
  const keyStub = installAnthropicKey();
  let calls = 0;
  const fetchMock = installFetchMock(
    makeAnthropicFetchHandler(() => {
      calls++;
      return calls === 1
        ? anthropicToolCallRound1Sse()
        : sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }) +
          sseEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } });
    })
  );

  try {
    const events = [];
    await createAiResponse([{ role: "user", content: "file" }], {
      model: "claude-sonnet-4-5",
      providers: { anthropic: { models: ["claude-sonnet-4-5"] } },
      emptyRetryCount: 0,
      onFile: () => {},
      onFileEvent: (event) => events.push(event)
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "content_block_start");
    assert.equal(events[0].firstEventInAttempt, true);
  } finally {
    fetchMock.restore();
    keyStub.restore();
  }
});

test("B4 createAiResponse: file event firstEventInAttempt resets on empty retry", async () => {
  const authStub = installCodexAuth();
  let calls = 0;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(() => {
      calls++;
      return sseEvent({
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: `fc_retry_${calls}`,
          call_id: `call_retry_${calls}`,
          name: "attach_file"
        }
      });
    })
  );

  try {
    const events = [];
    await createAiResponse([{ role: "user", content: "file" }], {
      model: "gpt-5",
      emptyRetryCount: 1,
      onFile: () => {},
      onFileEvent: (event) => events.push(event)
    });
    assert.equal(calls, 2);
    assert.deepEqual(events.map((event) => event.firstEventInAttempt), [true, true]);
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("B4 createAiResponse: multiple file calls in one attempt mark only the first event", async () => {
  const authStub = installCodexAuth();
  let calls = 0;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(() => {
      calls++;
      if (calls > 1) {
        return sseEvent({ type: "response.output_text.delta", delta: "done" });
      }
      return ["one", "two"].map((suffix) =>
        sseEvent({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: `fc_${suffix}`,
            call_id: `call_${suffix}`,
            name: "attach_file",
            arguments: JSON.stringify({ filename: `${suffix}.txt`, content: suffix })
          }
        })
      ).join("");
    })
  );

  try {
    const events = [];
    await createAiResponse([{ role: "user", content: "two files" }], {
      model: "gpt-5",
      emptyRetryCount: 0,
      onFile: () => {},
      onFileEvent: (event) => events.push(event)
    });
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((event) => event.firstEventInAttempt), [true, false]);
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("B4 createAiResponse: without onFile the system prompt is unchanged", async () => {
  const authStub = installCodexAuth();
  const bodies = [];
  const fetchMock = installFetchMock(
    makeCodexFetchHandler((url, init) => {
      bodies.push(JSON.parse(init.body));
      return sseEvent({ type: "response.output_text.delta", delta: "ok" });
    })
  );

  try {
    await createAiResponse([{ role: "user", content: "hi" }], {
      model: "gpt-5",
      systemPrompt: "base prompt",
      emptyRetryCount: 0
    });
    assert.equal(bodies[0].instructions, "base prompt");
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("B4 createAiResponse: file-only response returns '' without empty-retry (fileCount guard)", async () => {
  const authStub = installCodexAuth();
  let calls = 0;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(() => {
      calls++;
      if (calls === 1) {
        return sseEvent({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_only",
            call_id: "call_only",
            name: "attach_file",
            arguments: JSON.stringify({ filename: "only.txt", content: "data" })
          }
        });
      }
      // Follow-up round produces neither text nor further calls.
      return sseEvent({ type: "response.completed", response: { output: [] } });
    })
  );

  try {
    const files = [];
    const result = await createAiResponse([{ role: "user", content: "file please" }], {
      model: "gpt-5",
      emptyRetryCount: 2,
      onFile: (f) => files.push(f)
    });
    assert.equal(result, "");
    assert.equal(files.length, 1);
    assert.equal(calls, 2, "fileCount>0 must suppress the empty-response retry");
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("B4 createAiResponse: codex end-to-end tool chain (file collected + follow-up text)", async () => {
  const authStub = installCodexAuth();
  let calls = 0;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(() => {
      calls++;
      if (calls === 1) return codexToolCallRound1Sse();
      return sseEvent({ type: "response.output_text.delta", delta: "attached for you" });
    })
  );

  try {
    const files = [];
    const result = await createAiResponse([{ role: "user", content: "write a script" }], {
      model: "gpt-5",
      emptyRetryCount: 0,
      onFile: (f) => files.push(f)
    });
    assert.equal(result, "Here is the script.\nattached for you");
    assert.deepEqual(files, [attachArgs]);
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("B4 createAiResponse: anthropic end-to-end tool chain via providers config", async () => {
  const keyStub = installAnthropicKey();
  const bodies = [];
  const fetchMock = installFetchMock(
    makeAnthropicFetchHandler((url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return anthropicToolCallRound1Sse();
      return (
        sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }) +
        sseEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } })
      );
    })
  );

  try {
    const files = [];
    const result = await createAiResponse([{ role: "user", content: "write a script" }], {
      model: "claude-sonnet-4-5",
      providers: { anthropic: { models: ["claude-sonnet-4-5"] } },
      systemPrompt: "base prompt",
      emptyRetryCount: 0,
      onFile: (f) => files.push(f)
    });
    assert.equal(result, "Attaching now.\nDone.");
    assert.deepEqual(files, [{ filename: "solution.py", content: "print(1)" }]);
    assert.ok(bodies[0].system.includes("attach_file"), "guidance reaches the anthropic system prompt");
  } finally {
    fetchMock.restore();
    keyStub.restore();
  }
});
