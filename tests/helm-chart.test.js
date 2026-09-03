import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const chart = new URL("../helm/bot", import.meta.url).pathname;
const helmAvailable = spawnSync("helm", ["version", "--short"], {
  encoding: "utf8"
}).status === 0;

function render(...args) {
  return spawnSync("helm", ["template", "test", chart, ...args], {
    encoding: "utf8"
  });
}

const configuredCodex = [
  "--set-string",
  "auth.codex.accessToken=access-seed",
  "--set-string",
  "auth.codex.refreshToken=refresh-seed"
];

test("Helm rejects default values without any authentication source", {
  skip: !helmAvailable
}, () => {
  const result = render();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Codex access\/refresh tokens or auth\.anthropic\.apiKey are required/i);
});

test("Helm wires Codex bootstrap tokens and the persistent auth bundle", {
  skip: !helmAvailable
}, () => {
  const result = render(...configuredCodex);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CODEX_ACCESS_TOKEN: "access-seed"/);
  assert.match(result.stdout, /CODEX_REFRESH_TOKEN: "refresh-seed"/);
  assert.match(result.stdout, /- name: CODEX_ACCESS_TOKEN\s+valueFrom:\s+secretKeyRef:[\s\S]*?key: CODEX_ACCESS_TOKEN\s+optional: true/);
  assert.match(result.stdout, /- name: CODEX_REFRESH_TOKEN\s+valueFrom:\s+secretKeyRef:[\s\S]*?key: CODEX_REFRESH_TOKEN\s+optional: true/);
  assert.match(result.stdout, /- name: CODEX_AUTH_FILE\s+value: "\/app\/data\/codex-auth\.json"/);
  assert.match(result.stdout, /replicas: 1/);
  assert.match(result.stdout, /strategy:\s+type: Recreate/);
  assert.match(result.stdout, /mountPath: "\/app\/data"/);
});

test("Helm derives the auth bundle path from a normalized custom PVC mount", {
  skip: !helmAvailable
}, () => {
  const result = render(
    ...configuredCodex,
    "--set-string",
    "auth.persistence.mountPath=/custom//data/"
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /- name: CODEX_AUTH_FILE\s+value: "\/custom\/data\/codex-auth\.json"/);
  assert.match(result.stdout, /- name: auth-state\s+mountPath: "\/custom\/data"/);
});

for (const [name, mountPath] of [
  ["an empty mount path", ""],
  ["a relative mount path", "custom/data"]
]) {
  test(`Helm rejects ${name}`, { skip: !helmAvailable }, () => {
    const result = render(
      ...configuredCodex,
      "--set-string",
      `auth.persistence.mountPath=${mountPath}`
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /auth\.persistence\.mountPath must be a non-empty absolute path/);
  });
}

test("Helm accepts an Anthropic-only self-managed Secret", {
  skip: !helmAvailable
}, () => {
  const result = render(
    "--set-string",
    "auth.anthropic.apiKey=anthropic-seed"
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ANTHROPIC_API_KEY: "anthropic-seed"/);
  assert.doesNotMatch(result.stdout, /CODEX_ACCESS_TOKEN: "/);
  assert.doesNotMatch(result.stdout, /CODEX_REFRESH_TOKEN: "/);
});

for (const [name, args] of [
  ["access token", ["--set-string", "auth.codex.accessToken=access-seed"]],
  ["refresh token", ["--set-string", "auth.codex.refreshToken=refresh-seed"]]
]) {
  test(`Helm rejects a self-managed Secret with only a Codex ${name}`, {
    skip: !helmAvailable
  }, () => {
    const result = render(...args);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /auth\.codex\.accessToken and auth\.codex\.refreshToken must be set together/);
  });
}

test("Helm references optional Codex keys from an existing Secret", {
  skip: !helmAvailable
}, () => {
  const result = render(
    "--set-string",
    "auth.existingSecret=shared-auth"
  );

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Source: bot\/templates\/auth-secret\.yaml/);
  assert.match(result.stdout, /- name: CODEX_ACCESS_TOKEN\s+valueFrom:\s+secretKeyRef:\s+name: shared-auth\s+key: CODEX_ACCESS_TOKEN\s+optional: true/);
  assert.match(result.stdout, /- name: CODEX_REFRESH_TOKEN\s+valueFrom:\s+secretKeyRef:\s+name: shared-auth\s+key: CODEX_REFRESH_TOKEN\s+optional: true/);
});

for (const [name, args, message] of [
  ["multiple replicas", ["--set", "replicaCount=2"], "replicaCount must be 1"],
  ["a rolling strategy", ["--set-string", "strategy.type=RollingUpdate"], "strategy.type must be Recreate"]
]) {
  test(`Helm rejects ${name}`, { skip: !helmAvailable }, () => {
    const result = render(...configuredCodex, ...args);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(message.replaceAll(".", "\\.")));
  });
}
