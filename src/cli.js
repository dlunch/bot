import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createAiResponse, getAiConfig } from "./ai.js";

const rl = readline.createInterface({ input, output });
const history = [];
const servicesFile = path.join(process.cwd(), "config", "services.json");
const aiConfig = getAiConfig();

function normalizeModels(entry) {
  if (Array.isArray(entry?.models) && entry.models.length > 0) {
    return entry.models.map((m) => String(m).trim()).filter(Boolean);
  }
  if (typeof entry?.model === "string" && entry.model.trim()) {
    return [entry.model.trim()];
  }
  return [];
}

async function loadCliConfig() {
  const content = await fs.readFile(servicesFile, "utf8");
  const parsed = JSON.parse(content);
  const providers = parsed.providers || {};

  const findEntry = (entries = []) =>
    entries.find((entry) => normalizeModels(entry).length > 0);

  const allEntries = [
    ...(parsed.slack || []).map((e) => ({ ...e, service: "slack", name: e.name || "slack" })),
    ...(parsed.discord || []).map((e) => ({ ...e, service: "discord", name: e.name || "discord" })),
    ...(parsed.irc || []).map((e) => ({ ...e, service: "irc", name: e.name || "irc" }))
  ];

  const entry = findEntry(allEntries);
  if (!entry) {
    throw new Error("No model found in config/services.json");
  }

  return {
    models: normalizeModels(entry),
    providers,
    systemPrompt:
      typeof entry.systemPrompt === "string" && entry.systemPrompt.trim()
        ? entry.systemPrompt.trim()
        : undefined,
    service: entry.service,
    name: entry.name
  };
}

const cliConfig = await loadCliConfig();

console.log("[cli] chat test interface");
console.log(`[cli] models=${cliConfig.models.join(",")}`);
console.log(`[cli] service=${cliConfig.service}:${cliConfig.name}`);
console.log(`[cli] auth_source=${aiConfig.codexAuthSource}`);
console.log(`[cli] system_prompt=${cliConfig.systemPrompt ? "service" : "default"}`);
console.log("[cli] /reset to clear context, /exit to quit\n");

while (true) {
  const text = (await rl.question("you> ")).trim();

  if (!text) {
    continue;
  }

  if (text === "/exit") {
    break;
  }

  if (text === "/reset") {
    history.length = 0;
    console.log("assistant> context cleared\n");
    continue;
  }

  history.push({ role: "user", content: text });

  try {
    let started = false;
    const answer =
      (await createAiResponse(history, {
        models: cliConfig.models,
        providers: cliConfig.providers,
        systemPrompt: cliConfig.systemPrompt,
        onDelta: (delta) => {
          if (!delta) {
            return;
          }

          if (!started) {
            process.stdout.write("assistant> ");
            started = true;
          }

          process.stdout.write(delta);
        }
      })) || "응답을 생성하지 못했어요.";

    if (started) {
      process.stdout.write("\n\n");
    } else {
      console.log(`assistant> ${answer}\n`);
    }

    history.push({ role: "assistant", content: answer });
  } catch (error) {
    console.error(`assistant> error: ${error.message}\n`);
  }
}

rl.close();
