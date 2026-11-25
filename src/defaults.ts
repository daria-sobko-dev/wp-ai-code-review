/** Defaults shared by the GitHub Action and the CLI. */
export const DEFAULTS = {
  model: "claude-sonnet-5-5",
  include: "**/*.php, **/*.js, **/*.jsx, **/*.ts, **/*.tsx, **/*.mjs",
  exclude: "vendor/**, node_modules/**, dist/**, build/**, **/*.min.js, **/*.asset.php",
  maxFiles: 30,
  maxDiffChars: 80_000,
  maxComments: 20,
  minSeverity: "low",
  rulesFile: ".github/ai-review.md",
} as const;
