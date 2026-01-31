#!/usr/bin/env tsx
/**
 * Test lead enrichment functionality
 */

import "dotenv/config";
import { enrichLead } from "../server/lead-enrichment";
import { storage } from "../server/storage";

async function testEnrichment() {
  console.log("=== Testing Lead Enrichment ===\n");

  try {
    // Test with a sample lead
    const testLead = {
      companyNames: ["OpenAI"],
      founderNames: ["Sam Altman", "Greg Brockman"],
      region: "United States",
      companyDescription: "AI research and deployment company focused on developing artificial general intelligence"
    };

    console.log("1. Testing enrichment with sample data:");
    console.log(`   Company: ${testLead.companyNames[0]}`);
    console.log(`   Founders: ${testLead.founderNames.join(", ")}`);
    console.log(`   Region: ${testLead.region}\n`);

    console.log("2. Running enrichment...\n");
    const result = await enrichLead(testLead);

    console.log("3. Results:");
    console.log(`   LinkedIn profiles found: ${result.linkedinProfiles.length}`);
    result.linkedinProfiles.forEach(url => {
      console.log(`     - ${url}`);
    });

    console.log(`\n   Investors found: ${result.investors.length}`);
    result.investors.forEach(inv => {
      console.log(`     - ${inv}`);
    });

    // Test database update if there are actual leads
    const leads = await storage.getAllLeads();
    if (leads.length > 0) {
      console.log(`\n4. Testing database update with lead ID: ${leads[0].id}`);
      await storage.enrichLead(leads[0].id, result.linkedinProfiles, result.investors);
      console.log("   ✓ Database updated successfully");

      const enrichedLead = await storage.getLeadById(leads[0].id);
      if (enrichedLead) {
        console.log(`   ✓ Verified: ${enrichedLead.linkedinProfiles?.length || 0} LinkedIn profiles stored`);
        console.log(`   ✓ Verified: ${enrichedLead.investors?.length || 0} investors stored`);
      }
    } else {
      console.log(`\n4. No existing leads to test database update`);
    }

    console.log("\n✅ Enrichment test complete!");

  } catch (error) {
    console.error("\n✗ Test failed:", error);
    process.exit(1);
  }
}

testEnrichment();
