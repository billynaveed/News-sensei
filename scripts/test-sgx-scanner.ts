#!/usr/bin/env tsx
/**
 * Test script for SGX IPO scanner
 * Usage: tsx scripts/test-sgx-scanner.ts
 */

import "dotenv/config";
import { scrapeAllSgxListings } from "../server/ipo-scanner/sgx-scraper";
import { scanSgxIpos, scanAllIpos } from "../server/ipo-scanner";
import { storage } from "../server/storage";

async function testSgxScraper() {
  console.log("=== Testing SGX IPO Scanner ===\n");

  try {
    console.log("1. Testing SGX web scraping...");
    const listings = await scrapeAllSgxListings();

    console.log(`\n✓ Found ${listings.length} listings\n`);

    if (listings.length > 0) {
      console.log("Sample listings:");
      listings.slice(0, 3).forEach((listing, index) => {
        console.log(`\n  ${index + 1}. ${listing.companyName}`);
        console.log(`     Stock Code: ${listing.stockCode}`);
        console.log(`     Prospectus URL: ${listing.prospectusUrl || 'N/A'}`);
        if (listing.listingDate) {
          console.log(`     Listing Date: ${listing.listingDate.toLocaleDateString()}`);
        }
      });
    } else {
      console.log("⚠️  No listings found from SGX scraper.");
      console.log("Note: SGX may have changed their website structure or requires different scraping approach.");
      console.log("Consider these alternatives:");
      console.log("  1. Check SGX's official IPO page: https://www.sgx.com/securities/ipos");
      console.log("  2. Use SGX API if available");
      console.log("  3. Scrape SGX company announcements");
    }

    // Test full scan (without PDF parsing for speed)
    console.log("\n2. Testing full SGX IPO scan (quick mode - no PDF parsing)...");
    const result = await scanSgxIpos({ parsePdfs: false });

    console.log("\n✓ Scan complete:");
    console.log(`  Listings scanned: ${result.scanned}`);
    console.log(`  New filings: ${result.newFilings}`);
    console.log(`  Duplicates skipped: ${result.duplicatesSkipped}`);
    console.log(`  Errors: ${result.errors.length}`);

    if (result.errors.length > 0) {
      console.log("\n  Errors encountered:");
      result.errors.forEach(err => console.log(`    - ${err}`));
    }

    // Show stored IPO filings from SGX
    console.log("\n3. Checking stored SGX IPO filings...");
    const allFilings = await storage.getAllIpoFilings();
    const sgxFilings = allFilings.filter(f => f.exchange === "SGX");
    console.log(`\n✓ Total SGX IPO filings in database: ${sgxFilings.length}`);

    if (sgxFilings.length > 0) {
      console.log("\nMost recent SGX filings:");
      sgxFilings.slice(0, 3).forEach(filing => {
        console.log(`  - ${filing.companyName} (${filing.exchange}:${filing.stockCode})`);
        console.log(`    Status: ${filing.status} | Filed: ${filing.filingDate.toLocaleDateString()}`);
      });
    }

    // Test combined scan
    console.log("\n4. Testing combined HKEX + SGX scan...");
    const combinedResult = await scanAllIpos({ parsePdfs: false });

    console.log("\n✓ Combined scan complete:");
    console.log(`  HKEX: ${combinedResult.hkex.newFilings} new, ${combinedResult.hkex.scanned} scanned`);
    console.log(`  SGX:  ${combinedResult.sgx.newFilings} new, ${combinedResult.sgx.scanned} scanned`);

    console.log("\n=== Test Complete ===");
  } catch (error) {
    console.error("\n✗ Test failed:", error);
    process.exit(1);
  }
}

testSgxScraper();
