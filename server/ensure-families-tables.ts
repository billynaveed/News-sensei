import { db } from "./db";
import { sql } from "drizzle-orm";

/**
 * Ensures the family-tree + blocked-persons tables exist (additive; avoids a
 * full db:push, matching the contact_meta pattern — the app role owns these).
 */
export async function ensureFamiliesTables() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS families (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      country TEXT,
      primary_companies TEXT[],
      description TEXT,
      patriarch_person_id INTEGER,
      net_worth_estimate TEXT,
      research_status TEXT NOT NULL DEFAULT 'manual',
      research_attempts INTEGER NOT NULL DEFAULT 0,
      researched_at TIMESTAMP,
      confidence TEXT,
      source_urls TEXT[],
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_families_status ON families (research_status);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_families_country ON families (country);`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS family_members (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      family_id VARCHAR NOT NULL,
      person_id INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS family_members_family_person_uq ON family_members (family_id, person_id);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_family_members_person ON family_members (person_id);`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS family_relationships (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      family_id VARCHAR NOT NULL,
      from_person_id INTEGER NOT NULL,
      to_person_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      confidence TEXT,
      source_url TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS family_rel_uq ON family_relationships (from_person_id, to_person_id, type);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_family_rel_family ON family_relationships (family_id);`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS person_blocks (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id INTEGER NOT NULL UNIQUE,
      reason TEXT,
      covered_by TEXT,
      origin TEXT NOT NULL DEFAULT 'direct',
      origin_person_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_person_blocks_origin ON person_blocks (origin_person_id);`);
}
