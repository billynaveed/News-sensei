import { pool } from "./db";

/**
 * Ensures the research_cache table exists in the database.
 */
export async function ensureResearchCacheTable(): Promise<boolean> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'research_cache'
      );
    `);

    if (result.rows[0].exists) {
      return false;
    }

    await client.query(`
      CREATE TABLE research_cache (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        query TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        result JSONB NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_research_cache_query ON research_cache (lower(query));
      CREATE INDEX idx_research_cache_created_at ON research_cache (created_at);
    `);

    console.log("[Research] Created research_cache table");
    return true;
  } finally {
    client.release();
  }
}
