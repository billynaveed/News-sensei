#!/usr/bin/env tsx
/**
 * Test script for HKEX IPO scanner
 * Usage: tsx scripts/test-ipo-scanner.ts
 */

import "dotenv/config";
import { scrapeAllHkexListings } from "../server/ipo-scanner/hkex-scraper";
import { parseProspectusPdf } from "../server/ipo-scanner/pdf-parser";
import { scanHkexIpos } from "../server/ipo-scanner";
import { storage } from "../server/storage";

async function testScraper() {
  console.log("=== Testing HKEX Scraper ===\n");

  try {
    console.log("1. Testing web scraping...");
    const listings = await scrapeAllHkexListings();

    console.log(`\n✓ Found ${listings.length} listings\n`);

    if (listings.length > 0) {
      console.log("Sample listing:");
      console.log(`  Company: ${listings[0].companyName}`);
      console.log(`  Stock Code: ${listings[0].stockCode}`);
      console.log(`  Prospectus URL: ${listings[0].prospectusUrl}\n`);

      // Test PDF parsing with first listing (if available)
      console.log("2. Testing PDF parsing (this may take a minute)...");
      try {
        const prospectusInfo = await parseProspectusPdf(listings[0].prospectusUrl, true);
        console.log("\n✓ PDF parsed successfully:");
        console.log(`  Company: ${prospectusInfo.companyName}`);
        console.log(`  Description: ${prospectusInfo.businessDescription}`);
        console.log(`  Founders: ${prospectusInfo.founders.join(', ') || 'None found'}`);
        console.log(`  Key Management: ${prospectusInfo.keyManagement.slice(0, 3).join(', ') || 'None found'}`);
      } catch (pdfError) {
        console.error("\n✗ PDF parsing failed:", pdfError instanceof Error ? pdfError.message : "Unknown error");
        console.log("  (This is common - PDFs can be large or in non-standard formats)");
      }

      // Test full scan (without PDF parsing to be fast)
      console.log("\n3. Testing full IPO scan (quick mode - no PDF parsing)...");
      const result = await scanHkexIpos({ parsePdfs: false });

      console.log("\n✓ Scan complete:");
      console.log(`  Listings scanned: ${result.scanned}`);
      console.log(`  New filings: ${result.newFilings}`);
      console.log(`  Duplicates skipped: ${result.duplicatesSkipped}`);
      console.log(`  Errors: ${result.errors.length}`);

      if (result.errors.length > 0) {
        console.log("\n  Errors encountered:");
        result.errors.forEach(err => console.log(`    - ${err}`));
      }

      // Show stored IPO filings
      console.log("\n4. Checking stored IPO filings...");
      const filings = await storage.getAllIpoFilings();
      console.log(`\n✓ Total IPO filings in database: ${filings.length}`);

      if (filings.length > 0) {
        console.log("\nMost recent filings:");
        filings.slice(0, 3).forEach(filing => {
          console.log(`  - ${filing.companyName} (${filing.exchange}:${filing.stockCode})`);
          console.log(`    Status: ${filing.status} | Filed: ${filing.filingDate.toLocaleDateString()}`);
        });
      }
    } else {
      console.log("No listings found - HKEX page may have changed or is temporarily unavailable");
    }

    console.log("\n=== Test Complete ===");
  } catch (error) {
    console.error("\n✗ Test failed:", error);
    process.exit(1);
  }
}

testScraper();
