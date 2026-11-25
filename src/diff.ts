/**
 * Parses unified diffs (from the GitHub API or `git diff`) and keeps track of
 * which new-file line numbers can receive a review comment.
 */

export interface DiffLine {
  type: "add" | "del" | "ctx" | "gap";
  /** Line number in the new file (null for removed lines). */
  newLine: number | null;
  text: string;
}

export interface DiffFile {
  path: string;
  status: string;
  lines: DiffLine[];
  /** New-file line numbers that were added. */
  added: Set<number>;
  /** New-file line numbers visible in the diff (added or context): GitHub accepts comments on these. */
  commentable: Set<number>;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses the patch of one file (the "patch" field of the GitHub pull request files API). */
export function parsePatch(path: string, status: string, patch: string): DiffFile {
  const file: DiffFile = { path, status, lines: [], added: new Set(), commentable: new Set() };
  let newLine = 0;
  let inHunk = false;

  for (const raw of patch.split("\n")) {
    const hunk = raw.match(HUNK);
    if (hunk) {
      if (file.lines.length > 0) file.lines.push({ type: "gap", newLine: null, text: "" });
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue; // "\ No newline at end of file"

    const mark = raw[0];
    const text = raw.slice(1);
    if (mark === "+") {
      file.lines.push({ type: "add", newLine, text });
      file.added.add(newLine);
      file.commentable.add(newLine);
      newLine++;
    } else if (mark === "-") {
      file.lines.push({ type: "del", newLine: null, text });
    } else if (mark === " " || raw === "") {
      file.lines.push({ type: "ctx", newLine, text });
      file.commentable.add(newLine);
      newLine++;
    }
  }
  return file;
}

/** Parses the output of `git diff` (several files). Binary files are skipped. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const blocks = text.split(/^(?=diff --git )/m).filter((b) => b.startsWith("diff --git "));

  for (const block of blocks) {
    const header = block.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
    if (!header) continue;
    if (/^Binary files /m.test(block)) continue;

    let status = "modified";
    if (/^new file mode/m.test(block)) status = "added";
    else if (/^deleted file mode/m.test(block)) status = "removed";
    else if (/^rename to /m.test(block)) status = "renamed";

    const start = block.search(/^@@ /m);
    if (start === -1) continue;
    const path = status === "removed" ? header[1] : header[2];
    files.push(parsePatch(path, status, block.slice(start).replace(/\n$/, "")));
  }
  return files;
}

/**
 * Renders a file diff with new-file line numbers, so the model can point at exact lines.
 *   "+  42 | code"  added line 42
 *   "   43 | code"  unchanged line 43
 *   "-     | code"  removed line
 */
export function renderForPrompt(file: DiffFile): string {
  const width = String(Math.max(0, ...file.commentable)).length;
  const body = file.lines
    .map((l) => {
      if (l.type === "gap") return `  ${"".padStart(width)} ⋯`;
      const num = l.newLine === null ? "".padStart(width) : String(l.newLine).padStart(width);
      const mark = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
      return `${mark} ${num} | ${l.text}`;
    })
    .join("\n");
  return `### ${file.path} (${file.status})\n${body}`;
}

/** Simple glob matching: "**" any folders, "*" any characters except "/". */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

export function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
