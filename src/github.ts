/**
 * The few GitHub REST API calls the action needs.
 */

export interface PrFile {
  filename: string;
  status: string;
  patch?: string;
  changes?: number;
}

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

export class GitHubError extends Error {
  constructor(message: string, public readonly status = 0) {
    super(message);
    this.name = "GitHubError";
  }
}

export class GitHub {
  constructor(
    private readonly token: string,
    private readonly apiUrl = "https://api.github.com"
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<T> {
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
      } catch {
        /* keep raw text */
      }
      throw new GitHubError(`GitHub API ${method} ${path} failed (${response.status}): ${message}`, response.status);
    }
    if (accept.includes("raw")) return text as T;
    return (text ? JSON.parse(text) : null) as T;
  }

  /** All files of a pull request (GitHub returns at most 3000). */
  async listPrFiles(owner: string, repo: string, number: number): Promise<PrFile[]> {
    const files: PrFile[] = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await this.request<PrFile[]>("GET", `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
      files.push(...batch);
      if (batch.length < 100) break;
    }
    return files;
  }

  /** File content at a commit, or null if it does not exist. */
  async getFile(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    try {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      return await this.request<string>("GET", `/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, undefined, "application/vnd.github.raw+json");
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  async createReview(owner: string, repo: string, number: number, commitId: string, body: string, comments: ReviewComment[]) {
    return this.request<{ id: number; html_url?: string }>("POST", `/repos/${owner}/${repo}/pulls/${number}/reviews`, {
      commit_id: commitId,
      body,
      event: "COMMENT",
      comments,
    });
  }
}
