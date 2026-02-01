#!/usr/bin/env tsx
/**
 * Research alternative sources for SGX IPO filings
 */

import "dotenv/config";
import axios from "axios";

async function testSource(name: string, url: string, description: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing: ${name}`);
  console.log(`URL: ${url}`);
  console.log(`Description: ${description}`);
  console.log("=".repeat(60));

  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/html",
      },
      timeout: 10000,
    });

    console.log(`✓ Status: ${response.status}`);
    console.log(`✓ Content-Type: ${response.headers['content-type']}`);
    console.log(`✓ Size: ${(JSON.stringify(response.data).length / 1024).toFixed(2)} KB`);

    // Check for IPO-related content
    const dataStr = JSON.stringify(response.data).toLowerCase();
    const hasIpo = dataStr.includes('ipo') || dataStr.includes('listing') || dataStr.includes('prospectus');
    console.log(`${hasIpo ? '✓' : '✗'} Contains IPO-related content: ${hasIpo}`);

    if (hasIpo) {
      console.log("\nSample data:");
      const sample = JSON.stringify(response.data).slice(0, 500);
      console.log(sample);
    }

    return { success: true, hasIpo };
  } catch (error: any) {
    console.log(`✗ Failed: ${error.message}`);
    return { success: false, hasIpo: false };
  }
}

async function researchSgxSources() {
  console.log("=== Researching Alternative SGX IPO Data Sources ===\n");

  const sources = [
    {
      name: "SGXNet Announcements API",
      url: "https://api.sgx.com/announcements/v1.1/",
      description: "SGX official announcements API",
    },
    {
      name: "SGX Press Releases RSS",
      url: "https://www.sgx.com/rss-feeds",
      description: "SGX press releases and news",
    },
    {
      name: "Business Times Singapore RSS",
      url: "https://www.businesstimes.com.sg/rss-feeds",
      description: "Singapore business news including IPOs",
    },
    {
      name: "Channel News Asia Business",
      url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511",
      description: "CNA business news RSS feed",
    },
    {
      name: "SGX Companies API",
      url: "https://api2.sgx.com/companies",
      description: "SGX companies data API",
    },
    {
      name: "SGX Listings API",
      url: "https://api2.sgx.com/listings/securities",
      description: "SGX securities listings",
    },
    {
      name: "Finnhub IPO Calendar",
      url: "https://finnhub.io/api/v1/calendar/ipo?from=2026-01-01&to=2026-12-31&token=demo",
      description: "Finnhub IPO calendar (global)",
    },
    {
      name: "Alpha Vantage IPO Calendar",
      url: "https://www.alphavantage.co/query?function=IPO_CALENDAR&apikey=demo",
      description: "Alpha Vantage IPO calendar",
    },
  ];

  const results = [];

  for (const source of sources) {
    const result = await testSource(source.name, source.url, source.description);
    results.push({ ...source, ...result });
    await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
  }

  console.log("\n\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));

  const successfulSources = results.filter(r => r.success);
  const sourcesWithIpo = results.filter(r => r.hasIpo);

  console.log(`\nTested: ${results.length} sources`);
  console.log(`Accessible: ${successfulSources.length} sources`);
  console.log(`With IPO data: ${sourcesWithIpo.length} sources`);

  if (sourcesWithIpo.length > 0) {
    console.log("\n✓ Recommended sources:");
    sourcesWithIpo.forEach(source => {
      console.log(`  - ${source.name}`);
      console.log(`    ${source.url}`);
    });
  }

  console.log("\n=== Research Complete ===");
}

researchSgxSources();
