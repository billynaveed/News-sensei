import axios from "axios";
import * as cheerio from "cheerio";
import puppeteer, { type Browser, type Page } from "puppeteer";
import type { InsertIpoFiling } from "@shared/schema";

const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY;

export interface SgxIpoListing {
  stockCode: string;
  companyName: string;
  prospectusUrl: string;
  listingDate?: Date;
  ipoSize?: number;
}

/**
 * NOTE: SGX Website Limitation
 *
 * The SGX website (https://www.sgx.com/securities/ipos) is a JavaScript-rendered
 * single-page application. Standard HTTP requests only return the HTML shell,
 * not the actual IPO data which is loaded dynamically via JavaScript.
 *
 * To scrape SGX IPOs, consider these approaches:
 * 1. Use a headless browser (Puppeteer/Playwright) to render JavaScript
 * 2. Find the actual API endpoint that the SGX website uses
 * 3. Use SGX's SGXNet announcements API
 * 4. Manual entry for now (SGX has fewer IPOs than HKEX)
 *
 * For now, this scraper provides the infrastructure but returns empty results.
 */

/**
 * Scrapes SGX IPO page using Puppeteer for full browser control
 * This method can handle JavaScript rendering and wait for AJAX requests
 */
export async function scrapeSgxWithPuppeteer(): Promise<SgxIpoListing[]> {
  let browser: Browser | null = null;

  try {
    console.log("Launching Puppeteer browser...");
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page: Page = await browser.newPage();

    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log("Navigating to SGX IPO Prospectus page...");

    // Navigate to the correct IPO page and wait for network to be idle
    await page.goto('https://www.sgx.com/securities/ipo-prospectus', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    console.log("Waiting for content to load...");

    // Wait for potential IPO content to appear
    // Try multiple selectors as we're not sure which one will be present
    try {
      await page.waitForSelector('table, .ipo-listing, [class*="ipo"], .table-row', {
        timeout: 10000,
      });
    } catch (e) {
      console.log("No standard IPO selectors found, checking page content...");
    }

    // Give extra time for any lazy-loaded content
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log("Extracting IPO data from page...");

    // Extract data using page.evaluate
    const listings = await page.evaluate(() => {
      const results: Array<{
        companyName: string;
        stockCode: string;
        prospectusUrl: string;
        listingDate?: string;
      }> = [];

      // Pattern 1: Look for table rows
      const tableRows = document.querySelectorAll('table tbody tr, .table-row, [class*="ipo-item"]');

      tableRows.forEach((row) => {
        // Try to find company name
        const companyNameEl = row.querySelector('[class*="company"], [class*="name"], td:first-child, .name, h3, h4');
        const companyName = companyNameEl?.textContent?.trim() || '';

        // Try to find stock code
        const stockCodeEl = row.querySelector('[class*="code"], [class*="ticker"], [class*="symbol"], td:nth-child(2)');
        const stockCode = stockCodeEl?.textContent?.trim() || '';

        // Try to find prospectus link
        const links = row.querySelectorAll('a');
        let prospectusUrl = '';

        links.forEach((link) => {
          const href = link.getAttribute('href');
          const text = link.textContent?.toLowerCase() || '';

          if (href && (
            href.includes('prospectus') ||
            href.includes('.pdf') ||
            text.includes('prospectus') ||
            text.includes('offer document')
          )) {
            prospectusUrl = href.startsWith('http')
              ? href
              : `https://www.sgx.com${href.startsWith('/') ? href : `/${href}`}`;
          }
        });

        // Try to find listing date
        const dateEl = row.querySelector('[class*="date"], .date, td:last-child');
        const listingDate = dateEl?.textContent?.trim() || '';

        if (companyName && (stockCode || prospectusUrl)) {
          results.push({
            companyName,
            stockCode,
            prospectusUrl,
            listingDate: listingDate || undefined,
          });
        }
      });

      // Pattern 2: Look for card-style layouts
      const cards = document.querySelectorAll('[class*="card"], [class*="listing"]');

      cards.forEach((card) => {
        const companyNameEl = card.querySelector('h3, h4, h5, [class*="title"], [class*="company"]');
        const companyName = companyNameEl?.textContent?.trim() || '';

        const stockCodeEl = card.querySelector('[class*="code"], [class*="ticker"]');
        const stockCode = stockCodeEl?.textContent?.trim() || '';

        const links = card.querySelectorAll('a');
        let prospectusUrl = '';

        links.forEach((link) => {
          const href = link.getAttribute('href');
          const text = link.textContent?.toLowerCase() || '';

          if (href && (href.includes('.pdf') || text.includes('prospectus'))) {
            prospectusUrl = href.startsWith('http')
              ? href
              : `https://www.sgx.com${href.startsWith('/') ? href : `/${href}`}`;
          }
        });

        if (companyName && (stockCode || prospectusUrl)) {
          // Check if not duplicate
          const isDuplicate = results.some(r => r.companyName === companyName);
          if (!isDuplicate) {
            results.push({
              companyName,
              stockCode,
              prospectusUrl,
            });
          }
        }
      });

      // Pattern 3: Look for any links or sections with "IPO" in text
      const allLinks = document.querySelectorAll('a');
      allLinks.forEach((link) => {
        const text = link.textContent?.toLowerCase() || '';
        const href = link.getAttribute('href') || '';

        if ((text.includes('ipo') || text.includes('listing')) && href.includes('.pdf')) {
          const companyName = link.textContent?.trim() || '';
          const prospectusUrl = href.startsWith('http')
            ? href
            : `https://www.sgx.com${href.startsWith('/') ? href : `/${href}`}`;

          if (companyName && !results.some(r => r.companyName === companyName)) {
            results.push({
              companyName,
              stockCode: '',
              prospectusUrl,
            });
          }
        }
      });

      return results;
    });

    // Convert to SgxIpoListing format
    const sgxListings: SgxIpoListing[] = listings.map(listing => ({
      stockCode: listing.stockCode || '',
      companyName: listing.companyName,
      prospectusUrl: listing.prospectusUrl || '',
      listingDate: listing.listingDate ? new Date(listing.listingDate) : undefined,
    }));

    console.log(`Extracted ${sgxListings.length} IPO listings from SGX via Puppeteer`);

    return sgxListings;
  } catch (error) {
    console.error("Error scraping SGX with Puppeteer:", error);
    return [];
  } finally {
    if (browser) {
      await browser.close();
      console.log("Browser closed");
    }
  }
}

/**
 * Scrapes SGX IPO page using ScrapingBee to render JavaScript
 * SGX IPO page: https://www.sgx.com/securities/ipos
 */
export async function scrapeSgxWithScrapingBee(): Promise<SgxIpoListing[]> {
  if (!SCRAPINGBEE_API_KEY) {
    console.log("ScrapingBee API key not configured, skipping JavaScript rendering");
    return [];
  }

  try {
    console.log("Fetching SGX IPO page via ScrapingBee (JavaScript rendering)...");

    const params = new URLSearchParams({
      api_key: SCRAPINGBEE_API_KEY,
      url: "https://www.sgx.com/securities/ipos",
      render_js: "true", // Enable JavaScript rendering
      wait: "3000", // Wait 3 seconds for content to load
      premium_proxy: "false",
    });

    const response = await fetch(`https://app.scrapingbee.com/api/v1?${params.toString()}`, {
      method: "GET",
      headers: {
        "Accept": "text/html",
      },
    });

    if (!response.ok) {
      throw new Error(`ScrapingBee returned status ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const listings: SgxIpoListing[] = [];

    console.log("Parsing rendered SGX IPO page...");

    // Look for IPO listings in various possible structures
    // Try to find tables, divs, or list items that contain IPO data

    // Pattern 1: Look for table rows with company information
    $("table tbody tr, .table-row, [class*='ipo-item']").each((index, element) => {
      const $row = $(element);

      // Try to extract company name (look in various possible locations)
      let companyName = $row.find("[class*='company'], [class*='name'], td:first-child, .name, h3, h4")
        .first()
        .text()
        .trim();

      // Try to extract stock code
      let stockCode = $row.find("[class*='code'], [class*='ticker'], [class*='symbol'], td:nth-child(2)")
        .first()
        .text()
        .trim();

      // Try to find prospectus link
      const prospectusLink = $row.find("a").filter((_, el) => {
        const href = $(el).attr("href");
        const text = $(el).text().toLowerCase();
        return href && (
          href.includes("prospectus") ||
          href.includes(".pdf") ||
          text.includes("prospectus") ||
          text.includes("offer document")
        );
      }).first();

      let prospectusUrl = "";
      if (prospectusLink.length > 0) {
        const href = prospectusLink.attr("href");
        if (href) {
          prospectusUrl = href.startsWith("http")
            ? href
            : `https://www.sgx.com${href.startsWith("/") ? href : `/${href}`}`;
        }
      }

      // Try to find listing date
      let listingDate: Date | undefined;
      const dateText = $row.find("[class*='date'], .date, td:last-child").text().trim();
      if (dateText && /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(dateText)) {
        try {
          listingDate = new Date(dateText);
        } catch (e) {
          // Invalid date, skip
        }
      }

      if (companyName && (stockCode || prospectusUrl)) {
        listings.push({
          stockCode: stockCode || "",
          companyName,
          prospectusUrl: prospectusUrl || "",
          listingDate,
        });
      }
    });

    // Pattern 2: Look for card-style layouts
    $("[class*='card'], [class*='listing']").each((index, element) => {
      const $card = $(element);

      const companyName = $card.find("h3, h4, h5, [class*='title'], [class*='company']")
        .first()
        .text()
        .trim();

      const stockCode = $card.find("[class*='code'], [class*='ticker']")
        .first()
        .text()
        .trim();

      const prospectusLink = $card.find("a").filter((_, el) => {
        const href = $(el).attr("href");
        const text = $(el).text().toLowerCase();
        return href && (href.includes(".pdf") || text.includes("prospectus"));
      }).first();

      let prospectusUrl = "";
      if (prospectusLink.length > 0) {
        const href = prospectusLink.attr("href");
        if (href) {
          prospectusUrl = href.startsWith("http")
            ? href
            : `https://www.sgx.com${href.startsWith("/") ? href : `/${href}`}`;
        }
      }

      if (companyName && (stockCode || prospectusUrl)) {
        // Check if not duplicate
        const isDuplicate = listings.some(l => l.companyName === companyName);
        if (!isDuplicate) {
          listings.push({
            stockCode: stockCode || "",
            companyName,
            prospectusUrl: prospectusUrl || "",
          });
        }
      }
    });

    console.log(`Extracted ${listings.length} IPO listings from SGX via ScrapingBee`);
    return listings;
  } catch (error) {
    console.error("Error scraping SGX with ScrapingBee:", error);
    return [];
  }
}

/**
 * Scrapes SGX company announcements for IPO-related filings
 * SGX announcements: https://links.sgx.com/1.0.0/corporate-announcements
 */
export async function scrapeSgxAnnouncements(): Promise<SgxIpoListing[]> {
  try {
    console.log("Fetching SGX announcements for IPO filings...");

    // Try the SGXNet API endpoint
    const response = await axios.get("https://links.sgx.com/1.0.0/corporate-announcements", {
      params: {
        params: JSON.stringify({
          category: ["listing"],
          period: "1m", // Last 1 month
        }),
      },
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
        "Referer": "https://www.sgx.com/",
      },
      timeout: 30000,
    });

    const listings: SgxIpoListing[] = [];

    // Process announcements
    if (response.data && response.data.data && Array.isArray(response.data.data)) {
      for (const announcement of response.data.data) {
        // Filter for IPO-related announcements
        const title = (announcement.title || "").toLowerCase();
        const isIpoRelated = title.includes("ipo") ||
                            title.includes("listing") ||
                            title.includes("prospectus") ||
                            title.includes("offer document");

        if (isIpoRelated) {
          listings.push({
            stockCode: announcement.stockCode || announcement.securitySymbol || "",
            companyName: announcement.companyName || announcement.security || "",
            prospectusUrl: announcement.pdfUrl || announcement.documentUrl || "",
            listingDate: announcement.broadcastDate ? new Date(announcement.broadcastDate) : undefined,
          });
        }
      }
    }

    console.log(`Extracted ${listings.length} IPO-related announcements from SGX`);
    return listings;
  } catch (error) {
    console.error("Error fetching SGX announcements:", error);
    return [];
  }
}

/**
 * Manual SGX IPO data entry
 * Since SGX requires JavaScript rendering, this function allows manual addition
 * of recent IPO filings that can be found at https://www.sgx.com/securities/ipos
 */
export function getManualSgxIpos(): SgxIpoListing[] {
  // Manually add recent SGX IPOs here
  // Visit https://www.sgx.com/securities/ipos to find current IPOs
  // and add them to this array
  return [
    // Example:
    // {
    //   stockCode: "ABC",
    //   companyName: "Example Company Ltd",
    //   prospectusUrl: "https://links.sgx.com/FileOpen/Example.ashx?App=Prospectus&FileID=12345",
    //   listingDate: new Date("2026-02-01"),
    // },
  ];
}

/**
 * Main SGX scraper - tries multiple methods to get IPO listings
 */
export async function scrapeAllSgxListings(): Promise<SgxIpoListing[]> {
  const allListings: SgxIpoListing[] = [];

  // Try Puppeteer first (best for JavaScript-rendered sites with full control)
  try {
    console.log("Trying Puppeteer for SGX IPO scraping...");
    const puppeteerListings = await scrapeSgxWithPuppeteer();
    allListings.push(...puppeteerListings);
  } catch (error) {
    console.error("Puppeteer scraping failed:", error);
  }

  // Try ScrapingBee if Puppeteer didn't find anything and API key is available
  if (allListings.length === 0 && SCRAPINGBEE_API_KEY) {
    try {
      console.log("Trying ScrapingBee for SGX IPO scraping...");
      const scrapingBeeListings = await scrapeSgxWithScrapingBee();
      allListings.push(...scrapingBeeListings);
    } catch (error) {
      console.error("ScrapingBee scraping failed:", error);
    }
  }

  // Try announcements API if previous methods didn't find anything
  if (allListings.length === 0) {
    try {
      console.log("Trying SGX announcements API...");
      const announcements = await scrapeSgxAnnouncements();
      allListings.push(...announcements);
    } catch (error) {
      console.error("Announcements scraping failed:", error);
    }
  }

  // Add manual entries if automated methods didn't return results
  if (allListings.length === 0) {
    console.log("No automated results found, using manual IPO data...");
    const manualIpos = getManualSgxIpos();
    allListings.push(...manualIpos);
  }

  // Remove duplicates based on stock code and company name
  const uniqueListings = allListings.filter(
    (listing, index, self) =>
      index === self.findIndex((l) =>
        (l.stockCode && listing.stockCode && l.stockCode === listing.stockCode) ||
        l.companyName === listing.companyName
      )
  );

  console.log(`Total SGX IPO listings: ${uniqueListings.length}`);
  return uniqueListings;
}

/**
 * Converts SGX listing to InsertIpoFiling format
 */
export function convertToIpoFiling(listing: SgxIpoListing): Omit<InsertIpoFiling, "filingDate"> {
  return {
    exchange: "SGX",
    stockCode: listing.stockCode,
    companyName: listing.companyName,
    businessDescription: null,
    founders: null,
    keyManagement: null,
    listingDate: listing.listingDate || null,
    prospectusUrl: listing.prospectusUrl,
    ipoSize: listing.ipoSize || null,
    region: "Singapore",
    status: "new",
    aiSummary: null,
    matchedKeywords: null,
    priorityScore: null,
    priorityLevel: null,
  };
}
