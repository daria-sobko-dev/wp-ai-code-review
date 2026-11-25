/**
 * Minimal Anthropic Messages API client with forced tool use, so the review
 * always comes back as JSON that matches a schema.
 */
export class ClaudeError extends Error {
    status;
    constructor(message, status = 0) {
        super(message);
        this.status = status;
        this.name = "ClaudeError";
    }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function callTool(options, system, prompt, tool) {
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
    for (let attempt = 0;; attempt++) {
        let response;
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
        }
        catch (error) {
            if (attempt < retries) {
                await sleep(2000 * (attempt + 1));
                continue;
            }
            throw new ClaudeError(`Could not reach the Anthropic API: ${error instanceof Error ? error.message : String(error)}`);
        }
        const text = await response.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        }
        catch {
            data = null;
        }
        if (response.ok) {
            if (data?.stop_reason === "max_tokens") {
                throw new ClaudeError("The review was cut off (max_tokens). Review fewer files at once (max_files, max_diff_chars).");
            }
            const block = Array.isArray(data?.content)
                ? data.content.find((b) => b?.type === "tool_use" && b?.name === tool.name)
                : null;
            if (!block || typeof block.input !== "object") {
                throw new ClaudeError("The model did not return a structured review.");
            }
            return block.input;
        }
        const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
        if (retryable && attempt < retries) {
            const after = Number(response.headers.get("retry-after"));
            await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 3000 * (attempt + 1));
            continue;
        }
        const message = data?.error?.message ?? `HTTP ${response.status}`;
        if (response.status === 401)
            throw new ClaudeError(`Anthropic rejected the API key (401): ${message}`, 401);
        throw new ClaudeError(`Anthropic API error (${response.status}): ${message}`, response.status);
    }
}
