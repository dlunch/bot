import test from "node:test";
import assert from "node:assert/strict";
import SlackBolt from "@slack/bolt";
import { createAiResponse } from "../src/ai.js";

import {
  buildSlackContext,
  collectSlackDirectCandidates,
  collectSlackThreadCandidates,
  materializeSlackMessage,
  startSlackBot
} from "../src/connectors/slack.js";
import { collectRecentContext } from "../src/connectors/context.js";

function slackFiles(textCount, imageNames = []) {
  const files = [];
  for (let index = 1; index <= textCount; index++) {
    files.push({
      id: `text-${index}`,
      name: `file-${index}.txt`,
      mimetype: "text/plain",
      url_private_download: `https://files.test/text-${index}`
    });
  }
  for (const name of imageNames) {
    files.push({
      id: name,
      name: `${name}.png`,
      mimetype: "image/png",
      url_private_download: `https://files.test/${name}`
    });
  }
  return files;
}

function installSlackFileFetch(t) {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes("text-")) {
      if (url.endsWith("text-6")) {
        return new Response("x".repeat(50_100));
      }
      return new Response(`body:${url.at(-1)}`);
    }
    const bytes = url.endsWith("too-large")
      ? Buffer.alloc(5 * 1024 * 1024 + 1)
      : Buffer.from(url.split("/").at(-1));
    return { ok: true, status: 200, arrayBuffer: async () => bytes };
  };
  console.warn = () => {};
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });
  return calls;
}

async function startSlackHandlerHarness(t, fetchImpl) {
  const { App, webApi } = SlackBolt;
  const originalEvent = App.prototype.event;
  const originalError = App.prototype.error;
  const originalStart = App.prototype.start;
  const originalStop = App.prototype.stop;
  const originalApiCall = webApi.WebClient.prototype.apiCall;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalErrorLog = console.error;
  const handlers = {};
  let app;

  App.prototype.event = function registerEvent(name, handler) {
    handlers[name] = handler;
  };
  App.prototype.error = function registerError() {};
  App.prototype.start = async function start() {
    app = this;
  };
  App.prototype.stop = async function stop() {};
  webApi.WebClient.prototype.apiCall = async function apiCall(method) {
    assert.equal(method, "auth.test");
    return { user_id: "bot" };
  };
  globalThis.fetch = fetchImpl;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  const runtime = await startSlackBot(
    {
      name: "context-test",
      appToken: "xapp-test",
      botToken: "xoxb-test",
      models: ["test-model"],
      providers: { anthropic: { models: ["test-model"] } },
      webSearch: false,
      systemPrompt: "test",
      imageGeneration: false
    },
    { maxContextBytes: 200_000, slackStreamUpdateMs: 0 }
  );

  t.after(async () => {
    await runtime.stop();
    App.prototype.event = originalEvent;
    App.prototype.error = originalError;
    App.prototype.start = originalStart;
    App.prototype.stop = originalStop;
    webApi.WebClient.prototype.apiCall = originalApiCall;
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalErrorLog;
  });

  assert.ok(app);
  return handlers.message;
}

test("stops direct-message pagination after the first overflowing message", async () => {
  const event = { channel: "D1", ts: "300.000001", text: "new" };
  const calls = [];
  const candidates = collectSlackDirectCandidates(event, async (params) => {
    calls.push(params);
    if (calls.length === 1) {
      return {
        messages: [
          { ...event },
          { channel: "D1", ts: "299.000001", text: "overflow" }
        ],
        response_metadata: { next_cursor: "older" }
      };
    }
    throw new Error("the older page must not be requested");
  });

  const result = await collectRecentContext(candidates, 5, async (message) => ({
    source: message,
    role: "user",
    content: message.text
  }));

  assert.deepEqual(result.map(({ content }) => content), ["new"]);
  assert.deepEqual(calls, [{
    channel: "D1",
    limit: 200,
    latest: event.ts,
    inclusive: true,
    cursor: undefined
  }]);
});

test("consumes two direct-message pages with one fixed snapshot and chronological output", async () => {
  const event = { channel: "D1", ts: "400.000001", text: "current" };
  const staleEventCopy = { ...event, text: "stale API copy" };
  const third = { channel: "D1", ts: "300.000001", text: "third" };
  const second = { channel: "D1", ts: "200.000001", text: "second" };
  const first = { channel: "D1", ts: "100.000001", text: "first" };
  const calls = [];
  const candidates = collectSlackDirectCandidates(event, async (params) => {
    calls.push(params);
    return calls.length === 1
      ? {
          messages: [
            { channel: "D1", ts: "500.000001", text: "future" },
            staleEventCopy,
            third
          ],
          response_metadata: { next_cursor: "older" }
        }
      : {
          messages: [third, first, second],
          response_metadata: { next_cursor: "" }
        };
  });

  const result = await collectRecentContext(candidates, 1_000, async (message) => ({
    source: message,
    role: "user",
    content: message.text
  }));

  assert.deepEqual(result.map(({ content }) => content), ["first", "second", "third", "current"]);
  assert.equal(result.at(-1).source, event);
  assert.deepEqual(calls, [
    {
      channel: "D1",
      limit: 200,
      latest: event.ts,
      inclusive: true,
      cursor: undefined
    },
    {
      channel: "D1",
      limit: 200,
      latest: event.ts,
      inclusive: true,
      cursor: "older"
    }
  ]);
});

test("keeps the direct event when history loading fails", async () => {
  const event = { channel: "D1", ts: "300.000001", text: "new" };
  const errors = [];
  const collected = [];
  for await (const message of collectSlackDirectCandidates(
    event,
    async () => { throw new Error("unavailable"); },
    (...args) => errors.push(args)
  )) {
    collected.push(message);
  }

  assert.deepEqual(collected, [event]);
  assert.equal(errors.length, 1);
});

test("loads every thread metadata page and returns the current snapshot newest first", async () => {
  const event = {
    channel: "C1",
    thread_ts: "100.000001",
    ts: "400.000001",
    text: "current"
  };
  const pages = [
    {
      messages: [
        { ts: "100.000001", text: "first" },
        { ts: "200.000001", text: "second" },
        { ts: event.ts, text: "stale API copy" }
      ],
      response_metadata: { next_cursor: "page-2" }
    },
    {
      messages: [
        { ts: "300.000001", text: "third" },
        { ts: "500.000001", text: "future" }
      ],
      response_metadata: { next_cursor: "page-3" }
    },
    {
      messages: [],
      response_metadata: { next_cursor: "page-3" }
    }
  ];
  const calls = [];
  const result = await collectSlackThreadCandidates(event, async (params) => {
    calls.push(params);
    return pages[calls.length - 1];
  });

  assert.deepEqual(result.map(({ text }) => text), ["current", "third", "second", "first"]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(({ latest, inclusive, limit, cursor }) => ({
    latest,
    inclusive,
    limit,
    cursor
  })), [
    { latest: event.ts, inclusive: true, limit: 200, cursor: undefined },
    { latest: event.ts, inclusive: true, limit: 200, cursor: "page-2" },
    { latest: event.ts, inclusive: true, limit: 200, cursor: "page-3" }
  ]);
});

test("merges the current thread event when the API has not returned it yet", async () => {
  const event = {
    channel: "C1",
    thread_ts: "100.000001",
    ts: "300.000001",
    text: "current"
  };
  const messages = await collectSlackThreadCandidates(event, async () => ({
    messages: [{ ts: "100.000001", text: "starter" }],
    response_metadata: { next_cursor: "" }
  }));

  assert.equal(messages[0], event);
  assert.deepEqual(messages.map(({ text }) => text), ["current", "starter"]);
});

test("retains more than two hundred short thread messages within the byte budget", async () => {
  const event = {
    channel: "C1",
    thread_ts: "100.000001",
    ts: "400.000001",
    text: "current"
  };
  const all = Array.from({ length: 250 }, (_, index) => ({
    ts: `${100 + index}.000001`,
    text: "x"
  }));
  let page = 0;
  const candidates = await collectSlackThreadCandidates(event, async () => {
    page += 1;
    return page === 1
      ? { messages: all.slice(0, 200), response_metadata: { next_cursor: "rest" } }
      : { messages: all.slice(200), response_metadata: { next_cursor: "" } };
  });
  const result = await collectRecentContext(candidates, 1_000, async (message) => ({
    source: message,
    role: "user",
    content: message.text
  }));

  assert.equal(page, 2);
  assert.equal(result.length, 251);
  assert.equal(result.at(-1).content, "current");
});

test("builds Slack context with six authenticated text files and every image within the size limit", async (t) => {
  const fetchCalls = installSlackFileFetch(t);
  const event = {
    channel: "D1",
    channel_type: "im",
    ts: "300.000001",
    text: "question",
    subtype: "file_share",
    user: "user",
    files: slackFiles(6, ["image-1", "image-2", "image-3", "image-4", "too-large"])
  };
  const client = {
    conversations: {
      history: async () => ({ messages: [], response_metadata: { next_cursor: "" } })
    }
  };

  const context = await buildSlackContext(client, event, {
    botUserId: "bot",
    botToken: "xoxb-test",
    maxContextBytes: 20_000,
    withRetry: async (action) => action()
  });

  assert.equal(context.length, 1);
  const text = context[0].content.find((part) => part.type === "input_text").text;
  for (let index = 1; index <= 6; index++) {
    if (index === 6) {
      assert.match(text, /\[attached file: file-6\.txt \(truncated to 50000 chars\)\]/);
    } else {
      assert.match(text, new RegExp(`\\[attached file: file-${index}\\.txt\\]`));
      assert.match(text, new RegExp(`body:${index}`));
    }
  }
  assert.equal(context[0].content.filter((part) => part.type === "input_image").length, 4);
  assert.equal(fetchCalls.filter(({ url }) => url.includes("text-")).length, 6);
  assert.equal(fetchCalls.filter(({ url }) => url.includes("image-")).length, 4);
  for (const call of fetchCalls) {
    assert.equal(call.options?.headers?.Authorization, "Bearer xoxb-test");
  }
});

test("uses all Slack text files for budgeting and loads images only from selected messages", async (t) => {
  const fetchCalls = installSlackFileFetch(t);
  const older = {
    channel: "D1",
    ts: "200.000001",
    text: "old",
    user: "user",
    files: slackFiles(6, ["old-image"])
  };
  const event = {
    channel: "D1",
    channel_type: "im",
    ts: "300.000001",
    text: "new",
    user: "user",
    files: slackFiles(0, ["current-image"])
  };
  const client = {
    conversations: {
      history: async () => ({
        messages: [event, older],
        response_metadata: { next_cursor: "" }
      })
    }
  };

  const context = await buildSlackContext(client, event, {
    botUserId: "bot",
    botToken: "xoxb-test",
    maxContextBytes: 20,
    withRetry: async (action) => action()
  });

  assert.equal(context.length, 1);
  assert.equal(context[0].content[0].text, "new");
  assert.equal(context[0].content.filter((part) => part.type === "input_image").length, 1);
  assert.equal(fetchCalls.filter(({ url }) => url.includes("text-")).length, 6);
  assert.ok(fetchCalls.some(({ url }) => url.endsWith("current-image")));
  assert.ok(!fetchCalls.some(({ url }) => url.endsWith("old-image")));
});

test("excludes a descriptionless assistant Slack image-only message", async () => {
  const result = await materializeSlackMessage({
    text: "",
    bot_id: "B1",
    files: [{
      id: "generated",
      name: "generated.png",
      mimetype: "image/png",
      url_private_download: "https://files.test/generated"
    }]
  }, "bot", "xoxb-test");

  assert.equal(result, null);
});

test("keeps supported Slack images on their source user turns and skips unsupported and assistant images", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(url.at(-1)) };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const file = (id, mimetype) => ({
    id,
    name: `${id}.img`,
    mimetype,
    url_private_download: `https://files.test/${id}`
  });
  const older = {
    channel: "D1",
    ts: "100.000001",
    text: "older request",
    user: "user",
    files: [file("older-png", " image/PNG ; charset=binary ")]
  };
  const assistant = {
    channel: "D1",
    ts: "200.000001",
    text: "",
    bot_id: "B1",
    files: [file("assistant-png", "image/png")]
  };
  const event = {
    channel: "D1",
    channel_type: "im",
    ts: "300.000001",
    text: "current request",
    user: "user",
    files: [
      file("current-jpeg", "IMAGE/JPEG"),
      file("current-gif", "image/gif; name=x"),
      file("current-webp", " image/webp "),
      file("unsupported-avif", "image/avif")
    ]
  };
  const client = {
    conversations: {
      history: async () => ({
        messages: [event, assistant, older],
        response_metadata: { next_cursor: "" }
      })
    }
  };

  const context = await buildSlackContext(client, event, {
    botUserId: "bot",
    botToken: "xoxb-test",
    maxContextBytes: 20_000,
    withRetry: async (action) => action()
  });

  assert.equal(context.length, 2);
  assert.deepEqual(context[0].content, [
    { type: "input_text", text: "older request" },
    { type: "input_image", image_url: "data:image/png;base64,Zw==" }
  ]);
  assert.deepEqual(
    context[1].content.slice(1).map((part) => part.image_url.split(";")[0]),
    ["data:image/jpeg", "data:image/gif", "data:image/webp"]
  );
  assert.deepEqual(calls.map(({ url }) => url), [
    "https://files.test/older-png",
    "https://files.test/current-jpeg",
    "https://files.test/current-gif",
    "https://files.test/current-webp"
  ]);
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, "Bearer xoxb-test");
  }
});

test("fails a Slack image-only current request with only unsupported images before download", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("unsupported image must not be downloaded");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const event = {
    channel: "D1",
    channel_type: "im",
    ts: "300.000001",
    text: "",
    user: "user",
    files: [{
      id: "unsupported",
      name: "misleading.txt",
      mimetype: " IMAGE/AVIF ; charset=binary ",
      url_private_download: "https://files.test/unsupported"
    }]
  };
  const client = {
    conversations: {
      history: async () => ({ messages: [], response_metadata: { next_cursor: "" } })
    }
  };

  await assert.rejects(
    buildSlackContext(client, event, {
      botUserId: "bot",
      botToken: "xoxb-test",
      maxContextBytes: 20_000,
      withRetry: async (action) => action()
    }),
    /Current user image-only request could not load any supported images/
  );
  assert.equal(fetches, 0);
});

test("asks for a supported image again when a Slack image-only DM request cannot load", async (t) => {
  const fetchUrls = [];
  const handler = await startSlackHandlerHarness(t, async (url) => {
    fetchUrls.push(String(url));
    throw new Error("neither attachment nor provider should be fetched");
  });
  const posted = [];
  const client = {
    conversations: {
      history: async () => ({ messages: [], response_metadata: { next_cursor: "" } })
    },
    reactions: {
      add: async () => {},
      remove: async () => {}
    },
    chat: {
      postMessage: async (payload) => {
        posted.push(payload);
        return { ts: `reply-${posted.length}` };
      },
      update: async () => {},
      delete: async () => {}
    }
  };
  const event = {
    channel: "D1",
    channel_type: "im",
    ts: "300.000001",
    text: "",
    user: "user",
    files: [{
      id: "unsupported",
      name: "image.avif",
      mimetype: "image/avif",
      url_private_download: "https://files.test/unsupported"
    }]
  };

  await handler({ event, client, say: async () => {} });

  assert.deepEqual(fetchUrls, []);
  assert.equal(posted.length, 1);
  assert.equal(
    posted[0].text,
    "현재 요청의 이미지를 불러올 수 없어요. JPEG, PNG, GIF 또는 WebP 이미지를 다시 첨부해 주세요."
  );
  assert.equal(Object.hasOwn(posted[0], "thread_ts"), false);
});

test("carries Slack past and current images through to their delimited Codex request segments", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalRefreshToken = process.env.CODEX_REFRESH_TOKEN;
  const originalRefreshFile = process.env.CODEX_REFRESH_TOKEN_FILE;
  let providerBody;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://files.test/")) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from(String(url).split("/").at(-1))
      };
    }
    if (String(url).includes("auth.openai.com")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: "access-token",
          refresh_token: "next-refresh-token",
          expires_in: 3600
        })
      };
    }
    if (String(url).includes("codex/responses")) {
      providerBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        body: null,
        text: async () => JSON.stringify({ output_text: "ok" })
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  process.env.CODEX_REFRESH_TOKEN = "refresh-token";
  process.env.CODEX_REFRESH_TOKEN_FILE = "/dev/null";
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalRefreshToken === undefined) delete process.env.CODEX_REFRESH_TOKEN;
    else process.env.CODEX_REFRESH_TOKEN = originalRefreshToken;
    if (originalRefreshFile === undefined) delete process.env.CODEX_REFRESH_TOKEN_FILE;
    else process.env.CODEX_REFRESH_TOKEN_FILE = originalRefreshFile;
  });

  const file = (id) => ({
    id,
    name: `${id}.png`,
    mimetype: "image/png",
    url_private_download: `https://files.test/${id}`
  });
  const older = {
    channel: "D1",
    ts: "100.000001",
    text: "older request",
    user: "user",
    files: [file("older-image")]
  };
  const event = {
    channel: "D1",
    channel_type: "im",
    ts: "200.000001",
    text: "current request",
    user: "user",
    files: [file("current-image")]
  };
  const client = {
    conversations: {
      history: async () => ({
        messages: [event, older],
        response_metadata: { next_cursor: "" }
      })
    }
  };

  const context = await buildSlackContext(client, event, {
    botUserId: "bot",
    botToken: "xoxb-test",
    maxContextBytes: 20_000,
    withRetry: async (action) => action()
  });
  await createAiResponse(context, { model: "gpt-5", emptyRetryCount: 0 });

  assert.deepEqual(providerBody.input.map(({ role }) => role), [
    "user", "assistant", "user", "assistant", "user"
  ]);
  assert.equal(providerBody.input[0].content, "[APP_CONTEXT_PROTOCOL_START]");
  assert.equal(providerBody.input[1].content, "[APP_ORIGINAL_USER_TURN_FOLLOWS]");
  assert.equal(providerBody.input[3].content, "[APP_ORIGINAL_USER_TURN_FOLLOWS]");
  assert.deepEqual(providerBody.input[2].content.map((part) => part.type), [
    "input_text", "input_image"
  ]);
  assert.deepEqual(providerBody.input[4].content.map((part) => part.type), [
    "input_text", "input_image"
  ]);
  assert.equal(
    providerBody.input[2].content[1].image_url,
    `data:image/png;base64,${Buffer.from("older-image").toString("base64")}`
  );
  assert.equal(
    providerBody.input[4].content[1].image_url,
    `data:image/png;base64,${Buffer.from("current-image").toString("base64")}`
  );
});
