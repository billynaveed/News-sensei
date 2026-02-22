import { pool } from "./db";

/**
 * Ensures the ipo_filings table exists in the database.
 */
export async function ensureIpoFilingsTable(): Promise<boolean> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'ipo_filings'
      );
    `);

    if (result.rows[0].exists) {
      return false; // already exists
    }

    await client.query(`
      CREATE TABLE ipo_filings (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        exchange TEXT NOT NULL,
        stock_code TEXT NOT NULL,
        company_name TEXT NOT NULL,
        industry TEXT,
        proposed_valuation TEXT,
        revenue TEXT,
        profit TEXT,
        founders TEXT,
        underwriters TEXT,
        sponsors TEXT,
        prospectus_url TEXT,
        listing_date TEXT,
        filing_date TEXT,
        lockup_expiration TEXT,
        raw_data JSONB,
        alert_sent BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("[IPO] Created ipo_filings table");
    return true;
  } finally {
    client.release();
  }
}
