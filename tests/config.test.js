// Unit tests for B5 (config schema + imageGeneration parsing).
// Uses Node's built-in test runner (node --test). No external deps.
//
// These tests write a temp services.json and invoke `loadServicesConfig`
// with the temp path directly, so we avoid monkey-patching fs/path/cwd.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadServicesConfig } from "../src/index.js";

async function writeTempServices(payload) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bot-config-test-"));
  const file = path.join(dir, "services.json");
  await fs.writeFile(file, JSON.stringify(payload), "utf8");
  return {
    file,
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

test("(A) Slack bot config with imageGeneration: true → parsed as true", async (t) => {
  const { file, cleanup } = await writeTempServices({
    slack: [
      {
        name: "main",
        botToken: "xoxb-x",
        appToken: "xapp-x",
        model: "gpt-5.3-codex",
        imageGeneration: true
      }
    ]
  });
  t.after(cleanup);

  const cfg = await loadServicesConfig(file);
  assert.equal(cfg.slack.length, 1);
  assert.equal(cfg.slack[0].imageGeneration, true);
});

test("(B) Slack bot config without imageGeneration field → defaults to false", async (t) => {
  const { file, cleanup } = await writeTempServices({
    slack: [
      {
        name: "main",
        botToken: "xoxb-x",
        appToken: "xapp-x",
        model: "gpt-5.3-codex"
      }
    ]
  });
  t.after(cleanup);

  const cfg = await loadServicesConfig(file);
  assert.equal(cfg.slack[0].imageGeneration, false);
});

test("(C) imageGeneration: \"true\" (string) → false (strict ===)", async (t) => {
  const { file, cleanup } = await writeTempServices({
    slack: [
      {
        name: "main",
        botToken: "xoxb-x",
        appToken: "xapp-x",
        model: "gpt-5.3-codex",
        imageGeneration: "true"
      }
    ]
  });
  t.after(cleanup);

  const cfg = await loadServicesConfig(file);
  assert.equal(cfg.slack[0].imageGeneration, false);
});

test("(C2) imageGeneration: 1 (integer) → false (strict ===)", async (t) => {
  const { file, cleanup } = await writeTempServices({
    slack: [
      {
        name: "main",
        botToken: "xoxb-x",
        appToken: "xapp-x",
        model: "gpt-5.3-codex",
        imageGeneration: 1
      }
    ]
  });
  t.after(cleanup);

  const cfg = await loadServicesConfig(file);
  assert.equal(cfg.slack[0].imageGeneration, false);
});

test("(C3) imageGeneration: \"false\" (string) → false", async (t) => {
  const { file, cleanup } = await writeTempServices({
    slack: [
      {
        name: "main",
        botToken: "xoxb-x",
        appToken: "xapp-x",
        model: "gpt-5.3-codex",
        imageGeneration: "false"
      }
    ]
  });
  t.after(cleanup);

  const cfg = await loadServicesConfig(file);
  assert.equal(cfg.slack[0].imageGeneration, false);
});

test("(D) IRC bot config with imageGeneration: true → parsed (inert, IRC connector ignores it)", async (t) => {
  // IRC normalizes the field for config-shape consistency but the IRC
  // connector never forwards it to `createAiResponse`. This test confirms
  // that the parser does NOT error out and leaves the field on the config
  // object (architecture.md §4: IRC 수정 없음, dead field).
  const { file, cleanup } = await writeTempServices({
    irc: [
      {
        name: "libera",
        server: "irc.libera.chat",
        port: 6697,
        ssl: true,
        nick: "codexbot",
        channels: ["#test"],
        model: "gpt-5.3-codex",
        imageGeneration: true
      }
    ]
  });
  t.after(cleanup);

  const cfg = await loadServicesConfig(file);
  assert.equal(cfg.irc.length, 1);
  // Field is normalized for consistency; the IRC connector never reads it.
  assert.equal(cfg.irc[0].imageGeneration, true);
});

test("(E) Discord bot config imageGeneration parsing (true / missing / bogus)", async (t) => {
  const { file, cleanup } = await writeTempServices({
    discord: [
      { name: "a", botToken: "t1", model: "gpt-5", imageGeneration: true },
      { name: "b", botToken: "t2", model: "gpt-5" },
      { name: "c", botToken: "t3", model: "gpt-5", imageGeneration: "true" },
      { name: "d", botToken: "t4", model: "gpt-5", imageGeneration: false }
    ]
  });
  t.after(cleanup);

  const cfg = await loadServicesConfig(file);
  assert.deepEqual(
    cfg.discord.map((b) => ({ name: b.name, img: b.imageGeneration })),
    [
      { name: "a", img: true },
      { name: "b", img: false },
      { name: "c", img: false },
      { name: "d", img: false }
    ]
  );
});
