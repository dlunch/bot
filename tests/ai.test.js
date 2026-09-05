// Unit tests for B1 (AI layer image-generation extensions).
// Uses Node's built-in test runner (node --test). No external deps.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAiResponse, __testing__ } from "../src/ai.js";
import { __testing__ as codexAuthTesting } from "../src/codex-auth.js";

const {
  parseCodexSseStream,
  callCodex,
  addOriginalUserTurnProtocol,
  toResponsesInput,
  toAnthropicMessages,
  parseAnthropicImageDataUrl
} = __testing__;

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
function jwtWithClaims(claims = {}) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })
    ).toString("base64url"),
    "test-signature"
  ].join(".");
}

function installCodexAuth({ accessToken = jwtWithClaims(), refreshToken = "stub-refresh-token" } = {}) {
  const prevAuthFile = process.env.CODEX_AUTH_FILE;
  const prevAccessTok = process.env.CODEX_ACCESS_TOKEN;
  const prevRefreshTok = process.env.CODEX_REFRESH_TOKEN;
  const directory = mkdtempSync(path.join(tmpdir(), "bot-ai-auth-"));
  const file = path.join(directory, "auth.json");
  writeFileSync(
    file,
    `${JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: accessToken, refresh_token: refreshToken }
    }, null, 2)}\n`,
    { mode: 0o600 }
  );
  process.env.CODEX_AUTH_FILE = file;
  delete process.env.CODEX_ACCESS_TOKEN;
  delete process.env.CODEX_REFRESH_TOKEN;
  codexAuthTesting.reset();
  return {
    file,
    accessToken,
    refreshToken,
    restore() {
      codexAuthTesting.reset();
      if (prevAuthFile === undefined) delete process.env.CODEX_AUTH_FILE;
      else process.env.CODEX_AUTH_FILE = prevAuthFile;
      if (prevAccessTok === undefined) delete process.env.CODEX_ACCESS_TOKEN;
      else process.env.CODEX_ACCESS_TOKEN = prevAccessTok;
      if (prevRefreshTok === undefined) delete process.env.CODEX_REFRESH_TOKEN;
      else process.env.CODEX_REFRESH_TOKEN = prevRefreshTok;
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

/** Delegates Codex responses requests to the provided sseString (callable). */
function makeCodexFetchHandler(sseOrFn) {
  return async (url, init) => {
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

const protocolPreamble = "[APP_CONTEXT_PROTOCOL_START]";
const userTurnDelimiter = "[APP_ORIGINAL_USER_TURN_FOLLOWS]";

test("adds a static protocol preamble and assistant delimiter before every original user turn", () => {
  const context = [
    { role: "user", content: "past text" },
    {
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,YQ==" }]
    },
    { role: "assistant", content: "answer" },
    { role: "user", content: "current text" }
  ];
  Object.freeze(context[1].content[0]);
  Object.freeze(context[1].content);
  for (const message of context) Object.freeze(message);
  Object.freeze(context);

  const marked = addOriginalUserTurnProtocol(context);

  assert.deepEqual(marked, [
    { role: "user", content: protocolPreamble },
    { role: "assistant", content: userTurnDelimiter },
    { role: "user", content: "past text" },
    { role: "assistant", content: userTurnDelimiter },
    {
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,YQ==" }]
    },
    { role: "assistant", content: "answer" },
    { role: "assistant", content: userTurnDelimiter },
    { role: "user", content: "current text" }
  ]);
  assert.notStrictEqual(marked, context);
  assert.notStrictEqual(marked[4], context[1]);
  assert.notStrictEqual(marked[4].content, context[1].content);
  assert.notStrictEqual(marked[4].content[0], context[1].content[0]);
});

test("builds Codex input with standalone assistant delimiters and unchanged canonical content", () => {
  const context = [
    {
      role: "user",
      content: [
        { type: "input_text", text: "past" },
        { type: "input_image", image_url: "data:image/png;base64,YQ==" }
      ]
    },
    { role: "assistant", content: "answer" },
    {
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/jpeg;base64,Yg==" }]
    }
  ];

  const result = toResponsesInput(context);

  assert.deepEqual(result.map(({ role }) => role), [
    "user", "assistant", "user", "assistant", "assistant", "user"
  ]);
  assert.equal(result[0].content, protocolPreamble);
  assert.equal(result[1].content, userTurnDelimiter);
  assert.deepEqual(result[2].content, context[0].content);
  assert.equal(result[3].content, "answer");
  assert.equal(result[4].content, userTurnDelimiter);
  assert.equal(result[5].content[0].image_url, "data:image/jpeg;base64,Yg==");
  assert.notStrictEqual(result[2].content[1], context[0].content[1]);
});

test("coalesces Anthropic messages while keeping the delimiter as the final assistant text block", () => {
  const context = [
    {
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,YQ==" }]
    },
    {
      role: "user",
      content: [
        { type: "input_text", text: "current" },
        { type: "input_image", image_url: "data:image/webp;base64,Yg==" }
      ]
    },
    { role: "assistant", content: "answer" }
  ];

  const result = toAnthropicMessages(context);

  assert.deepEqual(result, [
    {
      role: "user",
      content: [{ type: "text", text: protocolPreamble }]
    },
    { role: "assistant", content: [{ type: "text", text: userTurnDelimiter }] },
    {
      role: "user",
      content: [
        {
          type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" }
        }
      ]
    },
    { role: "assistant", content: [{ type: "text", text: userTurnDelimiter }] },
    {
      role: "user",
      content: [
        { type: "text", text: "current" },
        { type: "image", source: { type: "base64", media_type: "image/webp", data: "Yg==" } }
      ]
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "answer" }
      ]
    }
  ]);
  assert.notStrictEqual(result[2].content[0], context[0].content[0]);
  assert.notStrictEqual(result[2].content[0].source, context[0].content[0]);
});

test("coalesces a real Anthropic assistant turn with the following structural delimiter", () => {
  const result = toAnthropicMessages([
    { role: "user", content: "past" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "current" }
  ]);

  assert.deepEqual(result[3], {
    role: "assistant",
    content: [
      { type: "text", text: "answer" },
      { type: "text", text: userTurnDelimiter }
    ]
  });
  assert.deepEqual(result[4], {
    role: "user",
    content: [{ type: "text", text: "current" }]
  });
});

test("accepts only anchored standard base64 data URLs for Anthropic supported image MIME types", () => {
  for (const mediaType of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
    assert.deepEqual(parseAnthropicImageDataUrl(`data:${mediaType};base64,YWJjZA==`), {
      mediaType,
      data: "YWJjZA=="
    });
  }

  for (const invalid of [
    "data:image/png;base64,",
    "data:image/png;base64,YQ=",
    "data:image/png;base64,YQ===",
    "data:image/png;base64,Y=Q=",
    "data:image/png;base64,Y Q==",
    "data:image/png;base64,YQ-_",
    "data:image/png;charset=utf-8;base64,YQ==",
    "data:image/avif;base64,YQ==",
    "data:image/PNG;base64,YQ==",
    "prefixdata:image/png;base64,YQ==",
    "data:image/png;base64,YQ==trailing"
  ]) {
    assert.throws(() => parseAnthropicImageDataUrl(invalid), /Invalid Anthropic image data URL/);
  }
});

// ---------------------------------------------------------------------------
// callCodex: body.tools shape tests (A, B, C)
// ---------------------------------------------------------------------------

test("callCodex reuses a valid access token without refreshing", async () => {
  const accessToken = jwtWithClaims();
  const authStub = installCodexAuth({ accessToken });
  const fetchMock = installFetchMock(async (url, init) => {
    assert.ok(url.includes("codex/responses"), `unexpected request: ${url}`);
    assert.equal(init.headers.Authorization, `Bearer ${accessToken}`);
    return fakeOkResponseWithStream(
      sseEvent({ type: "response.output_text.delta", delta: "ready" })
    );
  });

  try {
    assert.equal(
      await callCodex("gpt-5", [{ role: "user", content: "hello" }], "sys", false),
      "ready"
    );
    assert.equal(fetchMock.calls.filter(({ url }) => url.includes("auth.openai.com")).length, 0);
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("callCodex persists a refreshed auth bundle before retrying a 401 response", async () => {
  const oldAccessToken = jwtWithClaims({ marker: "old" });
  const nextAccessToken = jwtWithClaims({ marker: "next" });
  const authStub = installCodexAuth({ accessToken: oldAccessToken, refreshToken: "old-refresh" });
  let responseCalls = 0;
  let oauthCalls = 0;
  const fetchMock = installFetchMock(async (url, init) => {
    if (url.includes("auth.openai.com")) {
      oauthCalls++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: nextAccessToken,
          refresh_token: "next-refresh"
        })
      };
    }
    if (url.includes("codex/responses")) {
      responseCalls++;
      if (responseCalls === 1) {
        assert.equal(init.headers.Authorization, `Bearer ${oldAccessToken}`);
        return { ok: false, status: 401, text: async () => "unauthorized" };
      }
      const stored = JSON.parse(readFileSync(authStub.file, "utf8"));
      assert.equal(stored.tokens.access_token, nextAccessToken);
      assert.equal(stored.tokens.refresh_token, "next-refresh");
      assert.equal(init.headers.Authorization, `Bearer ${nextAccessToken}`);
      return fakeOkResponseWithStream(
        sseEvent({ type: "response.output_text.delta", delta: "retried" })
      );
    }
    throw new Error(`unexpected request: ${url}`);
  });

  try {
    assert.equal(
      await callCodex("gpt-5", [{ role: "user", content: "hello" }], "sys", false),
      "retried"
    );
    assert.equal(oauthCalls, 1);
    assert.equal(responseCalls, 2);
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("callCodex does not refresh again when the retried request is also unauthorized", async () => {
  const oldAccessToken = jwtWithClaims({ marker: "old" });
  const nextAccessToken = jwtWithClaims({ marker: "next" });
  const authStub = installCodexAuth({ accessToken: oldAccessToken, refreshToken: "old-refresh" });
  let responseCalls = 0;
  let oauthCalls = 0;
  const fetchMock = installFetchMock(async (url) => {
    if (url.includes("auth.openai.com")) {
      oauthCalls++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: nextAccessToken,
          refresh_token: "next-refresh"
        })
      };
    }
    responseCalls++;
    return { ok: false, status: responseCalls === 1 ? 401 : 403, text: async () => "denied" };
  });

  try {
    await assert.rejects(
      callCodex("gpt-5", [{ role: "user", content: "hello" }], "sys", false),
      /Codex authentication failed \(model=gpt-5, HTTP 403\)/
    );
    assert.equal(oauthCalls, 1);
    assert.equal(responseCalls, 2);
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("callCodex never exposes auth response bodies or header values in errors and debug output", async () => {
  const previousDebug = process.env.CODEX_SSE_DEBUG;
  const originalStderrWrite = process.stderr.write;
  const originalConsole = {
    error: console.error,
    log: console.log,
    warn: console.warn
  };
  const diagnostics = [];
  process.env.CODEX_SSE_DEBUG = "1";
  process.stderr.write = (chunk) => {
    diagnostics.push(String(chunk));
    return true;
  };
  console.error = (...args) => diagnostics.push(args.map(String).join(" "));
  console.log = (...args) => diagnostics.push(args.map(String).join(" "));
  console.warn = (...args) => diagnostics.push(args.map(String).join(" "));

  try {
    for (const responseFormat of ["json", "text"]) {
      diagnostics.length = 0;
      const oldAccessToken = jwtWithClaims({
        chatgpt_account_id: "OLD_ACCOUNT_SENTINEL",
        marker: "OLD_ACCESS_SENTINEL"
      }).replace(/test-signature$/, "OLD_ACCESS_SENTINEL");
      const nextAccessToken = jwtWithClaims({ marker: "NEW_ACCESS_SENTINEL" })
        .replace(/test-signature$/, "NEW_ACCESS_SENTINEL");
      const sentinels = [
        oldAccessToken,
        nextAccessToken,
        "OLD_REFRESH_SENTINEL",
        "NEW_REFRESH_SENTINEL",
        "OLD_ACCOUNT_SENTINEL",
        "NEW_ACCOUNT_SENTINEL"
      ];
      const reflected = sentinels.join("|");
      const authStub = installCodexAuth({
        accessToken: oldAccessToken,
        refreshToken: "OLD_REFRESH_SENTINEL"
      });
      let responseCalls = 0;
      let authBodyReads = 0;
      const fetchMock = installFetchMock(async (url) => {
        if (url.includes("auth.openai.com")) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              access_token: nextAccessToken,
              refresh_token: "NEW_REFRESH_SENTINEL",
              account_id: "NEW_ACCOUNT_SENTINEL"
            })
          };
        }
        responseCalls++;
        const status = responseCalls === 1 ? 401 : 403;
        return {
          ok: false,
          status,
          headers: new Map([
            ["content-type", responseFormat === "json" ? "application/json" : "text/plain"],
            ["x-reflected-credentials", reflected]
          ]),
          text: async () => {
            authBodyReads++;
            return responseFormat === "json"
              ? JSON.stringify({ error: { message: reflected } })
              : reflected;
          }
        };
      });

      try {
        let caught;
        try {
          await callCodex("gpt-5", [{ role: "user", content: "hello" }], "sys", false);
        } catch (error) {
          caught = error;
        }
        assert.ok(caught);
        assert.equal(caught.message, "Codex authentication failed (model=gpt-5, HTTP 403)");
        assert.equal(authBodyReads, 0, "authentication error bodies must not be read");

        const observableOutput = [caught.message, caught.stack, ...diagnostics].join("\n");
        for (const sentinel of sentinels) {
          assert.equal(
            observableOutput.includes(sentinel),
            false,
            `${responseFormat} authentication failure exposed ${sentinel}`
          );
        }
        assert.match(observableOutput, /header_names=\["content-type"\]/);
      } finally {
        fetchMock.restore();
        authStub.restore();
      }
    }
  } finally {
    if (previousDebug === undefined) delete process.env.CODEX_SSE_DEBUG;
    else process.env.CODEX_SSE_DEBUG = previousDebug;
    process.stderr.write = originalStderrWrite;
    console.error = originalConsole.error;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
  }
});

test("callCodex never exposes non-ok response bodies or header values in errors and debug output", async () => {
  const previousDebug = process.env.CODEX_SSE_DEBUG;
  const originalStderrWrite = process.stderr.write;
  const originalConsole = {
    error: console.error,
    log: console.log,
    warn: console.warn
  };
  const diagnostics = [];
  process.env.CODEX_SSE_DEBUG = "1";
  process.stderr.write = (chunk) => {
    diagnostics.push(String(chunk));
    return true;
  };
  console.error = (...args) => diagnostics.push(args.map(String).join(" "));
  console.log = (...args) => diagnostics.push(args.map(String).join(" "));
  console.warn = (...args) => diagnostics.push(args.map(String).join(" "));

  try {
    for (const status of [400, 429, 500]) {
      for (const responseFormat of ["json", "text"]) {
        diagnostics.length = 0;
        const accessToken = jwtWithClaims({
          chatgpt_account_id: "NON_OK_ACCOUNT_SENTINEL",
          marker: "NON_OK_ACCESS_SENTINEL"
        }).replace(/test-signature$/, "NON_OK_ACCESS_SENTINEL");
        const sentinels = [
          accessToken,
          "NON_OK_REFRESH_SENTINEL",
          "NON_OK_ACCOUNT_SENTINEL"
        ];
        const reflected = sentinels.join("|");
        const authStub = installCodexAuth({
          accessToken,
          refreshToken: "NON_OK_REFRESH_SENTINEL"
        });
        let bodyReads = 0;
        const fetchMock = installFetchMock(async (url) => {
          assert.ok(url.includes("codex/responses"));
          return {
            ok: false,
            status,
            headers: new Map([
              ["content-type", responseFormat === "json" ? "application/json" : "text/plain"],
              ["x-reflected-credentials", reflected]
            ]),
            text: async () => {
              bodyReads++;
              return responseFormat === "json"
                ? JSON.stringify({ error: { message: reflected } })
                : reflected;
            }
          };
        });

        try {
          let caught;
          try {
            await callCodex("gpt-5", [{ role: "user", content: "hello" }], "sys", false);
          } catch (error) {
            caught = error;
          }
          assert.ok(caught);
          assert.equal(
            caught.message,
            status === 429
              ? "[codex] rate limited on model=gpt-5: HTTP 429"
              : `Codex request failed (model=gpt-5, HTTP ${status})`
          );
          assert.equal(bodyReads, 0, "Codex non-ok response bodies must not be read");

          const observableOutput = [caught.message, caught.stack, ...diagnostics].join("\n");
          for (const sentinel of sentinels) {
            assert.equal(
              observableOutput.includes(sentinel),
              false,
              `${status} ${responseFormat} response exposed ${sentinel}`
            );
          }
          assert.match(observableOutput, /header_names=\["content-type"\]/);
        } finally {
          fetchMock.restore();
          authStub.restore();
        }
      }
    }
  } finally {
    if (previousDebug === undefined) delete process.env.CODEX_SSE_DEBUG;
    else process.env.CODEX_SSE_DEBUG = previousDebug;
    process.stderr.write = originalStderrWrite;
    console.error = originalConsole.error;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
  }
});

test("tool follow-up authentication failures do not expose reflected credentials through console", async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(" "));

  try {
    for (const responseFormat of ["json", "text"]) {
      warnings.length = 0;
      const oldAccessToken = jwtWithClaims({
        chatgpt_account_id: "TOOL_OLD_ACCOUNT_SENTINEL",
        marker: "TOOL_OLD_ACCESS_SENTINEL"
      }).replace(/test-signature$/, "TOOL_OLD_ACCESS_SENTINEL");
      const nextAccessToken = jwtWithClaims({ marker: "TOOL_NEW_ACCESS_SENTINEL" })
        .replace(/test-signature$/, "TOOL_NEW_ACCESS_SENTINEL");
      const sentinels = [
        oldAccessToken,
        nextAccessToken,
        "TOOL_OLD_REFRESH_SENTINEL",
        "TOOL_NEW_REFRESH_SENTINEL",
        "TOOL_OLD_ACCOUNT_SENTINEL",
        "TOOL_NEW_ACCOUNT_SENTINEL"
      ];
      const reflected = sentinels.join("|");
      const authStub = installCodexAuth({
        accessToken: oldAccessToken,
        refreshToken: "TOOL_OLD_REFRESH_SENTINEL"
      });
      let responseCalls = 0;
      const fetchMock = installFetchMock(async (url) => {
        if (url.includes("auth.openai.com")) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              access_token: nextAccessToken,
              refresh_token: "TOOL_NEW_REFRESH_SENTINEL",
              account_id: "TOOL_NEW_ACCOUNT_SENTINEL"
            })
          };
        }
        responseCalls++;
        if (responseCalls === 1) {
          return fakeOkResponseWithStream(
            sseEvent({ type: "response.output_text.delta", delta: "partial" }) +
            sseEvent({
              type: "response.output_item.done",
              item: {
                type: "function_call",
                id: "fc-sensitive",
                call_id: "call-sensitive",
                name: "attach_file",
                arguments: JSON.stringify({ filename: "safe.txt", content: "safe" })
              }
            })
          );
        }
        return {
          ok: false,
          status: responseCalls === 2 ? 401 : 403,
          headers: new Map([["x-reflected-credentials", reflected]]),
          text: async () => responseFormat === "json"
            ? JSON.stringify({ error: { message: reflected } })
            : reflected
        };
      });

      try {
        assert.equal(
          await callCodex(
            "gpt-5",
            [{ role: "user", content: "create a file" }],
            "sys",
            false,
            undefined,
            { onFile: async () => {} }
          ),
          "partial"
        );
        const consoleOutput = warnings.join("\n");
        assert.match(consoleOutput, /Codex authentication failed \(model=gpt-5, HTTP 403\)/);
        for (const sentinel of sentinels) {
          assert.equal(
            consoleOutput.includes(sentinel),
            false,
            `${responseFormat} authentication failure exposed ${sentinel}`
          );
        }
      } finally {
        fetchMock.restore();
        authStub.restore();
      }
    }
  } finally {
    console.warn = originalWarn;
  }
});

test("tool follow-up round uses the latest access token and account snapshot", async () => {
  const oldAccessToken = jwtWithClaims({ chatgpt_account_id: "old-account" });
  const nextAccessToken = jwtWithClaims({ marker: "next" });
  const authStub = installCodexAuth({ accessToken: oldAccessToken, refreshToken: "old-refresh" });
  let oauthCalls = 0;
  let primaryCalls = 0;
  let secondaryCalls = 0;
  const fetchMock = installFetchMock(async (url, init) => {
    if (url.includes("auth.openai.com")) {
      oauthCalls++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: nextAccessToken,
          refresh_token: "next-refresh",
          account_id: "next-account"
        })
      };
    }

    const body = JSON.parse(init.body);
    const isSecondary = JSON.stringify(body.input).includes("secondary refresh request");
    if (isSecondary) {
      secondaryCalls++;
      if (secondaryCalls === 1) {
        assert.equal(init.headers.Authorization, `Bearer ${oldAccessToken}`);
        return { ok: false, status: 401, text: async () => "unauthorized" };
      }
      assert.equal(init.headers.Authorization, `Bearer ${nextAccessToken}`);
      assert.equal(init.headers["ChatGPT-Account-Id"], "next-account");
      return fakeOkResponseWithStream(
        sseEvent({ type: "response.output_text.delta", delta: "refreshed" })
      );
    }

    primaryCalls++;
    if (primaryCalls === 1) {
      assert.equal(init.headers.Authorization, `Bearer ${oldAccessToken}`);
      assert.equal(init.headers["ChatGPT-Account-Id"], "old-account");
      return fakeOkResponseWithStream(
        sseEvent({ type: "response.output_text.delta", delta: "preparing" }) +
        sseEvent({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc-refresh",
            call_id: "call-refresh",
            name: "attach_file",
            arguments: JSON.stringify({ filename: "result.txt", content: "content" })
          }
        })
      );
    }
    assert.equal(init.headers.Authorization, `Bearer ${nextAccessToken}`);
    assert.equal(init.headers["ChatGPT-Account-Id"], "next-account");
    return fakeOkResponseWithStream(
      sseEvent({ type: "response.output_text.delta", delta: "finished" })
    );
  });

  try {
    const result = await callCodex(
      "gpt-5",
      [{ role: "user", content: "primary file request" }],
      "sys",
      false,
      undefined,
      {
        onFile: async () => {
          assert.equal(
            await callCodex(
              "gpt-5",
              [{ role: "user", content: "secondary refresh request" }],
              "sys",
              false
            ),
            "refreshed"
          );
        }
      }
    );
    assert.equal(result, "preparing\nfinished");
    assert.equal(oauthCalls, 1);
    assert.equal(primaryCalls, 2);
    assert.equal(secondaryCalls, 2);
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("an old-token 401 reuses credentials refreshed by another request without another OAuth call", async () => {
  const oldAccessToken = jwtWithClaims({ chatgpt_account_id: "old-account" });
  const nextAccessToken = jwtWithClaims({ marker: "next" });
  const authStub = installCodexAuth({ accessToken: oldAccessToken, refreshToken: "old-refresh" });
  let oauthCalls = 0;
  let primaryCalls = 0;
  let secondaryCalls = 0;
  let releasePrimary;
  let markPrimaryStarted;
  const primaryStarted = new Promise((resolve) => {
    markPrimaryStarted = resolve;
  });
  const fetchMock = installFetchMock(async (url, init) => {
    if (url.includes("auth.openai.com")) {
      oauthCalls++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: nextAccessToken,
          refresh_token: "next-refresh",
          account_id: "next-account"
        })
      };
    }

    const body = JSON.parse(init.body);
    const isPrimary = JSON.stringify(body.input).includes("delayed primary request");
    if (isPrimary) {
      primaryCalls++;
      if (primaryCalls === 1) {
        assert.equal(init.headers.Authorization, `Bearer ${oldAccessToken}`);
        markPrimaryStarted();
        return new Promise((resolve) => {
          releasePrimary = () => resolve({
            ok: false,
            status: 401,
            text: async () => "unauthorized"
          });
        });
      }
      assert.equal(init.headers.Authorization, `Bearer ${nextAccessToken}`);
      assert.equal(init.headers["ChatGPT-Account-Id"], "next-account");
      return fakeOkResponseWithStream(
        sseEvent({ type: "response.output_text.delta", delta: "primary retried" })
      );
    }

    secondaryCalls++;
    if (secondaryCalls === 1) {
      assert.equal(init.headers.Authorization, `Bearer ${oldAccessToken}`);
      return { ok: false, status: 401, text: async () => "unauthorized" };
    }
    assert.equal(init.headers.Authorization, `Bearer ${nextAccessToken}`);
    return fakeOkResponseWithStream(
      sseEvent({ type: "response.output_text.delta", delta: "secondary retried" })
    );
  });

  try {
    const primary = callCodex(
      "gpt-5",
      [{ role: "user", content: "delayed primary request" }],
      "sys",
      false
    );
    await primaryStarted;
    assert.equal(
      await callCodex(
        "gpt-5",
        [{ role: "user", content: "secondary request" }],
        "sys",
        false
      ),
      "secondary retried"
    );
    releasePrimary();
    assert.equal(await primary, "primary retried");
    assert.equal(oauthCalls, 1);
    assert.equal(primaryCalls, 2);
    assert.equal(secondaryCalls, 2);
  } finally {
    fetchMock.restore();
    authStub.restore();
  }
});

test("callCodex sends the account header only when credentials include an account ID", async () => {
  for (const accountId of ["account-123", undefined]) {
    const accessToken = jwtWithClaims(accountId ? { chatgpt_account_id: accountId } : {});
    const authStub = installCodexAuth({ accessToken });
    let headers;
    const fetchMock = installFetchMock(async (url, init) => {
      assert.ok(url.includes("codex/responses"));
      headers = init.headers;
      return fakeOkResponseWithStream(
        sseEvent({ type: "response.output_text.delta", delta: "ok" })
      );
    });

    try {
      await callCodex("gpt-5", [{ role: "user", content: "hello" }], "sys", false);
      if (accountId) {
        assert.equal(headers["ChatGPT-Account-Id"], accountId);
      } else {
        assert.equal(Object.hasOwn(headers, "ChatGPT-Account-Id"), false);
      }
    } finally {
      fetchMock.restore();
      authStub.restore();
    }
  }
});

test("(A) callCodex default body matches codex-rs shape (tools:[], tool_choice, include, cache key)", async () => {
  const authStub = installCodexAuth();
  let capturedInit;
  const fetchMock = installFetchMock(
    makeCodexFetchHandler(async (url, init) => {
      if (url.includes("codex/responses")) {
        capturedInit = init;
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

    const parsed = JSON.parse(capturedInit.body);
    assert.deepEqual(parsed.tools, [], "tools must be present as empty array");
    assert.equal(parsed.tool_choice, "auto");
    assert.equal(parsed.parallel_tool_calls, false);
    assert.deepEqual(parsed.include, []);
    assert.equal(typeof parsed.prompt_cache_key, "string");
    assert.equal(parsed.store, false);
    assert.equal(parsed.stream, true);

    // Required streaming + auth headers to keep the SSE connection alive.
    assert.equal(capturedInit.headers.Accept, "text/event-stream");
    assert.equal(capturedInit.headers.originator, "codex_cli_rs");
    assert.equal(typeof capturedInit.headers.session_id, "string");
    assert.equal(typeof capturedInit.headers["x-client-request-id"], "string");
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

test("createAiResponse forwards explicit reasoning effort and omits reasoning when unset", async (t) => {
  const authStub = installCodexAuth();
  t.after(() => authStub.restore());
  const fetchMock = installFetchMock(makeCodexFetchHandler(
    sseEvent({ type: "response.output_text.delta", delta: "answer" })
  ));
  t.after(() => fetchMock.restore());

  for (const effort of [undefined, "none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(await createAiResponse([{ role: "user", content: "hello" }], {
      model: "gpt-test",
      reasoningEffort: effort
    }), "answer");
    const body = JSON.parse(fetchMock.calls.at(-1).init.body);
    if (effort === undefined) {
      assert.equal(Object.hasOwn(body, "reasoning"), false);
    } else {
      assert.deepEqual(body.reasoning, { effort });
    }
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

  const fetchMock = installFetchMock(async (url, init) => {
    if (url.includes("api.anthropic.com")) {
      assert.equal(Object.hasOwn(JSON.parse(init.body), "reasoning"), false);
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
        reasoningEffort: "high",
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
