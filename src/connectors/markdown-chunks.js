function backtickRunAt(text, index) {
  let end = index;
  while (text[end] === "`") end += 1;
  return end - index;
}

function isEscaped(text, index, precedingSlashes = 0) {
  let slashes = index === 0 ? precedingSlashes : 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function fenceCanClose(text, afterRun, lookahead) {
  const rest = `${text.slice(afterRun)}${lookahead}`;
  return /^[ \t]*(?:\r?\n|$)/.test(rest);
}

function scanMarkdown(text, initialContext = null, lookahead = "") {
  let state = initialContext?.state ? { ...initialContext.state } : null;
  let lineStart = initialContext?.lineStart ?? true;
  const precedingSlashes = initialContext?.trailingSlashes || 0;

  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (char === "\n") {
      lineStart = true;
      i += 1;
      continue;
    }
    if (char !== "`") {
      if (lineStart && char !== " " && char !== "\t" && char !== "\r") lineStart = false;
      i += 1;
      continue;
    }

    const runLength = backtickRunAt(text, i);
    if (isEscaped(text, i, precedingSlashes)) {
      lineStart = false;
      i += runLength;
      continue;
    }

    if (state?.type === "fence") {
      if (
        lineStart &&
        runLength >= state.delimiter.length &&
        fenceCanClose(text, i + runLength, lookahead)
      ) {
        state = null;
      }
    } else if (state?.type === "inline") {
      if (runLength === state.delimiter.length) state = null;
    } else if (lineStart && runLength >= 3) {
      const newline = text.indexOf("\n", i + runLength);
      const infoEnd = newline === -1 ? text.length : newline;
      const info = text.slice(i + runLength, infoEnd).replace(/\r$/, "").trim();
      state = { type: "fence", delimiter: "`".repeat(runLength), info };
    } else {
      state = { type: "inline", delimiter: "`".repeat(runLength) };
    }
    lineStart = false;
    i += runLength;
  }
  let trailingSlashes = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === "\\"; i -= 1) trailingSlashes += 1;
  if (trailingSlashes === text.length) trailingSlashes += precedingSlashes;
  return { state, lineStart, trailingSlashes };
}

function openingFor(state) {
  if (!state) return "";
  return state.type === "fence"
    ? `${state.delimiter}${state.info || ""}\n`
    : state.delimiter;
}

function closingFor(state, content) {
  if (!state) return "";
  return state.type === "fence"
    ? `${content.endsWith("\n") ? "" : "\n"}${state.delimiter}`
    : state.delimiter;
}

function safeBoundary(text, limit) {
  if (text.length <= limit) return text.length;
  const minimumUseful = Math.floor(limit * 0.5);
  for (const separator of ["\n\n", "\r\n\r\n", "\n", "\r\n", " ", "\t"]) {
    const found = text.lastIndexOf(separator, Math.max(0, limit - separator.length));
    if (found >= minimumUseful) return found + separator.length;
  }

  // Keep Windows newlines atomic. At index zero a maxLength of one cannot
  // carry CRLF losslessly; markdownChunk handles that whitespace-only prefix
  // with a placeholder while consuming both source characters.
  if (text[limit - 1] === "\r" && text[limit] === "\n" && limit > 1) {
    return limit - 1;
  }

  if (text[limit - 1] === "`" && text[limit] === "`") {
    let runStart = limit - 1;
    while (runStart > 0 && text[runStart - 1] === "`") runStart -= 1;
    if (runStart > 0) return runStart;
  }
  return limit;
}

function rawChunk(remaining, maxLength) {
  const consumedLength = safeBoundary(remaining, maxLength);
  return result(remaining.slice(0, consumedLength), consumedLength);
}

function result(text, consumedLength) {
  return { text: text.trim() ? text : ".", consumedLength };
}

function bisectsBacktickRun(source, offset) {
  return offset > 0 && offset < source.length && source[offset - 1] === "`" && source[offset] === "`";
}

/**
 * Produce one platform-sized Markdown chunk from raw streamed text.
 *
 * Synthetic close/reopen delimiters are excluded from `consumedLength`. When
 * even one raw character plus complete synthetic delimiters cannot fit (tiny
 * limits, huge fence info, or huge delimiter runs), formatting repair is
 * deliberately omitted and raw source is sent losslessly. A raw delimiter run
 * longer than the platform limit is necessarily hard-split, but no synthetic
 * delimiter is ever truncated.
 */
export function markdownChunk(source, offset, maxLength) {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new RangeError("maxLength must be a positive integer");
  }
  const remaining = source.slice(offset);
  if (!remaining.length) return { text: ".", consumedLength: 0 };
  if (!remaining.trim()) return { text: ".", consumedLength: remaining.length };
  if (maxLength === 1 && remaining.startsWith("\r\n")) {
    return { text: ".", consumedLength: 2 };
  }
  if (bisectsBacktickRun(source, offset)) return rawChunk(remaining, maxLength);

  const initialContext = scanMarkdown(source.slice(0, offset), null, remaining);
  const prefix = openingFor(initialContext.state);
  if (prefix.length + 1 > maxLength) return rawChunk(remaining, maxLength);

  let consumedLength = safeBoundary(remaining, maxLength - prefix.length);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = remaining.slice(0, consumedLength);
    if (bisectsBacktickRun(source, offset + consumedLength)) {
      return rawChunk(remaining, maxLength);
    }
    const endState = scanMarkdown(candidate, initialContext, remaining.slice(consumedLength)).state;
    const suffix = closingFor(endState, `${prefix}${candidate}`);
    const available = maxLength - prefix.length - suffix.length;
    if (available < 1) return rawChunk(remaining, maxLength);

    const nextLength = safeBoundary(remaining, available);
    if (nextLength === consumedLength) {
      const text = `${prefix}${candidate}${suffix}`;
      return text.length <= maxLength
        ? result(text, consumedLength)
        : rawChunk(remaining, maxLength);
    }
    consumedLength = nextLength;
  }

  // Defensive degradation: the boundary calculation should converge, but a
  // raw chunk is always preferable to truncating synthetic syntax or stalling.
  return rawChunk(remaining, maxLength);
}
