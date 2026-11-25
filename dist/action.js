#!/usr/bin/env node
/**
 * GitHub Action entry point. Runs on pull_request events, reviews the diff
 * with Claude and posts one review with inline comments.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { ClaudeError } from "./anthropic.js";
import { DEFAULTS } from "./defaults.js";
import { parsePatch, splitList } from "./diff.js";
import { commentBody, reviewBody } from "./format.js";
import { GitHub, GitHubError } from "./github.js";
import { highestSeverity, meetsThreshold, review, SEVERITIES } from "./review.js";
const escapeData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const log = {
    info: (m) => console.log(m),
    notice: (m) => console.log(`::notice::${escapeData(m)}`),
    warning: (m) => console.log(`::warning::${escapeData(m)}`),
    error: (m) => console.log(`::error::${escapeData(m)}`),
};
function input(name, fallback = "") {
    const value = process.env[`INPUT_${name.toUpperCase()}`];
    return value === undefined || value.trim() === "" ? fallback : value.trim();
}
function numberInput(name, fallback) {
    const n = Number(input(name));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
function setOutput(name, value) {
    if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
function writeSummary(markdown) {
    if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
}
export async function run() {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
    const pr = event.pull_request;
    if (!pr) {
        log.notice("Not a pull_request event, nothing to review.");
        return;
    }
    if (pr.draft && input("review_drafts", "false") !== "true") {
        log.notice("Draft pull request, skipping. Set review_drafts: true to review drafts.");
        return;
    }
    const apiKey = input("anthropic_api_key");
    if (!apiKey) {
        log.warning("anthropic_api_key is empty, skipping the review. Secrets are not available to pull requests from forks.");
        return;
    }
    const [owner = "", repo = ""] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
    if (!owner || !repo)
        throw new Error("GITHUB_REPOSITORY is not set. Run this action inside GitHub Actions.");
    const github = new GitHub(input("github_token") || process.env.GITHUB_TOKEN || "", process.env.GITHUB_API_URL);
    const model = input("model", DEFAULTS.model);
    const minSeverity = input("min_severity", DEFAULTS.minSeverity).toLowerCase();
    if (!SEVERITIES.includes(minSeverity))
        throw new Error(`min_severity must be one of: ${SEVERITIES.join(", ")}`);
    const failOn = input("fail_on", "none").toLowerCase();
    if (failOn !== "none" && !SEVERITIES.includes(failOn)) {
        throw new Error(`fail_on must be one of: ${SEVERITIES.join(", ")}, none`);
    }
    const prFiles = await github.listPrFiles(owner, repo, pr.number);
    const files = [];
    const noPatch = [];
    for (const f of prFiles) {
        if (f.patch)
            files.push(parsePatch(f.filename, f.status, f.patch));
        else
            noPatch.push({ path: f.filename, reason: f.changes === 0 ? "renamed without changes" : "no diff (binary or too large)" });
    }
    const rulesFile = input("rules_file", DEFAULTS.rulesFile);
    const projectRules = (await github.getFile(owner, repo, rulesFile, pr.head.sha).catch(() => null)) ?? undefined;
    if (projectRules)
        log.info(`Using project rules from ${rulesFile}`);
    let result;
    try {
        result = await review(files, {
            claude: { apiKey, model, baseUrl: input("anthropic_base_url") || undefined },
            include: splitList(input("include", DEFAULTS.include)),
            exclude: splitList(input("exclude", DEFAULTS.exclude)),
            maxFiles: numberInput("max_files", DEFAULTS.maxFiles),
            maxDiffChars: numberInput("max_diff_chars", DEFAULTS.maxDiffChars),
            maxComments: numberInput("max_comments", DEFAULTS.maxComments),
            minSeverity,
            projectRules,
        });
    }
    catch (error) {
        if (error instanceof ClaudeError && input("fail_on_error", "false") !== "true") {
            log.warning(`AI review skipped: ${error.message}`);
            return;
        }
        throw error;
    }
    result.skipped.push(...noPatch);
    const all = [...result.inline, ...result.general];
    setOutput("findings", all.length);
    setOutput("inline_comments", result.inline.length);
    setOutput("highest_severity", highestSeverity(all));
    if (result.reviewed.length === 0) {
        log.notice("No reviewable files in this pull request (check include/exclude).");
        writeSummary("## 🤖 AI code review\n\nNo reviewable files in this pull request.");
        return;
    }
    const body = reviewBody(result, model);
    const comments = result.inline.map((f) => ({ path: f.path, line: f.line, side: "RIGHT", body: commentBody(f) }));
    try {
        await github.createReview(owner, repo, pr.number, pr.head.sha, body, comments);
        log.info(`Posted a review with ${comments.length} inline comment(s).`);
    }
    catch (error) {
        // 422 usually means GitHub could not place a comment (the PR changed meanwhile). Post everything in the summary instead.
        if (error instanceof GitHubError && error.status === 422 && comments.length) {
            log.warning("GitHub rejected the inline comments, posting all findings in the review summary instead.");
            const fallback = reviewBody({ ...result, inline: [], general: [...result.inline, ...result.general] }, model);
            await github.createReview(owner, repo, pr.number, pr.head.sha, fallback, []);
        }
        else {
            throw error;
        }
    }
    writeSummary(reviewBody(result, model, 1_000_000));
    if (meetsThreshold(all, failOn)) {
        log.error(`Found ${failOn} or more severe issues. Failing because fail_on is "${failOn}".`);
        process.exitCode = 1;
    }
}
run().catch((error) => {
    log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
