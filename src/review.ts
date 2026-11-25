/**
 * Builds the review prompt, asks Claude, and checks every finding before it is posted.
 *
 * The model can point at lines that are not in the diff or at files it was not shown.
 * Those findings are never posted as inline comments: unknown files are dropped,
 * lines outside the diff move to the summary.
 */

import { callTool, type ClaudeOptions, type ToolSpec } from "./anthropic.js";
import { matchesAny, renderForPrompt, type DiffFile } from "./diff.js";
import { runRules, type Hint, type Severity } from "./rules.js";

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
export const CATEGORIES = ["security", "bug", "performance", "wordpress", "accessibility", "i18n", "maintainability"] as const;

export interface Finding {
  path: string;
  line: number;
  severity: Severity;
  category: string;
  title: string;
  explanation: string;
  suggestion?: string;
  /** A full replacement for this single line, shown as a GitHub suggestion. */
  replacement?: string;
}

export interface ReviewConfig {
  claude: ClaudeOptions;
  include: string[];
  exclude: string[];
  maxFiles: number;
  maxDiffChars: number;
  minSeverity: Severity;
  maxComments: number;
  projectRules?: string;
}

export interface ReviewResult {
  summary: string;
  inline: Finding[];
  general: Finding[];
  dropped: number;
  hints: Hint[];
  reviewed: string[];
  skipped: { path: string; reason: string }[];
}

type Caller = typeof callTool;

export const SYSTEM_PROMPT = `You are a senior WordPress engineer reviewing a pull request for a plugin or theme.

Look for real problems in the changed code:
- Security: missing escaping on output (esc_html, esc_attr, esc_url, wp_kses), unsanitized input, missing nonce checks, missing capability checks (current_user_can), SQL without $wpdb->prepare(), unsafe file uploads or file paths, REST routes with weak permission_callback, XSS in JavaScript.
- Bugs: wrong logic, undefined variables, wrong hook names or arguments, PHP errors, broken JavaScript.
- Performance: queries inside loops, uncached remote requests, large autoloaded options, loading assets on every page.
- WordPress APIs: using the right functions (wp_remote_get, WP_Query, Settings API), i18n with a text domain, accessibility in markup.

Rules:
- Comment only on added lines (marked "+") unless the change breaks something in the context lines.
- Use the new-file line numbers exactly as shown in the diff.
- Do not comment on formatting or naming that a linter handles.
- Do not invent problems. If the code is fine, return no findings. Precision matters more than coverage.
- Some "static hints" are provided from simple pattern rules. They can be false positives: report one only if it is a real problem in this code.
- Use "replacement" only when the fix is one complete line that replaces that exact line, with the same indentation.
- At most 15 findings, most important first. Write short, plain English.`;

export const REVIEW_TOOL: ToolSpec = {
  name: "submit_review",
  description: "Submit the code review.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Two or three sentences: what the change does and the main risks." },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            line: { type: "integer", description: "New-file line number from the diff." },
            severity: { type: "string", enum: SEVERITIES },
            category: { type: "string", enum: [...CATEGORIES] },
            title: { type: "string", description: "One short sentence." },
            explanation: { type: "string", description: "Why it is a problem and what can happen." },
            suggestion: { type: "string", description: "How to fix it. Code allowed." },
            replacement: { type: "string", description: "Optional single replacement line for this exact line." },
          },
          required: ["path", "line", "severity", "category", "title", "explanation"],
        },
      },
    },
    required: ["summary", "findings"],
  },
};

/** Picks reviewable files: matches include, not exclude, not deleted, within maxFiles. */
export function selectFiles(files: DiffFile[], config: Pick<ReviewConfig, "include" | "exclude" | "maxFiles">) {
  const selected: DiffFile[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const file of files) {
    if (file.status === "removed") skipped.push({ path: file.path, reason: "deleted" });
    else if (!matchesAny(file.path, config.include)) skipped.push({ path: file.path, reason: "not in include" });
    else if (matchesAny(file.path, config.exclude)) skipped.push({ path: file.path, reason: "excluded" });
    else if (file.added.size === 0) skipped.push({ path: file.path, reason: "no added lines" });
    else if (selected.length >= config.maxFiles) skipped.push({ path: file.path, reason: `over max_files (${config.maxFiles})` });
    else selected.push(file);
  }
  return { selected, skipped };
}

export function buildPrompt(files: DiffFile[], hints: Hint[], maxChars: number, projectRules?: string) {
  const parts: string[] = [];
  const included: DiffFile[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let used = 0;

  for (const file of files) {
    const rendered = renderForPrompt(file);
    if (used + rendered.length > maxChars && included.length > 0) {
      skipped.push({ path: file.path, reason: "diff too large for one review (max_diff_chars)" });
      continue;
    }
    parts.push(rendered.length > maxChars ? rendered.slice(0, maxChars) + "\n…[cut]" : rendered);
    included.push(file);
    used += rendered.length;
  }

  const paths = new Set(included.map((f) => f.path));
  const relevant = hints.filter((h) => paths.has(h.path));
  const hintText = relevant.length
    ? relevant.map((h) => `- ${h.path}:${h.line} [${h.rule}] ${h.message}`).join("\n")
    : "- none";

  const prompt =
    (projectRules ? `Project rules from the repository:\n${projectRules.trim()}\n\n` : "") +
    `Static hints (may be false positives):\n${hintText}\n\n` +
    `Diff (line numbers are new-file lines):\n\n${parts.join("\n\n")}`;

  return { prompt, included, skipped };
}

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\r/g, "").trim().slice(0, max) : "";

/** Hard limit on what we accept from the model, whatever the prompt says. */
const MAX_FINDINGS = 60;

const rank = (s: Severity) => SEVERITIES.indexOf(s);

/** Checks the model output against the real diff. */
export function validateFindings(raw: unknown, files: DiffFile[], minSeverity: Severity, maxComments: number) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const inline: Finding[] = [];
  const general: Finding[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  for (const item of (Array.isArray(raw) ? raw : []).slice(0, MAX_FINDINGS)) {
    const path = clean(item?.path, 500).replace(/^(\.\/|\/|b\/)/, "");
    const file = byPath.get(path);
    const severity = SEVERITIES.includes(item?.severity) ? (item.severity as Severity) : null;
    const title = clean(item?.title, 300);
    const line = Number(item?.line);

    if (!file || !severity || !title || !Number.isInteger(line)) {
      dropped++; // Unknown file, bad severity or empty title: we cannot trust it.
      continue;
    }
    if (rank(severity) > rank(minSeverity)) continue;

    const key = `${path}:${line}:${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const finding: Finding = {
      path,
      line,
      severity,
      category: (CATEGORIES as readonly string[]).includes(item?.category) ? item.category : "maintainability",
      title,
      explanation: clean(item?.explanation, 2000),
      suggestion: clean(item?.suggestion, 3000) || undefined,
    };
    const replacement = typeof item?.replacement === "string" ? item.replacement.replace(/\r/g, "") : "";
    if (replacement && !replacement.includes("\n") && file.added.has(line)) finding.replacement = replacement;

    (file.commentable.has(line) ? inline : general).push(finding);
  }

  const order = (a: Finding, b: Finding) => rank(a.severity) - rank(b.severity) || a.path.localeCompare(b.path) || a.line - b.line;
  inline.sort(order);
  general.sort(order);
  if (inline.length > maxComments) general.unshift(...inline.splice(maxComments));
  return { inline, general, dropped };
}

export async function review(files: DiffFile[], config: ReviewConfig, caller: Caller = callTool): Promise<ReviewResult> {
  const { selected, skipped } = selectFiles(files, config);
  const hints = runRules(selected);

  if (selected.length === 0) {
    return { summary: "No reviewable files in this change.", inline: [], general: [], dropped: 0, hints, reviewed: [], skipped };
  }

  const { prompt, included, skipped: tooLarge } = buildPrompt(selected, hints, config.maxDiffChars, config.projectRules);
  const output = await caller<{ summary?: string; findings?: unknown[] }>(config.claude, SYSTEM_PROMPT, prompt, REVIEW_TOOL);
  const checked = validateFindings(output?.findings, included, config.minSeverity, config.maxComments);

  return {
    summary: clean(output?.summary, 2000) || "Review finished.",
    ...checked,
    hints: hints.filter((h) => included.some((f) => f.path === h.path)),
    reviewed: included.map((f) => f.path),
    skipped: [...skipped, ...tooLarge],
  };
}

export function highestSeverity(findings: Finding[]): Severity | "none" {
  for (const s of SEVERITIES) if (findings.some((f) => f.severity === s)) return s;
  return "none";
}

export function meetsThreshold(findings: Finding[], failOn: string): boolean {
  if (!SEVERITIES.includes(failOn as Severity)) return false;
  return findings.some((f) => rank(f.severity) <= rank(failOn as Severity));
}
