import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";

const refreshEndpoint = "https://auth.openai.com/oauth/token";
const refreshClientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const expirySkewMs = 30_000;
const approvedOAuthErrorCodes = new Set([
  "access_denied",
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "unauthorized_client",
  "unsupported_grant_type"
]);

const defaultFileSystem = {
  readFile: (...args) => nodeFs.readFile(...args),
  mkdir: (...args) => nodeFs.mkdir(...args),
  open: (...args) => nodeFs.open(...args),
  chmod: (...args) => nodeFs.chmod(...args),
  rename: (...args) => nodeFs.rename(...args),
  unlink: (...args) => nodeFs.unlink(...args)
};

const defaultDependencies = {
  fs: defaultFileSystem,
  fetch: (...args) => globalThis.fetch(...args),
  now: () => Date.now(),
  randomUUID: () => nodeRandomUUID()
};

let dependencies = { ...defaultDependencies, fs: { ...defaultFileSystem } };
let authState;
let initializeInFlight;
let refreshInFlight;

function optionalEnvironmentValue(name) {
  const value = process.env[name];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function configuredAuthFile() {
  return optionalEnvironmentValue("CODEX_AUTH_FILE") || path.join(process.cwd(), "data", "codex-auth.json");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJwtClaims(token) {
  if (typeof token !== "string") {
    return undefined;
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return undefined;
  }
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return isPlainObject(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

function accountIdFromClaims(claims) {
  if (!claims) {
    return undefined;
  }
  const embeddedAuth = claims["https://api.openai.com/auth"];
  const candidates = [
    claims.chatgpt_account_id,
    isPlainObject(embeddedAuth) ? embeddedAuth.chatgpt_account_id : undefined,
    Array.isArray(claims.organizations) && isPlainObject(claims.organizations[0])
      ? claims.organizations[0].id
      : undefined
  ];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim();
}

function accountIdFromTokenClaims(tokens) {
  return (
    accountIdFromClaims(parseJwtClaims(tokens.id_token)) ||
    accountIdFromClaims(parseJwtClaims(tokens.access_token))
  );
}

function jwtExpiration(token) {
  const exp = parseJwtClaims(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}

function fingerprint(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function fileError(action, file, error) {
  const code =
    typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? ` (${error.code})` : "";
  return new Error(`Unable to ${action} Codex auth file ${file}${code}`);
}

function validateAuthDocument(document, file) {
  if (!isPlainObject(document) || !isPlainObject(document.tokens)) {
    throw new Error(`Codex auth file has an invalid document structure: ${file}`);
  }

  for (const field of ["access_token", "refresh_token", "id_token", "account_id"]) {
    if (document.tokens[field] !== undefined && typeof document.tokens[field] !== "string") {
      throw new Error(`Codex auth file has an invalid tokens.${field} field: ${file}`);
    }
  }
  return document;
}

function parseAuthDocument(raw, file) {
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new Error(`Codex auth file is not valid JSON: ${file}`);
  }
  return validateAuthDocument(document, file);
}

function normalizedState(document) {
  const accessToken = document.tokens.access_token?.trim() || undefined;
  const refreshToken = document.tokens.refresh_token?.trim() || undefined;
  const explicitAccountId = document.tokens.account_id?.trim() || undefined;
  return {
    accessToken,
    refreshToken,
    accountId: explicitAccountId || accountIdFromTokenClaims(document.tokens),
    accessTokenExpiresAt: jwtExpiration(accessToken)
  };
}

function safeStateFromDocument({
  authFile,
  source,
  document,
  raw,
  pendingDocument,
  pendingBlockedError,
  refreshBlockedError
}) {
  return {
    authFile,
    source,
    document,
    fingerprint: fingerprint(raw),
    ...normalizedState(document),
    pendingDocument,
    pendingBlockedError,
    refreshBlockedError
  };
}

function serializeDocument(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function persistDocument(authFile, document) {
  const directory = path.dirname(authFile);
  const temporaryFile = path.join(
    directory,
    `.${path.basename(authFile)}.${process.pid}.${dependencies.randomUUID()}.tmp`
  );
  const raw = serializeDocument(document);
  let handle;
  let directoryHandle;
  let temporaryCreated = false;
  let renamed = false;

  try {
    await dependencies.fs.mkdir(directory, { recursive: true });
    handle = await dependencies.fs.open(temporaryFile, "wx", 0o600);
    temporaryCreated = true;
    await handle.writeFile(raw, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await dependencies.fs.chmod(temporaryFile, 0o600);
    await dependencies.fs.rename(temporaryFile, authFile);
    renamed = true;
    directoryHandle = await dependencies.fs.open(directory, "r");
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = undefined;
    return raw;
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The original persistence error is the actionable one.
      }
    }
    if (directoryHandle) {
      try {
        await directoryHandle.close();
      } catch {
        // The original persistence error is the actionable one.
      }
    }
    if (temporaryCreated && !renamed) {
      try {
        await dependencies.fs.unlink(temporaryFile);
      } catch {
        // Only the exact temporary file from this call is eligible for cleanup.
      }
    }
    throw fileError("persist", authFile, error);
  }
}

async function readAuthFile(authFile, { optional = false } = {}) {
  let raw;
  try {
    raw = await dependencies.fs.readFile(authFile, "utf8");
  } catch (error) {
    if (optional && error?.code === "ENOENT") {
      return undefined;
    }
    throw fileError("read", authFile, error);
  }

  return {
    raw,
    document: parseAuthDocument(raw, authFile),
    fingerprint: fingerprint(raw)
  };
}

function credentialsFromState(state) {
  if (!state.accessToken) {
    return undefined;
  }
  return state.accountId
    ? { accessToken: state.accessToken, accountId: state.accountId }
    : { accessToken: state.accessToken };
}

function accessTokenIsUsable(state) {
  return (
    typeof state.accessTokenExpiresAt === "number" &&
    state.accessTokenExpiresAt > dependencies.now() + expirySkewMs
  );
}

function publishDocument(document, raw, source = "file", refreshBlockedError) {
  authState = safeStateFromDocument({
    authFile: authState.authFile,
    source,
    document,
    raw,
    refreshBlockedError
  });
}

async function persistPendingDocument() {
  const pendingDocument = authState.pendingDocument;
  const pendingBlockedError = authState.pendingBlockedError;
  const raw = await persistDocument(authState.authFile, pendingDocument);
  publishDocument(pendingDocument, raw, "file", pendingBlockedError);
  if (authState.refreshBlockedError) {
    throw new Error(authState.refreshBlockedError);
  }
  return credentialsFromState(authState);
}

function safeOAuthErrorCode(payload) {
  const candidates = [
    typeof payload?.error === "string" ? payload.error : undefined,
    isPlainObject(payload?.error) ? payload.error.code : undefined,
    payload?.code,
    isPlainObject(payload?.detail) ? payload.detail.code : undefined
  ];
  return candidates.find((value) => approvedOAuthErrorCodes.has(value));
}

async function requestRefresh(refreshToken) {
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", refreshToken);
  form.set("client_id", refreshClientId);

  let response;
  try {
    response = await dependencies.fetch(refreshEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });
  } catch {
    throw new Error("Codex token refresh request failed");
  }

  let raw;
  try {
    raw = await response.text();
  } catch {
    throw new Error(`Codex token refresh failed (HTTP ${response.status})`);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const code = safeOAuthErrorCode(payload);
    throw new Error(
      `Codex token refresh failed (HTTP ${response.status}${code ? `, ${code}` : ""})`
    );
  }
  if (!isPlainObject(payload)) {
    throw new Error("Codex token refresh failed: response is not a JSON object");
  }
  return payload;
}

function mergedRefreshDocument(document, payload) {
  const responseAccessToken =
    typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  const responseAccessExpiresAt = jwtExpiration(responseAccessToken);
  let blockedError;
  if (!responseAccessToken) {
    blockedError = "Codex token refresh failed: access_token is missing";
  } else if (responseAccessExpiresAt === undefined) {
    blockedError = "Codex token refresh failed: access_token must have a numeric JWT exp";
  } else if (responseAccessExpiresAt <= dependencies.now() + expirySkewMs) {
    blockedError =
      "Codex token refresh failed: access_token must remain valid for more than 30 seconds";
  }

  const tokens = { ...document.tokens };
  if (!blockedError) {
    tokens.access_token = responseAccessToken;
  }
  if (typeof payload.refresh_token === "string" && payload.refresh_token.trim()) {
    tokens.refresh_token = payload.refresh_token.trim();
  }
  if (typeof payload.id_token === "string" && payload.id_token.trim()) {
    tokens.id_token = payload.id_token.trim();
  }

  const directAccountId =
    typeof payload.account_id === "string" && payload.account_id.trim()
      ? payload.account_id.trim()
      : undefined;
  const derivedAccountId = accountIdFromTokenClaims({
    id_token: tokens.id_token,
    access_token: tokens.access_token
  });
  const accountId = directAccountId || derivedAccountId || tokens.account_id?.trim();
  if (accountId) {
    tokens.account_id = accountId;
  }

  return {
    document: {
      ...document,
      tokens,
      last_refresh: new Date(dependencies.now()).toISOString()
    },
    blockedError
  };
}

async function refreshAndPersist() {
  if (authState.pendingDocument) {
    return persistPendingDocument();
  }

  const disk = await readAuthFile(authState.authFile);
  if (disk.fingerprint !== authState.fingerprint) {
    authState = safeStateFromDocument({
      authFile: authState.authFile,
      source: "file",
      document: disk.document,
      raw: disk.raw
    });
    if (accessTokenIsUsable(authState)) {
      return credentialsFromState(authState);
    }
  }

  if (authState.refreshBlockedError) {
    throw new Error(authState.refreshBlockedError);
  }
  if (!authState.refreshToken) {
    throw new Error(`Codex authentication cannot refresh because refresh_token is missing: ${authState.authFile}`);
  }

  const payload = await requestRefresh(authState.refreshToken);
  const merged = mergedRefreshDocument(authState.document, payload);
  authState.pendingDocument = merged.document;
  authState.pendingBlockedError = merged.blockedError;
  return persistPendingDocument();
}

async function runRefresh() {
  if (!refreshInFlight) {
    refreshInFlight = refreshAndPersist();
    refreshInFlight.catch(() => {});
  }
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = undefined;
  }
}

export function getCodexAuthConfig() {
  return {
    authFile: authState?.authFile || configuredAuthFile(),
    hasBootstrapAccessToken: Boolean(optionalEnvironmentValue("CODEX_ACCESS_TOKEN")),
    hasBootstrapRefreshToken: Boolean(optionalEnvironmentValue("CODEX_REFRESH_TOKEN"))
  };
}

export async function initializeCodexAuth() {
  if (authState) {
    return {
      configured: Boolean(authState.document),
      source: authState.source,
      authFile: authState.authFile
    };
  }
  if (initializeInFlight) {
    return initializeInFlight;
  }

  initializeInFlight = (async () => {
    const authFile = configuredAuthFile();
    const disk = await readAuthFile(authFile, { optional: true });
    if (disk) {
      authState = safeStateFromDocument({
        authFile,
        source: "file",
        document: disk.document,
        raw: disk.raw
      });
      return { configured: true, source: "file", authFile };
    }

    const accessToken = optionalEnvironmentValue("CODEX_ACCESS_TOKEN");
    const refreshToken = optionalEnvironmentValue("CODEX_REFRESH_TOKEN");
    if (Boolean(accessToken) !== Boolean(refreshToken)) {
      throw new Error(
        "CODEX_ACCESS_TOKEN and CODEX_REFRESH_TOKEN must both be set when the Codex auth file does not exist"
      );
    }
    if (!accessToken) {
      authState = {
        authFile,
        source: "none",
        document: undefined,
        fingerprint: undefined,
        accessToken: undefined,
        refreshToken: undefined,
        accountId: undefined,
        accessTokenExpiresAt: undefined,
        pendingDocument: undefined,
        pendingBlockedError: undefined,
        refreshBlockedError: undefined
      };
      return { configured: false, source: "none", authFile };
    }

    const tokens = {
      access_token: accessToken,
      refresh_token: refreshToken
    };
    const accountId = accountIdFromTokenClaims(tokens);
    if (accountId) {
      tokens.account_id = accountId;
    }
    const document = {
      auth_mode: "chatgpt",
      tokens,
      last_refresh: new Date(dependencies.now()).toISOString()
    };
    const raw = await persistDocument(authFile, document);
    authState = safeStateFromDocument({
      authFile,
      source: "environment",
      document,
      raw
    });
    return { configured: true, source: "environment", authFile };
  })();

  try {
    return await initializeInFlight;
  } finally {
    initializeInFlight = undefined;
  }
}

export async function getCodexRequestCredentials() {
  await initializeCodexAuth();
  if (!authState.document) {
    return undefined;
  }
  if (authState.pendingDocument) {
    return runRefresh();
  }
  if (authState.refreshBlockedError) {
    throw new Error(authState.refreshBlockedError);
  }
  if (accessTokenIsUsable(authState)) {
    return credentialsFromState(authState);
  }
  return runRefresh();
}

export async function refreshCodexRequestCredentials(rejectedAccessToken) {
  await initializeCodexAuth();
  if (!authState.document) {
    throw new Error("Codex authentication is not configured");
  }
  if (authState.pendingDocument) {
    return runRefresh();
  }
  if (authState.refreshBlockedError) {
    throw new Error(authState.refreshBlockedError);
  }
  if (authState.accessToken && authState.accessToken !== rejectedAccessToken) {
    return credentialsFromState(authState);
  }
  return runRefresh();
}

export const __testing__ = {
  reset() {
    authState = undefined;
    initializeInFlight = undefined;
    refreshInFlight = undefined;
    dependencies = { ...defaultDependencies, fs: { ...defaultFileSystem } };
  },
  setDependencies(overrides) {
    if (overrides.fs) {
      dependencies.fs = { ...dependencies.fs, ...overrides.fs };
    }
    for (const key of ["fetch", "now", "randomUUID"]) {
      if (overrides[key]) {
        dependencies[key] = overrides[key];
      }
    }
  },
  parseJwtClaims,
  parseAuthDocument,
  getStateSnapshot() {
    if (!authState) {
      return undefined;
    }
    return {
      authFile: authState.authFile,
      source: authState.source,
      accessToken: authState.accessToken,
      refreshToken: authState.refreshToken,
      accountId: authState.accountId,
      accessTokenExpiresAt: authState.accessTokenExpiresAt,
      hasPendingDocument: Boolean(authState.pendingDocument),
      refreshBlocked: Boolean(authState.refreshBlockedError || authState.pendingBlockedError)
    };
  }
};
