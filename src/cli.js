import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createAiResponse, getAiConfig, getSystemPromptInfo } from "./ai.js";

const rl = readline.createInterface({ input, output });
const history = [];
const servicesFile = path.join(process.cwd(), "config", "services.json");
const { codexAuthFile } = getAiConfig();
const promptInfo = await getSystemPromptInfo();

async function loadCliModel() {
  const content = await fs.readFile(servicesFile, "utf8");
  const parsed = JSON.parse(content);
  const slackModel = parsed?.slack?.find((entry) => typeof entry?.model === "string" && entry.model.trim())?.model;
  if (slackModel) {
    return slackModel.trim();
  }

  const discordModel = parsed?.discord?.find(
    (entry) => typeof entry?.model === "string" && entry.model.trim()
  )?.model;
  if (discordModel) {
    return discordModel.trim();
  }

  throw new Error("No model found in config/services.json");
}

const model = await loadCliModel();

console.log("[cli] Codex chat test interface");
console.log(`[cli] model=${model}`);
console.log(`[cli] auth_file=${codexAuthFile}`);
console.log(
  `[cli] system_prompt source=${promptInfo.source} file=${promptInfo.file} length=${promptInfo.length}`
);
console.log("[cli] system_prompt_raw");
console.log(promptInfo.fullPrompt);
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
        model,
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
