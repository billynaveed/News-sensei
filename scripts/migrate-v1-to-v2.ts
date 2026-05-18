/**
 * Phase 2 ETL — migrate v1 lifestyle data into the unified v2 schema.
 *
 * Two-tier hybrid (chosen 2026-05-18 after sample run showed news
 * pipeline was wrong filter for lifestyle content):
 *
 *   Tier A: relevance_score >= 70 → bulk-copy via SQL. No LLM.
 *   Tier B: relevance_score 40-69 → re-validate via LIFESTYLE pipeline
 *           (classifyLifestyleArticle from lifestyle-scanner.ts).
 *   Tier C: relevance_score < 40 → skip.
 *
 *   USAGE
 *     # Dry-run, prints what would happen, no writes:
 *     tsx scripts/migrate-v1-to-v2.ts
 *
 *     # Write everything (resumable, idempotent):
 *     tsx scripts/migrate-v1-to-v2.ts --commit
 *
 *     # Just Tier A (skip the LLM re-validation pass):
 *     tsx scripts/migrate-v1-to-v2.ts --commit --tier A
 *
 *     # Sample a few Tier B rows to sanity-check the LLM cost:
 *     tsx scripts/migrate-v1-to-v2.ts --tier B --sample 10
 *
 *   OUTPUT
 *     - migration_progress table: per-row stage + outcome + drop reason
 *     - migration-report.md: at end of run, summary + samples
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { classifyLifestyleArticle } from "../server/lifestyle-scanner";

// ============================================================================
// Config & argv
// ============================================================================

const argv = process.argv.slice(2);
const COMMIT = argv.includes("--commit");
const TIER = (() => {
  const i = argv.indexOf("--tier");
  const v = i >= 0 ? argv[i + 1] : null;
  return v === "A" || v === "B" ? v : "both";
})();
const SAMPLE_N = (() => {
  const i = argv.indexOf("--sample");
  return i >= 0 ? parseInt(argv[i + 1] ?? "10", 10) : null;
})();

const REPORT_PATH = "./migration-report.md";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set. Source .env first.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ============================================================================
// Stats
// ============================================================================

interface RunStats {
  tierA_copied: number;
  tierA_dedup_url: number;
  tierB_passed: number;
  tierB_rejected: number;
  tierB_errored: number;
  llmCalls: number;
  sampleAccepted: Array<{ headline: string; score: number; tier: "A" | "B"; source: string }>;
  sampleRejected: Array<{ headline: string; reason: string }>;
}

const stats: RunStats = {
  tierA_copied: 0,
  tierA_dedup_url: 0,
  tierB_passed: 0,
  tierB_rejected: 0,
  tierB_errored: 0,
  llmCalls: 0,
  sampleAccepted: [],
  sampleRejected: [],
};

function priorityLevelFor(score: number): "high" | "medium" | "low" {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

async function alreadyProcessed(sourceTable: string, sourceId: string): Promise<boolean> {
  const res = await pool.query(
    "SELECT 1 FROM migration_progress WHERE source_table = $1 AND source_id = $2",
    [sourceTable, sourceId]
  );
  return res.rowCount! > 0;
}

async function recordProgress(opts: {
  sourceTable: string;
  sourceId: string;
  stage: string;
  outcome: "passed" | "dropped" | "failed" | "inserted";
  dropReason?: string;
  targetLeadId?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO migration_progress
       (source_table, source_id, stage, outcome, drop_reason, target_lead_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_table, source_id) DO UPDATE
       SET stage = EXCLUDED.stage,
           outcome = EXCLUDED.outcome,
           drop_reason = EXCLUDED.drop_reason,
           target_lead_id = EXCLUDED.target_lead_id,
           processed_at = CURRENT_TIMESTAMP`,
    [opts.sourceTable, opts.sourceId, opts.stage, opts.outcome, opts.dropReason ?? null, opts.targetLeadId ?? null]
  );
}

// ============================================================================
// Source migration (no LLM)
// ============================================================================

async function migrateSources(): Promise<Map<string, string>> {
  const mapping = new Map<string, string>();
  console.log("\n--- Migrating sources ---");

  const newSources = await pool.query(
    "SELECT id, name, slug, region, publication_type, base_url, feed_url, scrape_config, check_interval_min, status FROM lifestyle_sources"
  );
  console.log(`Found ${newSources.rowCount} rows in lifestyle_sources`);

  for (const row of newSources.rows) {
    const domain = (() => { try { return new URL(row.base_url).hostname; } catch { return row.slug; } })();
    const newId = randomUUID();
    if (COMMIT) {
      const res = await pool.query(
        `INSERT INTO sources_v2 (id, category, name, slug, domain, base_url, region, publication_type, feed_url, scrape_config, check_interval_min, status, active)
         VALUES ($1, 'lifestyle', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE)
         ON CONFLICT (slug) DO UPDATE SET base_url = EXCLUDED.base_url
         RETURNING id`,
        [newId, row.name, row.slug, domain, row.base_url, row.region, row.publication_type, row.feed_url, row.scrape_config, row.check_interval_min, row.status]
      );
      mapping.set(`lifestyle_sources:${row.id}`, res.rows[0].id);
    } else {
      mapping.set(`lifestyle_sources:${row.id}`, newId);
    }
  }

  const oldSources = await pool.query(
    "SELECT id, name, slug, base_url, region, feed_url, scrape_config, check_interval_min, is_active FROM publications"
  );
  console.log(`Found ${oldSources.rowCount} rows in publications`);

  for (const row of oldSources.rows) {
    const existingFromNew = newSources.rows.find((r: { slug: string }) => r.slug === row.slug);
    if (existingFromNew) {
      mapping.set(`publications:${row.id}`, mapping.get(`lifestyle_sources:${existingFromNew.id}`)!);
      continue;
    }
    const domain = (() => { try { return new URL(row.base_url).hostname; } catch { return row.slug; } })();
    const newId = randomUUID();
    if (COMMIT) {
      const res = await pool.query(
        `INSERT INTO sources_v2 (id, category, name, slug, domain, base_url, region, feed_url, scrape_config, check_interval_min, active)
         VALUES ($1, 'lifestyle', $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (slug) DO UPDATE SET base_url = EXCLUDED.base_url
         RETURNING id`,
        [newId, row.name, row.slug, domain, row.base_url, row.region, row.feed_url, row.scrape_config, row.check_interval_min, row.is_active]
      );
      mapping.set(`publications:${row.id}`, res.rows[0].id);
    } else {
      mapping.set(`publications:${row.id}`, newId);
    }
  }

  console.log(`Source mapping built: ${mapping.size} entries.`);
  return mapping;
}

// ============================================================================
// Tier A — bulk copy >=70 (no LLM)
// ============================================================================

async function bulkCopyTierA(sourceMap: Map<string, string>): Promise<void> {
  console.log("\n--- Tier A: bulk-copy rows with relevance_score >= 70 ---");

  // Track URLs we've copied so the second source table doesn't insert duplicates.
  const copiedUrls = new Set<string>();

  // ----- From lifestyle_articles (status='extracted') -----
  const lifestyleArticlesRes = await pool.query(`
    SELECT a.id, a.source_id, a.url, a.title, a.full_text, a.snippet,
           a.published_at, a.headline AS ai_headline, a.summary, a.banker_angle,
           a.event_type, a.relevance_score, a.image_url, a.filter_reason,
           s.region, s.name as source_name
    FROM lifestyle_articles a
    LEFT JOIN lifestyle_sources s ON a.source_id = s.id
    WHERE a.status = 'extracted' AND a.relevance_score >= 70
    ORDER BY a.relevance_score DESC, a.created_at ASC
  `);
  console.log(`  lifestyle_articles candidates: ${lifestyleArticlesRes.rowCount}`);

  for (const r of lifestyleArticlesRes.rows) {
    if (await alreadyProcessed("lifestyle_articles", r.id)) continue;
    if (copiedUrls.has(r.url)) {
      stats.tierA_dedup_url++;
      continue;
    }
    copiedUrls.add(r.url);

    const sourceUuid = r.source_id ? sourceMap.get(`lifestyle_sources:${r.source_id}`) ?? null : null;
    const leadId = randomUUID();
    const score = r.relevance_score ?? 70;

    if (COMMIT) {
      await pool.query(
        `INSERT INTO leads_v2 (
           id, category, source_id,
           headline, source_url, source_name, source_tier,
           published_at, region,
           company_names, founder_names, investors, matched_keywords,
           ai_summary, banker_angle, event_type, relevance_score,
           priority_score, priority_level, status, fetch_method,
           analyzed_by_model
         ) VALUES (
           $1, 'lifestyle', $2,
           $3, $4, $5, 'tier2',
           $6, $7,
           '{}', '{}', '{}', '{}',
           $8, $9, $10, $11,
           $12, $13, 'new', 'rss',
           'google/gemini-2.5-flash-lite (v1 lifestyle scanner)'
         )`,
        [
          leadId, sourceUuid,
          r.title, r.url, r.source_name ?? "unknown",
          r.published_at ?? new Date(), r.region ?? "Unknown",
          r.summary ?? "", r.banker_angle, r.event_type, score,
          score, priorityLevelFor(score),
        ]
      );
    }
    stats.tierA_copied++;
    if (stats.sampleAccepted.length < 30) {
      stats.sampleAccepted.push({ headline: r.title ?? "(no title)", score, tier: "A", source: r.source_name ?? "unknown" });
    }
    await recordProgress({ sourceTable: "lifestyle_articles", sourceId: r.id, stage: "tier_a_bulk", outcome: COMMIT ? "inserted" : "passed", targetLeadId: leadId });
  }

  // ----- From lifestyle_leads (OLD table) -----
  const lifestyleLeadsRes = await pool.query(`
    SELECT l.id, l.publication_id, l.url, l.title, l.full_text, l.snippet,
           l.published_at, l.headline AS ai_headline, l.summary, l.banker_angle,
           l.event_type, l.relevance_score, l.wealth_signals, l.image_url,
           COALESCE(l.saved, FALSE) AS saved,
           COALESCE(l.dismissed, FALSE) AS dismissed,
           l.feedback,
           p.region, p.name as source_name
    FROM lifestyle_leads l
    LEFT JOIN publications p ON l.publication_id = p.id
    WHERE l.relevance_score >= 70
    ORDER BY l.relevance_score DESC, l.id ASC
  `);
  console.log(`  lifestyle_leads candidates: ${lifestyleLeadsRes.rowCount}`);

  for (const r of lifestyleLeadsRes.rows) {
    if (await alreadyProcessed("lifestyle_leads", r.id)) continue;
    if (copiedUrls.has(r.url)) {
      stats.tierA_dedup_url++;
      await recordProgress({ sourceTable: "lifestyle_leads", sourceId: String(r.id), stage: "tier_a_dedup", outcome: "dropped", dropReason: "URL already migrated via lifestyle_articles" });
      continue;
    }
    copiedUrls.add(r.url);

    const sourceUuid = r.publication_id ? sourceMap.get(`publications:${r.publication_id}`) ?? null : null;
    const leadId = randomUUID();
    const score = Math.round(r.relevance_score ?? 70);
    const status = r.saved ? "saved" : r.dismissed ? "dismissed" : "new";
    const matchedKeywords: string[] = r.wealth_signals ?? [];

    if (COMMIT) {
      await pool.query(
        `INSERT INTO leads_v2 (
           id, category, source_id,
           headline, source_url, source_name, source_tier,
           published_at, region,
           company_names, founder_names, investors, matched_keywords,
           ai_summary, banker_angle, event_type, relevance_score,
           priority_score, priority_level, status, fetch_method,
           analyzed_by_model
         ) VALUES (
           $1, 'lifestyle', $2,
           $3, $4, $5, 'tier2',
           $6, $7,
           '{}', '{}', '{}', $8,
           $9, $10, $11, $12,
           $13, $14, $15, 'rss',
           'google/gemini-2.5-flash-lite (v1 lifestyle scanner)'
         )`,
        [
          leadId, sourceUuid,
          r.title, r.url, r.source_name ?? "unknown",
          r.published_at ?? new Date(), r.region ?? "Unknown",
          matchedKeywords,
          r.summary ?? "", r.banker_angle, r.event_type, score,
          score, priorityLevelFor(score), status,
        ]
      );

      if (r.saved) {
        await pool.query(`INSERT INTO saved_leads_v2 (lead_id) VALUES ($1)`, [leadId]);
      }
      if (r.feedback === "thumbs_up" || r.feedback === "thumbs_down") {
        await pool.query(`INSERT INTO lead_feedback_v2 (lead_id, verdict) VALUES ($1, $2)`, [leadId, r.feedback]);
      }
    }
    stats.tierA_copied++;
    if (stats.sampleAccepted.length < 30) {
      stats.sampleAccepted.push({ headline: r.title ?? "(no title)", score, tier: "A", source: r.source_name ?? "unknown" });
    }
    await recordProgress({ sourceTable: "lifestyle_leads", sourceId: String(r.id), stage: "tier_a_bulk", outcome: COMMIT ? "inserted" : "passed", targetLeadId: leadId });
  }

  console.log(`  Tier A copied: ${stats.tierA_copied} (URL-dedup: ${stats.tierA_dedup_url})`);
}

// ============================================================================
// Tier B — re-validate 40-69 through lifestyle filter
// ============================================================================

async function revalidateTierB(sourceMap: Map<string, string>): Promise<void> {
  console.log("\n--- Tier B: re-validate rows with relevance_score 40-69 ---");

  const limit = SAMPLE_N ? `LIMIT ${SAMPLE_N}` : "";

  // Most Tier B candidates are in lifestyle_leads (lifestyle_articles has 0).
  const res = await pool.query(`
    SELECT l.id, l.publication_id, l.url, l.title, l.full_text, l.snippet,
           l.published_at, l.headline AS ai_headline, l.summary, l.banker_angle,
           l.event_type, l.relevance_score, l.wealth_signals, l.image_url,
           COALESCE(l.saved, FALSE) AS saved,
           COALESCE(l.dismissed, FALSE) AS dismissed,
           l.feedback,
           p.region, p.name as source_name
    FROM lifestyle_leads l
    LEFT JOIN publications p ON l.publication_id = p.id
    WHERE l.relevance_score >= 40 AND l.relevance_score < 70
    ORDER BY l.relevance_score DESC, l.id ASC
    ${limit}
  `);
  console.log(`  lifestyle_leads Tier B candidates: ${res.rowCount}`);

  for (const r of res.rows) {
    if (await alreadyProcessed("lifestyle_leads", String(r.id))) continue;

    const articleInput = {
      title: r.title ?? "",
      snippet: r.snippet ?? r.full_text?.slice(0, 1000) ?? "",
    };

    try {
      stats.llmCalls++;
      const decision = await classifyLifestyleArticle(articleInput as any);
      if (!decision.relevant) {
        stats.tierB_rejected++;
        if (stats.sampleRejected.length < 30) {
          stats.sampleRejected.push({ headline: r.title ?? "(no title)", reason: decision.reason ?? "rejected by lifestyle filter" });
        }
        await recordProgress({
          sourceTable: "lifestyle_leads",
          sourceId: String(r.id),
          stage: "tier_b_classify",
          outcome: "dropped",
          dropReason: decision.reason ?? "rejected",
        });
        continue;
      }

      // Passed re-validation — insert with original score
      const sourceUuid = r.publication_id ? sourceMap.get(`publications:${r.publication_id}`) ?? null : null;
      const leadId = randomUUID();
      const score = Math.round(r.relevance_score ?? 40);
      const status = r.saved ? "saved" : r.dismissed ? "dismissed" : "new";
      const matchedKeywords: string[] = r.wealth_signals ?? [];

      if (COMMIT) {
        await pool.query(
          `INSERT INTO leads_v2 (
             id, category, source_id,
             headline, source_url, source_name, source_tier,
             published_at, region,
             company_names, founder_names, investors, matched_keywords,
             ai_summary, banker_angle, event_type, relevance_score,
             priority_score, priority_level, status, fetch_method,
             analyzed_by_model, pipeline_reasoning
           ) VALUES (
             $1, 'lifestyle', $2,
             $3, $4, $5, 'tier2',
             $6, $7,
             '{}', '{}', '{}', $8,
             $9, $10, $11, $12,
             $13, $14, $15, 'rss',
             'google/gemini-2.5-flash-lite (Tier B re-validated)', $16
           )`,
          [
            leadId, sourceUuid,
            r.title, r.url, r.source_name ?? "unknown",
            r.published_at ?? new Date(), r.region ?? "Unknown",
            matchedKeywords,
            r.summary ?? "", r.banker_angle, decision.eventType ?? r.event_type, score,
            score, priorityLevelFor(score), status,
            decision.reason,
          ]
        );

        if (r.saved) {
          await pool.query(`INSERT INTO saved_leads_v2 (lead_id) VALUES ($1)`, [leadId]);
        }
        if (r.feedback === "thumbs_up" || r.feedback === "thumbs_down") {
          await pool.query(`INSERT INTO lead_feedback_v2 (lead_id, verdict) VALUES ($1, $2)`, [leadId, r.feedback]);
        }
      }

      stats.tierB_passed++;
      if (stats.sampleAccepted.length < 30) {
        stats.sampleAccepted.push({ headline: r.title ?? "(no title)", score, tier: "B", source: r.source_name ?? "unknown" });
      }
      await recordProgress({
        sourceTable: "lifestyle_leads",
        sourceId: String(r.id),
        stage: "tier_b_classify",
        outcome: COMMIT ? "inserted" : "passed",
        targetLeadId: leadId,
      });
    } catch (err: any) {
      stats.tierB_errored++;
      const msg = err?.message ?? String(err);
      console.error(`  ! row ${r.id} failed: ${msg.slice(0, 100)}`);
      await recordProgress({
        sourceTable: "lifestyle_leads",
        sourceId: String(r.id),
        stage: "tier_b_classify",
        outcome: "failed",
        dropReason: msg,
      });
    }
  }

  console.log(`  Tier B: ${stats.tierB_passed} passed, ${stats.tierB_rejected} rejected, ${stats.tierB_errored} errored`);
}

// ============================================================================
// Report
// ============================================================================

function writeReport(durationMs: number) {
  const mins = Math.round(durationMs / 60_000);
  const estCostUsd = (stats.llmCalls * 0.0004).toFixed(4);

  const accepted = stats.sampleAccepted
    .map((s) => `- [Tier ${s.tier} · ${s.score}] ${s.headline.slice(0, 100)} _(${s.source})_`)
    .join("\n");
  const rejected = stats.sampleRejected
    .map((s) => `- ${s.headline.slice(0, 100)} — _${s.reason.slice(0, 200)}_`)
    .join("\n");

  const md = `# v1 → v2 Migration Report — hybrid

_Generated ${new Date().toISOString()}_

**Mode:** ${COMMIT ? "COMMIT (wrote to leads_v2)" : "DRY-RUN (no writes)"}
**Tier scope:** ${TIER}
${SAMPLE_N ? `**Tier B sample size:** ${SAMPLE_N}` : ""}

## Totals

| Bucket | Count |
|---|---:|
| Tier A copied (score ≥ 70) | ${stats.tierA_copied} |
| Tier A URL-dedup skipped | ${stats.tierA_dedup_url} |
| Tier B passed (re-validated 40-69) | ${stats.tierB_passed} |
| Tier B rejected by lifestyle filter | ${stats.tierB_rejected} |
| Tier B errored | ${stats.tierB_errored} |
| **Total leads_v2 inserts** | **${stats.tierA_copied + stats.tierB_passed}** |

## LLM cost (Tier B only)

| | |
|---|---:|
| Classify calls | ${stats.llmCalls} |
| Est. cost | ~$${estCostUsd} |

Run duration: ${mins} min (${(durationMs / 1000).toFixed(1)}s).

## Sample — accepted leads (up to 30)

${accepted || "_(none)_"}

## Sample — Tier B rejected (up to 30, with reasons)

${rejected || "_(none)_"}
`;
  writeFileSync(REPORT_PATH, md);
  console.log(`\nReport written: ${REPORT_PATH}`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=== News-sensei v1 → v2 migration (hybrid) ===");
  console.log(`Mode: ${COMMIT ? "COMMIT" : "DRY-RUN"} | Tier: ${TIER}${SAMPLE_N ? ` | Sample: ${SAMPLE_N}` : ""}`);

  const startTime = Date.now();
  const sourceMap = await migrateSources();

  if (TIER === "A" || TIER === "both") await bulkCopyTierA(sourceMap);
  if (TIER === "B" || TIER === "both") await revalidateTierB(sourceMap);

  const durationMs = Date.now() - startTime;
  console.log("\n=== Done ===");
  console.log(`Tier A: ${stats.tierA_copied} copied | Tier B: ${stats.tierB_passed} passed, ${stats.tierB_rejected} rejected`);
  writeReport(durationMs);

  await pool.end();
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  await pool.end();
  process.exit(1);
});
