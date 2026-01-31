#!/usr/bin/env tsx
/**
 * Add SGX-focused sources and keywords to existing database
 */

import "dotenv/config";
import { storage } from "../server/storage";

async function addSgxSources() {
  console.log("=== Adding SGX IPO Sources and Keywords ===\n");

  try {
    // Step 1: Check current settings
    console.log("1. Checking current settings...");
    const settings = await storage.getSettings();

    if (settings) {
      console.log(`   Current keywords: ${settings.keywords.length}`);
      console.log(`   Current regions: ${settings.regions.length}`);

      // Update keywords with SGX-specific terms if not already present
      const sgxKeywords = [
        "SGX IPO", "Singapore IPO", "Mainboard listing", "Catalist listing",
        "SGX listing", "offer document", "prospectus filing", "SGX debut",
        "Singapore bourse", "HKEX IPO", "Hong Kong IPO", "HK listing"
      ];

      const newKeywords = [...settings.keywords];
      let addedCount = 0;

      for (const keyword of sgxKeywords) {
        if (!newKeywords.includes(keyword)) {
          newKeywords.push(keyword);
          addedCount++;
        }
      }

      if (addedCount > 0) {
        console.log(`\n   Adding ${addedCount} new SGX-specific keywords...`);
        await storage.upsertSettings({ keywords: newKeywords });
        console.log(`   ✓ Keywords updated: now ${newKeywords.length} total`);
      } else {
        console.log(`   ✓ All SGX keywords already present`);
      }
    }

    // Step 2: Add new sources
    console.log("\n2. Adding new sources...");
    const existingSources = await storage.getAllSources();
    const existingDomains = existingSources.map(s => s.domain);

    const newSources = [
      { name: "The Edge Singapore", domain: "theedgesingapore.com", tier: "tier1" as const, active: true },
      { name: "Bloomberg", domain: "bloomberg.com", tier: "tier2" as const, active: true },
      { name: "KrASIA", domain: "kr-asia.com", tier: "tier3" as const, active: true },
    ];

    for (const source of newSources) {
      if (!existingDomains.includes(source.domain)) {
        const createdSource = await storage.createSource(source);
        console.log(`   ✓ Added: ${source.name}`);

        // Add RSS feeds for the new source
        if (source.domain === "theedgesingapore.com") {
          await storage.createRssFeed({
            sourceId: createdSource.id,
            name: "Capital",
            url: "https://www.theedgesingapore.com/capital/rss",
            active: true
          });
          await storage.createRssFeed({
            sourceId: createdSource.id,
            name: "Singapore",
            url: "https://www.theedgesingapore.com/singapore/rss",
            active: true
          });
          console.log(`     → Added 2 RSS feeds`);
        } else if (source.domain === "bloomberg.com") {
          await storage.createRssFeed({
            sourceId: createdSource.id,
            name: "Markets",
            url: "https://feeds.bloomberg.com/markets/news.rss",
            active: true
          });
          console.log(`     → Added 1 RSS feed`);
        } else if (source.domain === "kr-asia.com") {
          await storage.createRssFeed({
            sourceId: createdSource.id,
            name: "Main Feed",
            url: "https://kr-asia.com/feed",
            active: true
          });
          console.log(`     → Added 1 RSS feed`);
        }
      } else {
        console.log(`   ○ Already exists: ${source.name}`);
      }
    }

    // Step 3: Add additional feeds to existing sources
    console.log("\n3. Adding additional RSS feeds to existing sources...");
    const btSource = existingSources.find(s => s.domain === "businesstimes.com.sg");

    if (btSource) {
      const existingFeeds = await storage.getRssFeedsBySourceId(btSource.id);
      const feedUrls = existingFeeds.map(f => f.url);

      const bankingFeedUrl = "https://www.businesstimes.com.sg/rss/banking-finance";
      if (!feedUrls.includes(bankingFeedUrl)) {
        await storage.createRssFeed({
          sourceId: btSource.id,
          name: "Banking & Finance",
          url: bankingFeedUrl,
          active: true
        });
        console.log(`   ✓ Added Banking & Finance feed to Business Times`);
      } else {
        console.log(`   ○ Banking & Finance feed already exists`);
      }
    }

    // Step 4: Summary
    console.log("\n4. Summary:");
    const allSources = await storage.getAllSources();
    const allFeeds = await storage.getAllActiveRssFeeds();
    const updatedSettings = await storage.getSettings();

    console.log(`   Total sources: ${allSources.length}`);
    console.log(`   Active RSS feeds: ${allFeeds.length}`);
    console.log(`   Total keywords: ${updatedSettings?.keywords.length || 0}`);

    console.log("\n✓ SGX IPO sources and keywords added successfully!");
    console.log("\nYour scanner will now detect:");
    console.log("  - SGX IPO announcements");
    console.log("  - HKEX IPO announcements");
    console.log("  - Singapore market listings");
    console.log("  - Hong Kong market listings");
    console.log("\nNext scan will include these new sources and keywords.");

  } catch (error) {
    console.error("\n✗ Error adding SGX sources:", error);
    process.exit(1);
  }
}

addSgxSources();
