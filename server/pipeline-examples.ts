/**
 * Pipeline examples — the learning loop's memory.
 *
 * Every time Billy says "this should have passed" (or "should have been
 * rejected") on the Debug page, the article becomes a reference example. The
 * examples feed the prompts as few-shots (see feedback-prompt.ts) and are
 * re-run nightly as a regression suite, so a prompt change that breaks a
 * known-good case shows up on the Debug page and in the morning digest.
 */

import { db } from "./db";
import { sql } from "drizzle-orm";
import { log } from "./log";

export type ExampleExpectation = "pass" | "reject";

export interface PipelineExample {
  id: string;
  url: string;
  headline: string;
  expected: ExampleExpectation;
  note: string | null;
  lastResult: "pass" | "reject" | "error" | null;
  lastReason: string | null;
  lastRunAt: string | null;
  createdAt: string;
}

export async function listExamples(): Promise<PipelineExample[]> {
  const r = await db.execute(sql`
    SELECT id, url, headline, expected, note,
           last_result AS "lastResult", last_reason AS "lastReason",
           last_run_at AS "lastRunAt", created_at AS "createdAt"
    FROM pipeline_examples ORDER BY created_at DESC LIMIT 200
  `);
  return r.rows as unknown as PipelineExample[];
}

export async function upsertExample(input: { url: string; headline: string; expected: ExampleExpectation; note?: string | null }) {
  await db.execute(sql`
    INSERT INTO pipeline_examples (url, headline, expected, note)
    VALUES (${input.url}, ${input.headline.slice(0, 300)}, ${input.expected}, ${input.note ?? null})
    ON CONFLICT (url) DO UPDATE SET expected = EXCLUDED.expected, note = COALESCE(EXCLUDED.note, pipeline_examples.note), headline = EXCLUDED.headline
  `);
}

export async function deleteExample(id: string) {
  await db.execute(sql`DELETE FROM pipeline_examples WHERE id = ${id}`);
}

export async function recordExampleResult(url: string, result: "pass" | "reject" | "error", reason: string | null) {
  await db.execute(sql`
    UPDATE pipeline_examples SET last_result = ${result}, last_reason = ${reason ? reason.slice(0, 500) : null}, last_run_at = now()
    WHERE url = ${url}
  `);
}

/** Few-shot material for the prompts: false negatives Billy flagged, newest first. */
export async function getPositiveExamples(limit = 10): Promise<{ headline: string; note: string | null }[]> {
  const r = await db.execute(sql`
    SELECT headline, note FROM pipeline_examples WHERE expected = 'pass' ORDER BY created_at DESC LIMIT ${limit}
  `);
  return r.rows as unknown as { headline: string; note: string | null }[];
}

/** Summary for the Debug page and the daily digest. */
export async function getExamplesSummary() {
  const r = await db.execute(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE last_result IS NOT NULL AND last_result = expected)::int AS passing,
           count(*) FILTER (WHERE last_result IS NOT NULL AND last_result <> expected)::int AS failing,
           count(*) FILTER (WHERE last_result IS NULL)::int AS untested,
           max(last_run_at) AS "lastRunAt"
    FROM pipeline_examples
  `);
  return r.rows[0] as unknown as { total: number; passing: number; failing: number; untested: number; lastRunAt: string | null };
}

/**
 * Re-run every example through the pipeline (dry run: no lead is created)
 * and record whether the outcome matched the expectation.
 */
export async function runExamples(
  dryRun: (url: string) => Promise<{ status: "success" | "skipped" | "error"; reason?: string }>,
): Promise<{ ran: number; passing: number; failing: number }> {
  const examples = await listExamples();
  let passing = 0, failing = 0;
  for (const ex of examples) {
    try {
      const out = await dryRun(ex.url);
      const result: "pass" | "reject" | "error" = out.status === "success" ? "pass" : out.status === "skipped" ? "reject" : "error";
      await recordExampleResult(ex.url, result, out.reason ?? null);
      if (result === ex.expected) passing++; else failing++;
    } catch (error) {
      await recordExampleResult(ex.url, "error", (error as Error).message);
      failing++;
    }
  }
  log(`[Examples] ran ${examples.length}: ${passing} passing, ${failing} failing`, "pipeline");
  return { ran: examples.length, passing, failing };
}
