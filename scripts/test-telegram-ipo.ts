#!/usr/bin/env tsx
/**
 * Test script for Telegram IPO commands
 * This simulates what happens when /ipos and /iposcan commands are received
 */

import "dotenv/config";
import { storage } from "../server/storage";
import { scanHkexIpos } from "../server/ipo-scanner";
import { sendIpoFilingAlert } from "../server/telegram";

async function testTelegramIpoCommands() {
  console.log("=== Testing Telegram IPO Commands ===\n");

  // Check if Telegram is configured
  const settings = await storage.getSettings();

  if (!settings?.telegramChatId) {
    console.log("❌ Telegram chat ID not configured");
    console.log("Please set TELEGRAM_CHAT_ID in your settings first");
    return;
  }

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log("❌ TELEGRAM_BOT_TOKEN not configured");
    return;
  }

  console.log(`✓ Telegram configured for chat ID: ${settings.telegramChatId}\n`);

  // Test 1: /ipos command - get all IPO filings
  console.log("1. Testing /ipos command (list all IPO filings)...");
  const filings = await storage.getAllIpoFilings();
  console.log(`   Found ${filings.length} IPO filings in database`);

  if (filings.length > 0) {
    console.log("\n   Sample filing:");
    const sample = filings[0];
    console.log(`   - ${sample.companyName} (${sample.exchange}:${sample.stockCode})`);
    console.log(`   - Status: ${sample.status}`);
    console.log(`   - Filing Date: ${sample.filingDate.toLocaleDateString()}`);
    console.log(`   - Prospectus: ${sample.prospectusUrl}`);
  }

  // Test 2: Send a test IPO alert via Telegram
  if (filings.length > 0 && settings.telegramEnabled) {
    console.log("\n2. Testing Telegram IPO alert (sending test filing)...");
    try {
      await sendIpoFilingAlert(settings.telegramChatId, filings[0]);
      console.log("   ✓ Test IPO alert sent successfully!");
      console.log("   Check your Telegram bot for the message with Save/Dismiss buttons");
    } catch (error) {
      console.error("   ✗ Failed to send Telegram alert:", error);
    }
  }

  // Test 3: /iposcan command - scan for new IPOs
  console.log("\n3. Testing /iposcan command (scan for new IPOs)...");
  console.log("   Starting IPO scan (with PDF parsing disabled for speed)...");

  try {
    const result = await scanHkexIpos({ parsePdfs: false });

    console.log("\n   ✓ IPO Scan complete:");
    console.log(`   - Listings scanned: ${result.scanned}`);
    console.log(`   - New filings found: ${result.newFilings}`);
    console.log(`   - Duplicates skipped: ${result.duplicatesSkipped}`);

    if (result.errors.length > 0) {
      console.log(`   - Errors: ${result.errors.length}`);
      result.errors.forEach(err => console.log(`     * ${err}`));
    }

    // Send alerts for new filings
    if (result.newFilings > 0 && settings.telegramEnabled) {
      console.log(`\n   Sending ${result.newFilings} new filing alerts to Telegram...`);
      const newFilings = await storage.getAllIpoFilings();
      const recentNew = newFilings.filter(f => f.status === "new").slice(0, result.newFilings);

      for (const filing of recentNew) {
        try {
          await sendIpoFilingAlert(settings.telegramChatId!, filing);
          console.log(`   ✓ Sent alert for ${filing.companyName}`);
          await new Promise(resolve => setTimeout(resolve, 500)); // Small delay between messages
        } catch (error) {
          console.error(`   ✗ Failed to send alert for ${filing.companyName}:`, error);
        }
      }
    }
  } catch (error) {
    console.error("   ✗ IPO scan failed:", error);
  }

  console.log("\n=== Test Complete ===");
  console.log("\nTo test the actual Telegram commands:");
  console.log("1. Open your Telegram bot chat");
  console.log("2. Send /ipos to list all IPO filings");
  console.log("3. Send /iposcan to trigger a new scan");
  console.log("4. Click Save/Dismiss buttons to test interactions");
}

testTelegramIpoCommands().catch(error => {
  console.error("Test failed:", error);
  process.exit(1);
});
