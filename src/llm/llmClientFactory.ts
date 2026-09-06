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

  // A single API_KEY env var (from the `api_key` action input) is the
  // recommended way to configure a key now — one input regardless of
  // provider, so switching LLM_PROVIDER (e.g. via a repo/org Variable)
  // never also requires swapping which input the key goes under. That
  // mismatch (a key landing under the wrong provider-specific input after
  // only the provider was flipped) is exactly what caused a confusing
  // wrong-endpoint 401 in live testing. The older provider-specific
  // LITELLM_API_KEY / ANTHROPIC_API_KEY env vars still work unchanged and
  // take precedence if set explicitly, so an existing caller isn't
  // silently altered by this.
  const genericKey = process.env.API_KEY;
  if (genericKey) {
    if (raw === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = genericKey;
    } else if (raw === "openai" && !process.env.LITELLM_API_KEY) {
      process.env.LITELLM_API_KEY = genericKey;
    }
  }

  if (raw === "anthropic") return new AnthropicClient(modelOverride);
  if (raw === "openai") return new LiteLLMClient(modelOverride);

  throw new Error(
    `Unknown LLM_PROVIDER "${raw}" — expected "openai" (default, OpenAI-compatible/LiteLLM) or "anthropic" (native Anthropic Messages API).`
  );
}
