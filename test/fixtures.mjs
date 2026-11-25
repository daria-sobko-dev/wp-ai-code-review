// Shared test data: a realistic WordPress PR diff and a fake GitHub + Anthropic server.
import http from "node:http";

export const PHP_PATCH = `@@ -10,6 +10,14 @@ class My_Plugin_Admin {
 	public function init() {
 		add_action( 'admin_menu', array( $this, 'menu' ) );
+		add_action( 'wp_ajax_my_save', array( $this, 'save' ) );
 	}
 
-	public function old() {}
+	public function save() {
+		global $wpdb;
+		$id = $_POST['id'];
+		$wpdb->query( "DELETE FROM {$wpdb->prefix}items WHERE id = $id" );
+		echo $id;
+		wp_send_json_success();
+	}
 }`;

export const JS_PATCH = `@@ -1,3 +1,5 @@
 const box = document.querySelector('.box');
-box.textContent = data.title;
+box.innerHTML = data.title;
+console.log(data);
 export default box;`;

export const PR_FILES = [
  { filename: "includes/class-admin.php", status: "modified", patch: PHP_PATCH },
  { filename: "assets/admin.js", status: "modified", patch: JS_PATCH },
  { filename: "assets/logo.png", status: "added" },
  { filename: "vendor/lib/thing.php", status: "added", patch: "@@ -0,0 +1 @@\n+<?php eval($x);" },
];

export function fakeFindings() {
  return {
    summary: "Adds an AJAX handler that deletes items. It has no nonce or capability check and builds SQL from raw input.",
    findings: [
      { path: "includes/class-admin.php", line: 18, severity: "critical", category: "security", title: "SQL injection in DELETE query", explanation: "$id comes from $_POST and goes straight into SQL.", suggestion: "Use $wpdb->delete() with absint().", replacement: "\t\t$wpdb->delete( $wpdb->prefix . 'items', array( 'id' => $id ), array( '%d' ) );" },
      { path: "includes/class-admin.php", line: 17, severity: "high", category: "security", title: "Unsanitized input", explanation: "Use absint( wp_unslash( ... ) ).", replacement: "\t\t$id = isset( $_POST['id'] ) ? absint( wp_unslash( $_POST['id'] ) ) : 0;" },
      { path: "includes/class-admin.php", line: 15, severity: "high", category: "security", title: "No nonce or capability check", explanation: "Anyone logged in can delete items." },
      { path: "includes/class-admin.php", line: 10, severity: "low", category: "maintainability", title: "Context line comment", explanation: "On a context line." },
      { path: "includes/class-admin.php", line: 300, severity: "medium", category: "bug", title: "Line outside the diff", explanation: "Model guessed a line." },
      { path: "includes/made-up.php", line: 5, severity: "high", category: "bug", title: "Hallucinated file", explanation: "Not in the PR." },
      { path: "assets/admin.js", line: 2, severity: "medium", category: "security", title: "XSS through innerHTML", explanation: "data.title is inserted as HTML.", replacement: "box.textContent = data.title;" },
      { path: "assets/admin.js", line: 2, severity: "medium", category: "security", title: "XSS through innerHTML", explanation: "Duplicate." },
      { path: "assets/admin.js", line: 3, severity: "low", category: "maintainability", title: "console.log left in", explanation: "Remove it." },
    ],
  };
}

export async function startFakeApis({ rejectInlineOnce = false, claudeStatus = 200, prFiles = PR_FILES } = {}) {
  const calls = { github: [], claude: [], reviews: [] };
  let rejected = false;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    const send = (status, data, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(typeof data === "string" ? data : JSON.stringify(data));
    };

    if (req.url === "/v1/messages") {
      calls.claude.push({ headers: req.headers, body: json });
      if (claudeStatus !== 200) return send(claudeStatus, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low." } });
      return send(200, { content: [{ type: "tool_use", id: "t1", name: "submit_review", input: fakeFindings() }], stop_reason: "tool_use" });
    }

    calls.github.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    if (req.url.startsWith("/repos/acme/plugin/pulls/7/files")) return send(200, prFiles);
    if (req.url.startsWith("/repos/acme/plugin/contents/.github/ai-review.md")) return send(200, "- Text domain is acme.", "text/plain");
    if (req.url === "/repos/acme/plugin/pulls/7/reviews" && req.method === "POST") {
      if (rejectInlineOnce && !rejected && json.comments.length) {
        rejected = true;
        return send(422, { message: "Unprocessable Entity: pull_request_review_thread.line must be part of the diff" });
      }
      calls.reviews.push(json);
      return send(200, { id: 1 });
    }
    return send(404, { message: "Not Found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}
