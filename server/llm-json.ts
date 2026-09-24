/**
 * Shared helper for the "ask the gateway for JSON, parse it" call shape that
 * every pipeline stage, scanner and enrichment module repeated by hand.
 *
 * Each of those sites used to build the same `openai.chat.completions.create`
 * body, pull `choices[0].message.content`, guard it, run it through
 * `stripJsonFences` + `JSON.parse`, and invent its own log line. That is a lot
 * of surface area for one idea, and it meant a model that answered with prose
 * (or an empty string) simply failed the stage with no second chance.
 *
 * This module centralises the shape and adds one retry: when the reply will not
 * parse, the prompt is re-sent once with an explicit "Return ONLY valid JSON."
 * instruction appended. Transport errors are NOT retried — the SDK already has
 * its own retry policy, and a 429/500 will not be fixed by nagging the model
 * about formatting.
 */

import { openai } from "./openai-client";
import { stripJsonFences } from "./json-utils";
import { log } from "./log";

/** Appended to the prompt on the single retry after an unparseable reply. */
const RETRY_INSTRUCTION = "Return ONLY valid JSON.";

/** Longest snippet of a bad reply we put in a log line. */
const MAX_LOGGED_REPLY = 200;

export interface JsonStageOptions {
  /** Gateway model id, e.g. "google/gemini-2.5-flash-lite". */
  model: string;
  /** Fully-built user prompt. */
  prompt: string;
  /**
   * Optional system message, sent ahead of the user prompt. Only a couple of
   * call sites split their instructions this way; when omitted, no system
   * message is sent at all — identical to a plain single-message request.
   */
  systemPrompt?: string;
  /**
   * `max_completion_tokens`. Optional because a few call sites deliberately
   * leave the cap to the model default; omitting it here sends no cap, exactly
   * as those sites did before.
   */
  maxTokens?: number;
  /** Sampling temperature. Omitted from the request when not supplied. */
  temperature?: number;
  /** Short stage name used in log lines, e.g. "S1 Interest Filter". */
  label: string;
  /** Per-request timeout override, in ms. Defaults to the SDK's own timeout. */
  timeoutMs?: number;
  /**
   * Whether to request `response_format: { type: "json_object" }`. Defaults to
   * true. Set false only when the prompt asks for a top-level JSON *array* —
   * strict object mode can push a model into wrapping the array in an object.
   */
  jsonMode?: boolean;
}

/** Issue one completion and return the raw reply text (empty string if none). */
async function requestJson(opts: JsonStageOptions, prompt: string): Promise<string> {
  const response = await openai.chat.completions.create(
    {
      model: opts.model,
      messages: [
        ...(opts.systemPrompt !== undefined
          ? [{ role: "system" as const, content: opts.systemPrompt }]
          : []),
        { role: "user" as const, content: prompt },
      ],
      ...(opts.maxTokens !== undefined ? { max_completion_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.jsonMode === false ? {} : { response_format: { type: "json_object" as const } }),
    },
    opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : undefined,
  );

  return response.choices[0]?.message?.content ?? "";
}

/**
 * Calls the LLM gateway and parses the reply as JSON, retrying once when the
 * reply will not parse.
 *
 * @param opts - Model, prompt, token/temperature caps and a log label
 * @returns The parsed JSON, cast to `T` (no runtime validation is performed)
 * @throws The underlying SDK error on transport/API failure, or a descriptive
 *         Error when both the first reply and the retry fail to parse
 *
 * @example
 * const verdict = await callJsonStage<{ relevant: boolean }>({
 *   model: "google/gemini-2.5-flash-lite",
 *   prompt,
 *   maxTokens: 256,
 *   temperature: 0.2,
 *   label: "S1 Interest Filter",
 * });
 */
export async function callJsonStage<T>(opts: JsonStageOptions): Promise<T> {
  let lastFailure = "no attempt made";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1 ? opts.prompt : `${opts.prompt}\n\n${RETRY_INSTRUCTION}`;

    let raw: string;
    try {
      raw = await requestJson(opts, prompt);
    } catch (error) {
      // Transport/API failure. Surface the SDK's own error unchanged so call
      // sites keep reporting the message they always did.
      const message = error instanceof Error ? error.message : String(error);
      log(`[LLM ${opts.label}] request failed: ${message}`, "llm");
      throw error;
    }

    try {
      return JSON.parse(stripJsonFences(raw)) as T;
    } catch {
      lastFailure = raw.trim() ? `unparseable reply: ${raw.trim().slice(0, MAX_LOGGED_REPLY)}` : "empty reply";
      log(
        `[LLM ${opts.label}] ${lastFailure} (attempt ${attempt}/2)`,
        "llm",
      );
    }
  }

  throw new Error(`[LLM ${opts.label}] no valid JSON after 2 attempts — ${lastFailure}`);
}

/**
 * `callJsonStage` that returns null instead of throwing, for call sites that
 * treat "the model gave us nothing usable" as a normal, non-fatal outcome.
 *
 * @param opts - Same options as {@link callJsonStage}
 * @returns The parsed JSON, or null if the call or the parse ultimately failed
 */
export async function safeCallJsonStage<T>(opts: JsonStageOptions): Promise<T | null> {
  try {
    return await callJsonStage<T>(opts);
  } catch {
    return null;
  }
}
