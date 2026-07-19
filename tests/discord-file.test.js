import test from "node:test";
import assert from "node:assert/strict";

import { AttachmentBuilder } from "discord.js";
import { deliverDiscordFiles } from "../src/connectors/discord.js";

test("deliverDiscordFiles uploads UTF-8 text with a safe reply payload", async () => {
  const calls = [];
  const message = {
    id: "source-1",
    channel: { send: async (payload) => calls.push(payload) }
  };

  await deliverDiscordFiles(message, {
    files: [{ filename: "solution.py", content: "print('안녕')\n" }]
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].allowedMentions, { parse: [] });
  assert.deepEqual(calls[0].reply, {
    messageReference: "source-1",
    failIfNotExists: false
  });
  assert.ok(calls[0].files[0] instanceof AttachmentBuilder);
  assert.equal(calls[0].files[0].name, "solution.py");
  assert.deepEqual(calls[0].files[0].attachment, Buffer.from("print('안녕')\n", "utf8"));
});

test("deliverDiscordFiles isolates upload errors and continues", async () => {
  const calls = [];
  const oldError = console.error;
  console.error = () => {};
  const message = {
    id: "source-2",
    channel: {
      async send(payload) {
        calls.push(payload);
        if (calls.length === 1) throw new Error("upload failed");
      }
    }
  };

  try {
    await deliverDiscordFiles(message, {
      files: [
        { filename: "bad.txt", content: "bad" },
        { filename: "good.txt", content: "good" }
      ]
    });
  } finally {
    console.error = oldError;
  }

  assert.equal(calls.length, 3);
  assert.match(calls[1].content, /파일 첨부 실패 \(bad\.txt\): upload failed/);
  assert.deepEqual(calls[1].allowedMentions, { parse: [] });
  assert.equal(calls[2].files[0].name, "good.txt");
});

test("deliverDiscordFiles is a no-op for missing files", async () => {
  let sent = false;
  const message = { channel: { send: async () => { sent = true; } } };
  await deliverDiscordFiles(message);
  await deliverDiscordFiles(message, { files: [] });
  assert.equal(sent, false);
});
