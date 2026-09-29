import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";

export interface LLMClient {
  /**
   * @param prompt     The prompt to send to the model.
   * @param repoPath   If set, enables read_file / list_directory tool calls
   *                   scoped to this directory.
   * @param streamTo   If set, streams response chunks to this writable stream
   *                   as they arrive (e.g. a file write stream). Terminal output
   *                   is suppressed when streamTo is provided.
   */
  generate(prompt: string, repoPath?: string, streamTo?: fs.WriteStream): Promise<string>;
}

const FILE_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a specific file in the repository. Use this to inspect callers, dependents, or related files when you know the exact path from the diff or import graph. Do not guess paths speculatively — only read files you have reason to believe are relevant to the changes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the repo root" },
        },
        required: ["path"],
      },
    },
  },
];

export function executeTool(name: string, args: Record<string, string>, repoRoot: string): string {
  const root = path.resolve(repoRoot);
  const target = path.resolve(root, args.path ?? "");
  // Prevent path traversal outside the repo. A plain `startsWith(root)` check
  // is exploitable: a sibling directory whose name has `root` as a string
  // prefix (e.g. root "target-repo" vs. sibling "target-repo-secrets") would
  // incorrectly pass. Require an exact match or a path separator boundary.
  if (target !== root && !target.startsWith(root + path.sep)) {
    return "Error: path is outside the repository root.";
  }

  if (name === "read_file") {
    if (!fs.existsSync(target)) return `Error: file not found: ${args.path}`;
    if (fs.statSync(target).isDirectory()) return `Error: "${args.path}" is a directory — provide a specific file path.`;
    const content = fs.readFileSync(target, "utf-8");
    // Cap at 20k chars to keep individual tool results manageable
    return content.length > 20000
      ? content.slice(0, 20000) + "\n... (truncated)"
      : content;
  }

  return `Error: unknown tool "${name}"`;
}

// Network error codes that warrant a retry (transient failures).
// Exported so other LLMClient implementations (e.g. AnthropicClient) share
// the exact same retry policy rather than duplicating/drifting from it.
export const RETRYABLE_CODES = new Set([
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
]);
export const MAX_API_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 2000;

export function isRetryable(err: any): boolean {
  // Direct code on the error or on its underlying cause
  const code: string | undefined = err.code ?? err.cause?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  // HTTP 429 (rate limit) or 5xx (server error)
  if (err.status === 429 || (typeof err.status === "number" && err.status >= 500)) return true;
  return false;
}

export class LiteLLMClient implements LLMClient {
  private client: OpenAI;
  private modelName: string;

  /**
   * @param modelOverride  Optional model name. Falls back to LITELLM_MODEL env var.
   *                       Useful for using a different model for the validator pass.
   */
  constructor(modelOverride?: string) {
    const apiKey = process.env.LITELLM_API_KEY;
    if (!apiKey) throw new Error("Missing env var: LITELLM_API_KEY");
    // A native Anthropic key (sk-ant-...) sent to an OpenAI-compatible
    // endpoint fails as a generic 401 from OpenAI itself — confusing,
    // because the key looks fine, it's just aimed at the wrong API. Catch
    // the mismatch here with an actionable message instead of letting it
    // surface as an opaque AuthenticationError deep in the OpenAI SDK.
    if (apiKey.startsWith("sk-ant-")) {
      throw new Error(
        'The key passed as litellm_api_key looks like a native Anthropic API key (starts with "sk-ant-"), ' +
        'but llm_provider is "openai" (the default), which sends requests to an OpenAI-compatible endpoint. ' +
        'Set llm_provider: anthropic and pass this key as anthropic_api_key instead — see README.md\'s ' +
        '"Bringing a raw Anthropic key" section.'
      );
    }
    const baseURL = process.env.LITELLM_BASE_URL;
    if (!baseURL) throw new Error("Missing env var: LITELLM_BASE_URL");
    this.modelName = modelOverride || process.env.LITELLM_MODEL || "gpt-5.5";
    this.client = new OpenAI({
      apiKey,
      baseURL,
      // Give each request up to 10 minutes; large PRs produce big prompts
      // and the proxy can be slow when the payload is large.
      timeout: 600_000,
      // SDK-level retries for non-streaming errors (e.g. 429, 5xx).
      maxRetries: 2,
    });
  }

  async generate(prompt: string, repoPath?: string, streamTo?: fs.WriteStream): Promise<string> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "user", content: prompt },
    ];
    const tools = repoPath ? FILE_TOOLS : undefined;

    // When a file stream is provided, suppress terminal output — the caller
    // is responsible for displaying or logging the output file path.
    const toTerminal = !streamTo;
    let toolCallCount = 0;

    while (true) {
      // ── Retry loop for transient network errors ────────────────────────────
      // ETIMEDOUT / ECONNRESET can occur on the second+ API call after tool
      // results are added (payload grows with file contents). Retry with
      // exponential backoff before giving up.
      let textContent = "";
      const toolCalls: Record<number, { id: string; name: string; args: string }> = {};
      let finishReason = "";

      let lastErr: any;
      for (let attempt = 1; attempt <= MAX_API_RETRIES; attempt++) {
        textContent = "";
        // Reset tool call accumulator on each attempt
        for (const k of Object.keys(toolCalls)) delete toolCalls[k as any];
        finishReason = "";
        lastErr = undefined;

        try {
          const stream = await this.client.chat.completions.create({
            model: this.modelName,
            max_tokens: 32768,
            temperature: 0,
            messages,
            tools,
            tool_choice: tools ? "auto" : undefined,
            stream: true,
          });

          for await (const chunk of stream) {
            const choice = chunk.choices[0];
            if (!choice) continue;

            finishReason = choice.finish_reason ?? finishReason;
            const delta = choice.delta;

            if (delta.content) {
              textContent += delta.content;
              if (streamTo) {
                streamTo.write(delta.content);
              } else if (toTerminal) {
                process.stdout.write(delta.content);
              }
            }

            for (const tc of delta.tool_calls ?? []) {
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
              }
              toolCalls[tc.index].args += tc.function?.arguments ?? "";
              if (tc.id) toolCalls[tc.index].id = tc.id;
              if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
            }
          }

          // Stream completed successfully — break out of retry loop.
          break;
        } catch (err: any) {
          lastErr = err;
          if (attempt < MAX_API_RETRIES && isRetryable(err)) {
            const delayMs = RETRY_BASE_DELAY_MS * attempt;
            const code = err.code ?? err.cause?.code ?? err.message;
            console.log(
              `  ⚠️   API error (${code}) on attempt ${attempt}/${MAX_API_RETRIES} — retrying in ${delayMs / 1000}s…`
            );
            await new Promise((r) => setTimeout(r, delayMs));
          } else {
            throw err;
          }
        }
      }

      if (lastErr) throw lastErr;

      if (finishReason !== "tool_calls" || !repoPath) {
        if (toTerminal) process.stdout.write("\n");
        if (streamTo) streamTo.end();
        if (!textContent) throw new Error("LiteLLM returned empty response");
        if (finishReason === "length") {
          console.warn(
            "  ⚠️   LLM response was cut off (finish_reason=length) — findings may be incomplete. " +
            "Consider raising max_tokens or reducing the diff size."
          );
        }
        return textContent.trim();
      }

      // Add assistant message with tool calls
      const calls = Object.values(toolCalls);
      messages.push({
        role: "assistant",
        content: textContent || null,
        tool_calls: calls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.args },
        })),
      });

      // Execute each tool and add results
      for (const tc of calls) {
        let args: Record<string, string> = {};
        try { args = JSON.parse(tc.args); } catch {}
        const result = executeTool(tc.name, args, repoPath);
        toolCallCount++;
        console.log(`  🔧  [tool #${toolCallCount}] ${tc.name}(${args.path ?? ""})`);
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    }
  }
}

/** @deprecated Use LiteLLMClient */
export const ClaudeClient = LiteLLMClient;
