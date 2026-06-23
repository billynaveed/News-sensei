import { db } from "./db";
import { sql } from "drizzle-orm";

/** Ensures the contact_meta table exists (additive; avoids a full db:push). */
export async function ensureContactMetaTable() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS contact_meta (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id INTEGER NOT NULL UNIQUE,
      email TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      remind_at TIMESTAMP,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_contact_meta_status ON contact_meta (status);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_contact_meta_remind_at ON contact_meta (remind_at);`);
}
