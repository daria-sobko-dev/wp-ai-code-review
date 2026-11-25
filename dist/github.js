/**
 * The few GitHub REST API calls the action needs.
 */
export class GitHubError extends Error {
    status;
    constructor(message, status = 0) {
        super(message);
        this.status = status;
        this.name = "GitHubError";
    }
}
export class GitHub {
    token;
    apiUrl;
    constructor(token, apiUrl = "https://api.github.com") {
        this.token = token;
        this.apiUrl = apiUrl;
    }
    async request(method, path, body, accept = "application/vnd.github+json") {
        const response = await fetch(`${this.apiUrl.replace(/\/+$/, "")}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${this.token}`,
                Accept: accept,
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "wp-ai-code-review",
                ...(body ? { "Content-Type": "application/json" } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await response.text();
        if (!response.ok) {
            let message = text;
            try {
                message = JSON.parse(text).message ?? text;
            }
            catch {
                /* keep raw text */
            }
            throw new GitHubError(`GitHub API ${method} ${path} failed (${response.status}): ${message}`, response.status);
        }
        if (accept.includes("raw"))
            return text;
        return (text ? JSON.parse(text) : null);
    }
    /** All files of a pull request (GitHub returns at most 3000). */
    async listPrFiles(owner, repo, number) {
        const files = [];
        for (let page = 1; page <= 30; page++) {
            const batch = await this.request("GET", `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
            files.push(...batch);
            if (batch.length < 100)
                break;
        }
        return files;
    }
    /** File content at a commit, or null if it does not exist. */
    async getFile(owner, repo, path, ref) {
        try {
            const encoded = path.split("/").map(encodeURIComponent).join("/");
            return await this.request("GET", `/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, undefined, "application/vnd.github.raw+json");
        }
        catch (error) {
            if (error instanceof GitHubError && error.status === 404)
                return null;
            throw error;
        }
    }
    async createReview(owner, repo, number, commitId, body, comments) {
        return this.request("POST", `/repos/${owner}/${repo}/pulls/${number}/reviews`, {
            commit_id: commitId,
            body,
            event: "COMMENT",
            comments,
        });
    }
}
