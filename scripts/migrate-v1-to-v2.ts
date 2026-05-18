/**
 * Phase 2 ETL — migrate v1 lifestyle data into the unified v2 schema.
 *
 * Reads from v1 tables (publications, lifestyle_sources, lifestyle_leads,
 * lifestyle_articles), pushes each article through the current pipeline
 * stages, and writes survivors (score >= 40) to leads_v2.
 *
 *   PREREQUISITES
 *     - scripts/v2-create-tables.sql must have been applied
 *     - .env has DATABASE_URL + OpenRouter credentials
 *     - Lifestyle cron paused (LIFESTYLE_CRON_ENABLED unset/false)
 *
 *   USAGE
 *     # Dry-run, sample 25 rows from each source, print summary:
 *     tsx scripts/migrate-v1-to-v2.ts --sample 25
 *
 *     # Dry-run, full dataset, calls LLMs but does NOT write leads_v2:
 *     tsx scripts/migrate-v1-to-v2.ts
 *
 *     # Real run, write to leads_v2, resumable:
 *     tsx scripts/migrate-v1-to-v2.ts --commit
 *
 *     # Resume after crash (idempotent — skips rows in migration_progress):
 *     tsx scripts/migrate-v1-to-v2.ts --commit
 *
 *     # Process only one source table:
 *     tsx scripts/migrate-v1-to-v2.ts --commit --source lifestyle_leads
 *
 *   OUTPUT
 *     - migration_progress table: per-row stage + outcome + drop reason
 *     - migration-report.md: at end of run, summary + samples
 */

import "dotenv/config";
import { randomUUID, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import {
  passesInterestFilter,
  extractPrimaryCompany,
  isPublicCompany,
  checkDuplication,
  deepAnalyzeArticle,
} from "../server/pipeline-stages";
import type { RawArticle } from "../server/adapters";
import { DEFAULT_INTEREST_FILTER_PROMPT } from "../shared/schema";

// ============================================================================
// Config & argv
// ============================================================================

const argv = process.argv.slice(2);
const COMMIT = argv.includes("--commit");
const SAMPLE_N = (() => {
  const i = argv.indexOf("--sample");
  return i >= 0 ? parseInt(argv[i + 1] ?? "25", 10) : null;
})();
const LIMIT = (() => {
  const i = argv.indexOf("--limit");
  return i >= 0 ? parseInt(argv[i + 1] ?? "0", 10) || null : null;
})();
const SOURCE_FILTER = (() => {
  const i = argv.indexOf("--source");
  return i >= 0 ? argv[i + 1] : null;
})();

const DEFAULT_REGIONS = ["Singapore", "Malaysia", "Indonesia", "Thailand", "Vietnam", "Philippines", "Hong Kong", "Taiwan"];
const RATE_LIMIT_MS = 250;
const SCORE_THRESHOLD = 40;
const REPORT_PATH = "./migration-report.md";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set. Source .env first.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ============================================================================
// Helpers
// ============================================================================

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

interface RunStats {
  total: number;
  alreadyProcessed: number;
  droppedAtStage: Record<string, number>;
  inserted: number;
  failed: number;
  primaryCalls: number;
  fallbackCalls: number;
  sampleAccepted: Array<{ headline: string; score: number; company: string; sourceName: string }>;
  sampleDropped: Array<{ headline: string; reason: string; stage: string }>;
}

const stats: RunStats = {
  total: 0,
  alreadyProcessed: 0,
  droppedAtStage: {},
  inserted: 0,
  failed: 0,
  primaryCalls: 0,
  fallbackCalls: 0,
  sampleAccepted: [],
  sampleDropped: [],
};

async function recordProgress(opts: {
  sourceTable: string;
  sourceId: string;
  stage: string;
  outcome: "passed" | "dropped" | "failed" | "inserted";
  dropReason?: string;
  targetLeadId?: string;
  durationMs?: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO migration_progress
       (source_table, source_id, stage, outcome, drop_reason, target_lead_id, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source_table, source_id) DO UPDATE
       SET stage = EXCLUDED.stage,
           outcome = EXCLUDED.outcome,
           drop_reason = EXCLUDED.drop_reason,
           target_lead_id = EXCLUDED.target_lead_id,
           duration_ms = EXCLUDED.duration_ms,
           processed_at = CURRENT_TIMESTAMP`,
    [opts.sourceTable, opts.sourceId, opts.stage, opts.outcome, opts.dropReason ?? null, opts.targetLeadId ?? null, opts.durationMs ?? null]
  );
}

async function alreadyProcessed(sourceTable: string, sourceId: string): Promise<boolean> {
  const res = await pool.query(
    "SELECT 1 FROM migration_progress WHERE source_table = $1 AND source_id = $2",
    [sourceTable, sourceId]
  );
  return res.rowCount! > 0;
}

function trackDrop(stage: string, reason: string, headline: string) {
  stats.droppedAtStage[stage] = (stats.droppedAtStage[stage] ?? 0) + 1;
  if (stats.sampleDropped.length < 30) {
    stats.sampleDropped.push({ headline, reason, stage });
  }
}

// ============================================================================
// Source migration (no LLM cost — just copy publications + lifestyle_sources)
// ============================================================================

async function migrateSources(): Promise<Map<string, string>> {
  // Returns Map<"v1_table:v1_id", "v2_uuid"> so leads can FK to the new sources.
  const mapping = new Map<string, string>();

  console.log("\n--- Migrating sources ---");

  // lifestyle_sources (NEW table — prefer values from here when slug collides)
  const newSources = await pool.query(
    "SELECT id, name, slug, region, publication_type, base_url, feed_url, scrape_config, check_interval_min, status FROM lifestyle_sources"
  );
  console.log(`Found ${newSources.rowCount} rows in lifestyle_sources`);

  for (const row of newSources.rows) {
    const domain = (() => {
      try {
        return new URL(row.base_url).hostname;
      } catch {
        return row.slug;
      }
    })();
    const newId = randomUUID();
    if (COMMIT) {
      await pool.query(
        `INSERT INTO sources_v2 (id, category, name, slug, domain, base_url, region, publication_type, feed_url, scrape_config, check_interval_min, status, active)
         VALUES ($1, 'lifestyle', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE)
         ON CONFLICT (slug) DO UPDATE SET base_url = EXCLUDED.base_url RETURNING id`,
        [newId, row.name, row.slug, domain, row.base_url, row.region, row.publication_type, row.feed_url, row.scrape_config, row.check_interval_min, row.status]
      );
    }
    mapping.set(`lifestyle_sources:${row.id}`, newId);
  }

  // publications (OLD table — only insert if slug not already present)
  const oldSources = await pool.query(
    "SELECT id, name, slug, base_url, tier, region, feed_url, scrape_config, check_interval_min, is_active FROM publications"
  );
  console.log(`Found ${oldSources.rowCount} rows in publications`);

  const existingSlugs = new Set(newSources.rows.map((r: { slug: string }) => r.slug));

  for (const row of oldSources.rows) {
    if (existingSlugs.has(row.slug)) {
      // Reuse the new-table mapping (find by slug)
      const matched = newSources.rows.find((r: { slug: string }) => r.slug === row.slug);
      if (matched) {
        mapping.set(`publications:${row.id}`, mapping.get(`lifestyle_sources:${matched.id}`)!);
      }
      continue;
    }

    const domain = (() => {
      try {
        return new URL(row.base_url).hostname;
      } catch {
        return row.slug;
      }
    })();
    const newId = randomUUID();
    if (COMMIT) {
      await pool.query(
        `INSERT INTO sources_v2 (id, category, name, slug, domain, base_url, region, feed_url, scrape_config, check_interval_min, active)
         VALUES ($1, 'lifestyle', $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (slug) DO NOTHING`,
        [newId, row.name, row.slug, domain, row.base_url, row.region, row.feed_url, row.scrape_config, row.check_interval_min, row.is_active]
      );
    }
    mapping.set(`publications:${row.id}`, newId);
  }

  console.log(`Source mapping built: ${mapping.size} entries.`);
  return mapping;
}

// ============================================================================
// Article-row → RawArticle adapter
// ============================================================================

interface V1Row {
  sourceTable: "lifestyle_leads" | "lifestyle_articles";
  sourceId: string;
  publicationId: string | null;
  url: string;
  title: string;
  fullText: string | null;
  snippet: string | null;
  publishedAt: Date | null;
  region: string | null;
  sourceName: string;
  saved: boolean;
  dismissed: boolean;
  feedback: string | null;
}

function toRawArticle(row: V1Row): RawArticle {
  return {
    headline: row.title || "(no title)",
    url: row.url,
    source: row.sourceName,
    sourceTier: "tier2",
    publishedAt: row.publishedAt ?? new Date(),
    content: row.fullText ?? row.snippet ?? "",
    region: row.region ?? "Unknown",
    fetchMethod: "rss",
  };
}

// ============================================================================
// Per-row pipeline
// ============================================================================

async function processRow(row: V1Row, sourceUuid: string | null, seenCompanies: Set<string>): Promise<void> {
  stats.total++;
  const headline = row.title || "(no title)";

  if (await alreadyProcessed(row.sourceTable, row.sourceId)) {
    stats.alreadyProcessed++;
    return;
  }

  const startTime = Date.now();
  const article = toRawArticle(row);

  try {
    // ---- Stage 1: interest filter ----
    stats.primaryCalls++;
    const interest = await passesInterestFilter(article, DEFAULT_INTEREST_FILTER_PROMPT, DEFAULT_REGIONS);
    await sleep(RATE_LIMIT_MS);
    if (!interest.passes) {
      const reason = interest.reason ?? "interest filter rejected";
      trackDrop("interest_filter", reason, headline);
      await recordProgress({
        sourceTable: row.sourceTable,
        sourceId: row.sourceId,
        stage: "interest_filter",
        outcome: "dropped",
        dropReason: reason,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // ---- Stage 2: company extraction ----
    stats.primaryCalls++;
    const company = await extractPrimaryCompany(article);
    await sleep(RATE_LIMIT_MS);
    if (!company.companyName) {
      trackDrop("company_extraction", "no identifiable company", headline);
      await recordProgress({
        sourceTable: row.sourceTable,
        sourceId: row.sourceId,
        stage: "company_extraction",
        outcome: "dropped",
        dropReason: "no company",
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // ---- Stage 3: public company check ----
    stats.primaryCalls++;
    const publicCheck = await isPublicCompany(company.companyName, headline);
    await sleep(RATE_LIMIT_MS);
    if (publicCheck.isPublic) {
      trackDrop("public_company", "company already public", headline);
      await recordProgress({
        sourceTable: row.sourceTable,
        sourceId: row.sourceId,
        stage: "public_company",
        outcome: "dropped",
        dropReason: "company is publicly listed",
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // ---- Stage 4: in-batch dedup ----
    const companyKey = company.companyName.toLowerCase().trim();
    if (seenCompanies.has(companyKey)) {
      trackDrop("dedup_company", "duplicate company in batch", headline);
      await recordProgress({
        sourceTable: row.sourceTable,
        sourceId: row.sourceId,
        stage: "dedup_company",
        outcome: "dropped",
        dropReason: `duplicate of company "${company.companyName}" earlier in batch`,
        durationMs: Date.now() - startTime,
      });
      return;
    }
    // Note: skipping LLM-based checkDuplication for migration. The headline-level
    // similarity check is more relevant for live scans than for the historical
    // import — at this point we just want one canonical lead per company.

    // ---- Stage 5: skip fetchFullArticleContent (we have full_text or snippet) ----

    // ---- Stage 6: deep analysis ----
    stats.primaryCalls++;
    const fullContent = row.fullText ?? row.snippet ?? "";
    const analysis = await deepAnalyzeArticle(article, fullContent, DEFAULT_REGIONS);
    await sleep(RATE_LIMIT_MS);

    if (!analysis) {
      trackDrop("deep_analysis", "analysis returned null", headline);
      await recordProgress({
        sourceTable: row.sourceTable,
        sourceId: row.sourceId,
        stage: "deep_analysis",
        outcome: "dropped",
        dropReason: "deep analysis returned null",
        durationMs: Date.now() - startTime,
      });
      return;
    }

    const score = analysis.leadData.priorityScore ?? 0;
    if (score < SCORE_THRESHOLD) {
      trackDrop("score_threshold", `score ${score} < ${SCORE_THRESHOLD}`, headline);
      await recordProgress({
        sourceTable: row.sourceTable,
        sourceId: row.sourceId,
        stage: "score_threshold",
        outcome: "dropped",
        dropReason: `score ${score} below ${SCORE_THRESHOLD}`,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // ---- Stage 7 (enrichment) skipped — would 2x cost; can run as a separate pass later ----

    // ---- Insert into leads_v2 ----
    seenCompanies.add(companyKey);
    const leadId = randomUUID();
    const leadData = analysis.leadData;

    if (COMMIT) {
      const status = row.saved ? "saved" : row.dismissed ? "dismissed" : "new";
      await pool.query(
        `INSERT INTO leads_v2 (
           id, category, source_id,
           headline, source_url, source_name, source_tier,
           published_at, region,
           company_names, founder_names, investors, matched_keywords,
           ai_summary, wealth_angle, key_financials, pipeline_reasoning, sea_connection,
           priority_score, priority_level, status, fetch_method, analyzed_by_model
         ) VALUES (
           $1, 'lifestyle', $2,
           $3, $4, $5, $6,
           $7, $8,
           $9, $10, $11, $12,
           $13, $14, $15, $16, $17,
           $18, $19, $20, $21, $22
         )`,
        [
          leadId, sourceUuid,
          headline, row.url, row.sourceName, "tier2",
          leadData.publishedAt ?? row.publishedAt ?? new Date(), row.region ?? "Unknown",
          leadData.companyNames ?? [company.companyName],
          leadData.founderNames ?? [],
          leadData.investors ?? [],
          leadData.matchedKeywords ?? [],
          leadData.aiSummary ?? "",
          analysis.wealthAngle ?? "",
          analysis.keyFinancials ?? null,
          leadData.pipelineReasoning ?? null,
          leadData.seaConnection ?? null,
          score,
          leadData.priorityLevel ?? "medium",
          status,
          "rss",
          "google/gemini-2.5-flash-lite",
        ]
      );

      // Preserve saved metadata
      if (row.saved) {
        await pool.query(
          `INSERT INTO saved_leads_v2 (lead_id) VALUES ($1)`,
          [leadId]
        );
      }
      // Preserve feedback as lead_feedback_v2 row
      if (row.feedback === "thumbs_up" || row.feedback === "thumbs_down") {
        await pool.query(
          `INSERT INTO lead_feedback_v2 (lead_id, verdict) VALUES ($1, $2)`,
          [leadId, row.feedback]
        );
      }
    }

    stats.inserted++;
    if (stats.sampleAccepted.length < 30) {
      stats.sampleAccepted.push({ headline, score, company: company.companyName, sourceName: row.sourceName });
    }
    await recordProgress({
      sourceTable: row.sourceTable,
      sourceId: row.sourceId,
      stage: "inserted",
      outcome: COMMIT ? "inserted" : "passed",
      targetLeadId: leadId,
      durationMs: Date.now() - startTime,
    });
  } catch (err: any) {
    stats.failed++;
    const msg = err?.message ?? String(err);
    console.error(`  ! row failed: ${headline.slice(0, 60)} — ${msg}`);
    await recordProgress({
      sourceTable: row.sourceTable,
      sourceId: row.sourceId,
      stage: "error",
      outcome: "failed",
      dropReason: msg,
      durationMs: Date.now() - startTime,
    });
  }
}

// ============================================================================
// Row iterators
// ============================================================================

async function* iterateLifestyleLeads(sourceMap: Map<string, string>): AsyncGenerator<{ row: V1Row; sourceUuid: string | null }> {
  const sql = `
    SELECT l.id, l.publication_id, l.url, l.title, l.full_text, l.snippet,
           l.published_at, p.region, p.name as source_name,
           COALESCE(l.saved, FALSE) as saved,
           COALESCE(l.dismissed, FALSE) as dismissed,
           l.feedback
    FROM lifestyle_leads l
    LEFT JOIN publications p ON l.publication_id = p.id
    ORDER BY l.relevance_score DESC NULLS LAST, l.id ASC
    ${SAMPLE_N ? `LIMIT ${SAMPLE_N}` : LIMIT ? `LIMIT ${LIMIT}` : ""}
  `;
  const res = await pool.query(sql);
  for (const r of res.rows) {
    yield {
      row: {
        sourceTable: "lifestyle_leads",
        sourceId: String(r.id),
        publicationId: r.publication_id ? String(r.publication_id) : null,
        url: r.url,
        title: r.title ?? "",
        fullText: r.full_text,
        snippet: r.snippet,
        publishedAt: r.published_at,
        region: r.region,
        sourceName: r.source_name ?? "unknown",
        saved: r.saved,
        dismissed: r.dismissed,
        feedback: r.feedback,
      },
      sourceUuid: r.publication_id ? sourceMap.get(`publications:${r.publication_id}`) ?? null : null,
    };
  }
}

async function* iterateLifestyleArticles(sourceMap: Map<string, string>): AsyncGenerator<{ row: V1Row; sourceUuid: string | null }> {
  const sql = `
    SELECT a.id, a.source_id, a.url, a.title, a.full_text, a.snippet,
           a.published_at, s.region, s.name as source_name
    FROM lifestyle_articles a
    LEFT JOIN lifestyle_sources s ON a.source_id = s.id
    ORDER BY a.relevance_score DESC NULLS LAST, a.created_at ASC
    ${SAMPLE_N ? `LIMIT ${SAMPLE_N}` : LIMIT ? `LIMIT ${LIMIT}` : ""}
  `;
  const res = await pool.query(sql);
  for (const r of res.rows) {
    yield {
      row: {
        sourceTable: "lifestyle_articles",
        sourceId: r.id,
        publicationId: r.source_id ? String(r.source_id) : null,
        url: r.url,
        title: r.title ?? "",
        fullText: r.full_text,
        snippet: r.snippet,
        publishedAt: r.published_at,
        region: r.region,
        sourceName: r.source_name ?? "unknown",
        saved: false,
        dismissed: false,
        feedback: null,
      },
      sourceUuid: r.source_id ? sourceMap.get(`lifestyle_sources:${r.source_id}`) ?? null : null,
    };
  }
}

// ============================================================================
// Report
// ============================================================================

function writeReport(durationMs: number) {
  const mins = Math.round(durationMs / 60_000);
  const totalCalls = stats.primaryCalls + stats.fallbackCalls;
  // Rough cost estimate: Gemini 2.5 Flash Lite at $0.10 / M input + $0.40 / M output.
  // Assume ~2k input + 500 output per call → $0.0004 per call.
  const estCostUsd = (totalCalls * 0.0004).toFixed(4);

  const dropLines = Object.entries(stats.droppedAtStage)
    .sort(([, a], [, b]) => b - a)
    .map(([stage, n]) => `- ${stage}: ${n}`)
    .join("\n");

  const accepted = stats.sampleAccepted
    .map((s) => `- [${s.score}] **${s.company}** — ${s.headline.slice(0, 100)} _(${s.sourceName})_`)
    .join("\n");
  const dropped = stats.sampleDropped
    .map((s) => `- [${s.stage}] ${s.headline.slice(0, 100)} — _${s.reason.slice(0, 200)}_`)
    .join("\n");

  const md = `# v1 → v2 Migration Report

_Generated ${new Date().toISOString()}_

**Mode:** ${COMMIT ? "COMMIT (wrote to leads_v2)" : "DRY-RUN (no writes to leads_v2)"}
${SAMPLE_N ? `**Sample size:** ${SAMPLE_N} rows per source table` : ""}
${LIMIT ? `**Limit:** ${LIMIT} rows per source table` : ""}

## Totals

| Metric | Count |
|---|---:|
| Rows considered | ${stats.total} |
| Skipped (already in migration_progress) | ${stats.alreadyProcessed} |
| Inserted into leads_v2 | ${stats.inserted} |
| Dropped (filtered out) | ${Object.values(stats.droppedAtStage).reduce((a, b) => a + b, 0)} |
| Failed (errors) | ${stats.failed} |

## LLM cost

| | Count |
|---|---:|
| Primary model calls | ${stats.primaryCalls} |
| Fallback model calls | ${stats.fallbackCalls} |
| Total | ${totalCalls} |
| Est. cost | ~$${estCostUsd} |

Run duration: ${mins} min (${(durationMs / 1000).toFixed(1)}s).

## Drops by stage

${dropLines || "_(none)_"}

## Sample — accepted leads (up to 30)

${accepted || "_(none)_"}

## Sample — dropped rows (up to 30, with reasons)

${dropped || "_(none)_"}
`;
  writeFileSync(REPORT_PATH, md);
  console.log(`\nReport written: ${REPORT_PATH}`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=== News-sensei v1 → v2 migration ===");
  console.log(`Mode: ${COMMIT ? "COMMIT" : "DRY-RUN"}`);
  if (SAMPLE_N) console.log(`Sample size: ${SAMPLE_N} per source table`);
  if (LIMIT) console.log(`Limit: ${LIMIT} per source table`);
  if (SOURCE_FILTER) console.log(`Source filter: ${SOURCE_FILTER}`);

  const startTime = Date.now();
  const sourceMap = await migrateSources();
  const seenCompanies = new Set<string>();

  if (!SOURCE_FILTER || SOURCE_FILTER === "lifestyle_leads") {
    console.log("\n--- Processing lifestyle_leads ---");
    let i = 0;
    for await (const { row, sourceUuid } of iterateLifestyleLeads(sourceMap)) {
      i++;
      if (i % 50 === 0) {
        console.log(`  [${i}] processed=${stats.total} inserted=${stats.inserted} dropped=${Object.values(stats.droppedAtStage).reduce((a, b) => a + b, 0)}`);
      }
      await processRow(row, sourceUuid, seenCompanies);
    }
  }

  if (!SOURCE_FILTER || SOURCE_FILTER === "lifestyle_articles") {
    console.log("\n--- Processing lifestyle_articles ---");
    let i = 0;
    for await (const { row, sourceUuid } of iterateLifestyleArticles(sourceMap)) {
      i++;
      if (i % 50 === 0) {
        console.log(`  [${i}] processed=${stats.total} inserted=${stats.inserted} dropped=${Object.values(stats.droppedAtStage).reduce((a, b) => a + b, 0)}`);
      }
      await processRow(row, sourceUuid, seenCompanies);
    }
  }

  const durationMs = Date.now() - startTime;
  console.log("\n=== Done ===");
  console.log(`Total: ${stats.total} | Inserted: ${stats.inserted} | Dropped: ${Object.values(stats.droppedAtStage).reduce((a, b) => a + b, 0)} | Failed: ${stats.failed}`);
  writeReport(durationMs);

  await pool.end();
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  await pool.end();
  process.exit(1);
});
// Side-note: hashUrl is exported-ready in case Phase 3 also needs it.
void hashUrl;
