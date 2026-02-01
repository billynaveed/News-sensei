#!/usr/bin/env tsx
/**
 * Test Singapore-specific IPO data sources
 */

import "dotenv/config";
import axios from "axios";
import * as cheerio from "cheerio";

async function testSingaporeSources() {
  console.log("=== Testing Singapore-Specific IPO Sources ===\n");

  // Test 1: SGX Press Releases
  console.log("1. SGX Press Releases\n");
  try {
    const response = await axios.get("https://www.sgx.com/media-centre/20250131_0", {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 10000,
    });

    const $ = cheerio.load(response.data);
    console.log("   Title:", $('title').text());

    // Look for press releases
    const links = $('a[href*="media"]').map((i, el) => ({
      text: $(el).text().trim(),
      href: $(el).attr('href')
    })).get();

    console.log(`   Found ${links.length} media links`);
  } catch (error: any) {
    console.log(`   ✗ Failed: ${error.message}`);
  }

  // Test 2: Business Times IPO section
  console.log("\n2. Business Times IPO Coverage\n");
  try {
    const response = await axios.get("https://www.businesstimes.com.sg/companies-markets/ipos", {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 10000,
    });

    console.log(`   ✓ Status: ${response.status}`);
    const $ = cheerio.load(response.data);
    console.log("   Title:", $('title').text());

    // Look for articles
    const articles = $('article, .article, [class*="story"]').length;
    console.log(`   Articles found: ${articles}`);
  } catch (error: any) {
    console.log(`   ✗ Failed: ${error.message}`);
  }

  // Test 3: DealStreetAsia (covers Asia IPOs)
  console.log("\n3. DealStreetAsia\n");
  try {
    const response = await axios.get("https://www.dealstreetasia.com/tag/ipos/", {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 10000,
    });

    console.log(`   ✓ Status: ${response.status}`);
    const $ = cheerio.load(response.data);

    const articles = $('article, .post').length;
    console.log(`   Articles found: ${articles}`);
  } catch (error: any) {
    console.log(`   ✗ Failed: ${error.message}`);
  }

  // Test 4: The Edge Singapore
  console.log("\n4. The Edge Singapore Markets\n");
  try {
    const response = await axios.get("https://www.theedgesingapore.com/capital", {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 10000,
    });

    console.log(`   ✓ Status: ${response.status}`);
    const $ = cheerio.load(response.data);

    const articles = $('article').length;
    console.log(`   Articles found: ${articles}`);
  } catch (error: any) {
    console.log(`   ✗ Failed: ${error.message}`);
  }

  // Test 5: Reuters Singapore Markets
  console.log("\n5. Reuters Singapore\n");
  try {
    const response = await axios.get("https://www.reuters.com/markets/asia/", {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 10000,
    });

    console.log(`   ✓ Status: ${response.status}`);
  } catch (error: any) {
    console.log(`   ✗ Failed: ${error.message}`);
  }

  // Test 6: IPO-specific tracking sites
  console.log("\n6. IPO Tracking Sites\n");

  const ipoSites = [
    "https://www.ipomonitor.com/pages/ipo-calendar.html",
    "https://www.renaissancecapital.com/IPO-Center/IPO-Filings",
    "https://stockanalysis.com/ipos/calendar/",
  ];

  for (const site of ipoSites) {
    try {
      const response = await axios.get(site, {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 10000,
      });
      console.log(`   ✓ ${site.split('/')[2]}: Status ${response.status}`);
    } catch (error: any) {
      console.log(`   ✗ ${site.split('/')[2]}: ${error.message}`);
    }
  }

  console.log("\n=== Testing Complete ===");
  console.log("\nRecommendation:");
  console.log("Best approach for SGX IPOs:");
  console.log("1. Business Times Singapore - Has dedicated IPO section");
  console.log("2. DealStreetAsia - Covers Asian IPOs including SGX");
  console.log("3. SGX Press Releases - Official announcements");
  console.log("4. Your existing news scanner - Can catch IPO announcements");
}

testSingaporeSources();
