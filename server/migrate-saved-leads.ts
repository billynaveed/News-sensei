import { storage } from "./storage";
import { log } from "./index";

/**
 * Migration script to move existing saved leads (status="saved")
 * to the new saved_leads table
 */
async function migrateSavedLeads() {
  try {
    log("Starting saved leads migration...", "migration");

    // Get all leads with status="saved"
    const allLeads = await storage.getAllLeads();
    const savedLeads = allLeads.filter(lead => lead.status === "saved");

    log(`Found ${savedLeads.length} leads with status="saved"`, "migration");

    if (savedLeads.length === 0) {
      log("No saved leads to migrate", "migration");
      return { migrated: 0, skipped: 0, errors: 0 };
    }

    let migrated = 0;
    let skipped = 0;
    let errors = 0;

    for (const lead of savedLeads) {
      try {
        // Check if this lead is already in saved_leads table
        const existing = await storage.getSavedLeadByLeadId(lead.id);

        if (existing) {
          log(`Skipping lead ${lead.id} - already in saved_leads table`, "migration");
          skipped++;
          continue;
        }

        // Create entry in saved_leads table
        // Note: createSavedLead will also update the lead status to "saved"
        // but since it's already "saved", this is idempotent
        await storage.createSavedLead({
          leadId: lead.id,
        });

        migrated++;
        log(`Migrated lead ${lead.id} to saved_leads table`, "migration");
      } catch (error) {
        errors++;
        log(`Error migrating lead ${lead.id}: ${error}`, "migration");
      }
    }

    const summary = {
      total: savedLeads.length,
      migrated,
      skipped,
      errors,
    };

    log(`Migration complete: ${JSON.stringify(summary)}`, "migration");
    return summary;
  } catch (error) {
    log(`Migration failed: ${error}`, "migration");
    throw error;
  }
}

// Run migration if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  migrateSavedLeads()
    .then((result) => {
      console.log("Migration completed successfully:", result);
      process.exit(0);
    })
    .catch((error) => {
      console.error("Migration failed:", error);
      process.exit(1);
    });
}

export { migrateSavedLeads };
