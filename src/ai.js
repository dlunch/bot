const codexEndpoint = "https://chatgpt.com/backend-api/codex/responses";
const refreshEndpoint = "https://auth.openai.com/oauth/token";
const refreshClientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const refreshExpirySkewMs = 30_000;

const defaultSystemPrompt =
  "You are a concise and helpful assistant. Continue the conversation naturally using the context.";

let codexAuthState;
let refreshInFlight;

function readOptionalEnv(name) {
  if (typeof process.env[name] !== "string") {
    return undefined;
  }

  const trimmed = process.env[name].trim();
  return trimmed ? trimmed : undefined;
}

function parseJson(raw) {
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
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
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function extractAccountIdFromClaims(claims) {
  if (!claims || typeof claims !== "object") {
    return undefined;
  }

  const embeddedAuth = claims["https://api.openai.com/auth"];
  return (
    claims.chatgpt_account_id ||
    embeddedAuth?.chatgpt_account_id ||
    (Array.isArray(claims.organizations) && claims.organizations[0]?.id ? claims.organizations[0].id : undefined)
  );
}

function extractAccountIdFromTokens(tokens) {
  const idTokenClaims = parseJwtClaims(tokens?.id_token);
  const accountIdFromIdToken = extractAccountIdFromClaims(idTokenClaims);
  if (accountIdFromIdToken) {
    return accountIdFromIdToken;
  }

  const accessTokenClaims = parseJwtClaims(tokens?.access_token);
  return extractAccountIdFromClaims(accessTokenClaims);
}

function extractErrorDetail(raw, payload) {
  return (
    payload?.detail?.message ||
    payload?.detail?.code ||
    payload?.error_description ||
    payload?.error?.message ||
    payload?.error ||
    raw ||
    "unknown_error"
  );
}

function getCodexAuthState() {
  if (codexAuthState) {
    return codexAuthState;
  }

  const refreshToken = readOptionalEnv("CODEX_REFRESH_TOKEN");

  if (!refreshToken) {
    throw new Error("CODEX_REFRESH_TOKEN is required");
  }

  codexAuthState = {
    accessToken: undefined,
    refreshToken,
    accountId: undefined,
    accessTokenExpiresAt: undefined
  };

  return codexAuthState;
}

function shouldRefreshAccessToken(auth) {
  return Boolean(
    auth.refreshToken &&
      (!auth.accessToken ||
        (typeof auth.accessTokenExpiresAt === "number" && Date.now() >= auth.accessTokenExpiresAt))
  );
}

async function refreshCodexAccessToken() {
  const auth = getCodexAuthState();
  if (!auth.refreshToken) {
    throw new Error("CODEX_REFRESH_TOKEN is required to refresh access token");
  }

  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    const form = new URLSearchParams();
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", auth.refreshToken);
    form.set("client_id", refreshClientId);

    const refreshRes = await fetch(refreshEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    });

    const refreshRaw = await refreshRes.text();
    const refreshPayload = parseJson(refreshRaw);
    if (!refreshRes.ok) {
      throw new Error(`Codex token refresh failed: ${extractErrorDetail(refreshRaw, refreshPayload)}`);
    }

    const nextAccessToken =
      typeof refreshPayload?.access_token === "string" ? refreshPayload.access_token.trim() : "";
    if (!nextAccessToken) {
      throw new Error("Codex token refresh failed: access_token missing in refresh response");
    }

    const nextRefreshToken =
      typeof refreshPayload?.refresh_token === "string" && refreshPayload.refresh_token.trim()
        ? refreshPayload.refresh_token.trim()
        : auth.refreshToken;
    const nextAccountId = extractAccountIdFromTokens(refreshPayload) || auth.accountId;
    const expiresInSeconds = Number(refreshPayload?.expires_in);
    const nextAccessTokenExpiresAt =
      Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
        ? Date.now() + expiresInSeconds * 1000 - refreshExpirySkewMs
        : undefined;

    auth.accessToken = nextAccessToken;
    auth.refreshToken = nextRefreshToken;
    auth.accountId = nextAccountId;
    auth.accessTokenExpiresAt = nextAccessTokenExpiresAt;
    process.env.CODEX_REFRESH_TOKEN = nextRefreshToken;

    return auth;
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = undefined;
  }
}

async function requestCodexResponse(body, auth) {
  if (!auth.accessToken) {
    throw new Error("access token is unavailable; token refresh may have failed");
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${auth.accessToken}`,
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/"
  };
  if (auth.accountId) {
    headers["ChatGPT-Account-Id"] = auth.accountId;
  }

  return fetch(codexEndpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

function toResponsesInput(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
}

function extractOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  for (const item of response?.output || []) {
    if (item?.type !== "message") {
      continue;
    }

    for (const content of item?.content || []) {
      if (content?.type === "output_text" && content?.text?.trim()) {
        return content.text.trim();
      }
    }
  }

  return "";
}

function extractOutputTextFromEvent(event) {
  if (typeof event?.output_text === "string" && event.output_text.trim()) {
    return event.output_text.trim();
  }

  if (event?.response) {
    return extractOutputText(event.response);
  }

  return extractOutputText(event);
}

function parseSseResponse(raw) {
  let deltaText = "";
  let fallbackText = "";

  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }

    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") {
      continue;
    }

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }

    if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
      deltaText += event.delta;
      continue;
    }

    const maybeText = extractOutputTextFromEvent(event);
    if (maybeText) {
      fallbackText = maybeText;
    }
  }

  return deltaText.trim() || fallbackText.trim();
}

async function parseSseStream(stream, onDelta) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let deltaText = "";
  let fallbackText = "";

  const handleEventBlock = async (block) => {
    const lines = block.split("\n");
    const dataLines = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        dataLines.push(trimmed.slice(5).trim());
      }
    }

    if (!dataLines.length) {
      return;
    }

    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") {
      return;
    }

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }

    if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
      deltaText += event.delta;
      if (onDelta) {
        await onDelta(event.delta, deltaText);
      }
      return;
    }

    const maybeText = extractOutputTextFromEvent(event);
    if (maybeText) {
      fallbackText = maybeText;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const splitIndex = buffer.indexOf("\n\n");
      if (splitIndex === -1) {
        break;
      }

      const block = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);
      await handleEventBlock(block);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    await handleEventBlock(buffer);
  }

  return deltaText.trim() || fallbackText.trim();
}

export async function createAiResponse(context, options = {}) {
  const { onDelta, model: requestedModel, webSearch } = options;
  if (typeof requestedModel !== "string" || !requestedModel.trim()) {
    throw new Error("model is required for createAiResponse");
  }

  const auth = getCodexAuthState();
  if (shouldRefreshAccessToken(auth)) {
    await refreshCodexAccessToken();
  }

  const systemPrompt =
    typeof options.systemPrompt === "string" && options.systemPrompt.trim()
      ? options.systemPrompt.trim()
      : defaultSystemPrompt;
  const body = {
    model: requestedModel.trim(),
    instructions: systemPrompt,
    input: toResponsesInput(context),
    store: false,
    stream: true
  };

  if (webSearch) {
    body.tools = [{ type: "web_search" }];
  }

  let res = await requestCodexResponse(body, auth);
  if ((res.status === 401 || res.status === 403) && auth.refreshToken) {
    await refreshCodexAccessToken();
    res = await requestCodexResponse(body, auth);
  }

  if (!res.ok) {
    const raw = await res.text();
    const payload = parseJson(raw);
    throw new Error(`Codex request failed: ${extractErrorDetail(raw, payload)}`);
  }

  if (res.body) {
    return parseSseStream(res.body, onDelta);
  }

  const raw = await res.text();
  if (raw.includes("data:")) {
    return parseSseResponse(raw);
  }

  const payload = parseJson(raw);

  return extractOutputText(payload);
}

export function getAiConfig() {
  return {
    authMode: "codex_env",
    codexAuthSource: "env",
    hasRefreshToken: Boolean(process.env.CODEX_REFRESH_TOKEN?.trim())
  };
}
