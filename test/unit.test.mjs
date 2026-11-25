import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePatch, parseUnifiedDiff, renderForPrompt, globToRegExp, matchesAny, splitList } from "../dist/diff.js";
import { runRules } from "../dist/rules.js";
import { validateFindings, selectFiles, buildPrompt, review, meetsThreshold, highestSeverity } from "../dist/review.js";
import { commentBody, reviewBody } from "../dist/format.js";
import { PHP_PATCH, JS_PATCH, fakeFindings } from "./fixtures.mjs";

const php = () => parsePatch("includes/class-admin.php", "modified", PHP_PATCH);
const js = () => parsePatch("assets/admin.js", "modified", JS_PATCH);

test("parsePatch tracks new-file line numbers", () => {
  const f = php();
  assert.deepEqual([...f.added], [12, 15, 16, 17, 18, 19, 20, 21]);
  assert.ok(f.commentable.has(10) && f.commentable.has(13) && f.commentable.has(22));
  assert.ok(!f.commentable.has(9) && !f.commentable.has(23));
  assert.equal(f.lines.filter((l) => l.type === "del").length, 1);
});

test("renderForPrompt shows line numbers and markers", () => {
  const out = renderForPrompt(php());
  assert.match(out, /^### includes\/class-admin\.php \(modified\)/);
  assert.match(out, /\n\+ 18 \| \t\t\$wpdb->query/);
  assert.match(out, /\n  10 \| \tpublic function init/);
  assert.match(out, /\n-    \| \tpublic function old/);
});

test("parseUnifiedDiff handles new, deleted, renamed and binary files", () => {
  const diff = [
    "diff --git a/a.php b/a.php", "index 1..2 100644", "--- a/a.php", "+++ b/a.php", "@@ -1,2 +1,2 @@", " <?php", "-echo 1;", "+echo 2;",
    "diff --git a/new.js b/new.js", "new file mode 100644", "--- /dev/null", "+++ b/new.js", "@@ -0,0 +1,2 @@", "+let a = 1;", "+let b = 2;",
    "diff --git a/old.php b/old.php", "deleted file mode 100644", "--- a/old.php", "+++ /dev/null", "@@ -1 +0,0 @@", "-<?php",
    "diff --git a/x.php b/y.php", "similarity index 90%", "rename from x.php", "rename to y.php", "@@ -1 +1 @@", "-a", "+b",
    "diff --git a/img.png b/img.png", "Binary files a/img.png and b/img.png differ", "",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  assert.deepEqual(files.map((f) => [f.path, f.status]), [["a.php", "modified"], ["new.js", "added"], ["old.php", "removed"], ["y.php", "renamed"]]);
  assert.deepEqual([...files[1].added], [1, 2]);
  assert.deepEqual([...files[0].added], [2]);
});

test("globs", () => {
  assert.ok(globToRegExp("**/*.php").test("a.php"));
  assert.ok(globToRegExp("**/*.php").test("inc/deep/a.php"));
  assert.ok(!globToRegExp("**/*.php").test("a.phpx"));
  assert.ok(globToRegExp("vendor/**").test("vendor/a/b.php"));
  assert.ok(!globToRegExp("vendor/**").test("src/vendor.php"));
  assert.ok(globToRegExp("**/*.min.js").test("assets/app.min.js"));
  assert.ok(matchesAny("dist/x.js", splitList("vendor/**, dist/**")));
  assert.deepEqual(splitList("a, b\nc,,"), ["a", "b", "c"]);
});

test("static rules find WordPress security issues", () => {
  const hints = runRules([php(), js()]);
  const ids = hints.map((h) => `${h.rule}@${h.line}`);
  assert.ok(ids.includes("ajax-without-nonce@12"));
  assert.ok(ids.includes("unsanitized-input@17"));
  assert.ok(ids.includes("unprepared-sql@18"));
  assert.ok(ids.includes("unescaped-output@19"));
  assert.ok(ids.includes("unsafe-html@2"));
  assert.ok(ids.includes("console-log@3"));
  assert.equal(hints.length, 6, ids.join(", "));
});

test("static rules ignore safe code", () => {
  const safe = parsePatch("a.php", "modified", [
    "@@ -1,1 +1,12 @@",
    "+$id = isset( $_POST['id'] ) ? absint( wp_unslash( $_POST['id'] ) ) : 0;",
    "+echo esc_html( $title );",
    "+$wpdb->get_results( $wpdb->prepare( \"SELECT * FROM t WHERE id = %d\", $id ) );",
    "+$wpdb->query( \"DELETE FROM {$wpdb->prefix}log\" );",
    "+// echo $debug;",
    "+$stmt->exec( 'x' );",
    "+$out = print_r( $data, true );",
    "+check_ajax_referer( 'x' );",
    "+echo $this->get_title();",
    "+register_rest_route( 'a', '/b', array( 'permission_callback' => array( $this, 'can' ) ) );",
    "+$name = sanitize_text_field( wp_unslash( $_GET['name'] ?? '' ) );",
  ].join("\n"));
  const safeJs = parsePatch("a.js", "modified", "@@ -1 +1,3 @@\n+el.innerHTML = '';\n+el.textContent = value;\n+el.innerHTML = `<b>Hi</b>`;");
  const hints = runRules([safe, safeJs]);
  assert.deepEqual(hints.map((h) => `${h.rule}@${h.line}`), []);
});

test("more dangerous patterns", () => {
  const f = parsePatch("a.php", "modified", "@@ -1 +1,4 @@\n+$data = unserialize( $_COOKIE['x'] );\n+shell_exec( $cmd );\n+'permission_callback' => '__return_true',\n+var_dump( $x );");
  assert.deepEqual(runRules([f]).map((h) => h.rule), ["unsanitized-input", "dangerous-function", "shell-exec", "rest-open-permission", "debug-output"]);
});

test("validateFindings checks the model output against the diff", () => {
  const { inline, general, dropped } = validateFindings(fakeFindings().findings, [php(), js()], "low", 20);
  assert.equal(dropped, 1, "hallucinated file dropped");
  assert.deepEqual(inline.map((f) => `${f.path}:${f.line}`), [
    "includes/class-admin.php:18", "includes/class-admin.php:15", "includes/class-admin.php:17",
    "assets/admin.js:2", "assets/admin.js:3", "includes/class-admin.php:10",
  ]);
  assert.deepEqual(general.map((f) => f.line), [300], "line outside the diff goes to the summary");
  assert.ok(inline[0].replacement.includes("$wpdb->delete"), "replacement kept for an added line");
  assert.equal(inline.find((f) => f.line === 10).replacement, undefined);
});

test("validateFindings filters severity and limits inline comments", () => {
  const high = validateFindings(fakeFindings().findings, [php(), js()], "high", 20);
  assert.ok(high.inline.every((f) => ["critical", "high"].includes(f.severity)));
  const limited = validateFindings(fakeFindings().findings, [php(), js()], "low", 2);
  assert.equal(limited.inline.length, 2);
  assert.equal(limited.general.length, 5);
  assert.equal(validateFindings([{ path: "a", line: "x" }, null, "junk"], [php()], "low", 5).dropped, 3);
  const multi = validateFindings([{ path: "assets/admin.js", line: 2, severity: "low", category: "nope", title: "t", explanation: "e", replacement: "a\nb" }], [js()], "low", 5);
  assert.equal(multi.inline[0].replacement, undefined, "multi-line replacement refused");
  assert.equal(multi.inline[0].category, "maintainability");
});

test("selectFiles and buildPrompt", () => {
  const vendor = parsePatch("vendor/x.php", "added", "@@ -0,0 +1 @@\n+eval($x);");
  const removed = { ...php(), path: "gone.php", status: "removed" };
  const { selected, skipped } = selectFiles([php(), js(), vendor, removed], { include: ["**/*.php", "**/*.js"], exclude: ["vendor/**"], maxFiles: 1 });
  assert.deepEqual(selected.map((f) => f.path), ["includes/class-admin.php"]);
  assert.deepEqual(skipped.map((s) => s.reason), ["over max_files (1)", "excluded", "deleted"]);

  const hints = runRules([php(), js()]);
  const { prompt, included, skipped: big } = buildPrompt([php(), js()], hints, 600, "- Use text domain acme.");
  assert.deepEqual(included.map((f) => f.path), ["includes/class-admin.php"]);
  assert.equal(big[0].path, "assets/admin.js");
  assert.match(prompt, /Project rules from the repository:\n- Use text domain acme\./);
  assert.match(prompt, /includes\/class-admin\.php:18 \[unprepared-sql\]/);
  assert.doesNotMatch(prompt, /admin\.js:2/, "hints only for included files");
});

test("review() end to end with a fake model", async () => {
  let seen;
  const fake = async (opts, system, prompt, tool) => { seen = { opts, system, prompt, tool }; return fakeFindings(); };
  const result = await review([php(), js()], { claude: { apiKey: "k", model: "m" }, include: ["**/*.php", "**/*.js"], exclude: [], maxFiles: 10, maxDiffChars: 50000, maxComments: 20, minSeverity: "low" }, fake);
  assert.equal(seen.tool.name, "submit_review");
  assert.match(seen.system, /Do not invent problems/);
  assert.equal(result.inline.length, 6);
  assert.equal(result.hints.length, 6);
  assert.equal(highestSeverity(result.inline), "critical");
  assert.ok(meetsThreshold(result.inline, "high"));
  assert.ok(!meetsThreshold(result.inline.filter((f) => f.severity === "low"), "medium"));
  assert.ok(!meetsThreshold(result.inline, "none"));

  const empty = await review([], { claude: {}, include: ["**"], exclude: [], maxFiles: 1, maxDiffChars: 1, maxComments: 1, minSeverity: "low" }, async () => { throw new Error("must not be called"); });
  assert.equal(empty.reviewed.length, 0);
});

test("markdown output", async () => {
  const { inline, general, dropped } = validateFindings(fakeFindings().findings, [php(), js()], "low", 20);
  const body = reviewBody({ summary: "S", inline, general, dropped, hints: [{}, {}], reviewed: ["a", "b"], skipped: [{ path: "logo.png", reason: "no diff" }] }, "claude-sonnet-5-5");
  assert.match(body, /^<!-- wp-ai-code-review -->/);
  assert.match(body, /🔴 1 critical · 🟠 2 high · 🟡 2 medium · 🔵 2 low/);
  assert.match(body, /### Not on a changed line\n\n- 🟡 \*\*Medium\*\* `includes\/class-admin\.php:300`/);
  assert.match(body, /1 AI finding\(s\) were dropped/);
  assert.match(body, /Static rules flagged 2 line/);
  const c = commentBody(inline[0]);
  assert.match(c, /^🔴 \*\*Critical · Security\*\*: SQL injection/);
  assert.match(c, /```suggestion\n\t\t\$wpdb->delete/);
  assert.match(commentBody({ ...inline[0], replacement: "a ``` b" }), /````suggestion\na ``` b\n````/);
});

test("AJAX hint is skipped when the file checks a nonce", () => {
  const f = parsePatch("a.php", "modified", "@@ -1 +1,5 @@\n+add_action( 'wp_ajax_x', 'cb' );\n+function cb() {\n+\tcheck_ajax_referer( 'x', 'nonce' );\n+}\n+");
  assert.deepEqual(runRules([f]), []);
});

test("hunks are separated in the prompt", () => {
  const f = parsePatch("a.php", "modified", "@@ -1,1 +1,2 @@\n a\n+b\n@@ -50,1 +51,2 @@\n c\n+d");
  assert.deepEqual([...f.added], [2, 52]);
  assert.match(renderForPrompt(f), /\+  2 \| b\n     ⋯\n  51 \| c/);
});

test("review body fits GitHub's limit, model output is capped", async () => {
  const { fitGitHubLimit } = await import("../dist/format.js");
  const long = "x".repeat(70_000);
  const cut = fitGitHubLimit(long);
  assert.ok(cut.length <= 65_000);
  assert.match(cut, /too long for GitHub/);
  assert.equal(fitGitHubLimit("short"), "short");
  const many = Array.from({ length: 500 }, (_, i) => ({ path: "includes/class-admin.php", line: 18, severity: "low", category: "bug", title: `t${i}`, explanation: "e".repeat(1900) }));
  const v = validateFindings(many, [php()], "low", 20);
  assert.equal(v.inline.length + v.general.length, 60);
  const body = reviewBody({ summary: "s", ...v, hints: [], reviewed: ["a"], skipped: [] }, "m");
  assert.ok(body.length <= 65_000);
});

test("max_tokens gives a clear error", async () => {
  const http = await import("node:http");
  const { callTool } = await import("../dist/anthropic.js");
  const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ stop_reason: "max_tokens", content: [{ type: "tool_use", name: "submit_review", input: {} }] })); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await assert.rejects(callTool({ apiKey: "k", model: "m", baseUrl: `http://127.0.0.1:${server.address().port}` }, "s", "p", { name: "submit_review", description: "", input_schema: {} }), /cut off \(max_tokens\)/);
  server.close();
});
