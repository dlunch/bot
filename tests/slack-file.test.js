import test from "node:test";
import assert from "node:assert/strict";

import { deliverSlackFiles } from "../src/connectors/slack.js";

test("deliverSlackFiles uploads UTF-8 buffers through the retry wrapper", async () => {
  const uploads = [];
  const retryLabels = [];
  const client = {
    filesUploadV2: async (payload) => uploads.push(payload),
    chat: { postMessage: async () => {} }
  };

  await deliverSlackFiles(client, [{ filename: "notes.md", content: "안녕\n" }], {
    channelId: "C1",
    threadTs: "123.4",
    withRetry: async (fn, label) => {
      retryLabels.push(label);
      return fn();
    }
  });

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].channel_id, "C1");
  assert.equal(uploads[0].thread_ts, "123.4");
  assert.equal(uploads[0].filename, "notes.md");
  assert.deepEqual(uploads[0].file, Buffer.from("안녕\n", "utf8"));
  assert.deepEqual(retryLabels, ["files_upload_v2"]);
});

test("deliverSlackFiles sanitizes failure notices and continues", async () => {
  const uploads = [];
  const notices = [];
  const oldError = console.error;
  console.error = () => {};
  const client = {
    async filesUploadV2(payload) {
      uploads.push(payload);
      if (uploads.length === 1) throw new Error("notify <!channel> <@U123>");
    },
    chat: { postMessage: async (payload) => notices.push(payload) }
  };

  try {
    await deliverSlackFiles(client, [
      { filename: "first.txt", content: "one" },
      { filename: "second.txt", content: "two" }
    ], { channelId: "C2", threadTs: undefined });
  } finally {
    console.error = oldError;
  }

  assert.equal(uploads.length, 2);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].thread_ts, undefined);
  assert.equal(notices[0].parse, "none");
  assert.ok(!notices[0].text.includes("<!channel>"));
  assert.ok(!notices[0].text.includes("<@U123>"));
  assert.match(notices[0].text, /파일 첨부 실패/);
});

test("deliverSlackFiles is a no-op for missing files", async () => {
  let uploaded = false;
  const client = {
    filesUploadV2: async () => { uploaded = true; },
    chat: { postMessage: async () => {} }
  };
  await deliverSlackFiles(client);
  await deliverSlackFiles(client, []);
  assert.equal(uploaded, false);
});
