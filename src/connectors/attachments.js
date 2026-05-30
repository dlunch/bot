export const maxTextFileChars = 50000;
export const maxTextFilesInContext = 5;

const textMimeAllowlist = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-yaml",
  "application/yaml",
  "application/x-sh",
  "application/x-shellscript",
  "application/toml",
  "application/x-toml",
  "application/csv",
  "application/sql"
]);

const textExtAllowlist = new Set([
  "txt", "md", "markdown", "rst",
  "json", "jsonl", "ndjson", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties",
  "csv", "tsv", "log",
  "js", "mjs", "cjs", "ts", "tsx", "jsx",
  "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "scala",
  "c", "h", "cc", "cpp", "hpp", "cs", "m", "mm", "php", "pl", "lua", "r", "dart",
  "sh", "bash", "zsh", "fish", "ps1",
  "sql", "graphql", "gql",
  "html", "htm", "css", "scss", "sass", "less", "vue", "svelte",
  "dockerfile", "gitignore", "editorconfig", "diff", "patch"
]);

function extensionOf(name) {
  if (typeof name !== "string") {
    return "";
  }
  const base = name.split("/").pop();
  // Extension-less dotfiles like "Dockerfile" / ".gitignore" key off the name itself.
  if (!base.includes(".") || base.startsWith(".")) {
    return base.replace(/^\./, "").toLowerCase();
  }
  return base.slice(base.lastIndexOf(".") + 1).toLowerCase();
}

export function isTextLike(name, mime) {
  if (typeof mime === "string" && mime) {
    const base = mime.split(";")[0].trim().toLowerCase();
    if (base.startsWith("text/")) {
      return true;
    }
    if (textMimeAllowlist.has(base)) {
      return true;
    }
  }
  return textExtAllowlist.has(extensionOf(name));
}

async function readCappedText(res, maxChars) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const full = await res.text();
    return { text: full.slice(0, maxChars), truncated: full.length > maxChars };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let streamEnded = false;
  while (text.length < maxChars) {
    const { done, value } = await reader.read();
    if (done) {
      streamEnded = true;
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  reader.cancel().catch(() => {});
  const truncated = !streamEnded || text.length > maxChars;
  return { text: text.slice(0, maxChars), truncated };
}

function formatTextBlock(name, text, truncated) {
  const header = truncated
    ? `[attached file: ${name} (truncated to ${maxTextFileChars} chars)]`
    : `[attached file: ${name}]`;
  return `${header}\n${text}`;
}

export async function fetchTextAttachmentBlock({ url, name, headers }) {
  if (!url) {
    return null;
  }
  const label = name || "file";
  try {
    const res = await fetch(url, headers ? { headers } : undefined);
    if (!res.ok) {
      console.warn(`[attachment] http ${res.status} name=${label}`);
      return null;
    }
    const { text, truncated } = await readCappedText(res, maxTextFileChars);
    if (!text.trim()) {
      return null;
    }
    return formatTextBlock(label, text, truncated);
  } catch (err) {
    console.warn(`[attachment] fetch failed name=${label}`, err);
    return null;
  }
}
