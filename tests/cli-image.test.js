// Unit tests for B4 (CLI image saving).
// Uses Node's built-in test runner (node --test). No external deps.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { saveCliImages } from "../src/cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect writes to a stream so we can assert on the CLI stdout/stderr output
 * without actually polluting the real process streams.
 */
function makeWritable() {
  const chunks = [];
  return {
    write(str) {
      chunks.push(String(str));
      return true;
    },
    get text() {
      return chunks.join("");
    },
    get lines() {
      return chunks.join("").split("\n");
    }
  };
}

/** Create a fresh temp directory and return { dir, cleanup }. */
async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-image-test-"));
  return {
    dir,
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

/**
 * Build a freezing nowFn so the generated timestamp is deterministic.
 * 2026-04-22 15:30:45 local time.
 */
function frozenNow() {
  return new Date(2026, 3, 22, 15, 30, 45);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("(A) single image → saved as image-<ts>.png with correct bytes", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const stdout = makeWritable();
    const stderr = makeWritable();
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);

    const saved = await saveCliImages(
      [{ buffer: buf }],
      { nowFn: frozenNow, baseDir: dir, stdout, stderr }
    );

    assert.equal(saved.length, 1);
    assert.equal(saved[0].path, path.resolve(dir, "image-20260422-153045.png"));

    // File exists with correct bytes.
    const onDisk = await fs.readFile(saved[0].path);
    assert.deepEqual(Array.from(onDisk), Array.from(buf));

    // stdout has `저장됨: ./<filename>` line (relative form per H-3 fix).
    assert.ok(stdout.text.includes("저장됨:"), `stdout missing '저장됨:' — got ${stdout.text}`);
    assert.ok(
      stdout.text.includes(`.${path.sep}image-20260422-153045.png`),
      `stdout missing relative path — got ${stdout.text}`
    );
    // saved[0].path remains absolute for programmatic callers.
    assert.equal(saved[0].path, path.resolve(dir, "image-20260422-153045.png"));

    // No stderr output on success.
    assert.equal(stderr.text, "");
  } finally {
    await cleanup();
  }
});

test("(B) three images in same turn → -2 and -3 suffixes", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const stdout = makeWritable();
    const stderr = makeWritable();
    const imgs = [
      { buffer: Buffer.from("aaaa") },
      { buffer: Buffer.from("bbbb") },
      { buffer: Buffer.from("cccc") }
    ];

    const saved = await saveCliImages(imgs, {
      nowFn: frozenNow,
      baseDir: dir,
      stdout,
      stderr
    });

    assert.equal(saved.length, 3);
    assert.equal(path.basename(saved[0].path), "image-20260422-153045.png");
    assert.equal(path.basename(saved[1].path), "image-20260422-153045-2.png");
    assert.equal(path.basename(saved[2].path), "image-20260422-153045-3.png");

    // All three exist with correct content.
    for (let i = 0; i < 3; i++) {
      const onDisk = await fs.readFile(saved[i].path);
      assert.deepEqual(Array.from(onDisk), Array.from(imgs[i].buffer));
    }
  } finally {
    await cleanup();
  }
});

test("(C) revised_prompt printed after saved: line", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const stdout = makeWritable();
    const stderr = makeWritable();

    const saved = await saveCliImages(
      [
        {
          buffer: Buffer.from("zz"),
          revisedPrompt: "a fluffy orange cat sitting on a window sill"
        }
      ],
      { nowFn: frozenNow, baseDir: dir, stdout, stderr }
    );

    assert.equal(saved.length, 1);
    assert.equal(saved[0].revisedPrompt, "a fluffy orange cat sitting on a window sill");

    // The order must be: saved line first, then prompt line.
    const text = stdout.text;
    const savedIdx = text.indexOf("저장됨:");
    const promptIdx = text.indexOf("프롬프트:");
    assert.ok(savedIdx !== -1, "저장됨 line missing");
    assert.ok(promptIdx !== -1, `프롬프트 line missing — got ${text}`);
    assert.ok(savedIdx < promptIdx, "saved: line should come before prompt: line");
    assert.ok(text.includes("a fluffy orange cat sitting on a window sill"));
  } finally {
    await cleanup();
  }
});

test("(D) file write failure → stderr logged, does not throw; next image continues", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    // Create a read-only subdirectory and use it as the baseDir so the first
    // fs.writeFile attempt fails with EACCES/EPERM. The second image uses a
    // writable temp dir instead — but since saveCliImages writes all images to
    // the same baseDir, we instead simulate failure by passing a path to a
    // non-existent nested directory. Actually simpler: monkey-patch `fs` by
    // making the target path a directory (writeFile to a directory throws EISDIR).
    const failingPath = path.join(dir, "image-20260422-153045.png");
    // Create a directory at the exact path the first write would use.
    await fs.mkdir(failingPath, { recursive: true });

    const stdout = makeWritable();
    const stderr = makeWritable();
    const imgs = [
      { buffer: Buffer.from("first"), id: "ig_first" },
      { buffer: Buffer.from("second"), id: "ig_second" }
    ];

    let threw = false;
    let saved;
    try {
      saved = await saveCliImages(imgs, {
        nowFn: frozenNow,
        baseDir: dir,
        stdout,
        stderr
      });
    } catch (err) {
      threw = true;
      throw err;
    }

    assert.equal(threw, false, "saveCliImages must not throw upward");
    // First image failed → only second is in the saved list.
    assert.equal(saved.length, 1);
    assert.equal(path.basename(saved[0].path), "image-20260422-153045-2.png");

    // stderr contains failure line mentioning the id.
    assert.ok(stderr.text.includes("이미지 저장 실패"), `stderr missing failure log: ${stderr.text}`);
    assert.ok(stderr.text.includes("ig_first"), `stderr missing id: ${stderr.text}`);

    // Second file exists on disk.
    const onDisk = await fs.readFile(saved[0].path);
    assert.equal(onDisk.toString(), "second");
  } finally {
    await cleanup();
  }
});

test("(E) uses process.cwd() when baseDir is not provided", async () => {
  const { dir, cleanup } = await makeTempDir();
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);

    const stdout = makeWritable();
    const stderr = makeWritable();

    const saved = await saveCliImages(
      [{ buffer: Buffer.from("hello") }],
      { nowFn: frozenNow, stdout, stderr }
    );

    assert.equal(saved.length, 1);
    // Saved path should be inside the cwd we just chdir'd into.
    // fs.realpath is used to resolve platform-level symlinks (e.g. macOS /var → /private/var).
    const realDir = await fs.realpath(dir);
    const realSaved = await fs.realpath(saved[0].path);
    assert.ok(
      realSaved.startsWith(realDir),
      `saved path should be inside cwd: cwd=${realDir} saved=${realSaved}`
    );
    assert.equal(path.basename(saved[0].path), "image-20260422-153045.png");

    // File actually exists.
    const onDisk = await fs.readFile(saved[0].path);
    assert.equal(onDisk.toString(), "hello");
  } finally {
    process.chdir(originalCwd);
    await cleanup();
  }
});

test("(F) empty or missing images array → returns [] and writes nothing", async () => {
  const stdout = makeWritable();
  const stderr = makeWritable();

  const r1 = await saveCliImages([], { nowFn: frozenNow, stdout, stderr });
  assert.deepEqual(r1, []);
  assert.equal(stdout.text, "");
  assert.equal(stderr.text, "");

  const r2 = await saveCliImages(undefined, { nowFn: frozenNow, stdout, stderr });
  assert.deepEqual(r2, []);
});
