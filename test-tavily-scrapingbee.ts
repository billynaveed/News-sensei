/**
 * Test Tavily enrichment + ScrapingBee paywalled article fetching
 */
import { enrichLeadWithWebSearch } from "./server/scanner";
import { fetchFromScrapingBee } from "./server/adapters";

const DIVIDER = "=".repeat(60);

async function testTavilyEnrichment() {
  console.log(DIVIDER);
  console.log("TEST 1: Tavily Enrichment — Real Singapore Company");
  console.log(DIVIDER);

  const result = await enrichLeadWithWebSearch(
    ["Grab Holdings"],
    ["Anthony Tan"],
    "Singapore"
  );

  console.log("\nResults:");
  console.log("  LinkedIn URL:", result.founderLinkedInUrl || "NOT FOUND");
  console.log("  Founder Bio:", result.founderBio ? result.founderBio.substring(0, 200) + "..." : "NOT FOUND");
  console.log("  Company Desc:", result.companyDescription ? result.companyDescription.substring(0, 200) + "..." : "NOT FOUND");
  console.log("  Confidence:", result.confidenceScore);
  console.log("  Enrichment keys:", Object.keys(result.enrichmentData || {}));

  return result;
}

async function testTavilyEnrichment2() {
  console.log("\n" + DIVIDER);
  console.log("TEST 2: Tavily Enrichment — HK Tech Unicorn");
  console.log(DIVIDER);

  const result = await enrichLeadWithWebSearch(
    ["Lalamove"],
    ["Shing Chow"],
    "Hong Kong"
  );

  console.log("\nResults:");
  console.log("  LinkedIn URL:", result.founderLinkedInUrl || "NOT FOUND");
  console.log("  Founder Bio:", result.founderBio ? result.founderBio.substring(0, 200) + "..." : "NOT FOUND");
  console.log("  Company Desc:", result.companyDescription ? result.companyDescription.substring(0, 200) + "..." : "NOT FOUND");
  console.log("  Confidence:", result.confidenceScore);

  return result;
}

async function testTavilyEnrichment3() {
  console.log("\n" + DIVIDER);
  console.log("TEST 3: Tavily Enrichment — Indonesian Startup");
  console.log(DIVIDER);

  const result = await enrichLeadWithWebSearch(
    ["GoTo Group"],
    ["Andre Soelistyo"],
    "Indonesia"
  );

  console.log("\nResults:");
  console.log("  LinkedIn URL:", result.founderLinkedInUrl || "NOT FOUND");
  console.log("  Founder Bio:", result.founderBio ? result.founderBio.substring(0, 200) + "..." : "NOT FOUND");
  console.log("  Company Desc:", result.companyDescription ? result.companyDescription.substring(0, 200) + "..." : "NOT FOUND");
  console.log("  Confidence:", result.confidenceScore);

  return result;
}

async function testScrapingBeePaywall() {
  console.log("\n" + DIVIDER);
  console.log("TEST 4: ScrapingBee — Bloomberg (paywalled)");
  console.log(DIVIDER);

  // Bloomberg is heavily paywalled
  const source = {
    id: 999,
    name: "Bloomberg Test",
    type: "website" as const,
    url: "https://www.bloomberg.com/news/articles/2025-01-15/singapore-wealth-boom-draws-more-family-offices",
    enabled: true,
    tier: "tier1" as const,
    lastFetchedAt: null,
    createdAt: new Date(),
  };

  const result = await fetchFromScrapingBee(source, {
    extractRules: JSON.stringify({
      headline: "h1",
      body: "article",
    }),
  });

  console.log("\nResults:");
  console.log("  Articles found:", result.articles.length);
  console.log("  Errors:", result.errors.length ? result.errors : "None");
  if (result.articles.length > 0) {
    const a = result.articles[0];
    console.log("  Headline:", a.headline?.substring(0, 100));
    console.log("  Content length:", a.content?.length || 0, "chars");
    console.log("  Content preview:", a.content?.substring(0, 200));
  }
  console.log("  Debug:", JSON.stringify(result.debugEntry, null, 2).substring(0, 500));

  return result;
}

async function testScrapingBeeFT() {
  console.log("\n" + DIVIDER);
  console.log("TEST 5: ScrapingBee — Financial Times (paywalled)");
  console.log(DIVIDER);

  const source = {
    id: 998,
    name: "FT Test",
    type: "website" as const,
    url: "https://www.ft.com/content/singapore-private-banking",
    enabled: true,
    tier: "tier1" as const,
    lastFetchedAt: null,
    createdAt: new Date(),
  };

  const result = await fetchFromScrapingBee(source, {
    extractRules: JSON.stringify({
      headline: "h1",
      body: "article",
    }),
  });

  console.log("\nResults:");
  console.log("  Articles found:", result.articles.length);
  console.log("  Errors:", result.errors.length ? result.errors : "None");
  if (result.articles.length > 0) {
    console.log("  Content length:", result.articles[0].content?.length || 0, "chars");
    console.log("  Content preview:", result.articles[0].content?.substring(0, 200));
  }

  return result;
}

async function main() {
  console.log("🧪 News-Sensei: Tavily + ScrapingBee Integration Tests");
  console.log("Tavily key:", process.env.TAVILY_API_KEY ? "✅ SET" : "❌ MISSING");
  console.log("ScrapingBee key:", process.env.SCRAPINGBEE_API_KEY ? "✅ SET" : "❌ MISSING");
  console.log();

  const results: Record<string, string> = {};

  // Tavily tests
  try {
    const r1 = await testTavilyEnrichment();
    results["Tavily: Grab/Anthony Tan"] = r1.founderBio ? "✅ ENRICHED" : "⚠️ PARTIAL";
  } catch (e: any) {
    console.error("  ❌ FAILED:", e.message);
    results["Tavily: Grab/Anthony Tan"] = "❌ FAILED";
  }

  try {
    const r2 = await testTavilyEnrichment2();
    results["Tavily: Lalamove/Shing Chow"] = r2.founderBio ? "✅ ENRICHED" : "⚠️ PARTIAL";
  } catch (e: any) {
    console.error("  ❌ FAILED:", e.message);
    results["Tavily: Lalamove/Shing Chow"] = "❌ FAILED";
  }

  try {
    const r3 = await testTavilyEnrichment3();
    results["Tavily: GoTo/Andre Soelistyo"] = r3.founderBio ? "✅ ENRICHED" : "⚠️ PARTIAL";
  } catch (e: any) {
    console.error("  ❌ FAILED:", e.message);
    results["Tavily: GoTo/Andre Soelistyo"] = "❌ FAILED";
  }

  // ScrapingBee tests
  try {
    const r4 = await testScrapingBeePaywall();
    results["ScrapingBee: Bloomberg"] = r4.articles.length > 0 ? "✅ FETCHED" : "⚠️ NO ARTICLES";
  } catch (e: any) {
    console.error("  ❌ FAILED:", e.message);
    results["ScrapingBee: Bloomberg"] = "❌ FAILED";
  }

  try {
    const r5 = await testScrapingBeeFT();
    results["ScrapingBee: FT"] = r5.articles.length > 0 ? "✅ FETCHED" : "⚠️ NO ARTICLES";
  } catch (e: any) {
    console.error("  ❌ FAILED:", e.message);
    results["ScrapingBee: FT"] = "❌ FAILED";
  }

  // Summary
  console.log("\n" + DIVIDER);
  console.log("📊 SUMMARY");
  console.log(DIVIDER);
  for (const [test, result] of Object.entries(results)) {
    console.log(`  ${result}  ${test}`);
  }
}

main().catch(console.error);
