import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import { LLMClient, executeTool, isRetryable, MAX_API_RETRIES, RETRY_BASE_DELAY_MS } from "./claudeClient";

// ────────────────────────────────────────────────────────────────────────────
// Native Anthropic Messages API client — for clients who bring a raw
// Anthropic key rather than an OpenAI-compatible one (LiteLLMClient only
// speaks the OpenAI chat-completions shape; Anthropic's API is not
// OpenAI-compatible, unlike e.g. Gemini's, which already works through
// LiteLLMClient via its own OpenAI-compatible endpoint).
//
// Implements the same LLMClient interface and reuses the exact same
// executeTool()/path-safety logic and retry policy as claudeClient.ts, so
// the two providers can never silently diverge on either.
// ────────────────────────────────────────────────────────────────────────────

const FILE_TOOLS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description:
      "Read the full contents of a specific file in the repository. Use this to inspect callers, dependents, or related files when you know the exact path from the diff or import graph. Do not guess paths speculatively — only read files you have reason to believe are relevant to the changes.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the repo root" },
      },
      required: ["path"],
    },
  },
];

// Anthropic requires an explicit max_tokens. 8192 is supported by every
// current Claude model without needing an extended-output beta header —
// deliberately conservative over reaching for a higher limit that only
// some models/accounts support.
const MAX_TOKENS = 8192;

// A key that isn't scoped to a single workspace 400s on every request with
// this exact message until anthropic-workspace-id is set (see the
// ANTHROPIC_WORKSPACE_ID handling in the constructor below). Caught here and
// rethrown with the actual fix instead of surfacing as a raw APIError deep
// in the SDK's stack — hit live during real client testing, before
// ANTHROPIC_WORKSPACE_ID support existed, as an unreadable stack trace.
function isWorkspaceScopingError(err: any): boolean {
  return (
    err?.status === 400 &&
    typeof err?.message === "string" &&
    err.message.includes("not scoped to a workspace")
  );
}

export class AnthropicClient implements LLMClient {
  private client: Anthropic;
  private modelName: string;

  /**
   * @param modelOverride  Optional model name. Falls back to ANTHROPIC_MODEL
   *                       env var, then the same default LiteLLMClient uses
   *                       (kept identical so switching LLM_PROVIDER doesn't
   *                       silently change which model gets used).
   */
  constructor(modelOverride?: string) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Missing env var: ANTHROPIC_API_KEY");
    // Mirror the check in claudeClient.ts for the opposite mismatch: an
    // OpenAI-shaped key passed here would otherwise fail as an opaque 401
    // from Anthropic's API instead of naming the actual misconfiguration.
    if (apiKey.startsWith("sk-") && !apiKey.startsWith("sk-ant-")) {
      throw new Error(
        'The key passed as anthropic_api_key doesn\'t look like a native Anthropic key (those start with "sk-ant-"). ' +
        'If this is an OpenAI (or other OpenAI-compatible) key, remove llm_provider: anthropic and pass it as ' +
        'litellm_api_key instead — see README.md.'
      );
    }
    this.modelName = modelOverride || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
    // Some Anthropic API keys are not scoped to a single workspace, in which
    // case every request 400s with "This API key is not scoped to a
    // workspace... Add the header, or use an API key that is scoped to a
    // workspace." rather than any content-related error. Rather than forcing
    // every client to go regenerate a workspace-scoped key, accept an
    // optional workspace id and send it as the header the API asks for —
    // hit live during real client testing.
    const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
    this.client = new Anthropic({
      apiKey,
      // Optional override for enterprise/custom endpoints (e.g. a Bedrock
      // or Vertex proxy that speaks the Anthropic API shape). Undefined
      // falls back to the SDK's default (api.anthropic.com).
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
      timeout: 600_000,
      maxRetries: 2,
      defaultHeaders: workspaceId ? { "anthropic-workspace-id": workspaceId } : undefined,
    });
  }

  async generate(prompt: string, repoPath?: string, streamTo?: fs.WriteStream): Promise<string> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    const tools = repoPath ? FILE_TOOLS : undefined;

    const toTerminal = !streamTo;
    let toolCallCount = 0;

    while (true) {
      let finalMessage: Anthropic.Message | undefined;
      let lastErr: any;

      for (let attempt = 1; attempt <= MAX_API_RETRIES; attempt++) {
        try {
          const stream = this.client.messages.stream({
            model: this.modelName,
            max_tokens: MAX_TOKENS,
            temperature: 0,
            messages,
            tools,
            tool_choice: tools ? { type: "auto" } : undefined,
          });

          stream.on("text", (delta) => {
            if (streamTo) streamTo.write(delta);
            else if (toTerminal) process.stdout.write(delta);
          });

          finalMessage = await stream.finalMessage();
          lastErr = undefined;
          break;
        } catch (err: any) {
          lastErr = err;
          if (isWorkspaceScopingError(err)) {
            throw new Error(
              'Anthropic rejected this request: "This API key is not scoped to a workspace" — this key ' +
              "needs a workspace specified on every request. Either set anthropic_workspace_id (find the " +
              "workspace ID in the Anthropic Console), or regenerate the key with a specific workspace " +
              "selected in the Console instead (no config needed then) — see README.md."
            );
          }
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
      if (!finalMessage) throw new Error("Anthropic client: no response received");

      const stopReason = finalMessage.stop_reason;
      const textContent = finalMessage.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolUseBlocks = finalMessage.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      if (stopReason !== "tool_use" || !repoPath) {
        if (toTerminal) process.stdout.write("\n");
        if (streamTo) streamTo.end();
        if (!textContent) throw new Error("Anthropic returned empty response");
        if (stopReason === "max_tokens") {
          console.warn(
            "  ⚠️   LLM response was cut off (stop_reason=max_tokens) — findings may be incomplete. " +
            "Consider reducing the diff size."
          );
        }
        return textContent.trim();
      }

      // Assistant turn must carry the full content array (text + tool_use
      // blocks) so the subsequent tool_result correctly references it.
      messages.push({ role: "assistant", content: finalMessage.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tb of toolUseBlocks) {
        const args = (tb.input ?? {}) as Record<string, string>;
        const result = executeTool(tb.name, args, repoPath);
        toolCallCount++;
        console.log(`  🔧  [tool #${toolCallCount}] ${tb.name}(${args.path ?? ""})`);
        toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: result });
      }
      messages.push({ role: "user", content: toolResults });
    }
  }
}
