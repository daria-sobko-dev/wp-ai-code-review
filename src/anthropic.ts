/**
 * Minimal Anthropic Messages API client with forced tool use, so the review
 * always comes back as JSON that matches a schema.
 */

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ClaudeOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  /** Retries for 429, 529 and 5xx answers. */
  retries?: number;
  timeoutMs?: number;
}

export class ClaudeError extends Error {
  constructor(message: string, public readonly status = 0) {
    super(message);
    this.name = "ClaudeError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callTool<T>(options: ClaudeOptions, system: string, prompt: string, tool: ToolSpec): Promise<T> {
  const url = `${(options.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
  const body = JSON.stringify({
    model: options.model,
    max_tokens: options.maxTokens ?? 8000,
    system,
    messages: [{ role: "user", content: prompt }],
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
  });

  const retries = options.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
      });
    } catch (error) {
      if (attempt < retries) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new ClaudeError(`Could not reach the Anthropic API: ${error instanceof Error ? error.message : String(error)}`);
    }

    const text = await response.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (response.ok) {
      if (data?.stop_reason === "max_tokens") {
        throw new ClaudeError("The review was cut off (max_tokens). Review fewer files at once (max_files, max_diff_chars).");
      }
      const block = Array.isArray(data?.content)
        ? data.content.find((b: any) => b?.type === "tool_use" && b?.name === tool.name)
        : null;
      if (!block || typeof block.input !== "object") {
        throw new ClaudeError("The model did not return a structured review.");
      }
      return block.input as T;
    }

    const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
    if (retryable && attempt < retries) {
      const after = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 3000 * (attempt + 1));
      continue;
    }

    const message = data?.error?.message ?? `HTTP ${response.status}`;
    if (response.status === 401) throw new ClaudeError(`Anthropic rejected the API key (401): ${message}`, 401);
    throw new ClaudeError(`Anthropic API error (${response.status}): ${message}`, response.status);
  }
}
