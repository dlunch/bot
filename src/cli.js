import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import url from "node:url";
import { stdin as input, stdout as output } from "node:process";
import { createAiResponse, getAiConfig } from "./ai.js";

const servicesFile = path.join(process.cwd(), "config", "services.json");

function normalizeModels(entry) {
  if (Array.isArray(entry?.models) && entry.models.length > 0) {
    return entry.models.map((m) => String(m).trim()).filter(Boolean);
  }
  if (typeof entry?.model === "string" && entry.model.trim()) {
    return [entry.model.trim()];
  }
  return [];
}

export async function loadCliConfig() {
  const content = await fs.readFile(servicesFile, "utf8");
  const parsed = JSON.parse(content);
  const providers = parsed.providers || {};

  const findEntry = (entries = []) =>
    entries.find((entry) => normalizeModels(entry).length > 0);

  // Per architecture §5.11 / M-2: CLI intentionally skips IRC entries so the
  // IRC tool-free policy does not bleed into the CLI experience.
  const allEntries = [
    ...(parsed.slack || []).map((e) => ({ ...e, service: "slack", name: e.name || "slack" })),
    ...(parsed.discord || []).map((e) => ({ ...e, service: "discord", name: e.name || "discord" }))
  ];

  const entry = findEntry(allEntries);
  if (!entry) {
    throw new Error("No model found in config/services.json");
  }

  // Per architecture §5.11 / M-2: imageGeneration precedence for CLI is
  //   parsed.cli?.imageGeneration
  //     → parsed.slack[0].imageGeneration
  //     → parsed.discord[0].imageGeneration
  // IRC entries are skipped so their tool-free policy doesn't leak into CLI.
  // Per L-1: strict `=== true` so string "true"/1 do NOT opt in.
  const firstDefined = (...candidates) =>
    candidates.find((value) => value !== undefined);
  const imageGeneration =
    firstDefined(
      parsed.cli?.imageGeneration,
      (parsed.slack || [])[0]?.imageGeneration,
      (parsed.discord || [])[0]?.imageGeneration
    ) === true;

  return {
    models: normalizeModels(entry),
    providers,
    systemPrompt:
      typeof entry.systemPrompt === "string" && entry.systemPrompt.trim()
        ? entry.systemPrompt.trim()
        : undefined,
    imageGeneration,
    service: entry.service,
    name: entry.name
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
  const aiConfig = getAiConfig();
  const cliConfig = await loadCliConfig();

  console.log("[cli] chat test interface");
  console.log(`[cli] models=${cliConfig.models.join(",")}`);
  console.log(`[cli] service=${cliConfig.service}:${cliConfig.name}`);
  console.log(`[cli] auth_source=${aiConfig.codexAuthSource}`);
  console.log(`[cli] system_prompt=${cliConfig.systemPrompt ? "service" : "default"}`);
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
