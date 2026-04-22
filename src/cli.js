import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import url from "node:url";
import { stdin as input, stdout as output } from "node:process";
import { createAiResponse, getAiConfig } from "./ai.js";

const servicesFile = path.join(process.cwd(), "config", "services.json");
const codexAuthFile = path.join(os.homedir(), ".codex", "auth.json");

function normalizeModels(entry) {
  if (Array.isArray(entry?.models) && entry.models.length > 0) {
    return entry.models.map((m) => String(m).trim()).filter(Boolean);
  }
  if (typeof entry?.model === "string" && entry.model.trim()) {
    return [entry.model.trim()];
  }
  return [];
}

/**
 * Bootstrap Codex auth from `~/.codex/auth.json` for the CLI.
 *
 * Priority: auth.json.tokens.refresh_token → process.env.CODEX_REFRESH_TOKEN.
 * If auth.json is present, its refresh token takes precedence and we route
 * rotation I/O into a temp file so nothing gets written under the project's
 * cwd. Rotated tokens are synced back into auth.json after each turn via
 * `syncCodexAuth`.
 *
 * Returns `null` when auth.json is missing (ai.js falls back to env).
 */
export async function loadCodexAuthFromCodexHome() {
  let content;
  try {
    content = await fs.readFile(codexAuthFile, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      return null;
    }
    throw err;
  }

  const parsed = JSON.parse(content);
  const refreshToken = parsed?.tokens?.refresh_token;
  if (typeof refreshToken !== "string" || !refreshToken.trim()) {
    return null;
  }

  process.env.CODEX_REFRESH_TOKEN = refreshToken;
  if (!process.env.CODEX_REFRESH_TOKEN_FILE) {
    process.env.CODEX_REFRESH_TOKEN_FILE = path.join(
      os.tmpdir(),
      `codex-cli-refresh-${process.pid}`
    );
  }

  return { parsed, refreshToken };
}

/**
 * Write the latest in-memory refresh token back into `~/.codex/auth.json`,
 * preserving all other fields. No-op when the token hasn't rotated.
 */
export async function syncCodexAuth(state) {
  if (!state) {
    return;
  }
  const current = process.env.CODEX_REFRESH_TOKEN;
  if (!current || current === state.refreshToken) {
    return;
  }
  const next = {
    ...state.parsed,
    tokens: { ...(state.parsed.tokens || {}), refresh_token: current }
  };
  await fs.writeFile(codexAuthFile, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  state.parsed = next;
  state.refreshToken = current;
}

export async function loadCliConfig() {
  const content = await fs.readFile(servicesFile, "utf8");
  const parsed = JSON.parse(content);
  const providers = parsed.providers || {};
  const cliSection = parsed.cli;

  if (!cliSection || typeof cliSection !== "object") {
    throw new Error("config.cli section is required in config/services.json");
  }

  const models = normalizeModels(cliSection);
  if (!models.length) {
    throw new Error("config.cli.model(s) is required");
  }

  return {
    models,
    providers,
    systemPrompt:
      typeof cliSection.systemPrompt === "string" && cliSection.systemPrompt.trim()
        ? cliSection.systemPrompt.trim()
        : undefined,
    webSearch: Boolean(cliSection.webSearch),
    imageGeneration: cliSection.imageGeneration === true,
    name: cliSection.name || "cli"
  };
}

/**
 * Format a Date as `YYYYMMDD-HHMMSS` using local time.
 * The CLI uses a single base timestamp per turn; if more than one image is
 * produced in the same turn, subsequent files are suffixed with `-2`, `-3`, ...
 * (so clashes within a sub-second burst remain deterministic).
 */
function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

/**
 * Save collected images to the current working directory.
 *
 * @param {Array<{ buffer: Buffer, revisedPrompt?: string, id?: string }>} images
 * @param {{ nowFn?: () => Date, baseDir?: string, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} [opts]
 * @returns {Promise<Array<{ path: string, revisedPrompt?: string }>>}
 */
export async function saveCliImages(images, opts = {}) {
  const nowFn = typeof opts.nowFn === "function" ? opts.nowFn : () => new Date();
  const baseDir = typeof opts.baseDir === "string" && opts.baseDir
    ? opts.baseDir
    : process.cwd();
  const out = opts.stdout || process.stdout;
  const err = opts.stderr || process.stderr;

  if (!Array.isArray(images) || images.length === 0) {
    return [];
  }

  // Base timestamp captured once per invocation — all images from a single turn
  // share the same `YYYYMMDD-HHMMSS`, disambiguated by an `-N` suffix.
  const ts = formatTimestamp(nowFn());
  const saved = [];

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const buffer = image?.buffer;
    const revisedPrompt = image?.revisedPrompt;
    const id = image?.id;
    const suffix = i === 0 ? "" : `-${i + 1}`;
    const filename = `image-${ts}${suffix}.png`;
    const absPath = path.resolve(baseDir, filename);

    try {
      await fs.writeFile(absPath, buffer);
      // H-3: Korean labels are intentional (user-facing, per task prompt).
      // The absolute vs relative path decision: use `./<filename>` in stdout
      // since baseDir === cwd in the typical interactive case. This matches
      // the spec intent (short, container-path-free) while keeping `path`
      // in the returned object absolute for programmatic callers.
      const displayPath = `.${path.sep}${filename}`;
      out.write(`저장됨: ${displayPath}\n`);
      if (revisedPrompt) {
        out.write(`  프롬프트: ${revisedPrompt}\n`);
      }
      saved.push(revisedPrompt ? { path: absPath, revisedPrompt } : { path: absPath });
    } catch (error) {
      const idPart = id ? ` ${id}` : "";
      err.write(`이미지 저장 실패${idPart}: ${error.message}\n`);
      // Intentionally continue with the next image (see architecture §6.2 E6).
    }
  }

  return saved;
}

async function main() {
  const rl = readline.createInterface({ input, output });
  const history = [];
  const codexAuth = await loadCodexAuthFromCodexHome();
  const aiConfig = getAiConfig();
  const cliConfig = await loadCliConfig();

  console.log("[cli] chat test interface");
  console.log(`[cli] models=${cliConfig.models.join(",")}`);
  console.log(`[cli] name=${cliConfig.name}`);
  console.log(`[cli] auth_source=${codexAuth ? "codex-home" : aiConfig.codexAuthSource}`);
  console.log(`[cli] system_prompt=${cliConfig.systemPrompt ? "service" : "default"}`);
  console.log(`[cli] web_search=${cliConfig.webSearch ? "on" : "off"}`);
  console.log(`[cli] image_generation=${cliConfig.imageGeneration ? "on" : "off"}`);
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
      const collected = [];
      // B5: image generation is now config-driven via `loadCliConfig`
      // (precedence: parsed.cli.imageGeneration → slack[0] → discord[0];
      // IRC is skipped per M-2). onImage is only wired up when the flag is
      // on, so that imageGeneration=false is a pure no-op.
      const imageGenerationEnabled = cliConfig.imageGeneration === true;
      const answer =
        (await createAiResponse(history, {
          models: cliConfig.models,
          providers: cliConfig.providers,
          systemPrompt: cliConfig.systemPrompt,
          webSearch: cliConfig.webSearch,
          imageGeneration: imageGenerationEnabled,
          onImage: imageGenerationEnabled
            ? (buffer, meta) => {
                collected.push({
                  buffer,
                  revisedPrompt: meta?.revisedPrompt,
                  id: meta?.id
                });
              }
            : undefined,
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
        })) || "";

      if (started) {
        process.stdout.write("\n\n");
      } else if (answer) {
        console.log(`assistant> ${answer}\n`);
      }

      if (collected.length > 0) {
        try {
          await saveCliImages(collected);
        } catch (error) {
          // saveCliImages handles per-image failures internally; this catch
          // only triggers on a truly unexpected error (e.g. nowFn throwing).
          console.error(`[cli] 이미지 저장 중 예기치 못한 오류: ${error.message}`);
        }
      }

      const historyAnswer = answer || (collected.length > 0 ? "(이미지 응답)" : "");
      if (!historyAnswer) {
        console.log("assistant> 응답을 생성하지 못했어요.\n");
        history.pop();
        continue;
      }

      history.push({ role: "assistant", content: historyAnswer });
    } catch (error) {
      console.error(`assistant> error: ${error.message}\n`);
    }

    try {
      await syncCodexAuth(codexAuth);
    } catch (err) {
      console.error(`[cli] auth.json 동기화 실패: ${err.message}`);
    }
  }

  rl.close();
}

// Only auto-run the interactive loop when this file is invoked as a script
// (`node src/cli.js`). When imported by tests, we just expose the helpers.
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
