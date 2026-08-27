import test from "node:test";
import assert from "node:assert/strict";

import {
  completeIrcTurn,
  IrcConversationHistory
} from "../src/connectors/irc.js";

test("keeps more than twenty successful IRC turns when their bytes fit", async () => {
  const history = new IrcConversationHistory(200_000);
  for (let index = 0; index < 25; index++) {
    await completeIrcTurn(
      history,
      "irc:dm:alice",
      { role: "user", content: `user-${index}` },
      async () => `answer-${index}`
    );
  }

  let nextContext;
  await completeIrcTurn(
    history,
    "irc:dm:alice",
    { role: "user", content: "next" },
    async (context) => {
      nextContext = context;
      return "done";
    }
  );

  assert.equal(nextContext.length, 51);
  assert.deepEqual(nextContext.slice(0, 3), [
    { role: "user", content: "user-0" },
    { role: "assistant", content: "answer-0" },
    { role: "user", content: "user-1" }
  ]);
  assert.deepEqual(nextContext.at(-1), { role: "user", content: "next" });
});

test("prunes only the oldest IRC messages after a successful turn", async () => {
  const history = new IrcConversationHistory(22);
  await completeIrcTurn(
    history,
    "irc:dm:alice",
    { role: "user", content: "old-user" },
    async () => "old-answer"
  );
  await completeIrcTurn(
    history,
    "irc:dm:alice",
    { role: "user", content: "new-user" },
    async () => "new-answer"
  );

  const context = await history.contextFor(
    "irc:dm:alice",
    { role: "user", content: "q" }
  );

  assert.deepEqual(context, [
    { role: "user", content: "new-user" },
    { role: "assistant", content: "new-answer" },
    { role: "user", content: "q" }
  ]);
});

test("always preserves an oversized current IRC request", async () => {
  const history = new IrcConversationHistory(20);
  await completeIrcTurn(
    history,
    "irc:dm:alice",
    { role: "user", content: "small" },
    async () => "answer"
  );
  const oversized = { role: "user", content: "가".repeat(10) };

  const context = await history.contextFor("irc:dm:alice", oversized);

  assert.deepEqual(context, [oversized]);
});

test("keeps IRC histories isolated by conversation key", async () => {
  const history = new IrcConversationHistory(200_000);
  await completeIrcTurn(
    history,
    "irc:dm:alice",
    { role: "user", content: "alice question" },
    async () => "alice answer"
  );

  const channelContext = await history.contextFor(
    "irc:channel:#bot",
    { role: "user", content: "bob: channel question" }
  );

  assert.deepEqual(channelContext, [
    { role: "user", content: "bob: channel question" }
  ]);
});

test("does not mutate IRC history when response generation fails", async () => {
  const history = new IrcConversationHistory(200_000);
  await completeIrcTurn(
    history,
    "irc:dm:alice",
    { role: "user", content: "successful question" },
    async () => "successful answer"
  );
  assert.equal(
    await completeIrcTurn(
      history,
      "irc:dm:alice",
      { role: "user", content: "empty question" },
      async () => ""
    ),
    ""
  );

  await assert.rejects(
    completeIrcTurn(
      history,
      "irc:dm:alice",
      { role: "user", content: "failed question" },
      async () => { throw new Error("provider failed"); }
    ),
    /provider failed/
  );

  const context = await history.contextFor(
    "irc:dm:alice",
    { role: "user", content: "retry question" }
  );
  assert.deepEqual(context, [
    { role: "user", content: "successful question" },
    { role: "assistant", content: "successful answer" },
    { role: "user", content: "retry question" }
  ]);
});
