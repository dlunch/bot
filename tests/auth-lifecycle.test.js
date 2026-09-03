import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { defaultCliCodexAuthFile } from "../src/cli.js";
import { startServices } from "../src/index.js";
import { __testing__ as codexAuthTesting } from "../src/codex-auth.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const originalEnv = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CODEX_ACCESS_TOKEN: process.env.CODEX_ACCESS_TOKEN,
  CODEX_AUTH_FILE: process.env.CODEX_AUTH_FILE,
  CODEX_REFRESH_TOKEN: process.env.CODEX_REFRESH_TOKEN
};
const tempDirectories = [];

function jwt(expiresAt) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) })).toString("base64url"),
    "signature"
  ].join(".");
}

async function tempDirectory(prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function isolatedEnvironment(overrides = {}) {
  const environment = { ...process.env, ...overrides };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "CODEX_AUTH_FILE",
    "CODEX_REFRESH_TOKEN"
  ]) {
    if (!(name in overrides)) {
      delete environment[name];
    }
  }
  return environment;
}

afterEach(async () => {
  codexAuthTesting.reset();
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  while (tempDirectories.length) {
    await fs.rm(tempDirectories.pop(), { recursive: true, force: true });
  }
});

test("CLI defaults to ~/.codex/auth.json regardless of an inherited server path", async () => {
  assert.equal(defaultCliCodexAuthFile, path.join(os.homedir(), ".codex", "auth.json"));

  const directory = await tempDirectory("bot-cli-auth-lifecycle-");
  const authFile = path.join(directory, "auth.json");
  const inheritedServerAuthFile = path.join(directory, "server-auth.json");
  const access = jwt(Date.now() + 60_000);
  const refresh = "CLI-REFRESH-SEED";
  const script = [
    'import fs from "node:fs/promises";',
    'import { main } from "./src/cli.js";',
    "await main({ authFile: process.env.TEST_CODEX_AUTH_FILE, createInterface: () => ({",
    "  async question() {",
    '    await fs.access(process.env.CODEX_AUTH_FILE);',
    '    return "/exit";',
    "  },",
    "  close() {}",
    "}) });"
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: projectRoot,
    env: isolatedEnvironment({
      CODEX_AUTH_FILE: inheritedServerAuthFile,
      CODEX_ACCESS_TOKEN: access,
      CODEX_REFRESH_TOKEN: refresh,
      TEST_CODEX_AUTH_FILE: authFile
    }),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(await fs.readFile(authFile, "utf8"));
  assert.equal(document.tokens.access_token, access);
  assert.equal(document.tokens.refresh_token, refresh);
  await assert.rejects(fs.access(inheritedServerAuthFile), { code: "ENOENT" });
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(refresh));
});

test("server persists the environment seed before starting a connector", async () => {
  const directory = await tempDirectory("bot-server-auth-lifecycle-");
  const authFile = path.join(directory, "state", "codex-auth.json");
  const servicesFile = path.join(directory, "services.json");
  const access = jwt(Date.now() + 60_000);
  const refresh = "SERVER-REFRESH-SEED";
  await fs.writeFile(
    servicesFile,
    JSON.stringify({
      slack: [{ name: "test", botToken: "bot", appToken: "app", model: "model" }]
    })
  );
  process.env.CODEX_AUTH_FILE = authFile;
  process.env.CODEX_ACCESS_TOKEN = access;
  process.env.CODEX_REFRESH_TOKEN = refresh;

  const sigintListeners = process.listenerCount("SIGINT");
  const sigtermListeners = process.listenerCount("SIGTERM");
  let started = false;
  await startServices({
    servicesFile,
    startSlackBot: async () => {
      const document = JSON.parse(await fs.readFile(authFile, "utf8"));
      assert.equal(document.tokens.access_token, access);
      assert.equal(document.tokens.refresh_token, refresh);
      started = true;
      return {};
    }
  });

  assert.equal(started, true);
  assert.equal(process.listenerCount("SIGINT"), sigintListeners);
  assert.equal(process.listenerCount("SIGTERM"), sigtermListeners);
});

test("server starts an Anthropic-only connector without Codex credentials", async () => {
  const directory = await tempDirectory("bot-server-anthropic-lifecycle-");
  const servicesFile = path.join(directory, "services.json");
  process.env.CODEX_AUTH_FILE = path.join(directory, "codex-auth.json");
  delete process.env.CODEX_ACCESS_TOKEN;
  delete process.env.CODEX_REFRESH_TOKEN;
  process.env.ANTHROPIC_API_KEY = "ANTHROPIC-TEST-KEY";
  await fs.writeFile(
    servicesFile,
    JSON.stringify({
      slack: [{
        name: "test",
        botToken: "bot",
        appToken: "app",
        models: ["claude-test"],
        providers: { "claude-test": "anthropic" }
      }]
    })
  );

  let started = false;
  await startServices({
    servicesFile,
    startSlackBot: async () => {
      started = true;
      return {};
    }
  });

  assert.equal(started, true);
  await assert.rejects(fs.access(process.env.CODEX_AUTH_FILE), { code: "ENOENT" });
});

test("CLI and server fail before interaction on a partial seed without exposing it", async (t) => {
  for (const [name, script] of [["CLI", "src/cli.js"], ["server", "src/index.js"]]) {
    await t.test(name, async () => {
      const directory = await tempDirectory(`bot-${name.toLowerCase()}-auth-failure-`);
      const authFile = path.join(directory, "auth.json");
      const sentinel = `${name.toUpperCase()}-ACCESS-SENTINEL`;
      const args = name === "CLI"
        ? [
            "--input-type=module",
            "--eval",
            'import { main } from "./src/cli.js"; await main({ authFile: process.env.TEST_CODEX_AUTH_FILE });'
          ]
        : [script];
      const result = spawnSync(process.execPath, args, {
        cwd: projectRoot,
        env: isolatedEnvironment({
          CODEX_AUTH_FILE: authFile,
          CODEX_ACCESS_TOKEN: sentinel,
          TEST_CODEX_AUTH_FILE: authFile
        }),
        input: "/exit\n",
        encoding: "utf8"
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /CODEX_ACCESS_TOKEN.*CODEX_REFRESH_TOKEN/);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sentinel));
      assert.doesNotMatch(result.stdout, /you> /);
    });
  }
});
