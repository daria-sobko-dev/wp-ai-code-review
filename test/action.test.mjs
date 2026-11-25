import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeApis } from "./fixtures.mjs";

const ACTION = fileURLToPath(new URL("../dist/action.js", import.meta.url));

function runAction(api, { inputs = {}, event, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "act-"));
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify(event ?? { pull_request: { number: 7, draft: false, head: { sha: "abc123" } } }));
  const outFile = join(dir, "out"), summaryFile = join(dir, "summary");
  writeFileSync(outFile, ""); writeFileSync(summaryFile, "");
  const allInputs = { anthropic_api_key: "sk-test", github_token: "ghs_test", anthropic_base_url: api.url, ...inputs };
  const inputEnv = Object.fromEntries(Object.entries(allInputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v]));
  const r = spawnSync(process.execPath, [ACTION], {
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH, GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: "acme/plugin", GITHUB_API_URL: api.url, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: summaryFile, ...inputEnv, ...env },
  });
  return { code: r.status, stdout: r.stdout + r.stderr, outputs: readFileSync(outFile, "utf8"), summary: readFileSync(summaryFile, "utf8") };
}

// spawnSync blocks the event loop, so the fake server must run in another process.
import { fork } from "node:child_process";
async function withServer(options, fn) {
  const child = fork(fileURLToPath(new URL("./server-process.mjs", import.meta.url)), [JSON.stringify(options)], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const url = await new Promise((resolve) => child.once("message", (m) => resolve(m.url)));
  const api = { url, calls: async () => new Promise((resolve) => { child.once("message", (m) => resolve(m.calls)); child.send("calls"); }) };
  try { return await fn(api); } finally { child.kill(); }
}

test("posts one review with inline comments on the right lines", async () => {
  await withServer({}, async (api) => {
    const r = runAction(api);
    assert.equal(r.code, 0, r.stdout);
    const calls = await api.calls();
    assert.equal(calls.reviews.length, 1);
    const review = calls.reviews[0];
    assert.equal(review.event, "COMMENT");
    assert.equal(review.commit_id, "abc123");
    assert.deepEqual(review.comments.map((c) => `${c.path}:${c.line}:${c.side}`), [
      "includes/class-admin.php:18:RIGHT", "includes/class-admin.php:15:RIGHT", "includes/class-admin.php:17:RIGHT",
      "assets/admin.js:2:RIGHT", "assets/admin.js:3:RIGHT", "includes/class-admin.php:10:RIGHT",
    ]);
    assert.match(review.body, /Not on a changed line/);
    assert.match(review.body, /`assets\/logo\.png` \(no diff \(binary or too large\)\)/);
    assert.match(review.body, /`vendor\/lib\/thing\.php` \(excluded\)/);

    const claude = calls.claude[0];
    assert.equal(claude.headers["x-api-key"], "sk-test");
    assert.equal(claude.headers["anthropic-version"], "2023-06-01");
    assert.deepEqual(claude.body.tool_choice, { type: "tool", name: "submit_review" });
    assert.equal(claude.body.model, "claude-sonnet-5-5");
    const prompt = claude.body.messages[0].content;
    assert.match(prompt, /Project rules from the repository:\n- Text domain is acme\./);
    assert.match(prompt, /\[unprepared-sql\]/);
    assert.doesNotMatch(prompt, /vendor\/lib/);
    assert.ok(calls.github.every((c) => c.auth === "Bearer ghs_test"));

    assert.match(r.outputs, /findings=7\ninline_comments=6\nhighest_severity=critical/);
    assert.match(r.summary, /AI code review/);
  });
});

test("fail_on high fails the check", async () => {
  await withServer({}, async (api) => {
    const r = runAction(api, { inputs: { fail_on: "high" } });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /::error::Found high or more severe issues/);
  });
});

test("min_severity filters findings", async () => {
  await withServer({}, async (api) => {
    runAction(api, { inputs: { min_severity: "high" } });
    const [review] = (await api.calls()).reviews;
    assert.equal(review.comments.length, 3);
  });
});

test("falls back to a summary-only review when GitHub rejects inline comments", async () => {
  await withServer({ rejectInlineOnce: true }, async (api) => {
    const r = runAction(api);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /::warning::GitHub rejected the inline comments/);
    const [review] = (await api.calls()).reviews;
    assert.equal(review.comments.length, 0);
    assert.match(review.body, /includes\/class-admin\.php:18/);
  });
});

test("Anthropic errors skip the review with a warning, or fail with fail_on_error", async () => {
  await withServer({ claudeStatus: 400 }, async (api) => {
    const soft = runAction(api);
    assert.equal(soft.code, 0);
    assert.match(soft.stdout, /::warning::AI review skipped: Anthropic API error \(400\): Your credit balance is too low/);
    const hard = runAction(api, { inputs: { fail_on_error: "true" } });
    assert.equal(hard.code, 1);
    assert.equal((await api.calls()).reviews.length, 0);
  });
});

test("skips drafts, non-PR events and missing API keys", async () => {
  await withServer({}, async (api) => {
    const draft = runAction(api, { event: { pull_request: { number: 7, draft: true, head: { sha: "x" } } } });
    assert.match(draft.stdout, /Draft pull request, skipping/);
    const push = runAction(api, { event: { ref: "refs/heads/main" } });
    assert.match(push.stdout, /Not a pull_request event/);
    const noKey = runAction(api, { inputs: { anthropic_api_key: "" } });
    assert.equal(noKey.code, 0);
    assert.match(noKey.stdout, /::warning::anthropic_api_key is empty/);
    const calls = await api.calls();
    assert.equal(calls.claude.length, 0);
    assert.equal(calls.reviews.length, 0);
  });
});

test("no reviewable files: no Claude call, no review", async () => {
  await withServer({ prFiles: [{ filename: "README.md", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }] }, async (api) => {
    const r = runAction(api);
    assert.match(r.stdout, /No reviewable files/);
    const calls = await api.calls();
    assert.equal(calls.claude.length, 0);
    assert.equal(calls.reviews.length, 0);
  });
});

test("bad min_severity is a clear error", async () => {
  await withServer({}, async (api) => {
    const r = runAction(api, { inputs: { min_severity: "urgent" } });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /::error::min_severity must be one of/);
  });
});

test("severity inputs are case-insensitive and validated", async () => {
  await withServer({}, async (api) => {
    const r = runAction(api, { inputs: { fail_on: "High", min_severity: "HIGH" } });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /Found high or more severe issues/);
    const bad = runAction(api, { inputs: { fail_on: "blocker" } });
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /::error::fail_on must be one of/);
  });
});

test("missing GITHUB_REPOSITORY gives a clear error", async () => {
  await withServer({}, async (api) => {
    const r = runAction(api, { env: { GITHUB_REPOSITORY: "" } });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /GITHUB_REPOSITORY is not set/);
  });
});

test("renamed files without changes get the right reason", async () => {
  await withServer({ prFiles: [{ filename: "a.php", status: "renamed", changes: 0 }, { filename: "includes/class-admin.php", status: "modified", patch: (await import("./fixtures.mjs")).PHP_PATCH }] }, async (api) => {
    runAction(api);
    const [review] = (await api.calls()).reviews;
    assert.match(review.body, /`a\.php` \(renamed without changes\)/);
  });
});
