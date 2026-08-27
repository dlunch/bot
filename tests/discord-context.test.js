import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDiscordContext,
  collectDiscordChannelCandidates,
  collectDiscordReplyCandidates
} from "../src/connectors/discord.js";
import { collectRecentContext } from "../src/connectors/context.js";

function messages(values) {
  return new Map(values.map((message) => [message.id, message]));
}

function discordFiles(textCount, imageNames = []) {
  const files = [];
  for (let index = 1; index <= textCount; index++) {
    files.push({
      id: `text-${index}`,
      name: `file-${index}.txt`,
      contentType: "text/plain",
      url: `https://files.test/text-${index}`
    });
  }
  for (const name of imageNames) {
    files.push({
      id: name,
      name: `${name}.png`,
      contentType: "image/png",
      url: `https://files.test/${name}`
    });
  }
  return messages(files);
}

function installAttachmentFetch(t) {
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

test("paginates isolated channels past one hundred messages and fixes the current snapshot", async () => {
  const current = { id: "current", createdTimestamp: 300, content: "current" };
  const firstPage = Array.from({ length: 98 }, (_, index) => ({
    id: `first-${index}`,
    createdTimestamp: 299 - index,
    content: `first-${index}`
  }));
  firstPage.push(current, { id: "future", createdTimestamp: 301, content: "future" });
  const secondPage = Array.from({ length: 25 }, (_, index) => ({
    id: `second-${index}`,
    createdTimestamp: 199 - index,
    content: `second-${index}`
  }));
  const calls = [];
  current.channel = {
    type: 1,
    isThread: () => false,
    messages: {
      async fetch(params) {
        calls.push(params);
        return calls.length === 1 ? messages(firstPage) : messages(secondPage);
      }
    }
  };

  const collected = [];
  for await (const message of collectDiscordChannelCandidates(current)) {
    collected.push(message);
  }

  assert.equal(collected.length, 124);
  assert.equal(collected[0], current);
  assert.equal(collected.filter((message) => message.id === current.id).length, 1);
  assert.ok(!collected.some((message) => message.id === "future"));
  assert.deepEqual(calls, [
    { limit: 100, before: "current" },
    { limit: 100, before: "first-97" }
  ]);
});

test("stops isolated-channel pagination at the byte boundary before loading a starter", async () => {
  let starterFetches = 0;
  const current = { id: "current", createdTimestamp: 300, content: "new" };
  const page = Array.from({ length: 100 }, (_, index) => ({
    id: `old-${index}`,
    createdTimestamp: 299 - index,
    content: index === 0 ? "overflow" : "unused"
  }));
  current.channel = {
    isThread: () => true,
    messages: { fetch: async () => messages(page) },
    async fetchStarterMessage() {
      starterFetches += 1;
      return { id: "starter", createdTimestamp: 1, content: "starter" };
    }
  };

  const result = await collectRecentContext(
    collectDiscordChannelCandidates(current),
    5,
    async (message) => ({ source: message, role: "user", content: message.content })
  );

  assert.deepEqual(result.map(({ content }) => content), ["new"]);
  assert.equal(starterFetches, 0);
});

test("includes a Discord thread starter within and exactly at the byte boundary", async () => {
  async function buildWithBudget(maxContextBytes) {
    let starterFetches = 0;
    const current = {
      id: "current",
      createdTimestamp: 300,
      content: "ok",
      author: { id: "user" },
      embeds: [],
      attachments: messages([])
    };
    current.channel = {
      isThread: () => true,
      messages: { fetch: async () => messages([]) },
      async fetchStarterMessage() {
        starterFetches += 1;
        return {
          id: "starter",
          createdTimestamp: 100,
          content: "가",
          author: { id: "user" },
          embeds: [],
          attachments: messages([])
        };
      }
    };
    return {
      context: await buildDiscordContext(current, "bot", maxContextBytes),
      starterFetches
    };
  }

  const withinBudget = await buildWithBudget(10);
  const exactBoundary = await buildWithBudget(5);
  const oneByteShort = await buildWithBudget(4);

  assert.deepEqual(withinBudget.context.map(({ content }) => content), ["가", "ok"]);
  assert.deepEqual(exactBoundary.context.map(({ content }) => content), ["가", "ok"]);
  assert.deepEqual(oneByteShort.context.map(({ content }) => content), ["ok"]);
  assert.equal(withinBudget.starterFetches, 1);
  assert.equal(exactBoundary.starterFetches, 1);
  assert.equal(oneByteShort.starterFetches, 1);
});

test("restores paginated bot chunks before the direct reply in chronological order", async () => {
  const botUserId = "bot";
  const parent = {
    id: "chunk-1",
    createdTimestamp: 100,
    content: "one",
    author: { id: botUserId }
  };
  const second = {
    id: "chunk-2",
    createdTimestamp: 110,
    content: "two",
    author: { id: botUserId },
    reference: { messageId: parent.id }
  };
  const firstForwardPage = [
    second,
    ...Array.from({ length: 99 }, (_, index) => ({
      id: `noise-${index}`,
      createdTimestamp: 111 + index,
      author: { id: "someone" }
    }))
  ];
  const third = {
    id: "chunk-3",
    createdTimestamp: 220,
    content: "three",
    author: { id: botUserId },
    reference: { messageId: second.id }
  };
  const current = {
    id: "reply",
    createdTimestamp: 300,
    content: "question",
    author: { id: "user" },
    reference: { messageId: parent.id }
  };
  const forwardCalls = [];
  const channel = {
    messages: {
      async fetch(argument) {
        if (typeof argument === "string") {
          return parent;
        }
        forwardCalls.push(argument);
        return forwardCalls.length === 1
          ? messages(firstForwardPage)
          : messages([third, current]);
      }
    }
  };
  current.channel = channel;
  parent.channel = channel;
  second.channel = channel;
  third.channel = channel;

  const result = await collectRecentContext(
    collectDiscordReplyCandidates(current, botUserId),
    1_000,
    async (message) => ({
      source: message,
      role: message.author.id === botUserId ? "assistant" : "user",
      content: message.content
    })
  );

  assert.deepEqual(result.map(({ content }) => content), ["one", "two", "three", "question"]);
  assert.deepEqual(forwardCalls, [
    { after: "chunk-1", limit: 100 },
    { after: "noise-98", limit: 100 }
  ]);
});

test("keeps the triggering reply when its parent cannot be loaded", async () => {
  const oldWarn = console.warn;
  console.warn = () => {};
  const current = {
    id: "reply",
    createdTimestamp: 300,
    content: "question",
    reference: { messageId: "deleted" },
    channel: { messages: { fetch: async () => { throw new Error("missing"); } } }
  };
  const collected = [];
  try {
    for await (const message of collectDiscordReplyCandidates(current, "bot")) {
      collected.push(message);
    }
  } finally {
    console.warn = oldWarn;
  }

  assert.deepEqual(collected, [current]);
});

test("builds Discord context with six text files and every image within the file-size limit", async (t) => {
  const fetchCalls = installAttachmentFetch(t);
  const current = {
    id: "current",
    createdTimestamp: 300,
    content: "question",
    author: { id: "user" },
    embeds: [],
    attachments: discordFiles(6, ["image-1", "image-2", "image-3", "image-4", "too-large"])
  };
  current.channel = {
    type: 1,
    isThread: () => false,
    messages: { fetch: async () => messages([]) }
  };

  const context = await buildDiscordContext(current, "bot", 20_000);

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
  assert.equal(fetchCalls.filter(({ url }) => url.endsWith("too-large")).length, 1);
});

test("uses all Discord text files for budgeting and loads images only from selected messages", async (t) => {
  const fetchCalls = installAttachmentFetch(t);
  const older = {
    id: "older",
    createdTimestamp: 200,
    content: "old",
    author: { id: "user" },
    embeds: [],
    attachments: discordFiles(6, ["old-image"])
  };
  const current = {
    id: "current",
    createdTimestamp: 300,
    content: "new",
    author: { id: "user" },
    embeds: [],
    attachments: discordFiles(0, ["current-image"])
  };
  current.channel = {
    type: 1,
    isThread: () => false,
    messages: { fetch: async () => messages([older]) }
  };

  const context = await buildDiscordContext(current, "bot", 20);

  assert.equal(context.length, 1);
  assert.equal(context[0].content[0].text, "new");
  assert.equal(context[0].content.filter((part) => part.type === "input_image").length, 1);
  assert.equal(fetchCalls.filter(({ url }) => url.includes("text-")).length, 6);
  assert.ok(fetchCalls.some(({ url }) => url.endsWith("current-image")));
  assert.ok(!fetchCalls.some(({ url }) => url.endsWith("old-image")));
});
