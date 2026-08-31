import test from "node:test";
import assert from "node:assert/strict";
import { createAiResponse } from "../src/ai.js";

import {
  buildDiscordContext,
  collectDiscordChannelCandidates,
  collectDiscordReplyCandidates,
  collectDiscordThreadCandidates,
  materializeDiscordMessage
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

test("stops thread context at the byte boundary before loading a starter or its ancestry", async () => {
  let starterFetches = 0;
  let starterReferenceFetches = 0;
  let parentPaginationFetches = 0;
  const current = {
    id: "current",
    channelId: "thread",
    createdTimestamp: 300,
    content: "new",
    author: { id: "user" },
    embeds: [],
    attachments: messages([])
  };
  const page = Array.from({ length: 100 }, (_, index) => ({
    id: `old-${index}`,
    channelId: "thread",
    createdTimestamp: 299 - index,
    content: index === 0 ? "overflow" : "unused",
    author: { id: "user" },
    embeds: [],
    attachments: messages([])
  }));
  current.channel = {
    type: 11,
    isThread: () => true,
    messages: { fetch: async () => messages(page) },
    async fetchStarterMessage() {
      starterFetches += 1;
      return {
        id: "starter",
        channelId: "thread",
        system: true,
        reference: { messageId: "parent-starter", channelId: "parent" },
        async fetchReference() {
          starterReferenceFetches += 1;
          return {
            id: "parent-starter",
            channelId: "parent",
            createdTimestamp: 1,
            content: "starter",
            author: { id: "bot" },
            embeds: [],
            attachments: messages([]),
            channel: {
              messages: {
                async fetch() {
                  parentPaginationFetches += 1;
                  return messages([]);
                }
              }
            }
          };
        }
      };
    }
  };

  const result = await buildDiscordContext(current, "bot", 5);

  assert.deepEqual(result.map(({ content }) => content), ["new"]);
  assert.equal(starterFetches, 0);
  assert.equal(starterReferenceFetches, 0);
  assert.equal(parentPaginationFetches, 0);
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
  current.fetchReference = async () => parent;

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
    fetchReference: async () => { throw new Error("missing"); }
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

test("bridges a new thread to the starter reply chain and excludes the system proxy", async (t) => {
  const originalFetch = globalThis.fetch;
  const attachmentFetches = [];
  globalThis.fetch = async (url) => {
    attachmentFetches.push(url);
    throw new Error("system attachments must not be loaded");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const parentChannel = {
    messages: {
      async fetch(params) {
        assert.deepEqual(params, { after: "answer-1", limit: 100 });
        return messages([answer2, starterSource]);
      }
    }
  };
  const originalQuestion = {
    id: "question-1",
    channelId: "parent",
    createdTimestamp: 100,
    content: "original question",
    author: { id: "user" },
    embeds: [],
    attachments: messages([]),
    channel: parentChannel
  };
  const answer1 = {
    id: "answer-1",
    channelId: "parent",
    createdTimestamp: 110,
    content: "first answer chunk",
    author: { id: "bot" },
    reference: { messageId: originalQuestion.id },
    embeds: [],
    attachments: messages([]),
    channel: parentChannel,
    fetchReference: async () => originalQuestion
  };
  const answer2 = {
    id: "answer-2",
    channelId: "parent",
    createdTimestamp: 120,
    content: "second answer chunk",
    author: { id: "bot" },
    reference: { messageId: answer1.id },
    embeds: [],
    attachments: messages([]),
    channel: parentChannel
  };
  const starterSource = {
    id: "starter-shared",
    channelId: "parent",
    createdTimestamp: 130,
    content: "follow-up that opened the thread",
    author: { id: "user" },
    reference: { messageId: answer1.id },
    embeds: [],
    attachments: messages([]),
    channel: parentChannel,
    fetchReference: async () => answer1
  };
  const systemProxy = {
    id: "starter-shared",
    channelId: "thread",
    createdTimestamp: 130,
    system: true,
    content: "system proxy content",
    author: { id: "user" },
    reference: { messageId: starterSource.id, channelId: "parent" },
    embeds: [{ description: "system proxy embed" }],
    attachments: discordFiles(1),
    fetchReference: async () => starterSource
  };
  const current = {
    id: "thread-current",
    channelId: "thread",
    createdTimestamp: 200,
    content: "continue here",
    author: { id: "user" },
    embeds: [],
    attachments: messages([])
  };
  current.channel = {
    type: 11,
    isThread: () => true,
    messages: { fetch: async () => messages([systemProxy]) },
    fetchStarterMessage: async () => systemProxy
  };
  systemProxy.channel = current.channel;

  const context = await buildDiscordContext(current, "bot", 10_000);

  assert.deepEqual(context.map(({ content }) => content), [
    "original question",
    "first answer chunk",
    "second answer chunk",
    "follow-up that opened the thread",
    "continue here"
  ]);
  assert.deepEqual(attachmentFetches, []);
});

test("deduplicates thread candidates by channel and message identity", async () => {
  const duplicate = {
    id: "duplicate",
    channelId: "thread",
    createdTimestamp: 190,
    content: "thread history"
  };
  const starterSource = {
    id: "shared",
    channelId: "parent",
    createdTimestamp: 100,
    content: "starter source"
  };
  const systemProxy = {
    id: "shared",
    channelId: "thread",
    createdTimestamp: 100,
    system: true,
    reference: { messageId: starterSource.id, channelId: "parent" },
    fetchReference: async () => starterSource
  };
  const current = {
    id: "current",
    channelId: "thread",
    createdTimestamp: 200,
    content: "current"
  };
  current.channel = {
    isThread: () => true,
    messages: { fetch: async () => messages([duplicate, duplicate]) },
    fetchStarterMessage: async () => systemProxy
  };

  const collected = [];
  for await (const candidate of collectDiscordThreadCandidates(current, "bot")) {
    collected.push(`${candidate.channelId}:${candidate.id}`);
  }

  assert.deepEqual(collected, [
    "thread:current",
    "thread:duplicate",
    "parent:shared"
  ]);
});

test("never materializes Discord system messages", async () => {
  let attachmentReads = 0;
  const result = await materializeDiscordMessage({
    system: true,
    content: "copied content",
    author: { id: "user" },
    embeds: [{ description: "copied embed" }],
    attachments: {
      values() {
        attachmentReads += 1;
        return [];
      }
    }
  }, "bot");

  assert.equal(result, null);
  assert.equal(attachmentReads, 0);
});

test("excludes a descriptionless assistant image-only message", async () => {
  const result = await materializeDiscordMessage({
    system: false,
    content: "",
    author: { id: "bot", bot: true },
    embeds: [],
    attachments: messages([{
      id: "generated",
      name: "generated.png",
      contentType: "image/png",
      url: "https://files.test/generated"
    }])
  }, "bot");

  assert.equal(result, null);
});

test("terminates reply ancestry cycles without duplicating candidates", async () => {
  const first = {
    id: "first",
    channelId: "parent",
    reference: { messageId: "second" }
  };
  const second = {
    id: "second",
    channelId: "parent",
    reference: { messageId: "first" }
  };
  first.fetchReference = async () => second;
  second.fetchReference = async () => first;

  const collected = [];
  for await (const candidate of collectDiscordReplyCandidates(first, "bot")) {
    collected.push(candidate.id);
  }

  assert.deepEqual(collected, ["first", "second"]);
});

test("keeps partial thread candidates when local history or starter references fail", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const starterSource = {
      id: "starter-source",
      channelId: "parent",
      content: "starter source"
    };
    const currentAfterHistoryFailure = {
      id: "current-history-failure",
      channelId: "thread",
      createdTimestamp: 200,
      content: "current"
    };
    currentAfterHistoryFailure.channel = {
      messages: { fetch: async () => { throw new Error("history unavailable"); } },
      fetchStarterMessage: async () => starterSource
    };

    const afterHistoryFailure = [];
    for await (const candidate of collectDiscordThreadCandidates(
      currentAfterHistoryFailure,
      "bot"
    )) {
      afterHistoryFailure.push(candidate.id);
    }
    assert.deepEqual(afterHistoryFailure, ["current-history-failure", "starter-source"]);

    const local = {
      id: "local",
      channelId: "thread",
      createdTimestamp: 190,
      content: "local"
    };
    const currentAfterReferenceFailure = {
      id: "current-reference-failure",
      channelId: "thread",
      createdTimestamp: 200,
      content: "current"
    };
    currentAfterReferenceFailure.channel = {
      messages: { fetch: async () => messages([local]) },
      fetchStarterMessage: async () => ({
        id: "system-starter",
        channelId: "thread",
        system: true,
        reference: { messageId: "missing", channelId: "parent" },
        fetchReference: async () => { throw new Error("reference unavailable"); }
      })
    };

    const afterReferenceFailure = [];
    for await (const candidate of collectDiscordThreadCandidates(
      currentAfterReferenceFailure,
      "bot"
    )) {
      afterReferenceFailure.push(candidate.id);
    }
    assert.deepEqual(afterReferenceFailure, ["current-reference-failure", "local"]);
  } finally {
    console.warn = originalWarn;
  }
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

test("keeps supported Discord images on their source user turns and skips unsupported and assistant images", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(url.at(-1)) };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const attachment = (id, contentType) => ({
    id,
    name: `${id}.img`,
    contentType,
    url: `https://files.test/${id}`
  });
  const older = {
    id: "older",
    createdTimestamp: 100,
    content: "older request",
    author: { id: "user" },
    embeds: [],
    attachments: messages([attachment("older-png", " image/PNG ; charset=binary ")])
  };
  const assistant = {
    id: "assistant",
    createdTimestamp: 200,
    content: "",
    author: { id: "bot", bot: true },
    embeds: [],
    attachments: messages([attachment("assistant-png", "image/png")])
  };
  const current = {
    id: "current",
    createdTimestamp: 300,
    content: "current request",
    author: { id: "user" },
    embeds: [],
    attachments: messages([
      attachment("current-jpeg", "IMAGE/JPEG"),
      attachment("current-gif", "image/gif; name=x"),
      attachment("current-webp", " image/webp "),
      attachment("unsupported-avif", "image/avif")
    ])
  };
  current.channel = {
    type: 1,
    isThread: () => false,
    messages: { fetch: async () => messages([current, assistant, older]) }
  };

  const context = await buildDiscordContext(current, "bot", 20_000);

  assert.equal(context.length, 2);
  assert.deepEqual(context[0].content, [
    { type: "input_text", text: "older request" },
    { type: "input_image", image_url: "data:image/png;base64,Zw==" }
  ]);
  assert.deepEqual(context[1].content.map((part) => part.type), [
    "input_text", "input_image", "input_image", "input_image"
  ]);
  assert.deepEqual(
    context[1].content.slice(1).map((part) => part.image_url.split(";")[0]),
    ["data:image/jpeg", "data:image/gif", "data:image/webp"]
  );
  assert.deepEqual(calls, [
    "https://files.test/older-png",
    "https://files.test/current-jpeg",
    "https://files.test/current-gif",
    "https://files.test/current-webp"
  ]);
});

test("fails a Discord image-only current request with only unsupported images before download", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("unsupported image must not be downloaded");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const current = {
    id: "current",
    createdTimestamp: 300,
    content: "",
    author: { id: "user" },
    embeds: [],
    attachments: messages([{
      id: "unsupported",
      name: "misleading.txt",
      contentType: " IMAGE/AVIF ; charset=binary ",
      url: "https://files.test/unsupported"
    }])
  };
  current.channel = {
    type: 1,
    isThread: () => false,
    messages: { fetch: async () => messages([]) }
  };

  await assert.rejects(
    buildDiscordContext(current, "bot", 20_000),
    /Current user image-only request could not load any supported images/
  );
  assert.equal(fetches, 0);
});

test("carries Discord past and current images through to their marked Anthropic request segments", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  let providerBody;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://files.test/")) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from(String(url).split("/").at(-1))
      };
    }
    if (String(url).includes("api.anthropic.com")) {
      providerBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        body: null,
        text: async () => JSON.stringify({ content: [{ type: "text", text: "ok" }] })
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  process.env.ANTHROPIC_API_KEY = "test-key";
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  const older = {
    id: "older",
    createdTimestamp: 100,
    content: "older request",
    author: { id: "user" },
    embeds: [],
    attachments: messages([{
      id: "older-image",
      name: "older.png",
      contentType: "image/png",
      url: "https://files.test/older-image"
    }])
  };
  const current = {
    id: "current",
    createdTimestamp: 200,
    content: "current request",
    author: { id: "user" },
    embeds: [],
    attachments: messages([{
      id: "current-image",
      name: "current.png",
      contentType: "image/png",
      url: "https://files.test/current-image"
    }])
  };
  current.channel = {
    type: 1,
    isThread: () => false,
    messages: { fetch: async () => messages([current, older]) }
  };

  const context = await buildDiscordContext(current, "bot", 20_000);
  await createAiResponse(context, {
    model: "claude-test",
    providers: { anthropic: { models: ["claude-test"] } },
    emptyRetryCount: 0
  });

  assert.deepEqual(providerBody.messages.map(({ role }) => role), [
    "user", "assistant", "user", "assistant", "user"
  ]);
  assert.deepEqual(providerBody.messages[0].content, [
    { type: "text", text: "[APP_CONTEXT_PROTOCOL_START]" }
  ]);
  assert.deepEqual(providerBody.messages[1].content.at(-1), {
    type: "text", text: "[APP_ORIGINAL_USER_TURN_FOLLOWS]"
  });
  assert.deepEqual(providerBody.messages[3].content.at(-1), {
    type: "text", text: "[APP_ORIGINAL_USER_TURN_FOLLOWS]"
  });
  assert.equal(providerBody.system.includes("[APP_CONTEXT_PROTOCOL_START]"), true);
  assert.equal(providerBody.system.includes("[APP_ORIGINAL_USER_TURN_FOLLOWS]"), true);
  assert.deepEqual(providerBody.messages[2].content.map((part) => part.type), [
    "text", "image"
  ]);
  assert.deepEqual(providerBody.messages[4].content.map((part) => part.type), [
    "text", "image"
  ]);
  assert.equal(
    providerBody.messages[2].content[1].source.data,
    Buffer.from("older-image").toString("base64")
  );
  assert.equal(
    providerBody.messages[4].content[1].source.data,
    Buffer.from("current-image").toString("base64")
  );
});
