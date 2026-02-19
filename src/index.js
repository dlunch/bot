import fs from "node:fs/promises";
import path from "node:path";
import { getAiConfig, getSystemPromptInfo } from "./ai.js";
import { startSlackBot } from "./connectors/slack.js";
import { startDiscordBot } from "./connectors/discord.js";

const servicesFile = path.join(process.cwd(), "config", "services.json");

const maxThreadHistory = Number(process.env.MAX_THREAD_HISTORY || 20);
const slackStreamUpdateMs = Number(process.env.SLACK_STREAM_UPDATE_MS || 800);
const discordStreamUpdateMs = Number(process.env.DISCORD_STREAM_UPDATE_MS || 800);

async function loadServicesConfig() {
  const content = await fs.readFile(servicesFile, "utf8");
  const parsed = JSON.parse(content);

  const slack = (parsed.slack || []).map((entry) => ({
    name: entry.name || "slack",
    botToken: entry.botToken,
    appToken: entry.appToken,
    model: entry.model
  }));

  const discord = (parsed.discord || []).map((entry) => ({
    name: entry.name || "discord",
    botToken: entry.botToken,
    model: entry.model
  }));

  return { slack, discord };
}

function assertSlackConfig(config) {
  if (!config.botToken || !config.appToken) {
    throw new Error(`slack config missing tokens for name=${config.name}`);
  }

  if (typeof config.model !== "string" || !config.model.trim()) {
    throw new Error(`slack config model is required for name=${config.name}`);
  }
}

function assertDiscordConfig(config) {
  if (!config.botToken) {
    throw new Error(`discord config missing botToken for name=${config.name}`);
  }

  if (typeof config.model !== "string" || !config.model.trim()) {
    throw new Error(`discord config model is required for name=${config.name}`);
  }
}

(async () => {
  const ai = getAiConfig();
  const systemPromptInfo = await getSystemPromptInfo();
  console.log(
    `[config] system_prompt source=${systemPromptInfo.source} file=${systemPromptInfo.file} length=${systemPromptInfo.length}`
  );
  console.log("[config] system_prompt_raw");
  console.log(systemPromptInfo.fullPrompt);

  const services = await loadServicesConfig();

  const slackBots = services.slack || [];
  const discordBots = services.discord || [];

  if (!slackBots.length && !discordBots.length) {
    throw new Error("No services configured. Add slack/discord entries in config/services.json");
  }

  const commonOptions = {
    systemPromptInfo,
    maxThreadHistory,
    slackStreamUpdateMs,
    discordStreamUpdateMs
  };

  for (const slackConfig of slackBots) {
    assertSlackConfig(slackConfig);
    await startSlackBot(slackConfig, commonOptions);
  }

  for (const discordConfig of discordBots) {
    assertDiscordConfig(discordConfig);
    await startDiscordBot(discordConfig, commonOptions);
  }

  console.log(
    `[server] services started slack=${slackBots.length} discord=${discordBots.length} auth=${ai.authMode}`
  );
})();
