import axios from "axios";
import * as cheerio from "cheerio";
import type { InsertIpoFiling } from "@shared/schema";

export interface HkexIpoListing {
  stockCode: string;
  companyName: string;
  prospectusUrl: string;
  announcementUrl?: string;
  allotmentUrl?: string;
}

/**
 * Scrapes the HKEX Main Board new listings page
 * Returns an array of IPO listings with basic information
 */
export async function scrapeHkexMainBoard(): Promise<HkexIpoListing[]> {
  const url = "https://www2.hkexnews.hk/New-Listings/New-Listing-Information/Main-Board?sc_lang=en";

  try {
    console.log("Fetching HKEX Main Board listings...");
    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      timeout: 30000,
    });

    const $ = cheerio.load(response.data);
    const listings: HkexIpoListing[] = [];

    // Find the main table containing IPO listings
    // The table has columns: Stock Code, Stock Name, Documents (Announcements, Prospectuses, Allotment Results)
    const rows = $("table tbody tr");

    console.log(`Found ${rows.length} rows in the table`);

    rows.each((index, row) => {
      const $row = $(row);
      const cells = $row.find("td");

      if (cells.length >= 3) {
        const stockCode = cells.eq(0).text().trim();
        const companyName = cells.eq(1).text().trim();

        // Extract document links from the third column
        const documentCell = cells.eq(2);
        const prospectusLinks = documentCell.find("a").filter((_, el) => {
          const href = $(el).attr("href");
          return href && href.includes(".pdf");
        });

        // Get the first prospectus PDF link
        let prospectusUrl = "";
        prospectusLinks.each((_, link) => {
          const href = $(link).attr("href");
          if (href && !prospectusUrl) {
            // Make URL absolute if it's relative
            prospectusUrl = href.startsWith("http")
              ? href
              : `https://www1.hkexnews.hk${href.startsWith("/") ? href : `/${href}`}`;
          }
        });

        if (stockCode && companyName && prospectusUrl) {
          listings.push({
            stockCode,
            companyName,
            prospectusUrl,
          });
        }
      }
    });

    console.log(`Extracted ${listings.length} IPO listings from HKEX`);
    return listings;
  } catch (error) {
    console.error("Error scraping HKEX Main Board:", error);
    throw new Error(`Failed to scrape HKEX: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

/**
 * Scrapes the HKEX GEM (Growth Enterprise Market) listings page
 */
export async function scrapeHkexGem(): Promise<HkexIpoListing[]> {
  const url = "https://www2.hkexnews.hk/New-Listings/New-Listing-Information/GEM?sc_lang=en";

  try {
    console.log("Fetching HKEX GEM listings...");
    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      timeout: 30000,
    });

    const $ = cheerio.load(response.data);
    const listings: HkexIpoListing[] = [];

    // Same structure as Main Board
    const rows = $("table tbody tr");

    console.log(`Found ${rows.length} rows in GEM table`);

    rows.each((index, row) => {
      const $row = $(row);
      const cells = $row.find("td");

      if (cells.length >= 3) {
        const stockCode = cells.eq(0).text().trim();
        const companyName = cells.eq(1).text().trim();

        const documentCell = cells.eq(2);
        const prospectusLinks = documentCell.find("a").filter((_, el) => {
          const href = $(el).attr("href");
          return href && href.includes(".pdf");
        });

        let prospectusUrl = "";
        prospectusLinks.each((_, link) => {
          const href = $(link).attr("href");
          if (href && !prospectusUrl) {
            prospectusUrl = href.startsWith("http")
              ? href
              : `https://www1.hkexnews.hk${href.startsWith("/") ? href : `/${href}`}`;
          }
        });

        if (stockCode && companyName && prospectusUrl) {
          listings.push({
            stockCode,
            companyName,
            prospectusUrl,
          });
        }
      }
    });

    console.log(`Extracted ${listings.length} IPO listings from HKEX GEM`);
    return listings;
  } catch (error) {
    console.error("Error scraping HKEX GEM:", error);
    throw new Error(`Failed to scrape HKEX GEM: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

/**
 * Scrapes both Main Board and GEM listings from HKEX
 */
export async function scrapeAllHkexListings(): Promise<HkexIpoListing[]> {
  try {
    const [mainBoardListings, gemListings] = await Promise.all([
      scrapeHkexMainBoard(),
      scrapeHkexGem(),
    ]);

    return [...mainBoardListings, ...gemListings];
  } catch (error) {
    console.error("Error scraping all HKEX listings:", error);
    // If one fails, try to return at least the other
    try {
      const mainBoardListings = await scrapeHkexMainBoard();
      return mainBoardListings;
    } catch {
      const gemListings = await scrapeHkexGem();
      return gemListings;
    }
  }
}

/**
 * Converts HKEX listing to InsertIpoFiling format
 * Note: This only includes basic information. Use pdf-parser.ts to extract detailed info from prospectus
 */
export function convertToIpoFiling(listing: HkexIpoListing): Omit<InsertIpoFiling, "filingDate"> {
  return {
    exchange: "HKEX",
    stockCode: listing.stockCode,
    companyName: listing.companyName,
    businessDescription: null,
    founders: null,
    keyManagement: null,
    listingDate: null,
    prospectusUrl: listing.prospectusUrl,
    ipoSize: null,
    region: "Hong Kong",
    status: "new",
    aiSummary: null,
    matchedKeywords: null,
    priorityScore: null,
    priorityLevel: null,
  };
}
