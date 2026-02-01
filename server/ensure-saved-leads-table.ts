import { db } from "./db";
import { sql } from "drizzle-orm";

/**
 * Ensures the saved_leads table exists in the database
 * Creates it if it doesn't exist
 */
export async function ensureSavedLeadsTable() {
  try {
    // Check if the table exists
    const result = await db.execute(sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'saved_leads'
      );
    `);

    const tableExists = result.rows[0]?.exists;

    if (!tableExists) {
      console.log("Creating saved_leads table...");

      // Create the table
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS saved_leads (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          lead_id VARCHAR NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
          saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
          founder_linkedin_url TEXT,
          founder_bio TEXT,
          company_description TEXT,
          notes TEXT,
          research_data JSON
        );
      `);

      console.log("saved_leads table created successfully");
      return true;
    }

    return false;
  } catch (error) {
    console.error("Error ensuring saved_leads table:", error);
    throw error;
  }
}
