import OpenAI from "openai";

/**
 * Shared LLM client. Every model call routes through the configured gateway
 * (`AI_INTEGRATIONS_OPENAI_BASE_URL`, OpenRouter-style) — without baseURL the
 * OpenAI SDK would hit api.openai.com and the gateway-routed models
 * (gemini-2.5-flash-lite, claude-sonnet-4) would not resolve.
 *
 * Import this rather than constructing `new OpenAI(...)` per file, so the
 * gateway config (and any future timeout/retry policy) lives in one place.
 */
export const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});
