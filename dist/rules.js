/**
 * Fast, free static checks for common WordPress security mistakes.
 *
 * They only look at added lines and are deliberately simple, so they can be wrong.
 * Their results go to Claude as hints to confirm or reject, and are listed in the
 * review summary, so a person can see where each finding came from.
 */
const PHP = /\.php$/i;
const JS = /\.(js|jsx|ts|tsx|mjs)$/i;
const SANITIZED = /\b(sanitize_\w+|absint|intval|floatval|wp_unslash|esc_\w+|wp_verify_nonce|check_ajax_referer|check_admin_referer|isset|empty|array_key_exists|rest_sanitize_\w+|filter_input|wp_kses\w*)\s*\(/;
const ESCAPED = /\b(esc_html|esc_attr|esc_url|esc_textarea|esc_js|esc_xml|wp_kses\w*|absint|intval|number_format_i18n|wp_json_encode|json_encode|esc_html__|esc_attr__|esc_html_e|esc_attr_e)\s*\(/;
const RULES = [
    {
        id: "unsanitized-input",
        files: PHP,
        severity: "high",
        message: "Request data ($_GET, $_POST, $_REQUEST, $_COOKIE) is used without sanitizing or unslashing it.",
        test: (l) => /\$_(GET|POST|REQUEST|COOKIE)\s*\[/.test(l) && !SANITIZED.test(l),
    },
    {
        id: "unescaped-output",
        files: PHP,
        severity: "medium",
        message: "A variable is printed without escaping (esc_html, esc_attr, esc_url, wp_kses).",
        test: (l) => /^\s*(echo|print)\b[^;]*\$\w+/.test(l) && !ESCAPED.test(l) && !/\becho\s+\$\w+\s*->\s*get_/.test(l),
    },
    {
        id: "unprepared-sql",
        files: PHP,
        severity: "critical",
        message: "A $wpdb query is built with variables but without $wpdb->prepare(), which allows SQL injection.",
        test: (l) => /\$wpdb\s*->\s*(query|get_results|get_row|get_var|get_col)\s*\(/.test(l) &&
            /(\$\w+|\{\$)/.test(l.replace(/\$wpdb\s*->\s*\w+/g, "")) &&
            !/\bprepare\s*\(/.test(l),
    },
    {
        id: "dangerous-function",
        files: PHP,
        severity: "high",
        message: "eval(), unserialize() on outside data or extract() can run unexpected code or overwrite variables.",
        test: (l) => /\b(eval|extract|create_function|assert)\s*\(/.test(l) || /\bunserialize\s*\(\s*\$_/.test(l),
    },
    {
        id: "shell-exec",
        files: PHP,
        severity: "critical",
        message: "Shell commands (exec, shell_exec, system, passthru) are risky in a plugin or theme.",
        test: (l) => /\b(shell_exec|exec|system|passthru|proc_open|popen)\s*\(/.test(l) && !/->\s*exec\s*\(/.test(l),
    },
    {
        id: "ajax-without-nonce",
        files: PHP,
        severity: "medium",
        message: "A new AJAX or admin-post handler is registered. Make sure it checks a nonce and the user's capability.",
        test: (l) => /add_action\s*\(\s*['"](wp_ajax_|wp_ajax_nopriv_|admin_post_)/.test(l),
    },
    {
        id: "rest-open-permission",
        files: PHP,
        severity: "high",
        message: "A REST route allows everyone (__return_true). Check that the route does not change data or expose private data.",
        test: (l) => /permission_callback['"]?\s*=>\s*['"]__return_true['"]/.test(l),
    },
    {
        id: "debug-output",
        files: PHP,
        severity: "low",
        message: "Debug output (var_dump, print_r, error_log) left in the code.",
        test: (l) => /\b(var_dump|print_r|var_export|error_log)\s*\(/.test(l) && !/print_r\s*\([^)]*,\s*true\s*\)/.test(l),
    },
    {
        id: "unsafe-html",
        files: JS,
        severity: "medium",
        message: "HTML is inserted from a variable (innerHTML, dangerouslySetInnerHTML, jQuery .html()), which can allow XSS.",
        test: (l) => {
            const assigned = l.match(/\.(?:innerHTML|outerHTML)\s*\+?=\s*(.+?);?\s*$/);
            // A plain string literal without ${...} is safe: el.innerHTML = '';
            if (assigned && !/^(['"])[^'"]*\1$|^`[^`$]*`$/.test(assigned[1].trim()))
                return true;
            return /dangerouslySetInnerHTML/.test(l) || /\.html\(\s*[a-zA-Z_$][\w.$]*\s*\)/.test(l);
        },
    },
    {
        id: "js-eval",
        files: JS,
        severity: "high",
        message: "eval() or new Function() runs strings as code.",
        test: (l) => /\beval\s*\(|new\s+Function\s*\(/.test(l),
    },
    {
        id: "console-log",
        files: JS,
        severity: "low",
        message: "console.log left in the code.",
        test: (l) => /\bconsole\.log\s*\(/.test(l),
    },
];
function isComment(line) {
    const t = line.trim();
    return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#");
}
export function runRules(files) {
    const hints = [];
    for (const file of files) {
        let rules = RULES.filter((r) => r.files.test(file.path));
        if (rules.length === 0)
            continue;
        // If the changed code of this file already checks nonces, a new AJAX hook is probably handled.
        const checksNonce = file.lines.some((l) => l.type !== "del" && /\b(check_ajax_referer|wp_verify_nonce|check_admin_referer)\s*\(/.test(l.text));
        if (checksNonce)
            rules = rules.filter((r) => r.id !== "ajax-without-nonce");
        for (const line of file.lines) {
            if (line.type !== "add" || line.newLine === null || isComment(line.text))
                continue;
            for (const rule of rules) {
                if (rule.test(line.text)) {
                    hints.push({ path: file.path, line: line.newLine, rule: rule.id, severity: rule.severity, message: rule.message });
                }
            }
        }
    }
    return hints;
}
export const RULE_IDS = RULES.map((r) => r.id);
