import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSlackContext,
  collectSlackDirectCandidates,
  collectSlackThreadCandidates
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
