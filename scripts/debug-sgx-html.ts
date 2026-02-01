#!/usr/bin/env tsx
/**
 * Debug script to save SGX HTML from ScrapingBee
 */

import "dotenv/config";
import fs from "fs";
import path from "path";

const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY;

async function debugSgxHtml() {
  if (!SCRAPINGBEE_API_KEY) {
    console.log("❌ ScrapingBee API key not configured");
    return;
  }

  console.log("Fetching SGX IPO page via ScrapingBee...");

  const params = new URLSearchParams({
    api_key: SCRAPINGBEE_API_KEY,
    url: "https://www.sgx.com/securities/ipos",
    render_js: "true",
    wait: "5000", // Wait 5 seconds for content to load
    premium_proxy: "false",
  });

  const response = await fetch(`https://app.scrapingbee.com/api/v1?${params.toString()}`, {
    method: "GET",
    headers: {
      "Accept": "text/html",
    },
  });

  if (!response.ok) {
    console.log(`❌ ScrapingBee returned status ${response.status}`);
    return;
  }

  const html = await response.text();
  const outputPath = "/tmp/sgx-ipo-page.html";

  fs.writeFileSync(outputPath, html);

  console.log(`✓ HTML saved to: ${outputPath}`);
  console.log(`  Size: ${(html.length / 1024).toFixed(2)} KB`);
  console.log(`\nFirst 2000 characters of rendered content:`);
  console.log("=".repeat(80));
  console.log(html.slice(0, 2000));
  console.log("=".repeat(80));

  // Search for key terms
  const keywords = ["ipo", "listing", "prospectus", "offer document", "mainboard", "catalist"];
  console.log("\nSearching for keywords in HTML:");
  keywords.forEach(keyword => {
    const regex = new RegExp(keyword, "gi");
    const matches = html.match(regex);
    console.log(`  "${keyword}": ${matches ? matches.length : 0} occurrences`);
  });
}

debugSgxHtml().catch(error => {
  console.error("Debug failed:", error);
  process.exit(1);
});
