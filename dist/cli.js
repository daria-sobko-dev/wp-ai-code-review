#!/usr/bin/env node
/**
 * Local review before you push.
 *
 *   wp-ai-review                    review uncommitted changes (git diff HEAD)
 *   wp-ai-review --base main        review this branch against main
 *   git diff | wp-ai-review         review a diff from stdin
 *   wp-ai-review --diff file.diff   review a saved diff
 *
 * Options: --dry-run, --model <id>, --min-severity <level>, --fail-on <level>,
 *          --include <globs>, --exclude <globs>, --rules <file>, --json
 * Needs ANTHROPIC_API_KEY unless --dry-run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ClaudeError } from "./anthropic.js";
import { DEFAULTS } from "./defaults.js";
import { parseUnifiedDiff, splitList } from "./diff.js";
import { cliReport } from "./format.js";
import { buildPrompt, meetsThreshold, review, selectFiles, SEVERITIES } from "./review.js";
import { runRules } from "./rules.js";
const { values } = parseArgs({
    options: {
        diff: { type: "string" },
        base: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        model: { type: "string", default: process.env.AI_REVIEW_MODEL || DEFAULTS.model },
        "min-severity": { type: "string", default: DEFAULTS.minSeverity },
        "fail-on": { type: "string", default: "none" },
        include: { type: "string", default: DEFAULTS.include },
        exclude: { type: "string", default: DEFAULTS.exclude },
        rules: { type: "string", default: DEFAULTS.rulesFile },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
    },
});
function readDiff() {
    if (values.diff)
        return readFileSync(values.diff, "utf8");
    if (!values.base && !process.stdin.isTTY) {
        // Piped input (git diff | wp-ai-review). Empty stdin (CI, scripts) falls back to git.
        const piped = readFileSync(0, "utf8");
        if (piped.trim() !== "")
            return piped;
    }
    const args = values.base ? ["diff", `${values.base}...HEAD`] : ["diff", "HEAD"];
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
}
async function main() {
    if (values.help) {
        console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*?/, "").replace(/^ \* ?/gm, ""));
        return;
    }
    const minSeverity = String(values["min-severity"]).toLowerCase();
    if (!SEVERITIES.includes(minSeverity))
        throw new Error(`--min-severity must be one of: ${SEVERITIES.join(", ")}`);
    const files = parseUnifiedDiff(readDiff());
    if (files.length === 0) {
        console.log("No changes to review.");
        return;
    }
    const projectRules = values.rules && existsSync(values.rules) ? readFileSync(values.rules, "utf8") : undefined;
    const config = {
        claude: { apiKey: process.env.ANTHROPIC_API_KEY ?? "", model: String(values.model), baseUrl: process.env.ANTHROPIC_BASE_URL },
        include: splitList(String(values.include)),
        exclude: splitList(String(values.exclude)),
        maxFiles: DEFAULTS.maxFiles,
        maxDiffChars: DEFAULTS.maxDiffChars,
        maxComments: 1000,
        minSeverity,
        projectRules,
    };
    if (values["dry-run"]) {
        const { selected, skipped } = selectFiles(files, config);
        const hints = runRules(selected);
        const { prompt } = buildPrompt(selected, hints, config.maxDiffChars, projectRules);
        console.log(`Files to review: ${selected.map((f) => f.path).join(", ") || "none"}`);
        if (skipped.length)
            console.log(`Skipped: ${skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`);
        console.log(`\nStatic hints (${hints.length}):`);
        for (const h of hints)
            console.log(`  ${h.severity.padEnd(8)} ${h.path}:${h.line}  ${h.message}`);
        console.log(`\n--- Prompt that would be sent to ${config.claude.model} ---\n${prompt}`);
        return;
    }
    if (!config.claude.apiKey)
        throw new Error("Set ANTHROPIC_API_KEY, or use --dry-run to see what would be sent.");
    const result = await review(files, config);
    console.log(values.json ? JSON.stringify(result, null, 2) : cliReport(result, config.claude.model));
    if (meetsThreshold([...result.inline, ...result.general], String(values["fail-on"]).toLowerCase()))
        process.exitCode = 1;
}
main().catch((error) => {
    console.error(error instanceof ClaudeError || error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
});
