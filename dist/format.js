/**
 * Markdown for the review summary, inline comments and the local CLI report.
 */
import { SEVERITIES } from "./review.js";
export const MARKER = "<!-- wp-ai-code-review -->";
const ICON = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵" };
const label = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function fence(code, lang = "") {
    const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((m) => m.length));
    const ticks = "`".repeat(longest + 1);
    return `${ticks}${lang}\n${code}\n${ticks}`;
}
export function commentBody(f) {
    let body = `${ICON[f.severity]} **${label(f.severity)} · ${label(f.category)}**: ${f.title}\n\n${f.explanation}`;
    if (f.suggestion)
        body += `\n\n**Fix:** ${f.suggestion.includes("\n") ? "\n\n" + f.suggestion : f.suggestion}`;
    if (f.replacement !== undefined)
        body += `\n\n${fence(f.replacement, "suggestion")}`;
    return body;
}
function findingLine(f) {
    return `- ${ICON[f.severity]} **${label(f.severity)}** \`${f.path}:${f.line}\`: ${f.title}${f.explanation ? `. ${f.explanation}` : ""}`;
}
export function reviewBody(result, model, limit = 65_000) {
    const all = [...result.inline, ...result.general];
    const counts = SEVERITIES.map((s) => `${ICON[s]} ${all.filter((f) => f.severity === s).length} ${s}`).join(" · ");
    const lines = [MARKER, "## 🤖 AI code review", "", result.summary, ""];
    lines.push(all.length ? `**Findings:** ${counts}` : "**No issues found.**");
    if (result.general.length) {
        lines.push("", "### Not on a changed line", "", ...result.general.map(findingLine));
    }
    const details = [];
    details.push(`- Reviewed ${result.reviewed.length} file(s) with \`${model}\`.`);
    if (result.hints.length)
        details.push(`- Static rules flagged ${result.hints.length} line(s); Claude checked them and kept only real problems.`);
    if (result.dropped)
        details.push(`- ${result.dropped} AI finding(s) were dropped because they pointed at files that are not in this diff or were incomplete.`);
    if (result.skipped.length) {
        details.push(`- Skipped: ${result.skipped.map((s) => `\`${s.path}\` (${s.reason})`).join(", ")}.`);
    }
    lines.push("", "<details><summary>How this review was made</summary>", "", ...details, "", "</details>");
    lines.push("", "_AI suggestions can be wrong. A person decides what to change._");
    return fitGitHubLimit(lines.join("\n"), limit);
}
/** GitHub rejects review bodies over 65,536 characters. */
export function fitGitHubLimit(body, limit = 65_000) {
    if (body.length <= limit)
        return body;
    const note = "\n\n…The review was too long for GitHub and was cut. The full report is in the job summary.";
    return body.slice(0, limit - note.length) + note;
}
/** Plain report for the local CLI. */
export function cliReport(result, model) {
    const all = [...result.inline, ...result.general];
    const out = [`AI code review (${model})`, "", result.summary, ""];
    if (!all.length)
        out.push("No issues found.");
    for (const f of all) {
        out.push(`${ICON[f.severity]} ${label(f.severity)} · ${label(f.category)}  ${f.path}:${f.line}`);
        out.push(`   ${f.title}`);
        if (f.explanation)
            out.push(`   ${f.explanation}`);
        if (f.suggestion)
            out.push(`   Fix: ${f.suggestion.replace(/\n/g, "\n   ")}`);
        if (f.replacement !== undefined)
            out.push(`   Replace with: ${f.replacement.trim()}`);
        out.push("");
    }
    if (result.skipped.length)
        out.push(`Skipped: ${result.skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`);
    if (result.dropped)
        out.push(`Dropped ${result.dropped} finding(s) that did not match the diff.`);
    return out.join("\n");
}
