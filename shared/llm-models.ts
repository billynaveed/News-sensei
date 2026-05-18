/**
 * LLM model registry — single source of truth for available models.
 *
 * To wire in a new model: add one entry to KNOWN_MODELS below. That's it.
 * The settings UI auto-populates from this list; the fallback wrapper
 * looks up cost/tier metadata at runtime. No DB migration needed —
 * settings stores the model ID as a free-text string, so users can also
 * paste a custom OpenRouter slug not in this list.
 */

export type LlmProvider = "openrouter" | "openai" | "anthropic";

export type LlmTier =
  | "free"            // OpenRouter :free endpoints — rate-limited, best for fallback
  | "cheap"           // <$0.10/M input — daily-driver
  | "mid"             // $0.10-$2/M input — heavy analysis
  | "premium";        // >$2/M input — reserve for critical decisions

export interface LlmModel {
  id: string;                    // exact slug passed to the provider API
  label: string;                 // human-readable name for UI
  provider: LlmProvider;
  tier: LlmTier;
  contextWindow: number;         // tokens
  notes?: string;
}

/**
 * Add new models here. ID must match the provider's exact slug.
 *
 * For OpenRouter: https://openrouter.ai/models — copy the path under the
 * domain (e.g. `google/gemma-4-26b-a4b-it:free`).
 */
export const KNOWN_MODELS: LlmModel[] = [
  {
    id: "google/gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash Lite",
    provider: "openrouter",
    tier: "cheap",
    contextWindow: 1_000_000,
    notes: "Current daily-driver for News-sensei pipeline (2026-05).",
  },
  {
    id: "google/gemma-4-26b-a4b-it:free",
    label: "Gemma 4 26B (free)",
    provider: "openrouter",
    tier: "free",
    contextWindow: 128_000,
    notes: "Free-tier fallback. Rate-limited but unbilled. Good for credit-exhaustion failover.",
  },
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    provider: "openrouter",
    tier: "mid",
    contextWindow: 1_000_000,
    notes: "Step up from Flash Lite when accuracy matters more than cost.",
  },
  {
    id: "openai/gpt-4o-mini",
    label: "GPT-4o mini",
    provider: "openrouter",
    tier: "cheap",
    contextWindow: 128_000,
    notes: "OpenAI alternative if Google rate-limits both Gemini and Gemma.",
  },
];

export const DEFAULT_PRIMARY_MODEL_ID = "google/gemini-2.5-flash-lite";
export const DEFAULT_FALLBACK_MODEL_ID = "google/gemma-4-26b-a4b-it:free";

export function findModel(id: string): LlmModel | undefined {
  return KNOWN_MODELS.find((m) => m.id === id);
}
