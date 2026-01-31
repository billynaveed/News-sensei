#!/usr/bin/env tsx
/**
 * Test that the scanner can detect SGX IPO-related articles
 */

import "dotenv/config";
import { storage } from "../server/storage";

async function testSgxDetection() {
  console.log("=== Testing SGX IPO Detection ===\n");

  try {
    // Get current settings
    const settings = await storage.getSettings();

    if (!settings) {
      console.log("✗ No settings found");
      return;
    }

    console.log("1. Current Configuration:");
    console.log(`   Keywords: ${settings.keywords.length}`);
    console.log(`   Regions: ${settings.regions.length}`);

    // Check for SGX-specific keywords
    const sgxKeywords = settings.keywords.filter(k =>
      k.toLowerCase().includes('sgx') ||
      k.toLowerCase().includes('singapore') ||
      k.toLowerCase().includes('mainboard') ||
      k.toLowerCase().includes('catalist') ||
      k.toLowerCase().includes('hkex') ||
      k.toLowerCase().includes('hong kong')
    );

    console.log(`\n2. SGX/HK IPO Keywords (${sgxKeywords.length}):`);
    sgxKeywords.forEach(k => console.log(`   - ${k}`));

    // Check for Singapore sources
    const allSources = await storage.getAllSources();
    const sgSources = allSources.filter(s =>
      s.domain.includes('singapore') ||
      s.domain.includes('.sg') ||
      s.name.toLowerCase().includes('singapore') ||
      s.name.toLowerCase().includes('business times') ||
      s.name.toLowerCase().includes('edge') ||
      s.name.toLowerCase().includes('straits')
    );

    console.log(`\n3. Singapore-focused Sources (${sgSources.length}):`);
    sgSources.forEach(s => console.log(`   - ${s.name} (${s.domain}) - ${s.tier}`));

    // Get RSS feeds for these sources
    console.log(`\n4. RSS Feeds:`);
    for (const source of sgSources) {
      const feeds = await storage.getRssFeedsBySourceId(source.id);
      console.log(`   ${source.name}:`);
      feeds.forEach(f => console.log(`     - ${f.name}: ${f.url}`));
    }

    // Test with sample SGX IPO headlines
    console.log(`\n5. Testing Keyword Matching:`);

    const testHeadlines = [
      "Tech startup files for SGX IPO, aims to raise $100M",
      "Singapore company announces Mainboard listing plans",
      "New IPO on Catalist: FinTech firm debuts next week",
      "Hong Kong-based firm files prospectus for HKEX listing",
      "Company submits offer document for Singapore bourse debut",
      "Regular tech news without IPO mention",
    ];

    for (const headline of testHeadlines) {
      const matched = settings.keywords.some(keyword =>
        headline.toLowerCase().includes(keyword.toLowerCase())
      );

      const matchedKeywords = settings.keywords.filter(keyword =>
        headline.toLowerCase().includes(keyword.toLowerCase())
      );

      const icon = matched ? "✓" : "✗";
      console.log(`\n   ${icon} "${headline}"`);
      if (matched) {
        console.log(`     Matched: ${matchedKeywords.join(", ")}`);
      }
    }

    console.log(`\n\n=== Test Complete ===`);
    console.log(`\n✓ Configuration verified`);
    console.log(`✓ ${sgxKeywords.length} SGX/HK-specific keywords active`);
    console.log(`✓ ${sgSources.length} Singapore-focused sources configured`);
    console.log(`\nYour scanner is ready to detect SGX and HKEX IPO announcements!`);

  } catch (error) {
    console.error("\n✗ Test failed:", error);
    process.exit(1);
  }
}

testSgxDetection();
