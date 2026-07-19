import test from "node:test";
import assert from "node:assert/strict";
import { markdownChunk } from "../src/connectors/markdown-chunks.js";

function allChunks(source, maxLength) {
  const chunks = [];
  let offset = 0;
  while (offset < source.length) {
    const chunk = markdownChunk(source, offset, maxLength);
    assert.ok(chunk.text.length <= maxLength);
    assert.ok(chunk.text.trim(), "emitted platform text must never be blank");
    assert.ok(chunk.consumedLength > 0, "splitter must always make progress");
    chunks.push(chunk);
    offset += chunk.consumedLength;
  }
  assert.equal(offset, source.length);
  return chunks;
}

function assertRawProgress(source, maxLength) {
  let offset = 0;
  const consumed = [];
  while (offset < source.length) {
    const chunk = markdownChunk(source, offset, maxLength);
    assert.ok(chunk.text.length <= maxLength);
    assert.ok(chunk.consumedLength > 0);
    consumed.push(source.slice(offset, offset + chunk.consumedLength));
    offset += chunk.consumedLength;
    assert.equal(
      source[offset - 1] === "\r" && source[offset] === "\n",
      false,
      "chunk boundary must not bisect CRLF"
    );
  }
  assert.equal(consumed.join(""), source);
}

test("prefers paragraph, newline, and whitespace boundaries", () => {
  assert.equal(markdownChunk("first paragraph\n\nsecond paragraph", 0, 20).text, "first paragraph\n\n");
  assert.equal(markdownChunk("first line\nsecond line", 0, 16).text, "first line\n");
  assert.equal(markdownChunk("alpha beta gamma", 0, 12).text, "alpha beta ");
});

test("closes and resumes fenced code with its language", () => {
  const source = "```javascript\nconst alpha = 1;\nconst beta = 2;\n```\nafter";
  const chunks = allChunks(source, 32);
  assert.match(chunks[0].text, /\n```$/);
  assert.match(chunks[1].text, /^```javascript\n/);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.consumedLength, 0), source.length);
});

test("respects multi-backtick inline delimiters across chunks", () => {
  const source = "before ``code with ` inside and more text`` after";
  const chunks = allChunks(source, 24);
  assert.match(chunks[0].text, /``$/);
  assert.match(chunks[1].text, /^``/);
  for (const chunk of chunks) {
    assert.equal((chunk.text.match(/``/g) || []).length % 2, 0);
  }
});

test("unfinished streaming syntax remains valid and consumes only source", () => {
  const fence = markdownChunk("```js\nconst value = 1", 0, 40);
  assert.equal(fence.text, "```js\nconst value = 1\n```");
  assert.equal(fence.consumedLength, 21);

  const inline = markdownChunk("prefix `unfinished", 0, 40);
  assert.equal(inline.text, "prefix `unfinished`");
  assert.equal(inline.consumedLength, 18);
});

test("hard fallback limits keep progressing through long code", () => {
  const source = `\`\`\`txt\n${"x".repeat(100)}\n\`\`\``;
  const chunks = allChunks(source, 18);
  assert.ok(chunks.length > 2);
});

test("escaped backticks do not open code but even backslashes can", () => {
  assert.equal(markdownChunk("text \\`literal and more", 0, 18).text, "text \\`literal ");
  const even = markdownChunk("text \\\\`code continues", 0, 18);
  assert.match(even.text, /`$/);

  const oddAcrossBoundary = allChunks("aaaa\\`literal text", 5);
  assert.equal(oddAcrossBoundary[1].text.startsWith("`lite"), true);
  assert.equal(oddAcrossBoundary[1].text.endsWith("`"), false);

  const evenAcrossBoundary = allChunks("aaaa\\\\`code text", 6);
  assert.equal(evenAcrossBoundary[1].text.endsWith("`"), true);
});

test("fence closes only when the rest of its line is whitespace", () => {
  const source = "```js\nline\n```not-a-close\nmore code\n```\nafter";
  const chunks = allChunks(source, 32);
  const containingInvalidClose = chunks.find((chunk) => chunk.text.includes("not-a-close"));
  assert.ok(containingInvalidClose);
  assert.match(containingInvalidClose.text, /```$/);
});

test("CRLF fences and mixed inline plus fenced code retain valid boundaries", () => {
  const source = "`inline` then\r\n```ts\r\nconst x = `value`;\r\n```\t\r\nafter";
  assertRawProgress(source, 24);
  const chunks = allChunks(source, 24);
  assert.ok(chunks.some((chunk) => chunk.text.startsWith("```ts\n")));
});

test("whitespace-only input is consumed without stalling", () => {
  const chunk = markdownChunk("   \n\t  ", 0, 3);
  assert.deepEqual(chunk, { text: ".", consumedLength: 7 });
});

test("trailing and all-whitespace responses never produce an empty API payload", () => {
  const source = `${"a".repeat(12)} `;
  const first = markdownChunk(source, 0, 12);
  const trailing = markdownChunk(source, first.consumedLength, 12);
  assert.equal(first.text, "a".repeat(12));
  assert.deepEqual(trailing, { text: ".", consumedLength: 1 });
  assert.equal(trailing.text.trim().length > 0, true);

  const allWhitespace = markdownChunk(" \r\n\t", 0, 1);
  assert.deepEqual(allWhitespace, { text: ".", consumedLength: 4 });

  assert.deepEqual(markdownChunk(" x", 0, 1), { text: ".", consumedLength: 1 });
  assert.deepEqual(markdownChunk(`${" ".repeat(2000)}x`, 0, 2000), {
    text: ".",
    consumedLength: 2000
  });
  assert.deepEqual(markdownChunk("\rX", 0, 1), { text: ".", consumedLength: 1 });
});

test("never splits CRLF across chunks", () => {
  const source = "abc\r\ndef\r\nghi";
  let offset = 0;
  while (offset < source.length) {
    const chunk = markdownChunk(source, offset, 4);
    assert.equal(chunk.text.endsWith("\r"), false);
    assert.equal(chunk.text.startsWith("\n"), false);
    offset += chunk.consumedLength;
  }

  assert.deepEqual(markdownChunk("\r\nx", 0, 1), { text: ".", consumedLength: 2 });
  assert.equal(markdownChunk("\r\nx", 2, 1).text, "x");
});

test("tiny limits and oversized syntax degrade without truncating synthetic delimiters", () => {
  const sources = [
    "```language-name-that-is-much-too-long\nbody\n```",
    `${"`".repeat(20)}inline${"`".repeat(20)}`,
    "```js\nbody that keeps going"
  ];
  for (const source of sources) {
    for (let maxLength = 1; maxLength <= 12; maxLength += 1) {
      assertRawProgress(source, maxLength);
    }
  }


  const longRun = `${"`".repeat(20)}x`;
  let offset = 0;
  while (offset < longRun.length) {
    const chunk = markdownChunk(longRun, offset, 3);
    const raw = longRun.slice(offset, offset + chunk.consumedLength);
    assert.equal(chunk.text, raw, "raw degradation must not mix in synthetic delimiters");
    offset += chunk.consumedLength;
  }

  const invalidClose = "```js\nline\n```not-a-close\nmore\n```";
  offset = 0;
  while (offset < invalidClose.length) {
    const chunk = markdownChunk(invalidClose, offset, 3);
    assert.equal(
      chunk.text,
      invalidClose.slice(offset, offset + chunk.consumedLength),
      "tiny invalid-close chunks must not mix raw and synthetic fences"
    );
    offset += chunk.consumedLength;
  }
});

test("randomized inputs preserve source offsets and platform limits", () => {
  let seed = 0x12345678;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  const alphabet = ["a", " ", "\n", "\r", "\t", "`", "\\"];
  for (let sample = 0; sample < 200; sample += 1) {
    let source = "";
    const length = 1 + (next() % 120);
    for (let i = 0; i < length; i += 1) source += alphabet[next() % alphabet.length];
    assertRawProgress(source, 1 + (next() % 32));
  }
});
