#!/usr/bin/env tsx
/**
 * Debug script to capture what Puppeteer sees on SGX IPO page
 */

import "dotenv/config";
import puppeteer from "puppeteer";
import fs from "fs";

async function debugPuppeteerSgx() {
  let browser = null;

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

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log("Navigating to SGX IPO page...");
    await page.goto('https://www.sgx.com/securities/ipos', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    console.log("Page loaded, waiting for content...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Take screenshot
    const screenshotPath = '/tmp/sgx-ipo-puppeteer.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`✓ Screenshot saved to: ${screenshotPath}`);

    // Get HTML content
    const html = await page.content();
    const htmlPath = '/tmp/sgx-ipo-puppeteer.html';
    fs.writeFileSync(htmlPath, html);
    console.log(`✓ HTML saved to: ${htmlPath}`);
    console.log(`  Size: ${(html.length / 1024).toFixed(2)} KB`);

    // Get text content
    const textContent = await page.evaluate(() => document.body.innerText);
    console.log("\n=== Page Text Content (first 3000 chars) ===");
    console.log(textContent.slice(0, 3000));

    // Search for key elements
    console.log("\n=== Searching for IPO-related elements ===");

    const selectors = [
      'table',
      '.ipo-listing',
      '[class*="ipo"]',
      '.table-row',
      '[class*="listing"]',
      'a[href*="prospectus"]',
      'a[href*=".pdf"]',
    ];

    for (const selector of selectors) {
      const count = await page.evaluate((sel) => {
        return document.querySelectorAll(sel).length;
      }, selector);
      console.log(`  "${selector}": ${count} elements`);
    }

    // Check for specific text
    const hasIpoText = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return {
        ipo: text.includes('ipo'),
        listing: text.includes('listing'),
        prospectus: text.includes('prospectus'),
        mainboard: text.includes('mainboard'),
        catalist: text.includes('catalist'),
      };
    });

    console.log("\n=== Text content analysis ===");
    console.log(JSON.stringify(hasIpoText, null, 2));

    // Get all links
    const links = await page.evaluate(() => {
      const allLinks = Array.from(document.querySelectorAll('a'));
      return allLinks
        .map(link => ({
          text: link.textContent?.trim().slice(0, 100),
          href: link.href,
        }))
        .filter(link => link.text || link.href);
    });

    console.log(`\n=== Found ${links.length} links ===`);
    console.log("Links containing 'ipo', 'listing', or 'prospectus':");
    links
      .filter(link =>
        link.text?.toLowerCase().includes('ipo') ||
        link.text?.toLowerCase().includes('listing') ||
        link.text?.toLowerCase().includes('prospectus') ||
        link.href?.toLowerCase().includes('ipo') ||
        link.href?.toLowerCase().includes('prospectus')
      )
      .slice(0, 20)
      .forEach(link => {
        console.log(`  Text: ${link.text}`);
        console.log(`  URL: ${link.href}\n`);
      });

    console.log("\n=== Debug Complete ===");
  } catch (error) {
    console.error("Debug failed:", error);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

debugPuppeteerSgx();
