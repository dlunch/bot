import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getCodexAuthConfig,
  getCodexRequestCredentials,
  initializeCodexAuth,
  refreshCodexRequestCredentials,
  __testing__
} from "../src/codex-auth.js";

const NOW = Date.parse("2026-09-03T00:00:00.000Z");
const originalEnv = {
  CODEX_AUTH_FILE: process.env.CODEX_AUTH_FILE,
  CODEX_ACCESS_TOKEN: process.env.CODEX_ACCESS_TOKEN,
  CODEX_REFRESH_TOKEN: process.env.CODEX_REFRESH_TOKEN
};
const tempDirectories = [];

function jwt(claims) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature"
  ].join(".");
}

function accessToken(expiresInMs, extraClaims = {}) {
  return jwt({ exp: (NOW + expiresInMs) / 1000, ...extraClaims });
}

function authDocument({ access = accessToken(60_000), refresh = "refresh-old", ...rest } = {}) {
  return {
    auth_mode: "chatgpt",
    tokens: {
      access_token: access,
      refresh_token: refresh
    },
    last_refresh: "2026-09-02T00:00:00.000Z",
    ...rest
  };
}

async function tempAuthFile() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bot-codex-auth-test-"));
  tempDirectories.push(directory);
  return path.join(directory, "auth.json");
}

async function writeDocument(file, document) {
  await fs.writeFile(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

function setEnvironment(file, access, refresh) {
  process.env.CODEX_AUTH_FILE = file;
  if (access === undefined) delete process.env.CODEX_ACCESS_TOKEN;
  else process.env.CODEX_ACCESS_TOKEN = access;
  if (refresh === undefined) delete process.env.CODEX_REFRESH_TOKEN;
  else process.env.CODEX_REFRESH_TOKEN = refresh;
}

function response(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(payload)
  };
}

function installFetch(handler) {
  const calls = [];
  __testing__.setDependencies({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init, calls.length);
    }
  });
  return calls;
}

afterEach(async () => {
  __testing__.reset();
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  while (tempDirectories.length) {
    await fs.rm(tempDirectories.pop(), { recursive: true, force: true });
  }
});

test("uses a valid file access token without OAuth and ignores environment seed tokens", async () => {
  const file = await tempAuthFile();
  const fileAccess = accessToken(60_000);
  await writeDocument(file, authDocument({ access: fileAccess }));
  setEnvironment(file, accessToken(120_000), "refresh-from-environment");
  __testing__.setDependencies({ now: () => NOW });
  const calls = installFetch(() => {
    throw new Error("OAuth must not be called");
  });

  assert.deepEqual(await initializeCodexAuth(), {
    configured: true,
    source: "file",
    authFile: file
  });
  assert.deepEqual(await getCodexRequestCredentials(), { accessToken: fileAccess });
  assert.equal(calls.length, 0);
  assert.deepEqual(getCodexAuthConfig(), {
    authFile: file,
    hasBootstrapAccessToken: true,
    hasBootstrapRefreshToken: true
  });
});

test("reuses access with more than 30 seconds left and refreshes at the exact boundary", async (t) => {
  await t.test("more than 30 seconds", async () => {
    const file = await tempAuthFile();
    const current = accessToken(30_001);
    await writeDocument(file, authDocument({ access: current }));
    setEnvironment(file);
    __testing__.setDependencies({ now: () => NOW });
    const calls = installFetch(() => {
      throw new Error("OAuth must not be called");
    });

    assert.deepEqual(await getCodexRequestCredentials(), { accessToken: current });
    assert.equal(calls.length, 0);
  });

  await t.test("exactly 30 seconds", async () => {
    __testing__.reset();
    const file = await tempAuthFile();
    const next = accessToken(90_000);
    await writeDocument(file, authDocument({ access: accessToken(30_000) }));
    setEnvironment(file);
    __testing__.setDependencies({ now: () => NOW });
    const calls = installFetch(() => response({ access_token: next }));

    assert.deepEqual(await getCodexRequestCredentials(), { accessToken: next });
    assert.equal(calls.length, 1);
  });
});

test("refreshes expired, missing, and undecodable access tokens", async (t) => {
  const cases = [
    ["expired", accessToken(-1)],
    ["missing", undefined],
    ["undecodable", "not-a-jwt"]
  ];

  for (const [name, current] of cases) {
    await t.test(name, async () => {
      __testing__.reset();
      const file = await tempAuthFile();
      const document = authDocument({ access: current });
      if (current === undefined) delete document.tokens.access_token;
      await writeDocument(file, document);
      setEnvironment(file);
      __testing__.setDependencies({ now: () => NOW });
      const next = accessToken(60_000, { chatgpt_account_id: `account-${name}` });
      const calls = installFetch(() => response({ access_token: next }));

      assert.deepEqual(await getCodexRequestCredentials(), {
        accessToken: next,
        accountId: `account-${name}`
      });
      assert.equal(calls.length, 1);
    });
  }
});

test("bootstraps a Codex-compatible 0600 JSON document from a complete environment seed", async () => {
  const file = await tempAuthFile();
  const access = accessToken(60_000, { chatgpt_account_id: "account-env" });
  setEnvironment(file, access, "refresh-env");
  __testing__.setDependencies({ now: () => NOW });

  assert.deepEqual(await initializeCodexAuth(), {
    configured: true,
    source: "environment",
    authFile: file
  });
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {
    auth_mode: "chatgpt",
    tokens: {
      access_token: access,
      refresh_token: "refresh-env",
      account_id: "account-env"
    },
    last_refresh: "2026-09-03T00:00:00.000Z"
  });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("allows no seed but rejects a partial environment seed without exposing it", async () => {
  const unconfiguredFile = await tempAuthFile();
  setEnvironment(unconfiguredFile);
  assert.deepEqual(await initializeCodexAuth(), {
    configured: false,
    source: "none",
    authFile: unconfiguredFile
  });
  assert.equal(await getCodexRequestCredentials(), undefined);

  __testing__.reset();
  const partialFile = await tempAuthFile();
  const sentinel = "SENTINEL-ACCESS-PARTIAL";
  setEnvironment(partialFile, sentinel);
  await assert.rejects(initializeCodexAuth(), (error) => {
    assert.match(error.message, /CODEX_ACCESS_TOKEN.*CODEX_REFRESH_TOKEN/);
    assert.doesNotMatch(error.message, new RegExp(sentinel));
    return true;
  });
});

test("merges rotated tokens while preserving omitted and unknown auth.json fields", async () => {
  const file = await tempAuthFile();
  const oldId = jwt({ chatgpt_account_id: "old-id-account" });
  const document = authDocument({
    access: accessToken(-1),
    refresh: "refresh-old",
    custom_top_level: { keep: true }
  });
  document.OPENAI_API_KEY = null;
  document.tokens.id_token = oldId;
  document.tokens.account_id = "old-explicit-account";
  document.tokens.custom_token_field = { keep: "yes" };
  await writeDocument(file, document);
  setEnvironment(file);
  __testing__.setDependencies({ now: () => NOW });
  const nextAccess = accessToken(60_000, { chatgpt_account_id: "claim-account" });
  installFetch(() => response({ access_token: nextAccess, account_id: "response-account" }));

  assert.deepEqual(await getCodexRequestCredentials(), {
    accessToken: nextAccess,
    accountId: "response-account"
  });
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(saved.custom_top_level, { keep: true });
  assert.equal(saved.OPENAI_API_KEY, null);
  assert.deepEqual(saved.tokens.custom_token_field, { keep: "yes" });
  assert.equal(saved.tokens.refresh_token, "refresh-old");
  assert.equal(saved.tokens.id_token, oldId);
  assert.equal(saved.tokens.account_id, "response-account");
  assert.equal(saved.tokens.access_token, nextAccess);
  assert.equal(saved.last_refresh, "2026-09-03T00:00:00.000Z");
});

test("derives account ID from id then access claims while explicit account_id has priority", async (t) => {
  const cases = [
    {
      name: "explicit",
      tokens: {
        account_id: "explicit-account",
        id_token: jwt({ chatgpt_account_id: "id-account" }),
        access_token: accessToken(60_000, { chatgpt_account_id: "access-account" })
      },
      expected: "explicit-account"
    },
    {
      name: "id token namespaced claim",
      tokens: {
        id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "id-account" } }),
        access_token: accessToken(60_000, { chatgpt_account_id: "access-account" })
      },
      expected: "id-account"
    },
    {
      name: "access token organization",
      tokens: {
        access_token: accessToken(60_000, { organizations: [{ id: "organization-account" }] })
      },
      expected: "organization-account"
    }
  ];

  for (const { name, tokens, expected } of cases) {
    await t.test(name, async () => {
      __testing__.reset();
      const file = await tempAuthFile();
      await writeDocument(file, { auth_mode: "chatgpt", tokens });
      setEnvironment(file);
      __testing__.setDependencies({ now: () => NOW });
      assert.deepEqual(await getCodexRequestCredentials(), {
        accessToken: tokens.access_token,
        accountId: expected
      });
    });
  }
});

test("publishes refreshed credentials only after temp sync, rename, and directory sync", async () => {
  const file = await tempAuthFile();
  const oldAccess = accessToken(-1);
  const nextAccess = accessToken(60_000);
  await writeDocument(file, authDocument({ access: oldAccess }));
  setEnvironment(file);
  __testing__.setDependencies({ now: () => NOW, randomUUID: () => "fixed-uuid" });
  await initializeCodexAuth();

  const events = [];
  let temporaryFile;
  __testing__.setDependencies({
    fs: {
      open: async (target, flags, mode) => {
        const handle = await fs.open(target, flags, mode);
        if (flags === "wx") {
          temporaryFile = target;
          assert.equal(path.dirname(target), path.dirname(file));
          assert.equal(mode, 0o600);
          return {
            writeFile: async (...args) => {
              events.push("temp-write");
              return handle.writeFile(...args);
            },
            sync: async () => {
              events.push("file-sync");
              await handle.sync();
            },
            close: async () => {
              events.push("file-close");
              await handle.close();
            }
          };
        }
        return {
          sync: async () => {
            events.push("directory-sync");
            assert.equal(__testing__.getStateSnapshot().accessToken, oldAccess);
            await handle.sync();
          },
          close: () => handle.close()
        };
      },
      chmod: async (...args) => {
        events.push("chmod");
        return fs.chmod(...args);
      },
      rename: async (...args) => {
        events.push("rename");
        assert.equal(__testing__.getStateSnapshot().accessToken, oldAccess);
        return fs.rename(...args);
      }
    }
  });
  installFetch(() => response({ access_token: nextAccess }));

  assert.deepEqual(await getCodexRequestCredentials(), { accessToken: nextAccess });
  assert.deepEqual(events, [
    "temp-write",
    "file-sync",
    "file-close",
    "chmod",
    "rename",
    "directory-sync"
  ]);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).tokens.access_token, nextAccess);
  await assert.rejects(fs.access(temporaryFile), { code: "ENOENT" });
  assert.equal(__testing__.getStateSnapshot().accessToken, nextAccess);
});

test("coalesces concurrent refresh requests into one OAuth exchange", async () => {
  const file = await tempAuthFile();
  await writeDocument(file, authDocument({ access: accessToken(-1) }));
  setEnvironment(file);
  __testing__.setDependencies({ now: () => NOW });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const nextAccess = accessToken(60_000);
  const calls = installFetch(async () => {
    signalStarted();
    await gate;
    return response({ access_token: nextAccess });
  });

  const requests = Array.from({ length: 8 }, () => getCodexRequestCredentials());
  await started;
  assert.equal(calls.length, 1);
  release();
  const credentials = await Promise.all(requests);
  assert.ok(credentials.every((entry) => entry.accessToken === nextAccess));
  assert.equal(calls.length, 1);
});

test("does not refresh twice for sequential rejections of the same old access token", async () => {
  const file = await tempAuthFile();
  const oldAccess = accessToken(60_000);
  const nextAccess = accessToken(120_000);
  await writeDocument(file, authDocument({ access: oldAccess }));
  setEnvironment(file);
  __testing__.setDependencies({ now: () => NOW });
  const calls = installFetch(() => response({ access_token: nextAccess }));

  assert.deepEqual(await refreshCodexRequestCredentials(oldAccess), { accessToken: nextAccess });
  assert.deepEqual(await refreshCodexRequestCredentials(oldAccess), { accessToken: nextAccess });
  assert.equal(calls.length, 1);
});

test("adopts a completed external auth.json update immediately before refresh", async () => {
  const file = await tempAuthFile();
  const oldAccess = accessToken(-1);
  const externalAccess = accessToken(120_000);
  await writeDocument(file, authDocument({ access: oldAccess, refresh: "refresh-old" }));
  setEnvironment(file, accessToken(180_000), "refresh-env-must-not-win");
  __testing__.setDependencies({ now: () => NOW });
  await initializeCodexAuth();
  await writeDocument(file, authDocument({ access: externalAccess, refresh: "refresh-external" }));
  const calls = installFetch(() => {
    throw new Error("OAuth must not be called after an external valid update");
  });

  assert.deepEqual(await getCodexRequestCredentials(), { accessToken: externalAccess });
  assert.equal(calls.length, 0);
});

test("retains a rotated pending document and retries persistence without another OAuth call", async () => {
  const file = await tempAuthFile();
  const oldAccess = accessToken(-1);
  const nextAccess = accessToken(60_000);
  await writeDocument(file, authDocument({ access: oldAccess, refresh: "refresh-old" }));
  setEnvironment(file);
  __testing__.setDependencies({ now: () => NOW });
  const calls = installFetch(() =>
    response({ access_token: nextAccess, refresh_token: "refresh-rotated" })
  );
  let renameAttempts = 0;
  __testing__.setDependencies({
    fs: {
      rename: async (...args) => {
        renameAttempts++;
        if (renameAttempts === 1) {
          const error = new Error("SENTINEL-REFRESH-ROTATED must not leak");
          error.code = "EACCES";
          throw error;
        }
        return fs.rename(...args);
      }
    }
  });

  await assert.rejects(getCodexRequestCredentials(), (error) => {
    assert.match(error.message, /persist.*EACCES/i);
    assert.doesNotMatch(error.message, /SENTINEL|refresh-rotated|refresh-old/);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(__testing__.getStateSnapshot().hasPendingDocument, true);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).tokens.access_token, oldAccess);

  assert.deepEqual(await getCodexRequestCredentials(), { accessToken: nextAccess });
  assert.equal(calls.length, 1);
  assert.equal(renameAttempts, 2);
  assert.equal(__testing__.getStateSnapshot().hasPendingDocument, false);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).tokens.refresh_token, "refresh-rotated");
});

test("keeps pending state across repeated persistence failures without resending the old refresh token", async () => {
  const file = await tempAuthFile();
  const oldAccess = accessToken(-1);
  await writeDocument(file, authDocument({ access: oldAccess, refresh: "refresh-old" }));
  setEnvironment(file);
  __testing__.setDependencies({ now: () => NOW });
  const calls = installFetch(() =>
    response({ access_token: accessToken(60_000), refresh_token: "refresh-rotated" })
  );
  __testing__.setDependencies({
    fs: {
      rename: async () => {
        const error = new Error("rename failed");
        error.code = "EROFS";
        throw error;
      }
    }
  });

  await assert.rejects(getCodexRequestCredentials(), /EROFS/);
  await assert.rejects(getCodexRequestCredentials(), /EROFS/);
  assert.equal(calls.length, 1);
  assert.equal(__testing__.getStateSnapshot().hasPendingDocument, true);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).tokens.access_token, oldAccess);

  __testing__.reset();
  assert.equal(__testing__.getStateSnapshot(), undefined);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).tokens.access_token, oldAccess);
});

test("durably preserves rotated tokens and blocks unusable refresh access tokens", async (t) => {
  const cases = [
    ["missing", undefined, /access_token is missing/i],
    ["malformed exp", jwt({ exp: "not-a-number" }), /numeric JWT exp/i],
    ["expired", accessToken(-1), /more than 30 seconds/i],
    ["exactly 30 seconds", accessToken(30_000), /more than 30 seconds/i]
  ];

  for (const [name, refreshedAccess, expectedError] of cases) {
    await t.test(name, async () => {
      __testing__.reset();
      const file = await tempAuthFile();
      const oldAccess = accessToken(-60_000);
      await writeDocument(file, authDocument({ access: oldAccess, refresh: `refresh-old-${name}` }));
      setEnvironment(file);
      __testing__.setDependencies({ now: () => NOW });
      const rotatedId = jwt({ chatgpt_account_id: `account-${name}` });
      const payload = {
        refresh_token: `refresh-rotated-${name}`,
        id_token: rotatedId
      };
      if (refreshedAccess !== undefined) payload.access_token = refreshedAccess;
      const calls = installFetch(() => response(payload));

      await assert.rejects(getCodexRequestCredentials(), expectedError);
      const saved = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(saved.tokens.access_token, oldAccess);
      assert.equal(saved.tokens.refresh_token, `refresh-rotated-${name}`);
      assert.equal(saved.tokens.id_token, rotatedId);
      assert.equal(saved.tokens.account_id, `account-${name}`);
      assert.equal(__testing__.getStateSnapshot().refreshBlocked, true);

      await assert.rejects(getCodexRequestCredentials(), expectedError);
      await assert.rejects(refreshCodexRequestCredentials(oldAccess), expectedError);
      assert.equal(calls.length, 1);
    });
  }
});

test("persists an unusable refresh recovery document after a transient save failure and stays blocked", async () => {
  const file = await tempAuthFile();
  const oldAccess = accessToken(-60_000);
  const rotatedId = jwt({ chatgpt_account_id: "account-recovery" });
  await writeDocument(file, authDocument({ access: oldAccess, refresh: "refresh-old" }));
  setEnvironment(file);
  __testing__.setDependencies({ now: () => NOW });
  const calls = installFetch(() => response({
    access_token: "not-a-jwt",
    refresh_token: "refresh-rotated",
    id_token: rotatedId
  }));
  let renameAttempts = 0;
  __testing__.setDependencies({
    fs: {
      rename: async (...args) => {
        renameAttempts++;
        if (renameAttempts === 1) {
          const error = new Error("temporary rename failure");
          error.code = "EACCES";
          throw error;
        }
        return fs.rename(...args);
      }
    }
  });

  await assert.rejects(getCodexRequestCredentials(), /EACCES/);
  assert.equal(__testing__.getStateSnapshot().hasPendingDocument, true);
  assert.equal(__testing__.getStateSnapshot().refreshBlocked, true);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).tokens.refresh_token, "refresh-old");

  await assert.rejects(getCodexRequestCredentials(), /numeric JWT exp/i);
  assert.equal(calls.length, 1);
  assert.equal(renameAttempts, 2);
  assert.equal(__testing__.getStateSnapshot().hasPendingDocument, false);
  assert.equal(__testing__.getStateSnapshot().refreshBlocked, true);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).tokens.refresh_token, "refresh-rotated");
});

test("uses the recovery document's rotated refresh token after a process restart", async () => {
  const file = await tempAuthFile();
  const oldAccess = accessToken(-60_000);
  await writeDocument(file, authDocument({ access: oldAccess, refresh: "refresh-old" }));
  setEnvironment(file);
  __testing__.setDependencies({ now: () => NOW });
  installFetch(() => response({ refresh_token: "refresh-rotated" }));
  await assert.rejects(getCodexRequestCredentials(), /access_token is missing/i);

  __testing__.reset();
  __testing__.setDependencies({ now: () => NOW });
  const validAccess = accessToken(120_000);
  const restartCalls = installFetch((_url, init) => {
    assert.equal(new URLSearchParams(init.body).get("refresh_token"), "refresh-rotated");
    return response({ access_token: validAccess, refresh_token: "refresh-after-restart" });
  });

  assert.deepEqual(await getCodexRequestCredentials(), { accessToken: validAccess });
  assert.equal(restartCalls.length, 1);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).tokens.refresh_token, "refresh-after-restart");
});

test("sanitizes malformed file and OAuth failures", async (t) => {
  await t.test("malformed auth file", async () => {
    const file = await tempAuthFile();
    const sentinel = "SENTINEL-FILE-TOKEN";
    await fs.writeFile(file, `{\"tokens\":{\"access_token\":\"${sentinel}\"}`, { mode: 0o600 });
    setEnvironment(file, "SENTINEL-ENV-ACCESS", "SENTINEL-ENV-REFRESH");

    await assert.rejects(initializeCodexAuth(), (error) => {
      assert.match(error.message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(error.message, /SENTINEL/);
      return true;
    });
  });

  await t.test("OAuth HTTP body", async () => {
    __testing__.reset();
    const file = await tempAuthFile();
    await writeDocument(file, authDocument({
      access: accessToken(-1),
      refresh: "SENTINEL-REFRESH-TOKEN"
    }));
    setEnvironment(file);
    __testing__.setDependencies({ now: () => NOW });
    installFetch(() => response({
      error: "invalid_grant",
      error_description: "SENTINEL-REFRESH-TOKEN and SENTINEL-ID-TOKEN"
    }, { ok: false, status: 400 }));

    await assert.rejects(getCodexRequestCredentials(), (error) => {
      assert.match(error.message, /HTTP 400.*invalid_grant/);
      assert.doesNotMatch(error.message, /SENTINEL/);
      return true;
    });
  });

  for (const [name, payload] of [
    ["top-level error", { error: "SENTINEL_REFRESH_TOKEN" }],
    ["nested error code", { error: { code: "SENTINEL_REFRESH_TOKEN" } }],
    ["top-level code", { code: "SENTINEL_REFRESH_TOKEN" }],
    ["detail code", { detail: { code: "SENTINEL_REFRESH_TOKEN" } }]
  ]) {
    await t.test(`unknown ${name}`, async () => {
      __testing__.reset();
      const file = await tempAuthFile();
      await writeDocument(file, authDocument({
        access: accessToken(-1),
        refresh: "SENTINEL_REFRESH_TOKEN"
      }));
      setEnvironment(file);
      __testing__.setDependencies({ now: () => NOW });
      installFetch(() => response(payload, { ok: false, status: 400 }));

      await assert.rejects(getCodexRequestCredentials(), (error) => {
        assert.match(error.message, /HTTP 400/);
        assert.doesNotMatch(error.message, /SENTINEL_REFRESH_TOKEN/);
        return true;
      });
    });
  }
});

test("keeps a renamed target pending when directory fsync fails, then persists it again", async () => {
  const file = await tempAuthFile();
  const oldAccess = accessToken(-1);
  const nextAccess = accessToken(120_000);
  await writeDocument(file, authDocument({ access: oldAccess, refresh: "refresh-old" }));
  await fs.chmod(file, 0o644);
  setEnvironment(file);
  __testing__.setDependencies({ now: () => NOW });
  await initializeCodexAuth();
  const calls = installFetch(() => response({
    access_token: nextAccess,
    refresh_token: "refresh-rotated"
  }));
  let directorySyncAttempts = 0;
  __testing__.setDependencies({
    fs: {
      open: async (target, flags, mode) => {
        const handle = await fs.open(target, flags, mode);
        if (flags !== "r") return handle;
        return {
          sync: async () => {
            directorySyncAttempts++;
            if (directorySyncAttempts === 1) {
              const error = new Error("directory sync failed");
              error.code = "EIO";
              throw error;
            }
            await handle.sync();
          },
          close: () => handle.close()
        };
      }
    }
  });

  await assert.rejects(getCodexRequestCredentials(), /EIO/);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).tokens.access_token, nextAccess);
  assert.equal(__testing__.getStateSnapshot().accessToken, oldAccess);
  assert.equal(__testing__.getStateSnapshot().hasPendingDocument, true);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

  assert.deepEqual(await getCodexRequestCredentials(), { accessToken: nextAccess });
  assert.equal(calls.length, 1);
  assert.equal(directorySyncAttempts, 2);
  assert.equal(__testing__.getStateSnapshot().hasPendingDocument, false);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("removes the exact temporary file after every pre-rename persistence failure", async (t) => {
  for (const failurePoint of ["write", "file-sync", "chmod", "rename"]) {
    await t.test(failurePoint, async () => {
      __testing__.reset();
      const file = await tempAuthFile();
      await writeDocument(file, authDocument({ access: accessToken(-1) }));
      setEnvironment(file);
      __testing__.setDependencies({
        now: () => NOW,
        randomUUID: () => `cleanup-${failurePoint}`
      });
      await initializeCodexAuth();
      let temporaryFile;
      const fail = () => {
        const error = new Error(`${failurePoint} failed`);
        error.code = "EIO";
        throw error;
      };
      __testing__.setDependencies({
        fs: {
          open: async (target, flags, mode) => {
            const handle = await fs.open(target, flags, mode);
            if (flags !== "wx") return handle;
            temporaryFile = target;
            return {
              writeFile: async (...args) => {
                if (failurePoint === "write") fail();
                return handle.writeFile(...args);
              },
              sync: async () => {
                if (failurePoint === "file-sync") fail();
                return handle.sync();
              },
              close: () => handle.close()
            };
          },
          chmod: async (...args) => {
            if (failurePoint === "chmod") fail();
            return fs.chmod(...args);
          },
          rename: async (...args) => {
            if (failurePoint === "rename") fail();
            return fs.rename(...args);
          }
        }
      });
      installFetch(() => response({ access_token: accessToken(120_000) }));

      await assert.rejects(getCodexRequestCredentials(), /EIO/);
      assert.equal(path.dirname(temporaryFile), path.dirname(file));
      await assert.rejects(fs.access(temporaryFile), { code: "ENOENT" });
      assert.deepEqual(await fs.readdir(path.dirname(file)), [path.basename(file)]);
    });
  }
});

test("uses the persisted rotated bundle instead of an old environment seed after restart", async () => {
  const file = await tempAuthFile();
  const oldAccess = accessToken(-1);
  const rotatedAccess = accessToken(120_000);
  await writeDocument(file, authDocument({ access: oldAccess, refresh: "refresh-old" }));
  setEnvironment(file, accessToken(180_000), "refresh-seed");
  __testing__.setDependencies({ now: () => NOW });
  const calls = installFetch(() =>
    response({ access_token: rotatedAccess, refresh_token: "refresh-rotated" })
  );
  await getCodexRequestCredentials();
  assert.equal(calls.length, 1);

  __testing__.reset();
  __testing__.setDependencies({ now: () => NOW });
  const restartCalls = installFetch(() => {
    throw new Error("OAuth must not be called after restart");
  });
  assert.deepEqual(await getCodexRequestCredentials(), { accessToken: rotatedAccess });
  assert.equal(restartCalls.length, 0);
});
