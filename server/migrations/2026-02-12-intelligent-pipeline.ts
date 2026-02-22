/**
 * Migration: Intelligent Lead Pipeline Schema Changes
 * Date: 2026-02-12
 *
 * This migration adds new columns required by the intelligent 7-stage
 * lead pipeline and removes the deprecated `keywords` column from the
 * `settings` table, replacing it with the `interest_filter_prompt` field.
 *
 * Forward (migrateUp):
 * - settings: Add `interest_filter_prompt` TEXT, drop `keywords`
 * - leads: Add `is_update`, `related_saved_lead_id`, `key_financials`,
 *   `wealth_angle`, `founder_linkedin_url`, `founder_bio`,
 *   `company_description`, `enrichment_data` columns
 * - saved_leads: Add `article_summary` TEXT column
 * - sources: Add `use_premium_scraping` BOOLEAN column
 *
 * Rollback (migrateDown):
 * - settings: Re-add `keywords`, drop `interest_filter_prompt`
 * - leads: Drop all new pipeline columns
 * - saved_leads: Drop `article_summary`
 * - sources: Drop `use_premium_scraping`
 */

import { pool } from "../db";
import { DEFAULT_INTEREST_FILTER_PROMPT } from "@shared/schema";

/** Default keywords used before the semantic filter was introduced */
const LEGACY_DEFAULT_KEYWORDS = [
  "Liquidity event", "IPO", "Initial Public Offering", "Trade sale",
  "Private equity exit", "PE acquisition", "Merger & acquisition", "M&A deal",
  "Founder exit", "Startup funding Series C", "Startup funding Series D",
  "Unicorn", "SPAC merger", "Secondary sale", "Family office",
  "High net worth", "Asset sale", "Divestiture", "Stake sale",
  "Cashed out", "Sold stake", "Exit deal", "Buyout",
];

/**
 * Converts an existing keywords array into a customized interest filter prompt.
 * Preserves the user's keyword intent while upgrading to the semantic format.
 */
function buildInterestFilterPromptFromKeywords(keywords: string[]): string {
  if (!keywords || keywords.length === 0) {
    return DEFAULT_INTEREST_FILTER_PROMPT;
  }

  const keywordList = keywords.map(kw => `- ${kw}`).join("\n");

  return `Analyze if this article indicates a wealth liquidity event relevant to private banking clients in Southeast Asia.

INCLUDE articles about:
- Private companies raising Series A, B, C+ funding rounds
- Mergers & acquisitions where founders are exiting
- Companies preparing for IPO or listing (still private)
- Significant exits or strategic sales
- Founder liquidity events (secondary sales, founder shares)
- Private company valuations reaching unicorn status ($1B+)

Additional indicators to watch for (from previous keyword configuration):
${keywordList}

EXCLUDE articles about:
- Companies already publicly listed (trading on exchanges)
- Listed company earnings reports or stock movements
- Government policy or regulatory changes only
- General industry trends without specific companies
- Partnerships or commercial deals (unless involving equity/acquisition)

Target Regions: Singapore, Malaysia, Indonesia, Thailand, Vietnam, Philippines, Hong Kong

Return JSON with:
- relevant: true/false
- reason: brief explanation of decision
- confidenceScore: 0-100 (how confident you are)`;
}

/**
 * Runs the forward migration, adding all new columns and converting
 * existing keywords to the interest filter prompt before dropping the
 * keywords column.
 */
export async function migrateUp(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // -- Settings table: Add interest_filter_prompt before dropping keywords --
    await client.query(`
      ALTER TABLE settings
      ADD COLUMN IF NOT EXISTS interest_filter_prompt TEXT
    `);

    // Convert existing keywords to interest filter prompt (if keywords column still exists)
    const hasKeywordsColumn = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'settings' AND column_name = 'keywords'
    `);

    if (hasKeywordsColumn.rows.length > 0) {
      const settingsResult = await client.query(
        "SELECT id, keywords FROM settings LIMIT 1"
      );

      if (settingsResult.rows.length > 0) {
        const row = settingsResult.rows[0];
        const keywords: string[] = row.keywords || [];

        // Only convert if interest_filter_prompt is not already set
        if (!row.interest_filter_prompt) {
          const prompt = buildInterestFilterPromptFromKeywords(keywords);
          await client.query(
            "UPDATE settings SET interest_filter_prompt = $1 WHERE id = $2",
            [prompt, row.id]
          );

          console.log(
            `[Migration] Converted ${keywords.length} keywords to interest filter prompt for settings ${row.id}`
          );
        }
      }

      // Drop the keywords column now that data has been migrated
      await client.query(`
        ALTER TABLE settings DROP COLUMN IF EXISTS keywords
      `);

      console.log("[Migration] Dropped keywords column from settings table");
    }

    // Set NOT NULL default for future rows
    await client.query(`
      ALTER TABLE settings
      ALTER COLUMN interest_filter_prompt SET DEFAULT $1
    `, [DEFAULT_INTEREST_FILTER_PROMPT]);

    await client.query(`
      UPDATE settings SET interest_filter_prompt = $1
      WHERE interest_filter_prompt IS NULL
    `, [DEFAULT_INTEREST_FILTER_PROMPT]);

    await client.query(`
      ALTER TABLE settings
      ALTER COLUMN interest_filter_prompt SET NOT NULL
    `);

    // -- Leads table: Add intelligent pipeline columns --
    await client.query(`
      ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS is_update BOOLEAN DEFAULT false
    `);

    await client.query(`
      ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS related_saved_lead_id TEXT
    `);

    await client.query(`
      ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS key_financials JSONB
    `);

    await client.query(`
      ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS wealth_angle TEXT
    `);

    await client.query(`
      ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS founder_linkedin_url TEXT
    `);

    await client.query(`
      ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS founder_bio TEXT
    `);

    await client.query(`
      ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS company_description TEXT
    `);

    await client.query(`
      ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS enrichment_data JSONB
    `);

    // -- Saved leads table: Add article_summary --
    await client.query(`
      ALTER TABLE saved_leads
      ADD COLUMN IF NOT EXISTS article_summary TEXT
    `);

    // Backfill article_summary from existing leads' AI summaries
    const backfillResult = await client.query(`
      UPDATE saved_leads
      SET article_summary = leads.ai_summary
      FROM leads
      WHERE saved_leads.lead_id = leads.id
        AND saved_leads.article_summary IS NULL
        AND leads.ai_summary IS NOT NULL
    `);

    console.log(
      `[Migration] Backfilled article_summary for ${backfillResult.rowCount} saved leads`
    );

    // -- Sources table: Add use_premium_scraping --
    await client.query(`
      ALTER TABLE sources
      ADD COLUMN IF NOT EXISTS use_premium_scraping BOOLEAN NOT NULL DEFAULT false
    `);

    await client.query("COMMIT");
    console.log("[Migration] Intelligent pipeline schema migration completed successfully");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[Migration] Schema migration failed, rolled back:", error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs the rollback migration, restoring the schema to its pre-pipeline state.
 * Re-adds the `keywords` column with legacy defaults and removes all new columns.
 */
export async function migrateDown(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // -- Settings table: Restore keywords column --
    const hasKeywordsColumn = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'settings' AND column_name = 'keywords'
    `);

    if (hasKeywordsColumn.rows.length === 0) {
      await client.query(`
        ALTER TABLE settings
        ADD COLUMN keywords TEXT[] NOT NULL DEFAULT '{}'
      `);

      // Populate with legacy defaults
      const keywordsArray = `{${LEGACY_DEFAULT_KEYWORDS.map(kw => `"${kw}"`).join(",")}}`;
      await client.query(`
        UPDATE settings SET keywords = $1::TEXT[]
      `, [keywordsArray]);

      console.log("[Migration Rollback] Restored keywords column with legacy defaults");
    }

    // Drop interest_filter_prompt
    await client.query(`
      ALTER TABLE settings DROP COLUMN IF EXISTS interest_filter_prompt
    `);

    // -- Leads table: Drop intelligent pipeline columns --
    const leadColumnsToRemove = [
      "is_update",
      "related_saved_lead_id",
      "key_financials",
      "wealth_angle",
      "founder_linkedin_url",
      "founder_bio",
      "company_description",
      "enrichment_data",
    ];

    for (const col of leadColumnsToRemove) {
      await client.query(`
        ALTER TABLE leads DROP COLUMN IF EXISTS ${col}
      `);
    }

    // -- Saved leads table: Drop article_summary --
    await client.query(`
      ALTER TABLE saved_leads DROP COLUMN IF EXISTS article_summary
    `);

    // -- Sources table: Drop use_premium_scraping --
    await client.query(`
      ALTER TABLE sources DROP COLUMN IF EXISTS use_premium_scraping
    `);

    await client.query("COMMIT");
    console.log("[Migration Rollback] Schema rollback completed successfully");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[Migration Rollback] Schema rollback failed:", error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs the migration when this file is executed directly.
 * Usage:
 *   npx tsx server/migrations/2026-02-12-intelligent-pipeline.ts          # forward
 *   npx tsx server/migrations/2026-02-12-intelligent-pipeline.ts rollback # rollback
 */
async function main(): Promise<void> {
  const isRollback = process.argv.includes("rollback");

  if (isRollback) {
    console.log("[Migration] Starting intelligent pipeline schema ROLLBACK...");
    try {
      await migrateDown();
      console.log("[Migration] Rollback completed successfully.");
    } catch (error) {
      console.error("[Migration] Rollback failed:", error);
      process.exit(1);
    }
  } else {
    console.log("[Migration] Starting intelligent pipeline schema migration...");
    try {
      await migrateUp();
      console.log("[Migration] Migration completed successfully.");
    } catch (error) {
      console.error("[Migration] Migration failed:", error);
      process.exit(1);
    }
  }

  await pool.end();
}

// Run if executed directly (not imported)
const isDirectExecution = process.argv[1]?.includes("2026-02-12-intelligent-pipeline");
if (isDirectExecution) {
  main();
}
