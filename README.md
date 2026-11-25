# WordPress AI Code Review

A GitHub Action that reviews WordPress pull requests with Claude and comments on the exact lines: missing escaping, unsanitized input, missing nonce and capability checks, SQL without `$wpdb->prepare()`, open REST routes, XSS in JavaScript, and WordPress API misuse.

It also works locally, so you can review your changes before you push.

```
🔴 Critical · Security: SQL injection in the LIKE query

$url comes from $_GET and goes straight into the SQL string, so anyone can run their own SQL.

Fix: sanitize the value and use $wpdb->prepare() with $wpdb->esc_like().
```

## Why another AI reviewer

AI review is only useful if you can trust what it posts. This action is built around checking the model, not just calling it:

1. **Static rules first.** Fast regex rules flag common WordPress mistakes on the added lines. They are free and predictable, but can be wrong.
2. **Claude reviews the diff** with the rule hints and is told to confirm only real problems. The answer comes back through **forced tool use** with a JSON schema, so it is always structured data, never free text.
3. **Every finding is checked against the real diff** before it is posted:
   - a finding about a file that is not in the pull request is **dropped**;
   - a finding on a line outside the diff is **moved to the summary** instead of being posted in the wrong place;
   - one-click `suggestion` blocks are allowed only for a single added line;
   - duplicates are removed, and severity and the number of inline comments are limited.
4. **A person decides.** The action posts a `COMMENT` review. It never approves or requests changes. It can fail the check above a severity you choose.

The review summary says how many findings came from static rules, how many AI findings were dropped and which files were skipped, so you can see how the result was produced.

## Quick start

1. Add your Anthropic API key as a repository secret: **Settings → Secrets and variables → Actions → New repository secret**, name `ANTHROPIC_API_KEY`.
2. Create `.github/workflows/ai-review.yml`:

```yaml
name: AI code review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: ai-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: YOUR-USERNAME/wp-ai-code-review@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

3. Open a pull request. The review appears in a minute or two.

## Inputs

| Input | Default | Description |
|---|---|---|
| `anthropic_api_key` | required | Anthropic API key |
| `github_token` | `github.token` | Token to read the PR and post the review |
| `model` | `claude-sonnet-5-5` | Claude model ID |
| `min_severity` | `low` | Lowest severity to report: `critical`, `high`, `medium`, `low` |
| `fail_on` | `none` | Fail the check at this severity or worse |
| `include` | PHP, JS, TS files | Globs of files to review |
| `exclude` | `vendor/**`, `node_modules/**`, `dist/**`, `build/**`, `*.min.js`, `*.asset.php` | Globs of files to skip |
| `max_files` | `30` | Maximum files per review |
| `max_diff_chars` | `80000` | Maximum diff size sent to Claude |
| `max_comments` | `20` | Maximum inline comments; the rest go to the summary |
| `rules_file` | `.github/ai-review.md` | Project rules for the reviewer (optional) |
| `review_drafts` | `false` | Also review draft PRs |
| `fail_on_error` | `false` | Fail when the Anthropic API is unavailable (by default: warning, no review) |
| `anthropic_base_url` | | Custom API URL (proxy or gateway) |

**Outputs:** `findings`, `inline_comments`, `highest_severity`.

## Project rules

Put your team's conventions in `.github/ai-review.md` and the reviewer will follow them:

```markdown
- Text domain is "my-plugin". Every user-facing string must be translatable.
- Minimum PHP version is 7.4.
- All AJAX handlers must call check_ajax_referer() and current_user_can().
```

## Review locally before you push

```bash
git clone https://github.com/YOUR-USERNAME/wp-ai-code-review.git
cd wp-ai-code-review && npm install && npm run build && npm link

cd ~/my-plugin
export ANTHROPIC_API_KEY=sk-ant-...
wp-ai-review                  # uncommitted changes
wp-ai-review --base main      # this branch compared with main
git diff | wp-ai-review       # any diff
wp-ai-review --dry-run        # show the static hints and the prompt, no API call
```

Other options: `--min-severity`, `--fail-on`, `--include`, `--exclude`, `--rules`, `--model`, `--json`.

## Static rules

| Rule | Severity | Looks for |
|---|---|---|
| `unprepared-sql` | critical | `$wpdb->query/get_*` with variables and no `prepare()` |
| `shell-exec` | critical | `exec`, `shell_exec`, `system`, `passthru` |
| `unsanitized-input` | high | `$_GET/$_POST/$_REQUEST/$_COOKIE` without sanitizing |
| `dangerous-function` | high | `eval`, `extract`, `unserialize($_...)` |
| `rest-open-permission` | high | REST routes with `__return_true` |
| `js-eval` | high | `eval()`, `new Function()` |
| `unescaped-output` | medium | `echo`/`print` of variables without `esc_*` or `wp_kses` |
| `ajax-without-nonce` | medium | new `wp_ajax_` / `admin_post_` hooks in files without a nonce check |
| `unsafe-html` | medium | `innerHTML` from variables, `dangerouslySetInnerHTML`, jQuery `.html(var)` |
| `debug-output` | low | `var_dump`, `print_r`, `error_log` |
| `console-log` | low | `console.log` |

## How it works

```
pull request ─▶ GitHub API: changed files and patches
             ─▶ filter files (include / exclude / max_files)
             ─▶ static rules on added lines ─┐
             ─▶ numbered diff ──────────────┴▶ Claude (forced tool use, JSON schema)
             ─▶ validate findings against the diff
             ─▶ one GitHub review: summary + inline comments + suggestions
```

- No runtime dependencies: Node's built-in `fetch` for both APIs.
- Retries on Anthropic 429/529/5xx with backoff.
- If GitHub rejects an inline comment (422, the PR changed meanwhile), the action posts all findings in the summary instead of failing.
- Pull requests from forks do not get repository secrets, so the review is skipped with a warning.

## Development

```bash
npm install
npm test        # builds and runs all tests
```

Tests cover diff parsing, every static rule (including safe code that must not be flagged), the validation of model output, the Markdown output, and full runs of the action and the CLI as separate processes against fake GitHub and Anthropic APIs: inline comments on the right lines, `fail_on`, the 422 fallback, API errors, drafts, forks and empty PRs.

`dist/` is committed because GitHub runs actions from the repository as is. Run `npm run build` before committing; CI checks that `dist/` is up to date.

## Limitations

- The reviewer sees the diff, not the whole repository, so it can miss problems that depend on code elsewhere.
- Static rules are line-based regular expressions. They are hints, and Claude is asked to reject false positives.
- Each new push to a PR creates a new review.

## License

MIT
