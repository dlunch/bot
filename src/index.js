import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { getAiConfig } from "./ai.js";
import { startSlackBot } from "./connectors/slack.js";
import { startDiscordBot } from "./connectors/discord.js";
import { startIrcBot } from "./connectors/irc.js";

const defaultServicesFile = path.join(process.cwd(), "config", "services.json");

const maxThreadHistory = Number(process.env.MAX_THREAD_HISTORY || 20);
const slackStreamUpdateMs = Number(process.env.SLACK_STREAM_UPDATE_MS || 800);
const discordStreamUpdateMs = Number(process.env.DISCORD_STREAM_UPDATE_MS || 800);

export async function loadServicesConfig(filePath = defaultServicesFile) {
  const content = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(content);
  const normalizeOptionalString = (value) => {
    if (typeof value !== "string") {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  };

  const providers = parsed.providers || {};

  const normalizeModels = (entry) => {
    if (Array.isArray(entry.models) && entry.models.length > 0) {
      return entry.models.map((m) => String(m).trim()).filter(Boolean);
    }
    if (typeof entry.model === "string" && entry.model.trim()) {
      return [entry.model.trim()];
    }
    return [];
  };

  // Per architecture §5.11 / L-1: strict `=== true` so that truthy non-boolean
  // values (e.g. the string "true", or 1) do NOT opt into image generation.
  // This is also why we don't reuse `Boolean(...)` like `webSearch` does.
  const parseImageGeneration = (entry) => entry?.imageGeneration === true;

  const slack = (parsed.slack || []).map((entry) => ({
    name: entry.name || "slack",
    botToken: entry.botToken,
    appToken: entry.appToken,
    models: normalizeModels(entry),
    providers,
    webSearch: Boolean(entry.webSearch),
    imageGeneration: parseImageGeneration(entry),
    systemPrompt: normalizeOptionalString(entry.systemPrompt)
  }));

  const discord = (parsed.discord || []).map((entry) => ({
    name: entry.name || "discord",
    botToken: entry.botToken,
    models: normalizeModels(entry),
    providers,
    webSearch: Boolean(entry.webSearch),
    imageGeneration: parseImageGeneration(entry),
    systemPrompt: normalizeOptionalString(entry.systemPrompt)
  }));

  const cli = parsed.cli
    ? {
        models: normalizeModels(parsed.cli),
        providers,
        webSearch: Boolean(parsed.cli.webSearch),
        imageGeneration: parseImageGeneration(parsed.cli),
        systemPrompt: normalizeOptionalString(parsed.cli.systemPrompt)
      }
    : null;

  const irc = (parsed.irc || []).map((entry) => ({
    name: entry.name || "irc",
    server: typeof entry.server === "string" ? entry.server.trim() : entry.server,
    port: entry.port,
    ssl: Boolean(entry.ssl),
    tls: Boolean(entry.tls),
    nick: typeof entry.nick === "string" ? entry.nick.trim() : entry.nick,
    username: typeof entry.username === "string" ? entry.username.trim() : entry.username,
    realname: typeof entry.realname === "string" ? entry.realname.trim() : entry.realname,
    password: entry.password,
    channels: Array.isArray(entry.channels)
      ? entry.channels.map((channel) => String(channel).trim()).filter(Boolean)
      : [],
    sasl: entry?.sasl
      ? {
          enabled: Boolean(entry.sasl.enabled),
          mechanism:
            typeof entry.sasl.mechanism === "string" && entry.sasl.mechanism.trim()
              ? entry.sasl.mechanism.trim().toUpperCase()
              : "PLAIN",
          username:
            typeof entry.sasl.username === "string" ? entry.sasl.username.trim() : entry.sasl.username,
          password: entry.sasl.password
        }
      : null,
    models: normalizeModels(entry),
    providers,
    webSearch: Boolean(entry.webSearch),
    // IRC normalizes the field for config-shape consistency but the IRC
    // connector never forwards it to `createAiResponse` — it is an inert
    // field (see architecture.md §4 and PRD F5).
    imageGeneration: parseImageGeneration(entry),
    systemPrompt: normalizeOptionalString(entry.systemPrompt),
    maxMessageLength: entry.maxMessageLength,
    connectTimeoutMs: entry.connectTimeoutMs
  }));

  return { slack, discord, irc, cli };
}

function assertSlackConfig(config) {
  if (!config.botToken || !config.appToken) {
    throw new Error(`slack config missing tokens for name=${config.name}`);
  }

  if (!config.models?.length) {
    throw new Error(`slack config model/models is required for name=${config.name}`);
  }
}

function assertDiscordConfig(config) {
  if (!config.botToken) {
    throw new Error(`discord config missing botToken for name=${config.name}`);
  }

  if (!config.models?.length) {
    throw new Error(`discord config model/models is required for name=${config.name}`);
  }
}

function assertIrcConfig(config) {
  if (typeof config.server !== "string" || !config.server.trim()) {
    throw new Error(`irc config server is required for name=${config.name}`);
  }

  if (typeof config.nick !== "string" || !config.nick.trim()) {
    throw new Error(`irc config nick is required for name=${config.name}`);
  }

  if (!Array.isArray(config.channels) || !config.channels.length) {
    throw new Error(`irc config channels is required for name=${config.name}`);
  }

  if (!config.models?.length) {
    throw new Error(`irc config model/models is required for name=${config.name}`);
  }

  const saslEnabled =
    Boolean(config.sasl?.enabled) || Boolean(config.sasl?.username) || Boolean(config.sasl?.password);
  if (saslEnabled) {
    if (config.sasl?.mechanism && config.sasl.mechanism !== "PLAIN") {
      throw new Error(`irc config sasl.mechanism only supports PLAIN for name=${config.name}`);
    }

    if (typeof config.sasl?.username !== "string" || !config.sasl.username.trim()) {
      throw new Error(`irc config sasl.username is required for name=${config.name}`);
    }

    if (typeof config.sasl?.password !== "string" || !config.sasl.password.trim()) {
      throw new Error(`irc config sasl.password is required for name=${config.name}`);
    }
  }
}

async function main() {
  const stopHandlers = [];
  const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000);
  let isShuttingDown = false;

  async function shutdown(signal) {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    console.log(`[server] shutdown requested signal=${signal}`);

    const stopAll = Promise.allSettled(
      [...stopHandlers].reverse().map(async (handler) => {
        try {
          await handler();
        } catch (error) {
          console.error("[server] stop handler failed", error);
        }
      })
    );

    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve("timeout"), shutdownTimeoutMs);
    });

    const result = await Promise.race([stopAll, timeout]);
    if (result === "timeout") {
      console.error(`[server] shutdown timeout after ${shutdownTimeoutMs}ms`);
      process.exit(1);
      return;
    }

    console.log("[server] shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  const ai = getAiConfig();

  const services = await loadServicesConfig();

  const slackBots = services.slack || [];
  const discordBots = services.discord || [];
  const ircBots = services.irc || [];

  if (!slackBots.length && !discordBots.length && !ircBots.length) {
    throw new Error("No services configured. Add slack/discord/irc entries in config/services.json");
  }

  const commonOptions = {
    maxThreadHistory,
    slackStreamUpdateMs,
    discordStreamUpdateMs
  };

  for (const slackConfig of slackBots) {
    assertSlackConfig(slackConfig);
    const runtime = await startSlackBot(slackConfig, commonOptions);
    if (runtime?.stop) {
      stopHandlers.push(() => runtime.stop());
    }
  }

  for (const discordConfig of discordBots) {
    assertDiscordConfig(discordConfig);
    const runtime = await startDiscordBot(discordConfig, commonOptions);
    if (runtime?.stop) {
      stopHandlers.push(() => runtime.stop());
    }
  }

  for (const ircConfig of ircBots) {
    assertIrcConfig(ircConfig);
    const runtime = await startIrcBot(ircConfig, commonOptions);
    if (runtime?.stop) {
      stopHandlers.push(() => runtime.stop());
    }
  }

  console.log(
    `[server] services started slack=${slackBots.length} discord=${discordBots.length} irc=${ircBots.length} codex=${ai.hasRefreshToken} anthropic=${ai.hasAnthropicKey}`
  );
}

// Only auto-start when invoked directly (`node src/index.js`). Tests and
// ad-hoc imports (e.g. `node -e "import('./src/index.js')"`) just get the
// exported helpers — the bot does not connect to anything on import.
const isMain = (() => {
  try {
    return import.meta.url === url.pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  await main();
}
