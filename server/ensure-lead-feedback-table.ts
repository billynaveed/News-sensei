import { db } from "./db";
import { sql } from "drizzle-orm";

/** Ensures the lead_feedback table exists (additive; avoids a full db:push). */
export async function ensureLeadFeedbackTable() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ui_lead_feedback (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id VARCHAR,
      rating TEXT NOT NULL,
      reason TEXT,
      note TEXT,
      headline TEXT,
      category TEXT,
      region TEXT,
      company_names TEXT[],
      founder_names TEXT[],
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ui_lead_feedback_rating_created ON ui_lead_feedback (rating, created_at DESC);`);
}
