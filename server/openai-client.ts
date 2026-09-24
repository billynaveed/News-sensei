import OpenAI from "openai";

/**
 * Shared LLM client. Every model call routes through the configured gateway
 * (`AI_INTEGRATIONS_OPENAI_BASE_URL`, OpenRouter-style) — without baseURL the
 * OpenAI SDK would hit api.openai.com and the gateway-routed models
 * (gemini-2.5-flash-lite, claude-sonnet-4) would not resolve.
 *
 * Import this rather than constructing `new OpenAI(...)` per file, so the
 * gateway config (and any future timeout/retry policy) lives in one place.
 *
 * `chat.completions.create` is wrapped so the health checks can tell "the
 * gateway is answering" from "every call has been failing for an hour" without
 * spending a token. The wrapper returns the SDK's own APIPromise untouched, so
 * call sites (and `.withResponse()`/streaming) behave exactly as before.
 */

/** Outcome of a single LLM call, newest last. */
export type LlmCallOutcome = "ok" | "error";

export interface LlmStatus {
  /** ISO timestamp of the most recent successful completion, ever. */
  lastSuccessAt: string | null;
  /** ISO timestamp of the most recent failed completion, ever. */
  lastErrorAt: string | null;
  /** Message of the most recent failure (truncated). */
  lastError: string | null;
  /** Calls started today (UTC day, matching the scraper/search counters). */
  callsToday: number;
  /** Calls that rejected today (UTC day). */
  errorsToday: number;
  /** Outcomes of the last few calls, oldest first — used to spot a hard outage. */
  recentOutcomes: LlmCallOutcome[];
}

const RECENT_OUTCOME_WINDOW = 10;
const MAX_ERROR_LENGTH = 300;

const counters = { day: "", callsToday: 0, errorsToday: 0 };
let lastSuccessAt: string | null = null;
let lastErrorAt: string | null = null;
let lastError: string | null = null;
const recentOutcomes: LlmCallOutcome[] = [];

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Roll the per-day counters over at UTC midnight. */
function touchCounters(): void {
  const day = utcDay();
  if (counters.day !== day) {
    counters.day = day;
    counters.callsToday = 0;
    counters.errorsToday = 0;
  }
}

function recordOutcome(outcome: LlmCallOutcome): void {
  recentOutcomes.push(outcome);
  if (recentOutcomes.length > RECENT_OUTCOME_WINDOW) recentOutcomes.shift();
}

function recordSuccess(): void {
  lastSuccessAt = new Date().toISOString();
  recordOutcome("ok");
}

function recordError(error: unknown): void {
  touchCounters();
  counters.errorsToday++;
  lastErrorAt = new Date().toISOString();
  lastError = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
  recordOutcome("error");
}

/** Snapshot of LLM gateway health. Cheap: pure in-memory counters, no I/O. */
export function getLlmStatus(): LlmStatus {
  touchCounters();
  return {
    lastSuccessAt,
    lastErrorAt,
    lastError,
    callsToday: counters.callsToday,
    errorsToday: counters.errorsToday,
    recentOutcomes: [...recentOutcomes],
  };
}

const client = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

type CreateFn = typeof client.chat.completions.create;

const createUntracked = client.chat.completions.create.bind(client.chat.completions) as (
  ...args: unknown[]
) => unknown;

/**
 * Instrumented `create`. It observes the returned promise rather than replacing
 * it, so the caller still receives the SDK's APIPromise with all of its helper
 * methods intact. Observing twice is safe — APIPromise memoises its parse.
 */
const createTracked = (...args: unknown[]): unknown => {
  touchCounters();
  counters.callsToday++;
  let result: unknown;
  try {
    result = createUntracked(...args);
  } catch (error) {
    // Synchronous throw (bad params) — still a failed call.
    recordError(error);
    throw error;
  }
  Promise.resolve(result as PromiseLike<unknown>).then(recordSuccess, recordError);
  return result;
};

// Shadow the prototype method with the instrumented one so existing call sites
// (`openai.chat.completions.create(...)`) pick it up with no changes.
client.chat.completions.create = createTracked as unknown as CreateFn;

export const openai = client;
