import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PHP_PATCH } from "./fixtures.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "cli-"));
const diffFile = join(dir, "change.diff");
writeFileSync(diffFile, `diff --git a/includes/class-admin.php b/includes/class-admin.php\nindex 1..2 100644\n--- a/includes/class-admin.php\n+++ b/includes/class-admin.php\n${PHP_PATCH}\n`);

const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env }, timeout: 30_000 });

test("--dry-run shows hints and the prompt without an API key", () => {
  const r = run(["--diff", diffFile, "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Files to review: includes\/class-admin\.php/);
  assert.match(r.stdout, /critical\s+includes\/class-admin\.php:18\s+A \$wpdb query/);
  assert.match(r.stdout, /--- Prompt that would be sent to claude-sonnet-5-5 ---/);
});

test("without a key it explains what to do", () => {
  const r = run(["--diff", diffFile]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Set ANTHROPIC_API_KEY, or use --dry-run/);
});

test("reviews with the API and returns exit code 1 with --fail-on", async () => {
  const child = fork(fileURLToPath(new URL("./server-process.mjs", import.meta.url)), ["{}"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const url = await new Promise((r) => child.once("message", (m) => r(m.url)));
  try {
    const r = run(["--diff", diffFile, "--fail-on", "critical"], { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: url });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /🔴 Critical · Security  includes\/class-admin\.php:18\n   SQL injection in DELETE query/);
    assert.match(r.stdout, /Replace with: \$wpdb->delete/);
    assert.match(r.stdout, /Dropped 4 finding\(s\)/);
    const json = run(["--diff", diffFile, "--json"], { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: url });
    assert.equal(json.status, 0);
    assert.equal(JSON.parse(json.stdout).inline[0].line, 18);
  } finally {
    child.kill();
  }
});

test("--help", () => {
  const r = run(["--help"]);
  assert.match(r.stdout, /wp-ai-review --base main/);
});
