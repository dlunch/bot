import test from "node:test";
import assert from "node:assert/strict";

import {
  attachImagesToUserTurns,
  collectRecentContext,
  CurrentUserImageLoadError
} from "../src/connectors/context.js";

const materializeMessage = async (message) => ({ source: message, ...message });

test("keeps more than twenty short messages when their UTF-8 text fits", async () => {
  const newestFirst = Array.from({ length: 30 }, (_, index) => ({
    role: "user",
    content: String(29 - index).padStart(2, "0")
  }));

  const result = await collectRecentContext(newestFirst, 60, materializeMessage);

  assert.equal(result.length, 30);
  assert.equal(result[0].content, "00");
  assert.equal(result.at(-1).content, "29");
});

test("measures Korean and emoji content by UTF-8 bytes", async () => {
  const result = await collectRecentContext(
    [
      { role: "user", content: "🙂" },
      { role: "assistant", content: "가" },
      { role: "user", content: "x" }
    ],
    7,
    materializeMessage
  );

  assert.deepEqual(result.map(({ content }) => content), ["가", "🙂"]);
});

test("includes an exact byte boundary and stops before the next whole message", async () => {
  const exact = await collectRecentContext(
    [{ content: "123" }, { content: "45" }],
    5,
    materializeMessage
  );
  const overflow = await collectRecentContext(
    [{ content: "123" }, { content: "456" }],
    5,
    materializeMessage
  );

  assert.deepEqual(exact.map(({ content }) => content), ["45", "123"]);
  assert.deepEqual(overflow.map(({ content }) => content), ["123"]);
});

test("always keeps the newest valid message when it exceeds the budget", async () => {
  const oversized = "가".repeat(70_000);
  const result = await collectRecentContext(
    [{ role: "user", content: oversized }, { role: "assistant", content: "older" }],
    200_000,
    materializeMessage
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].content, oversized);
});

test("uses materialized attachment text when deciding a message boundary", async () => {
  const candidates = [
    { text: "new", attachment: "" },
    { text: "old", attachment: "0123456789" }
  ];
  const result = await collectRecentContext(candidates, 12, async (candidate) => ({
    source: candidate,
    role: "user",
    content: candidate.text + candidate.attachment
  }));

  assert.deepEqual(result.map(({ content }) => content), ["new"]);
});

test("does not consume candidates after the first overflow", async () => {
  let consumed = 0;
  async function* candidates() {
    for (const content of ["new", "overflow", "must-not-load"]) {
      consumed += 1;
      yield { content };
    }
  }

  const result = await collectRecentContext(candidates(), 5, materializeMessage);

  assert.deepEqual(result.map(({ content }) => content), ["new"]);
  assert.equal(consumed, 2);
});

test("keeps image-only messages without spending text bytes", async () => {
  const result = await collectRecentContext(
    [{ content: "new" }, { content: "" }, { content: "old" }],
    6,
    materializeMessage
  );

  assert.deepEqual(result.map(({ content }) => content), ["old", "", "new"]);
});

test("ignored candidates neither spend bytes nor become the protected newest message", async () => {
  const result = await collectRecentContext(
    [{ content: "ignored" }, { content: "oversized" }, { content: "old" }],
    2,
    async (candidate) => candidate.content === "ignored" ? null : materializeMessage(candidate)
  );

  assert.deepEqual(result.map(({ content }) => content), ["oversized"]);
});

test("keeps images on the user turns where they were attached", async () => {
  const context = [
    { role: "user", content: "older" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "current" }
  ];
  const sources = [
    { images: ["one", "two"] },
    { images: ["assistant-image"] },
    { images: ["three", "too-large", "four"] }
  ];
  const loaded = [];
  const listed = [];
  const result = await attachImagesToUserTurns(
    context,
    sources,
    (source) => {
      listed.push(source);
      return source.images;
    },
    async (image) => {
      loaded.push(image);
      return image === "too-large" ? null : `data:image/png;base64,${image}`;
    }
  );

  assert.deepEqual(loaded, ["one", "two", "three", "too-large", "four"]);
  assert.deepEqual(listed, [sources[0], sources[2]]);
  assert.deepEqual(result[0].content, [
    { type: "input_text", text: "older" },
    { type: "input_image", image_url: "data:image/png;base64,one" },
    { type: "input_image", image_url: "data:image/png;base64,two" }
  ]);
  assert.equal(result[1].content, "answer");
  assert.deepEqual(result[2].content, [
    { type: "input_text", text: "current" },
    { type: "input_image", image_url: "data:image/png;base64,three" },
    { type: "input_image", image_url: "data:image/png;base64,four" }
  ]);
});

test("keeps successful image-only turns and drops a past image-only turn when every load fails", async () => {
  const context = [
    { role: "user", content: "" },
    { role: "user", content: "" },
    { role: "user", content: "current" }
  ];
  const sources = [
    { images: ["missing"] },
    { images: ["available"] },
    { images: [] }
  ];

  const result = await attachImagesToUserTurns(
    context,
    sources,
    (source) => source.images,
    async (image) => image === "available" ? "data:image/png;base64,YQ==" : null
  );

  assert.deepEqual(result, [
    {
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,YQ==" }]
    },
    { role: "user", content: "current" }
  ]);
});

test("fails explicitly when the current image-only request has no loadable image", async () => {
  await assert.rejects(
    attachImagesToUserTurns(
      [{ role: "user", content: "earlier" }, { role: "user", content: "" }],
      [{ images: [] }, { images: ["missing"] }],
      (source) => source.images,
      async () => null
    ),
    (error) => {
      assert.ok(error instanceof CurrentUserImageLoadError);
      assert.equal(error.code, "CURRENT_USER_IMAGE_LOAD_FAILED");
      return true;
    }
  );
});

test("returns recursively independent messages without mutating frozen canonical input", async () => {
  const context = [
    {
      role: "user",
      content: [
        { type: "input_text", text: "look" },
        { type: "input_image", image_url: "data:image/png;base64,YQ==" }
      ]
    },
    { role: "assistant", content: "answer" }
  ];
  const sources = [{ images: [] }, { images: ["never-listed"] }];
  for (const part of context[0].content) Object.freeze(part);
  Object.freeze(context[0].content);
  for (const message of context) Object.freeze(message);
  Object.freeze(context);
  for (const source of sources) Object.freeze(source);
  Object.freeze(sources);

  const result = await attachImagesToUserTurns(
    context,
    sources,
    (source) => source.images,
    async () => null
  );

  assert.deepEqual(result, context);
  assert.notStrictEqual(result, context);
  assert.notStrictEqual(result[0], context[0]);
  assert.notStrictEqual(result[0].content, context[0].content);
  assert.notStrictEqual(result[0].content[0], context[0].content[0]);
  assert.notStrictEqual(result[1], context[1]);
});
