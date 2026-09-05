import { LLMClient, LiteLLMClient } from "./claudeClient";
import { AnthropicClient } from "./anthropicClient";

// ─────────────────────────────────────────────────────────────────────────────
// Single entry point for constructing the configured LLMClient. Every call
// site should go through this instead of instantiating LiteLLMClient or
// AnthropicClient directly, so a client choosing their provider is always a
// config change (LLM_PROVIDER env var), never a code change.
//
// Default is "openai" (LiteLLMClient, OpenAI-compatible chat-completions) —
// unchanged behavior for every existing config that doesn't set
// LLM_PROVIDER at all.
// ─────────────────────────────────────────────────────────────────────────────

export type LLMProvider = "openai" | "anthropic";

export function createLLMClient(modelOverride?: string): LLMClient {
  const raw = (process.env.LLM_PROVIDER || "openai").trim().toLowerCase();

  if (raw === "anthropic") return new AnthropicClient(modelOverride);
  if (raw === "openai") return new LiteLLMClient(modelOverride);

  throw new Error(
    `Unknown LLM_PROVIDER "${raw}" — expected "openai" (default, OpenAI-compatible/LiteLLM) or "anthropic" (native Anthropic Messages API).`
  );
}
