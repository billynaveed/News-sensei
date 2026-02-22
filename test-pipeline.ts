#!/usr/bin/env node

/**
 * Comprehensive News-sensei Pipeline Test
 * 
 * Tests the full pipeline with synthetic test articles:
 * 1. Database connection and settings
 * 2. extractLeadInfo function with various scenarios
 * 3. Regional and keyword filtering
 * 4. Lead enrichment 
 * 5. Save flow verification
 * 6. Comprehensive logging and PASS/FAIL reporting
 */

// Load environment variables first!
import { config } from "dotenv";
config();

// Ensure env vars are loaded before importing any server modules
if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL not found in environment variables");
  console.log("Available env vars:", Object.keys(process.env).filter(k => k.includes('DATABASE')));
  process.exit(1);
}

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./shared/schema";
import { eq } from "drizzle-orm";
import type { RawArticle } from "./server/adapters";
import type { InsertLead } from "./shared/schema";

// Import the functions we need to test (after env vars are loaded)
let passesInterestFilter: any, extractPrimaryCompany: any, isPublicCompany: any, checkDuplication: any, enrichLeadWithWebSearch: any;
let scannerEnrichment: any, storage: any;

// Dynamic imports to avoid premature db initialization
async function loadServerModules() {
  const pipelineStages = await import("./server/pipeline-stages");
  const scanner = await import("./server/scanner");
  const storageModule = await import("./server/storage");
  
  passesInterestFilter = pipelineStages.passesInterestFilter;
  extractPrimaryCompany = pipelineStages.extractPrimaryCompany;
  isPublicCompany = pipelineStages.isPublicCompany;
  checkDuplication = pipelineStages.checkDuplication;
  enrichLeadWithWebSearch = pipelineStages.enrichLeadWithWebSearch;
  
  scannerEnrichment = scanner.enrichLeadWithWebSearch;
  storage = storageModule.storage;
}

// Database setup
const { Pool } = pg;
const DATABASE_URL = "postgresql://newsuser:newspass123@localhost:5432/newssensei";
const pool = new Pool({ connectionString: DATABASE_URL });
const db = drizzle(pool, { schema });

// Test results tracking
interface TestResult {
  name: string;
  passed: boolean;
  details: string;
  error?: string;
}

const testResults: TestResult[] = [];

// Logging utility
function log(message: string, level: 'INFO' | 'SUCCESS' | 'ERROR' | 'WARN' = 'INFO') {
  const timestamp = new Date().toISOString();
  const prefix = level === 'SUCCESS' ? '✅' : level === 'ERROR' ? '❌' : level === 'WARN' ? '⚠️' : 'ℹ️';
  console.log(`${timestamp} ${prefix} ${message}`);
}

// Test synthetic articles with different scenarios
const testArticles: Array<{name: string, article: RawArticle, shouldPass: boolean, expectedRegion?: string}> = [
  {
    name: "Singapore IPO - Should PASS",
    shouldPass: true,
    expectedRegion: "Singapore",
    article: {
      headline: "TechCorp Singapore Announces $50M IPO on Singapore Exchange",
      content: "TechCorp Singapore, a leading fintech startup founded by CEO Jennifer Lim, announced its initial public offering valued at $50 million on the Singapore Exchange. The company specializes in digital banking solutions across Southeast Asia. Jennifer Lim, who previously worked at DBS Bank, said the IPO proceeds will fund expansion into Indonesia and Vietnam.",
      url: "https://example.com/techcorp-singapore-ipo",
      publishedAt: new Date('2024-02-14T10:00:00Z'),
      source: "Business Times Singapore",
      sourceTier: "tier1" as const,
      region: "Singapore",
      fetchMethod: "rss" as const
    }
  },
  {
    name: "Hong Kong M&A - Should PASS", 
    shouldPass: true,
    expectedRegion: "Hong Kong",
    article: {
      headline: "DataFlow HK Acquired by Global Ventures in $25M Deal",
      content: "Hong Kong-based DataFlow HK, founded by Michael Chen, has been acquired by Global Ventures in a strategic merger valued at $25 million. The company provides AI-powered analytics solutions for financial institutions in Greater China. Founder Michael Chen, who started the company in 2018, will stay on as CTO.",
      url: "https://example.com/dataflow-hk-acquisition",
      publishedAt: new Date('2024-02-14T11:00:00Z'),
      source: "Reuters",
      sourceTier: "tier2" as const,
      region: "Hong Kong",
      fetchMethod: "google_news" as const
    }
  },
  {
    name: "US-only tech company - Should FAIL",
    shouldPass: false,
    article: {
      headline: "Silicon Valley Startup CloudTech Raises $30M Series B",
      content: "San Francisco-based CloudTech, led by CEO Sarah Johnson, secured $30 million in Series B funding from Sequoia Capital. The cloud infrastructure company plans to expand across the United States and Europe. All operations remain in California and New York.",
      url: "https://example.com/cloudtech-series-b",
      publishedAt: new Date('2024-02-14T12:00:00Z'),
      source: "TechCrunch",
      sourceTier: "tier2" as const,
      region: "US",
      fetchMethod: "rss" as const
    }
  },
  {
    name: "UK founder with no Asia connection - Should FAIL",
    shouldPass: false,
    article: {
      headline: "London Fintech StartupPay Secures Series A Funding",
      content: "London-based StartupPay, founded by James Wilson, raised $15 million in Series A from UK venture capitalists. The company focuses exclusively on European payment solutions and has offices in London and Berlin.",
      url: "https://example.com/startuppay-series-a",
      publishedAt: new Date('2024-02-14T13:00:00Z'),
      source: "Financial Times",
      sourceTier: "tier1" as const,
      region: "UK",
      fetchMethod: "google_news" as const
    }
  },
  {
    name: "Vietnam startup Series D - Should PASS",
    shouldPass: true,
    expectedRegion: "Vietnam",
    article: {
      headline: "VietTech Raises $40M Series D to Expand Regional Operations",
      content: "Ho Chi Minh City-based VietTech, co-founded by CEO Nguyen Van Duc and CTO Tran Thi Mai, closed a $40 million Series D round led by regional investors to accelerate growth across Southeast Asia. The e-commerce logistics company has 2,000 employees across Vietnam and is profitable.",
      url: "https://example.com/viettech-series-d",
      publishedAt: new Date('2024-02-14T14:00:00Z'),
      source: "DealStreetAsia",
      sourceTier: "tier3" as const,
      region: "Vietnam",
      fetchMethod: "rss" as const
    }
  },
  {
    name: "Global company with Singapore subsidiary - Should PASS",
    shouldPass: true,
    expectedRegion: "Singapore",
    article: {
      headline: "GlobalCorp Establishes Singapore Hub, Appoints Regional Director",
      content: "International technology giant GlobalCorp has established its Singapore regional headquarters, appointing former Goldman Sachs executive Lisa Tan as Regional Director for Southeast Asia operations. The move signals GlobalCorp's commitment to the APAC market with initial investment of $100M in Singapore.",
      url: "https://example.com/globalcorp-singapore-hub",
      publishedAt: new Date('2024-02-14T15:00:00Z'),
      source: "Straits Times",
      sourceTier: "tier1" as const,
      region: "Singapore",
      fetchMethod: "scrapingbee" as const
    }
  },
  {
    name: "Article with no company names - Should FAIL",
    shouldPass: false,
    article: {
      headline: "Industry Trends: Fintech Growth in Asia",
      content: "The fintech sector continues to see strong growth across Asian markets, driven by digital adoption and regulatory support. Several unnamed startups are expected to announce funding rounds. Market analysts predict continued momentum through 2025.",
      url: "https://example.com/fintech-trends-asia",
      publishedAt: new Date('2024-02-14T16:00:00Z'),
      source: "Asian Financial Weekly",
      sourceTier: "tier3" as const,
      region: "Asia",
      fetchMethod: "rss" as const
    }
  }
];

async function testDatabaseConnection(): Promise<TestResult> {
  log("Testing database connection...");
  
  try {
    // Test basic connection using raw query
    const client = await pool.connect();
    const result = await client.query('SELECT 1 as test');
    client.release();
    
    log("Database connection successful");
    
    return {
      name: "Database Connection",
      passed: true,
      details: "Successfully connected to PostgreSQL database"
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Database connection failed: ${errorMsg}`, 'ERROR');
    
    return {
      name: "Database Connection", 
      passed: false,
      details: "Failed to connect to database",
      error: errorMsg
    };
  }
}

async function testSettingsRetrieval(): Promise<TestResult> {
  log("Testing settings retrieval...");
  
  try {
    const settings = await storage.getSettings();
    
    if (!settings) {
      throw new Error("No settings found in database");
    }
    
    log(`Settings found - Regions: ${settings.regions?.join(', ') || 'none'}`);
    log(`Keywords: ${settings.keywords?.join(', ') || 'none'}`);
    log(`Summary length: ${settings.summaryLength || 'default'}`);
    
    return {
      name: "Settings Retrieval",
      passed: true,
      details: `Regions: ${settings.regions?.length || 0}, Keywords: ${settings.keywords?.length || 0}`
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Settings retrieval failed: ${errorMsg}`, 'ERROR');
    
    return {
      name: "Settings Retrieval",
      passed: false,
      details: "Failed to retrieve settings from database",
      error: errorMsg
    };
  }
}

async function testPipelineStages(settings: any): Promise<TestResult[]> {
  log("Testing individual pipeline stages with synthetic articles...");
  const results: TestResult[] = [];
  
  for (const testCase of testArticles) {
    log(`\n--- Testing: ${testCase.name} ---`);
    
    try {
      // Stage 1: Interest Filter
      log(`🔍 Stage 1: Interest Filter`);
      const filterPrompt = settings.interestFilterPrompt || "Determine if this article is about a wealth event, liquidity event, IPO, M&A, or significant funding round relevant to private banking.";
      const interestResult = await passesInterestFilter(
        testCase.article,
        filterPrompt,
        settings.regions || []
      );
      
      log(`   Interest Filter Result: ${interestResult.passes ? 'PASS' : 'FAIL'}`);
      log(`   Reason: ${interestResult.reason}`);
      log(`   Confidence: ${interestResult.confidenceScore}`);
      
      if (!interestResult.passes) {
        if (testCase.shouldPass) {
          log(`❌ Expected to pass interest filter but failed`, 'ERROR');
          results.push({
            name: `Pipeline Stages - ${testCase.name}`,
            passed: false,
            details: `Failed interest filter: ${interestResult.reason}`
          });
        } else {
          log(`✅ Correctly filtered out at interest stage`, 'SUCCESS');
          results.push({
            name: `Pipeline Stages - ${testCase.name}`,
            passed: true,
            details: `Correctly filtered out: ${interestResult.reason}`
          });
        }
        continue;
      }
      
      // Stage 2: Company Extraction
      log(`🏢 Stage 2: Company Extraction`);
      const companyResult = await extractPrimaryCompany(testCase.article);
      
      log(`   Primary Company: ${companyResult.companyName || 'none found'}`);
      log(`   Confidence: ${companyResult.confidenceScore}`);
      
      if (!companyResult.companyName) {
        if (testCase.shouldPass) {
          log(`❌ Expected to extract company but none found`, 'ERROR');
          results.push({
            name: `Pipeline Stages - ${testCase.name}`,
            passed: false,
            details: "No company extracted"
          });
        } else {
          log(`✅ Correctly found no companies`, 'SUCCESS');
          results.push({
            name: `Pipeline Stages - ${testCase.name}`,
            passed: true,
            details: "Correctly found no companies as expected"
          });
        }
        continue;
      }
      
      // Stage 3: Public Company Check
      log(`📊 Stage 3: Public Company Check`);
      const publicResult = await isPublicCompany(companyResult.companyName, testCase.article.headline);
      
      log(`   Is Public: ${publicResult.isPublic ? 'YES' : 'NO'}`);
      log(`   Reason: ${publicResult.reason}`);
      log(`   Confidence: ${publicResult.confidenceScore}`);
      
      // Stage 4: Duplication Check
      log(`🔄 Stage 4: Duplication Check`);
      const dupResult = await checkDuplication(
        testCase.article.headline,
        testCase.article.url,
        companyResult.companyName
      );
      
      log(`   Is Duplicate: ${dupResult.isDuplicate ? 'YES' : 'NO'}`);
      log(`   Is Update: ${dupResult.isUpdate ? 'YES' : 'NO'}`);
      log(`   Reason: ${dupResult.reason}`);
      
      // Determine if the pipeline would accept this lead
      const pipelineWouldAccept = interestResult.passes && 
                                  companyResult.companyName && 
                                  !dupResult.isDuplicate;
      
      // Validate expectations
      if (testCase.shouldPass) {
        if (pipelineWouldAccept) {
          log(`✅ Pipeline would accept this lead`, 'SUCCESS');
          results.push({
            name: `Pipeline Stages - ${testCase.name}`,
            passed: true,
            details: `Pipeline accepts: company=${companyResult.companyName}, public=${publicResult.isPublic}`
          });
        } else {
          log(`❌ Pipeline rejected lead that should pass`, 'ERROR');
          results.push({
            name: `Pipeline Stages - ${testCase.name}`,
            passed: false,
            details: `Pipeline rejected: interest=${interestResult.passes}, company=${!!companyResult.companyName}, duplicate=${dupResult.isDuplicate}`
          });
        }
      } else {
        if (!pipelineWouldAccept) {
          log(`✅ Pipeline correctly rejected lead`, 'SUCCESS');
          results.push({
            name: `Pipeline Stages - ${testCase.name}`,
            passed: true,
            details: `Pipeline correctly rejected lead`
          });
        } else {
          log(`❌ Pipeline accepted lead that should be rejected`, 'ERROR');
          results.push({
            name: `Pipeline Stages - ${testCase.name}`,
            passed: false,
            details: `Pipeline incorrectly accepted lead`
          });
        }
      }
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`❌ Error processing ${testCase.name}: ${errorMsg}`, 'ERROR');
      results.push({
        name: `Pipeline Stages - ${testCase.name}`,
        passed: false,
        details: "Error during pipeline processing",
        error: errorMsg
      });
    }
  }
  
  return results;
}

async function testEnrichment(): Promise<TestResult> {
  log("\nTesting enrichLeadWithWebSearch function...");
  
  try {
    const testCompanies = ["TechCorp Singapore"];
    const testFounders = ["Jennifer Lim"];
    const testRegion = "Singapore";
    
    log(`Enriching lead: Companies: ${testCompanies.join(', ')}, Founders: ${testFounders.join(', ')}, Region: ${testRegion}`);
    
    const enrichmentResult = await scannerEnrichment(testCompanies, testFounders, testRegion);
    
    log(`Enrichment completed:`);
    log(`   Founder LinkedIn: ${enrichmentResult.founderLinkedInUrl || 'not found'}`);
    log(`   Founder Bio: ${enrichmentResult.founderBio?.substring(0, 100) || 'none'}...`);
    log(`   Company Description: ${enrichmentResult.companyDescription?.substring(0, 100) || 'none'}...`);
    log(`   Company LinkedIn: ${enrichmentResult.companyLinkedInUrl || 'not found'}`);
    
    // Consider it successful if we got some enrichment data
    const hasEnrichmentData = !!(
      enrichmentResult.founderLinkedInUrl ||
      enrichmentResult.founderBio ||
      enrichmentResult.companyDescription ||
      enrichmentResult.companyLinkedInUrl
    );
    
    return {
      name: "Lead Enrichment",
      passed: hasEnrichmentData,
      details: `Enrichment ${hasEnrichmentData ? 'successful' : 'returned no data'}`
    };
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Enrichment failed: ${errorMsg}`, 'ERROR');
    
    return {
      name: "Lead Enrichment",
      passed: false,
      details: "Error during enrichment",
      error: errorMsg
    };
  }
}

async function testSaveFlow(settings: any): Promise<TestResult> {
  log("\nTesting save flow...");
  
  try {
    // Create a test lead
    const testLead: InsertLead = {
      headline: "Test Lead for Pipeline Testing",
      sourceUrl: "https://test.example.com/test-article",
      sourceName: "Test Source",
      sourceTier: "tier2",
      publishedAt: new Date(),
      companyNames: ["Test Company"],
      founderNames: ["Test Founder"],
      investors: ["Test VC"],
      aiSummary: "This is a test lead created by the pipeline test script.",
      matchedKeywords: ["startup", "funding"],
      priorityScore: 75,
      priorityLevel: "medium",
      region: "Singapore"
    };
    
    log(`Creating test lead: ${testLead.headline}`);
    
    // Save the lead using storage
    const savedLead = await storage.createLead(testLead);
    log(`✅ Lead created with ID: ${savedLead.id}`);
    
    // Verify it exists in the database
    const retrievedLead = await storage.getLeadById(savedLead.id);
    
    if (retrievedLead && retrievedLead.headline === testLead.headline) {
      log(`✅ Lead successfully retrieved from database`, 'SUCCESS');
      
      // Now test saving to saved_leads table
      const savedLeadEntry = {
        leadId: savedLead.id,
        savedAt: new Date(),
        notes: "Test lead saved by pipeline test"
      };
      
      // Use direct database insertion for saved_leads
      const insertedSavedLead = await db.insert(schema.savedLeads).values(savedLeadEntry).returning();
      
      if (insertedSavedLead && insertedSavedLead.length > 0) {
        log(`✅ Lead successfully saved to saved_leads table`, 'SUCCESS');
        
        // Clean up - delete the test entries
        await db.delete(schema.savedLeads).where(eq(schema.savedLeads.leadId, savedLead.id));
        await db.delete(schema.leads).where(eq(schema.leads.id, savedLead.id));
        log(`🧹 Cleaned up test data`);
        
        return {
          name: "Save Flow",
          passed: true,
          details: "Successfully created, retrieved, and saved lead to saved_leads table"
        };
      } else {
        return {
          name: "Save Flow",
          passed: false,
          details: "Failed to save to saved_leads table"
        };
      }
    } else {
      return {
        name: "Save Flow",
        passed: false,
        details: "Failed to retrieve saved lead from database"
      };
    }
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Save flow failed: ${errorMsg}`, 'ERROR');
    
    return {
      name: "Save Flow",
      passed: false,
      details: "Error during save flow test",
      error: errorMsg
    };
  }
}

async function runAllTests() {
  log("🚀 Starting News-sensei Pipeline Comprehensive Test", 'INFO');
  log(repeat("=", 60));
  
  // Load server modules first
  log("Loading server modules...");
  await loadServerModules();
  log("Server modules loaded successfully");
  
  // Test 1: Database Connection
  const dbTest = await testDatabaseConnection();
  testResults.push(dbTest);
  
  if (!dbTest.passed) {
    log("❌ Database connection failed. Cannot continue with other tests.", 'ERROR');
    await printSummary();
    return;
  }
  
  // Test 2: Settings Retrieval
  const settingsTest = await testSettingsRetrieval();
  testResults.push(settingsTest);
  
  let settings: any = {};
  if (settingsTest.passed) {
    settings = await storage.getSettings();
  } else {
    // Use default settings for testing
    settings = {
      regions: ["Singapore", "Hong Kong", "Malaysia", "Thailand", "Vietnam", "Indonesia", "Philippines"],
      keywords: ["startup", "funding", "series", "ipo", "acquisition", "merger", "venture", "investment"],
      summaryLength: "brief"
    };
    log("Using default test settings", 'WARN');
  }
  
  // Test 3: Pipeline stages with various scenarios
  const pipelineTests = await testPipelineStages(settings);
  testResults.push(...pipelineTests);
  
  // Test 4: Enrichment
  const enrichmentTest = await testEnrichment();
  testResults.push(enrichmentTest);
  
  // Test 5: Save Flow
  const saveTest = await testSaveFlow(settings);
  testResults.push(saveTest);
  
  // Final summary
  await printSummary();
}

async function printSummary() {
  log("\n" + "=" * 60);
  log("📊 TEST SUMMARY", 'INFO');
  log("=" * 60);
  
  const totalTests = testResults.length;
  const passedTests = testResults.filter(r => r.passed).length;
  const failedTests = totalTests - passedTests;
  
  log(`Total Tests: ${totalTests}`);
  log(`Passed: ${passedTests} ✅`);
  log(`Failed: ${failedTests} ❌`);
  
  if (failedTests > 0) {
    log("\nFAILED TESTS:", 'ERROR');
    testResults.filter(r => !r.passed).forEach(test => {
      log(`❌ ${test.name}: ${test.details}${test.error ? ` (${test.error})` : ''}`, 'ERROR');
    });
  }
  
  if (passedTests > 0) {
    log("\nPASSED TESTS:", 'SUCCESS');
    testResults.filter(r => r.passed).forEach(test => {
      log(`✅ ${test.name}: ${test.details}`, 'SUCCESS');
    });
  }
  
  log("\n" + "=" * 60);
  if (failedTests === 0) {
    log("🎉 ALL TESTS PASSED!", 'SUCCESS');
  } else {
    log(`❌ ${failedTests} TESTS FAILED`, 'ERROR');
  }
  log("=" * 60);
  
  // Close database connection
  await pool.end();
}

// Helper function to repeat strings
function repeat(str: string, times: number): string {
  return new Array(times + 1).join(str);
}

// Use the repeat function instead of * operator for strings
const log_separator = repeat("=", 60);

// Run the tests
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().catch(error => {
    console.error("Fatal error running tests:", error);
    process.exit(1);
  });
}