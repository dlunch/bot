import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "discord.js";
import { startDiscordBot } from "../src/connectors/discord.js";

async function startDiscordHarness(
  t,
  fetchImpl = async () => {
    throw new Error("AI fetch should not run");
  },
  configOverrides = {}
) {
  const originalLogin = Client.prototype.login;
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalRefreshToken = process.env.CODEX_REFRESH_TOKEN;
  const originalRefreshTokenFile = process.env.CODEX_REFRESH_TOKEN_FILE;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  let client;

  Client.prototype.login = async function login() {
    client = this;
    this.user = { id: "bot" };
    return "test-token";
  };
  globalThis.fetch = fetchImpl;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.CODEX_REFRESH_TOKEN = "test-refresh-token";
  process.env.CODEX_REFRESH_TOKEN_FILE = "/dev/null";
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  const runtime = await startDiscordBot(
    {
      name: "thread-test",
      botToken: "test-token",
      models: ["test-model"],
      providers: { anthropic: { models: ["test-model"] } },
      webSearch: false,
      systemPrompt: "test",
      imageGeneration: false,
      ...configOverrides
    },
    { maxContextBytes: 200_000, discordStreamUpdateMs: 0 }
  );

  t.after(async () => {
    await runtime.stop();
    Client.prototype.login = originalLogin;
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
    if (originalRefreshToken === undefined) {
      delete process.env.CODEX_REFRESH_TOKEN;
    } else {
      process.env.CODEX_REFRESH_TOKEN = originalRefreshToken;
    }
    if (originalRefreshTokenFile === undefined) {
      delete process.env.CODEX_REFRESH_TOKEN_FILE;
    } else {
      process.env.CODEX_REFRESH_TOKEN_FILE = originalRefreshTokenFile;
    }
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  });

  return client.listeners("messageCreate")[0];
}

function createDiscordMessage({ content = "hello", inThread = true, system = false } = {}) {
  const calls = {
    react: 0,
    reply: [],
    send: [],
    history: 0,
    starter: 0,
    reference: 0
  };
  const sentMessages = [];
  const channel = {
    type: inThread ? 11 : 0,
    isThread: () => inThread,
    messages: {
      async fetch() {
        calls.history += 1;
        return new Map();
      }
    },
    async fetchStarterMessage() {
      calls.starter += 1;
      return null;
    },
    async send(payload) {
      calls.send.push(payload);
      const sent = {
        id: `sent-${calls.send.length}`,
        async edit() {},
        async delete() {}
      };
      sentMessages.push(sent);
      return sent;
    }
  };
  const message = {
    id: "source",
    channelId: inThread ? "thread" : "channel",
    createdTimestamp: 200,
    system,
    content,
    author: { id: "user", bot: false },
    mentions: { has: () => true },
    reference: null,
    embeds: [],
    attachments: new Map(),
    channel,
    async react() {
      calls.react += 1;
      return { users: { remove: async () => {} } };
    },
    async reply(payload) {
      calls.reply.push(payload);
      const sent = {
        id: `reply-${calls.reply.length}`,
        async edit() {},
        async delete() {}
      };
      sentMessages.push(sent);
      return sent;
    },
    async fetchReference() {
      calls.reference += 1;
      throw new Error("no reference");
    }
  };
  return { message, calls, sentMessages };
}

function anthropicTextResponse(text) {
  return {
    ok: true,
    status: 200,
    body: null,
    text: async () => JSON.stringify({ content: [{ type: "text", text }] })
  };
}

function anthropicStreamResponse(events) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      }
    }),
    text: async () => body
  };
}

test("ignores Discord system message events before any response work", async (t) => {
  let aiFetches = 0;
  const listener = await startDiscordHarness(t, async () => {
    aiFetches += 1;
    throw new Error("unexpected AI fetch");
  });
  const { message, calls } = createDiscordMessage({ system: true });

  await listener(message);

  assert.equal(calls.react, 0);
  assert.equal(calls.history, 0);
  assert.equal(calls.starter, 0);
  assert.equal(calls.reference, 0);
  assert.deepEqual(calls.reply, []);
  assert.deepEqual(calls.send, []);
  assert.equal(aiFetches, 0);
});

test("sends no-context and generated text directly in threads without reply payloads", async (t) => {
  const listener = await startDiscordHarness(t, async () => anthropicTextResponse("answer"));

  const empty = createDiscordMessage({ content: "" });
  await listener(empty.message);
  assert.deepEqual(empty.calls.reply, []);
  assert.equal(empty.calls.send.length, 1);
  assert.equal(empty.calls.send[0].content, "질문을 같이 보내주세요.");
  assert.equal(Object.hasOwn(empty.calls.send[0], "reply"), false);

  const text = createDiscordMessage();
  await listener(text.message);
  assert.deepEqual(text.calls.reply, []);
  assert.equal(text.calls.send.length, 1);
  assert.equal(text.calls.send[0].content, "answer");
  assert.equal(Object.hasOwn(text.calls.send[0], "reply"), false);
});

test("keeps the first generated message as a reply outside threads", async (t) => {
  const listener = await startDiscordHarness(t, async () => anthropicTextResponse("answer"));
  const { message, calls } = createDiscordMessage({ inThread: false });

  await listener(message);

  assert.equal(calls.reply.length, 1);
  assert.equal(calls.reply[0].content, "answer");
  assert.deepEqual(calls.send, []);
});

test("sends top-level errors directly in threads without a reply payload", async (t) => {
  const listener = await startDiscordHarness(t, async () => {
    throw new Error("provider failed");
  });
  const { message, calls } = createDiscordMessage();

  await listener(message);

  assert.deepEqual(calls.reply, []);
  assert.equal(calls.send.length, 1);
  assert.equal(calls.send[0].content, "에러가 발생했습니다. 잠시 후 다시 시도해주세요.");
  assert.equal(Object.hasOwn(calls.send[0], "reply"), false);
});

test("asks for a supported image again when a Discord image-only thread request cannot load", async (t) => {
  const fetchUrls = [];
  const listener = await startDiscordHarness(t, async (url) => {
    fetchUrls.push(String(url));
    throw new Error("neither attachment nor provider should be fetched");
  });
  const { message, calls } = createDiscordMessage({ content: "" });
  message.attachments = new Map([["unsupported", {
    id: "unsupported",
    name: "image.avif",
    contentType: "image/avif",
    url: "https://files.test/unsupported"
  }]]);

  await listener(message);

  assert.deepEqual(fetchUrls, []);
  assert.deepEqual(calls.reply, []);
  assert.equal(calls.send.length, 1);
  assert.equal(
    calls.send[0].content,
    "현재 요청의 이미지를 불러올 수 없어요. JPEG, PNG, GIF 또는 WebP 이미지를 다시 첨부해 주세요."
  );
  assert.equal(Object.hasOwn(calls.send[0], "reply"), false);
});

test("omits reply payloads from thread file progress, placeholder, and delivery", async (t) => {
  let round = 0;
  const listener = await startDiscordHarness(t, async () => {
    round += 1;
    if (round === 1) {
      return anthropicStreamResponse([
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "file-1", name: "attach_file" }
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({ filename: "result.txt", content: "done" })
          }
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" } }
      ]);
    }
    return anthropicStreamResponse([
      { type: "message_delta", delta: { stop_reason: "end_turn" } }
    ]);
  });
  const { message, calls } = createDiscordMessage();

  await listener(message);

  assert.equal(round, 2);
  assert.deepEqual(calls.reply, []);
  assert.equal(calls.send.length, 3);
  assert.equal(calls.send[0].content, "📎 파일 생성 중...");
  assert.equal(calls.send[1].content, "파일을 첨부했습니다.");
  assert.equal(calls.send[2].files[0].name, "result.txt");
  for (const payload of calls.send) {
    assert.equal(Object.hasOwn(payload, "reply"), false);
  }
});

test("continues mentionless threads when the starter ancestry contains the bot", async (t) => {
  let parentForwardFetches = 0;
  let contextStarted = false;
  let parentForwardFetchesAtAi;
  const listener = await startDiscordHarness(t, async () => {
    parentForwardFetchesAtAi = parentForwardFetches;
    assert.equal(contextStarted, true);
    assert.equal(parentForwardFetchesAtAi, 1);
    return anthropicTextResponse("continued");
  });
  const { message, calls } = createDiscordMessage();
  message.mentions.has = () => false;
  message.channel.messages.fetch = async (params) => {
    if (Object.hasOwn(params, "before")) {
      contextStarted = true;
      assert.equal(parentForwardFetches, 0);
    } else {
      assert.deepEqual(params, { limit: 100 });
      assert.equal(contextStarted, false);
      assert.equal(parentForwardFetches, 0);
    }
    calls.history += 1;
    return new Map();
  };

  const parentChannel = {
    messages: {
      async fetch(params) {
        assert.equal(contextStarted, true);
        parentForwardFetches += 1;
        assert.deepEqual(params, { after: "answer", limit: 100 });
        return new Map([[starterSource.id, starterSource]]);
      }
    }
  };
  const original = {
    id: "original",
    channelId: "parent",
    createdTimestamp: 100,
    content: "original",
    author: { id: "user" },
    embeds: [],
    attachments: new Map(),
    channel: parentChannel
  };
  const answer = {
    id: "answer",
    channelId: "parent",
    createdTimestamp: 110,
    content: "answer",
    author: { id: "bot" },
    reference: { messageId: original.id },
    embeds: [],
    attachments: new Map(),
    channel: parentChannel,
    fetchReference: async () => original
  };
  const starterSource = {
    id: "starter",
    channelId: "parent",
    createdTimestamp: 130,
    content: "open thread",
    author: { id: "user" },
    reference: { messageId: answer.id },
    embeds: [],
    attachments: new Map(),
    channel: parentChannel,
    fetchReference: async () => answer
  };
  const systemProxy = {
    id: "starter",
    channelId: "thread",
    createdTimestamp: 130,
    system: true,
    author: { id: "user" },
    reference: { messageId: starterSource.id, channelId: "parent" },
    fetchReference: async () => starterSource
  };
  message.channel.fetchStarterMessage = async () => {
    calls.starter += 1;
    return systemProxy;
  };

  await listener(message);

  assert.equal(calls.starter, 2);
  assert.equal(calls.history, 2);
  assert.equal(parentForwardFetchesAtAi, 1);
  assert.equal(parentForwardFetches, 1);
  assert.deepEqual(calls.reply, []);
  assert.equal(calls.send.at(-1).content, "continued");
  assert.equal(Object.hasOwn(calls.send.at(-1), "reply"), false);
});

test("applies thread and channel reply policy to image progress, placeholder, and delivery", async (t) => {
  let authFetches = 0;
  let imageFetches = 0;
  const listener = await startDiscordHarness(
    t,
    async (url) => {
      if (String(url).includes("auth.openai.com")) {
        authFetches += 1;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            access_token: "test-access-token",
            refresh_token: "test-refresh-token",
            expires_in: 3600
          })
        };
      }
      assert.match(String(url), /codex\/responses/);
      imageFetches += 1;
      return anthropicStreamResponse([
        {
          type: "response.image_generation_call.in_progress",
          item_id: `image-${imageFetches}`
        },
        {
          type: "response.output_item.done",
          item: {
            type: "image_generation_call",
            id: `image-${imageFetches}`,
            status: "completed",
            result: Buffer.from(`image-${imageFetches}`).toString("base64"),
            revised_prompt: "generated image"
          }
        }
      ]);
    },
    { models: ["image-model"], providers: {}, imageGeneration: true }
  );

  const thread = createDiscordMessage();
  await listener(thread.message);
  assert.deepEqual(thread.calls.reply, []);
  assert.equal(thread.calls.send.length, 3);
  assert.equal(thread.calls.send[0].content, "🎨 이미지 생성 중...");
  assert.equal(thread.calls.send[1].content, "이미지를 생성했습니다.");
  assert.equal(thread.calls.send[2].files[0].name, "image-image-1.png");
  for (const payload of thread.calls.send) {
    assert.equal(Object.hasOwn(payload, "reply"), false);
  }

  const channel = createDiscordMessage({ inThread: false });
  await listener(channel.message);
  assert.deepEqual(channel.calls.reply, []);
  assert.equal(channel.calls.send.length, 3);
  for (const payload of channel.calls.send) {
    assert.deepEqual(payload.reply, {
      messageReference: "source",
      failIfNotExists: false
    });
  }

  assert.equal(authFetches, 1);
  assert.equal(imageFetches, 2);
});
