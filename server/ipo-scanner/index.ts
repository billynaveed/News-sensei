import { storage } from "../storage";
import { scrapeAllHkexListings, type HkexIpoListing } from "./hkex-scraper";
import { scrapeAllSgxListings, type SgxIpoListing } from "./sgx-scraper";
import { parseProspectusPdf, type ProspectusExtractedInfo } from "./pdf-parser";
import type { InsertIpoFiling } from "@shared/schema";

export interface IpoScanResult {
  scanned: number;
  newFilings: number;
  duplicatesSkipped: number;
  errors: string[];
}

/**
 * Main IPO scanner - orchestrates the full flow:
 * 1. Scrapes HKEX for new listings
 * 2. Checks for duplicates in database
 * 3. Downloads and parses prospectus PDFs for new filings
 * 4. Stores results in database
 */
export async function scanHkexIpos(options: {
  parsePdfs?: boolean;
  maxPdfsToProcess?: number;
} = {}): Promise<IpoScanResult> {
  const {
    parsePdfs = true,
    maxPdfsToProcess = 5, // Limit to avoid excessive processing time
  } = options;

  console.log("Starting HKEX IPO scan...");

  const result: IpoScanResult = {
    scanned: 0,
    newFilings: 0,
    duplicatesSkipped: 0,
    errors: [],
  };

  try {
    // Step 1: Scrape HKEX for listings
    console.log("Scraping HKEX listings...");
    const listings = await scrapeAllHkexListings();
    result.scanned = listings.length;

    console.log(`Found ${listings.length} total listings on HKEX`);

    if (listings.length === 0) {
      console.log("No listings found");
      return result;
    }

    // Step 2: Filter for new listings (check duplicates)
    console.log("Checking for duplicates...");
    const newListings: HkexIpoListing[] = [];

    for (const listing of listings) {
      const existing = await storage.getIpoFilingByUrl(listing.prospectusUrl);
      if (existing) {
        result.duplicatesSkipped++;
        console.log(`Skipping duplicate: ${listing.companyName} (${listing.stockCode})`);
      } else {
        newListings.push(listing);
      }
    }

    console.log(`Found ${newListings.length} new listings to process`);

    if (newListings.length === 0) {
      console.log("No new filings to add");
      return result;
    }

    // Step 3: Process new listings
    // Limit the number of PDFs to process in one run
    const listingsToProcess = newListings.slice(0, maxPdfsToProcess);

    for (const listing of listingsToProcess) {
      try {
        console.log(`Processing: ${listing.companyName} (${listing.stockCode})`);

        let prospectusInfo: ProspectusExtractedInfo | null = null;

        // Step 3a: Parse PDF if enabled
        if (parsePdfs) {
          try {
            console.log(`  Downloading and parsing prospectus...`);
            prospectusInfo = await parseProspectusPdf(listing.prospectusUrl, true);
            console.log(`  ✓ PDF parsed successfully`);
          } catch (pdfError) {
            const errorMsg = `PDF parsing failed for ${listing.companyName}: ${pdfError instanceof Error ? pdfError.message : "Unknown error"}`;
            console.error(`  ✗ ${errorMsg}`);
            result.errors.push(errorMsg);
            // Continue with basic info even if PDF parsing fails
          }
        }

        // Step 3b: Create IPO filing entry
        const filing: InsertIpoFiling = {
          exchange: "HKEX",
          stockCode: listing.stockCode,
          companyName: prospectusInfo?.companyName || listing.companyName,
          businessDescription: prospectusInfo?.businessDescription || null,
          founders: prospectusInfo?.founders || null,
          keyManagement: prospectusInfo?.keyManagement || null,
          filingDate: prospectusInfo?.filingDate || new Date(),
          listingDate: prospectusInfo?.listingDate || null,
          prospectusUrl: listing.prospectusUrl,
          ipoSize: prospectusInfo?.ipoSize || null,
          region: "Hong Kong",
          status: "new",
          aiSummary: null,
          matchedKeywords: null,
          priorityScore: null,
          priorityLevel: null,
        };

        await storage.createIpoFiling(filing);
        result.newFilings++;
        console.log(`  ✓ Saved to database: ${filing.companyName}`);
      } catch (error) {
        const errorMsg = `Error processing ${listing.companyName}: ${error instanceof Error ? error.message : "Unknown error"}`;
        console.error(`  ✗ ${errorMsg}`);
        result.errors.push(errorMsg);
      }
    }

    // If there are more listings than we processed, note it
    if (newListings.length > maxPdfsToProcess) {
      const remaining = newListings.length - maxPdfsToProcess;
      console.log(`Note: ${remaining} additional new listings not processed in this run (limit: ${maxPdfsToProcess})`);
    }

    console.log(`HKEX IPO scan complete: ${result.newFilings} new filings added`);
    return result;
  } catch (error) {
    const errorMsg = `Fatal error in HKEX IPO scan: ${error instanceof Error ? error.message : "Unknown error"}`;
    console.error(errorMsg);
    result.errors.push(errorMsg);
    throw error;
  }
}

/**
 * Quick scan without PDF parsing (faster, less detailed)
 */
export async function quickScanHkexIpos(): Promise<IpoScanResult> {
  return scanHkexIpos({ parsePdfs: false });
}

/**
 * Full scan with PDF parsing (slower, more detailed)
 */
export async function fullScanHkexIpos(): Promise<IpoScanResult> {
  return scanHkexIpos({ parsePdfs: true, maxPdfsToProcess: 10 });
}

/**
 * Main SGX IPO scanner - orchestrates the full flow:
 * 1. Scrapes SGX for new listings
 * 2. Checks for duplicates in database
 * 3. Optionally parses prospectus PDFs for new filings
 * 4. Stores results in database
 */
export async function scanSgxIpos(options: {
  parsePdfs?: boolean;
  maxPdfsToProcess?: number;
} = {}): Promise<IpoScanResult> {
  const {
    parsePdfs = true,
    maxPdfsToProcess = 5,
  } = options;

  console.log("Starting SGX IPO scan...");

  const result: IpoScanResult = {
    scanned: 0,
    newFilings: 0,
    duplicatesSkipped: 0,
    errors: [],
  };

  try {
    // Step 1: Scrape SGX for listings
    console.log("Scraping SGX listings...");
    const listings = await scrapeAllSgxListings();
    result.scanned = listings.length;

    console.log(`Found ${listings.length} total listings on SGX`);

    if (listings.length === 0) {
      console.log("No listings found");
      return result;
    }

    // Step 2: Filter for new listings (check duplicates)
    console.log("Checking for duplicates...");
    const newListings: SgxIpoListing[] = [];

    for (const listing of listings) {
      const existing = await storage.getIpoFilingByUrl(listing.prospectusUrl);
      if (existing) {
        result.duplicatesSkipped++;
        console.log(`Skipping duplicate: ${listing.companyName} (${listing.stockCode})`);
      } else {
        newListings.push(listing);
      }
    }

    console.log(`Found ${newListings.length} new listings to process`);

    if (newListings.length === 0) {
      console.log("No new filings to add");
      return result;
    }

    // Step 3: Process new listings
    const listingsToProcess = newListings.slice(0, maxPdfsToProcess);

    for (const listing of listingsToProcess) {
      try {
        console.log(`Processing: ${listing.companyName} (${listing.stockCode})`);

        let prospectusInfo: ProspectusExtractedInfo | null = null;

        // Step 3a: Parse PDF if enabled and URL is available
        if (parsePdfs && listing.prospectusUrl) {
          try {
            console.log(`  Downloading and parsing prospectus...`);
            prospectusInfo = await parseProspectusPdf(listing.prospectusUrl, true);
            console.log(`  ✓ PDF parsed successfully`);
          } catch (pdfError) {
            const errorMsg = `PDF parsing failed for ${listing.companyName}: ${pdfError instanceof Error ? pdfError.message : "Unknown error"}`;
            console.error(`  ✗ ${errorMsg}`);
            result.errors.push(errorMsg);
          }
        }

        // Step 3b: Create IPO filing entry
        const filing: InsertIpoFiling = {
          exchange: "SGX",
          stockCode: listing.stockCode,
          companyName: prospectusInfo?.companyName || listing.companyName,
          businessDescription: prospectusInfo?.businessDescription || null,
          founders: prospectusInfo?.founders || null,
          keyManagement: prospectusInfo?.keyManagement || null,
          filingDate: prospectusInfo?.filingDate || listing.listingDate || new Date(),
          listingDate: prospectusInfo?.listingDate || listing.listingDate || null,
          prospectusUrl: listing.prospectusUrl,
          ipoSize: prospectusInfo?.ipoSize || listing.ipoSize || null,
          region: "Singapore",
          status: "new",
          aiSummary: null,
          matchedKeywords: null,
          priorityScore: null,
          priorityLevel: null,
        };

        await storage.createIpoFiling(filing);
        result.newFilings++;
        console.log(`  ✓ Saved to database: ${filing.companyName}`);
      } catch (error) {
        const errorMsg = `Error processing ${listing.companyName}: ${error instanceof Error ? error.message : "Unknown error"}`;
        console.error(`  ✗ ${errorMsg}`);
        result.errors.push(errorMsg);
      }
    }

    if (newListings.length > maxPdfsToProcess) {
      const remaining = newListings.length - maxPdfsToProcess;
      console.log(`Note: ${remaining} additional new listings not processed in this run (limit: ${maxPdfsToProcess})`);
    }

    console.log(`SGX IPO scan complete: ${result.newFilings} new filings added`);
    return result;
  } catch (error) {
    const errorMsg = `Fatal error in SGX IPO scan: ${error instanceof Error ? error.message : "Unknown error"}`;
    console.error(errorMsg);
    result.errors.push(errorMsg);
    throw error;
  }
}

/**
 * Scans both HKEX and SGX exchanges for IPO filings
 */
export async function scanAllIpos(options: {
  parsePdfs?: boolean;
  maxPdfsToProcess?: number;
} = {}): Promise<{ hkex: IpoScanResult; sgx: IpoScanResult }> {
  console.log("Starting combined IPO scan (HKEX + SGX)...\n");

  const hkexResult = await scanHkexIpos(options);
  console.log("\n");
  const sgxResult = await scanSgxIpos(options);

  console.log("\n=== Combined Scan Summary ===");
  console.log(`HKEX: ${hkexResult.newFilings} new, ${hkexResult.duplicatesSkipped} duplicates, ${hkexResult.errors.length} errors`);
  console.log(`SGX:  ${sgxResult.newFilings} new, ${sgxResult.duplicatesSkipped} duplicates, ${sgxResult.errors.length} errors`);
  console.log(`Total: ${hkexResult.newFilings + sgxResult.newFilings} new filings`);

  return { hkex: hkexResult, sgx: sgxResult };
}
