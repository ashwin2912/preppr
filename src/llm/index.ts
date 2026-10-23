import { AnthropicLlm } from "./anthropic";
import { OpenAiCompatLlm } from "./openai-compat";
import type { Llm } from "./types";

const BASE_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  huggingface: "https://router.huggingface.co/v1",
};

/**
 * Picks the parser model from env:
 *   LLM_PROVIDER=anthropic (default)  ANTHROPIC_API_KEY, ANTHROPIC_MODEL
 *   LLM_PROVIDER=openrouter | huggingface | openai  LLM_API_KEY, LLM_MODEL, LLM_BASE_URL (openai: required)
 * Returns null when the provider's API key is missing.
 */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): { llm: Llm; label: string } | null {
  const provider = (env.LLM_PROVIDER || "anthropic").toLowerCase();
  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) return null;
    const model = env.ANTHROPIC_MODEL || "claude-haiku-5-5";
    return { llm: new AnthropicLlm(env.ANTHROPIC_API_KEY, model), label: `anthropic ${model}` };
  }
  const baseUrl = env.LLM_BASE_URL || BASE_URLS[provider];
  if (!baseUrl) throw new Error(`LLM_PROVIDER=${provider} needs LLM_BASE_URL`);
  if (!env.LLM_MODEL) throw new Error(`LLM_PROVIDER=${provider} needs LLM_MODEL`);
  if (!env.LLM_API_KEY) return null;
  return { llm: new OpenAiCompatLlm(baseUrl, env.LLM_API_KEY, env.LLM_MODEL), label: `${provider} ${env.LLM_MODEL}` };
}
