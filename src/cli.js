import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createAiResponse, getAiConfig } from "./ai.js";

const rl = readline.createInterface({ input, output });
const history = [];
const servicesFile = path.join(process.cwd(), "config", "services.json");
const aiConfig = getAiConfig();

async function loadCliConfig() {
  const content = await fs.readFile(servicesFile, "utf8");
  const parsed = JSON.parse(content);
  const findEntry = (entries = []) =>
    entries.find((entry) => typeof entry?.model === "string" && entry.model.trim());

  const slackEntry = findEntry(parsed?.slack || []);
  if (slackEntry) {
    return {
      model: slackEntry.model.trim(),
      systemPrompt:
        typeof slackEntry.systemPrompt === "string" && slackEntry.systemPrompt.trim()
          ? slackEntry.systemPrompt.trim()
          : undefined,
      service: "slack",
      name: slackEntry.name || "slack"
    };
  }

  const discordEntry = findEntry(parsed?.discord || []);
  if (discordEntry) {
    return {
      model: discordEntry.model.trim(),
      systemPrompt:
        typeof discordEntry.systemPrompt === "string" && discordEntry.systemPrompt.trim()
          ? discordEntry.systemPrompt.trim()
          : undefined,
      service: "discord",
      name: discordEntry.name || "discord"
    };
  }

  const ircEntry = findEntry(parsed?.irc || []);
  if (ircEntry) {
    return {
      model: ircEntry.model.trim(),
      systemPrompt:
        typeof ircEntry.systemPrompt === "string" && ircEntry.systemPrompt.trim()
          ? ircEntry.systemPrompt.trim()
          : undefined,
      service: "irc",
      name: ircEntry.name || "irc"
    };
  }

  throw new Error("No model found in config/services.json");
}

const cliConfig = await loadCliConfig();

console.log("[cli] Codex chat test interface");
console.log(`[cli] model=${cliConfig.model}`);
console.log(`[cli] service=${cliConfig.service}:${cliConfig.name}`);
console.log(`[cli] auth_source=${aiConfig.codexAuthSource}`);
console.log(`[cli] auth_has_access_token=${aiConfig.hasAccessToken}`);
console.log(`[cli] auth_has_refresh_token=${aiConfig.hasRefreshToken}`);
console.log(`[cli] auth_has_account_id=${aiConfig.hasAccountId}`);
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
        model: cliConfig.model,
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
