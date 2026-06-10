import OpenAI from "openai";
import { storage } from "./storage";
import { sendLeadAlertEmail } from "./sendgrid";
import { sendLeadAlertTelegram } from "./telegram";
import { fetchAllArticles, type RawArticle, type RssFeedWithMeta } from "./adapters";
import { stripJsonFences } from "./json-utils";
import { enrichSavedLead, formatEnrichmentForSavedLead } from "./founder-enrichment";
import { passesInterestFilter, extractPrimaryCompany, isPublicCompany, checkDuplication } from "./pipeline-stages";
import { validateSeaAnchor } from "./sea-guard";
import { log } from "./log";
import type { InsertLead, PriorityLevel, SourceTier, FetchMethod, SourceSearched, ArticleProcessed, ScrapingBeeDebugEntry } from "@shared/schema";

const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY;

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

async function extractLeadInfo(article: RawArticle, keywords: string[], summaryLength: string, targetRegions: string[]): Promise<Partial<InsertLead> | null> {
  const summaryPrompt = summaryLength === "brief"
    ? "Write a 1-2 sentence summary."
    : summaryLength === "detailed"
    ? "Write a detailed paragraph summary."
    : "Write a summary with actionable recommendations for a private banker.";

  const regionsStr = targetRegions.join(", ");

  const prompt = `Analyze this news article and extract wealth-related lead information for a private banker.

IMPORTANT: Only extract leads if the article is relevant to these regions: ${regionsStr}
- The article must be about companies, founders, or wealth events in ${regionsStr}
- If the article is only about other regions (e.g., UK, US, Europe) with no connection to ${regionsStr}, return null
- If a global company is mentioned but the article has no specific relevance to ${regionsStr}, return null

Article:
Headline: ${article.headline}
Source: ${article.source}
Content: ${article.content}

If the article is NOT relevant to ${regionsStr}, return: {"relevant": false}

If the article IS relevant to ${regionsStr}, extract and return a JSON object with:
1. "relevant": true
2. "companyNames": array of company names mentioned
3. "founderNames": array of founder/key person names mentioned
4. "investors": array of investors mentioned (if any)
5. "summary": ${summaryPrompt}
6. "matchedKeywords": array of these keywords that match: ${keywords.join(", ")}
7. "priorityScore": number 1-100 based on wealth potential (consider deal size, founder liquidity, timing)
8. "priorityLevel": "high" (score 70+), "medium" (score 40-69), or "low" (score below 40)

Return only valid JSON, no markdown.`;

  try {
    const response = await openai.chat.completions.create({
      model: "google/gemini-2.5-flash-lite",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 1024,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    const extracted = JSON.parse(stripJsonFences(content));

    // Check if AI determined article is not relevant to target regions
    if (extracted.relevant === false) {
      return null;
    }

    return {
      headline: article.headline,
      sourceUrl: article.url,
      sourceName: article.source,
      sourceTier: article.sourceTier,
      publishedAt: article.publishedAt,
      companyNames: extracted.companyNames || [],
      founderNames: extracted.founderNames || [],
      investors: extracted.investors || [],
      aiSummary: extracted.summary || "",
      matchedKeywords: extracted.matchedKeywords || [],
      priorityScore: extracted.priorityScore || 50,
      priorityLevel: extracted.priorityLevel || "medium",
      region: article.region,
      status: "new",
      fetchMethod: article.fetchMethod,
    };
  } catch (error) {
    console.error("Error extracting lead info:", error);
    return null;
  }
}

// ============================================================================
// Pipeline Stages 1-4 (imported from pipeline-stages.ts)
// ============================================================================
// Re-export for any consumers that import from scanner.ts
export {
  passesInterestFilter,
  extractPrimaryCompany,
  isPublicCompany,
  checkDuplication,
  type InterestFilterResult,
  type CompanyExtractionResult,
  type PublicCompanyCheckResult,
  type DuplicationCheckResult,
} from "./pipeline-stages";

// ============================================================================
// Pipeline Stage Result Types (Stages 5-7, defined locally)
// ============================================================================

/** Stage 5 result: full article content fetched via premium extraction */
export interface FullArticleContentResult {
  fullContent: string;
  fetchMethod: string;
  contentLength: number;
}

/** Stage 6 result: deep analysis output with financial details */
export interface DeepAnalysisResult {
  leadData: Partial<InsertLead>;
  keyFinancials: {
    fundingAmount: string | null;
    valuation: string | null;
    dealValue: string | null;
  };
  wealthAngle: string;
  confidenceScore: number;
  seaConnection: string | null;
}

/** Stage 7 result: enrichment metadata from web search */
export interface EnrichmentResult {
  founderLinkedInUrl: string | null;
  founderBio: string | null;
  companyDescription: string | null;
  enrichmentData: Record<string, unknown>;
  confidenceScore: number;
}

/** Unified audit log entry for pipeline decision tracking */
interface PipelineAuditEntry {
  stage: number;
  stageName: string;
  articleHeadline: string;
  decision: string;
  reason: string;
  confidenceScore: number;
  durationMs: number;
}

/**
 * Logs a pipeline stage decision for audit purposes.
 * Each stage call is recorded with its decision, reasoning, and timing.
 */
function logPipelineDecision(entry: PipelineAuditEntry): void {
  log(
    `[Pipeline S${entry.stage}] ${entry.stageName}: ${entry.decision} ` +
    `(confidence: ${entry.confidenceScore}%) - ${entry.reason} ` +
    `[${entry.durationMs}ms] "${entry.articleHeadline.slice(0, 60)}"`,
    "pipeline"
  );
}

// ============================================================================
// Stage 5: Full Article Content Fetch
// ============================================================================

/**
 * Fetches full article content for deeper analysis. For Tier 1 sources with
 * ScrapingBee available, uses premium extraction to bypass paywalls.
 * For other tiers, returns the existing snippet content.
 *
 * @param article - The raw article with URL and existing content
 * @param sourceTier - The source tier determining fetch strategy
 * @returns Full article content and the method used to fetch it
 *
 * @example
 * const result = await fetchFullArticleContent(article, "tier1");
 * if (result.fetchMethod === "scrapingbee_premium") {
 *   console.log("Premium content fetched:", result.contentLength, "chars");
 * }
 */
export async function fetchFullArticleContent(
  article: RawArticle,
  sourceTier: SourceTier
): Promise<FullArticleContentResult> {
  const startTime = Date.now();

  // For Tier 1 sources, use premium ScrapingBee if available
  if (sourceTier === "tier1" && SCRAPINGBEE_API_KEY) {
    try {
      const params = new URLSearchParams({
        api_key: SCRAPINGBEE_API_KEY,
        url: article.url,
        render_js: "true",
        premium_proxy: "true",
        block_resources: "false",
        extract_rules: JSON.stringify({
          article_text: {
            selector: "article, .article-body, .story-body, main, .content-body, .article-content",
            type: "item",
            output: "text",
          },
        }),
      });

      const response = await fetch(`https://app.scrapingbee.com/api/v1?${params.toString()}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        log(
          `[Pipeline S5] ScrapingBee premium failed (${response.status}), falling back to existing content`,
          "pipeline"
        );
        return buildFallbackResult(article, startTime);
      }

      const data = await response.json();
      const fullContent: string = data.article_text || "";

      if (fullContent.length > article.content.length) {
        const result: FullArticleContentResult = {
          fullContent,
          fetchMethod: "scrapingbee_premium",
          contentLength: fullContent.length,
        };

        logPipelineDecision({
          stage: 5,
          stageName: "Full Article Fetch",
          articleHeadline: article.headline,
          decision: "PREMIUM FETCH",
          reason: `Fetched ${fullContent.length} chars via ScrapingBee premium`,
          confidenceScore: 95,
          durationMs: Date.now() - startTime,
        });

        return result;
      }

      // Premium fetch returned less content than snippet; use existing
      return buildFallbackResult(article, startTime);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      log(`[Pipeline S5] Premium fetch error: ${errorMessage}, using existing content`, "pipeline");
      return buildFallbackResult(article, startTime);
    }
  }

  // For non-Tier 1 sources or when ScrapingBee is unavailable
  return buildFallbackResult(article, startTime);
}

/**
 * Builds a fallback result using the article's existing content.
 */
function buildFallbackResult(article: RawArticle, startTime: number): FullArticleContentResult {
  logPipelineDecision({
    stage: 5,
    stageName: "Full Article Fetch",
    articleHeadline: article.headline,
    decision: "EXISTING CONTENT",
    reason: `Using existing ${article.content.length} chars (${article.fetchMethod})`,
    confidenceScore: 50,
    durationMs: Date.now() - startTime,
  });

  return {
    fullContent: article.content,
    fetchMethod: article.fetchMethod,
    contentLength: article.content.length,
  };
}

// ============================================================================
// Stage 6: Deep Article Analysis
// ============================================================================

/**
 * Performs comprehensive analysis of an article using full content, extracting
 * all relevant lead data including financial details and wealth angle assessment.
 *
 * @param article - The raw article metadata
 * @param fullContent - Complete article text (from Stage 5)
 * @param targetRegions - Geographic regions of interest
 * @returns Full lead data with financials and wealth angle, or null if irrelevant
 *
 * @example
 * const result = await deepAnalyzeArticle(article, fullContent, ["Singapore", "Indonesia"]);
 * if (result && result.leadData.priorityScore >= 70) {
 *   console.log("High-priority lead:", result.wealthAngle);
 * }
 */
export async function deepAnalyzeArticle(
  article: RawArticle,
  fullContent: string,
  targetRegions: string[]
): Promise<DeepAnalysisResult | null> {
  const startTime = Date.now();

  const prompt = `Perform deep analysis of this news article for private banking lead intelligence.

FULL ARTICLE:
Headline: ${article.headline}
Source: ${article.source}
Content: ${fullContent.slice(0, 6000)}

Target Regions (SEA / HK / Taiwan): ${targetRegions.join(", ")}

GEOGRAPHY RULE (strict, source-backed). A lead qualifies on geography ONLY if the
article itself contains evidence of one of these:
  1. company_hq           — company is headquartered in a Target Region
  2. founder_base         — a named founder currently lives / works in a Target Region
  3. founder_roots        — a named founder has credible roots in a Target Region
                            (born / raised / educated / family / previously based there)
  4. operational_centre   — company has a strong operational centre in a Target Region
                            (regional HQ, primary office, principal market with leadership presence)
  5. wealth_event         — the article explicitly concerns a wealth liquidity event
                            for a SEA / HK / Taiwan founder, family or private company

NOT ENOUGH (must NOT pass on these alone — record each one observed in
disqualifyingSignals so the deterministic guard can reject):
  - sea_publisher_only      → article is published by a SEA outlet (Tech in Asia,
                              Business Times, Straits Times, KrASIA, DealStreetAsia,
                              The Edge, e27, SCMP, CNA, etc) but the subject company
                              and founders are non-SEA
  - sea_investor_only       → company is non-SEA but an investor / backer / fund is
                              SEA-based (GIC, Temasek, Khazanah, EDBI, MUFG-SEA arm,
                              SEA family office, etc). Investor identity does NOT
                              establish target-region relevance.
  - vague_apac_expansion    → vague "expanding into Asia / APAC", "Asian customers",
                              "Asia growth strategy" with no concrete office, founder,
                              or HQ in a Target Region
  - sea_customers_only      → company sells to SEA customers but is not based there
  - sea_distribution_only   → distribution / partner network in SEA only

Mainland China is NOT in the Target Regions. Beijing, Shanghai, Shenzhen,
Guangzhou, Hangzhou-based companies do NOT qualify unless they have an
independent qualifying anchor in HK or Taiwan or another Target Region.

PRIORITY SCORING:
- 80-100 (HIGH): Clear liquidity event with a named individual. IPO filing,
  acquisition with disclosed price, Series D+ / late-stage raise >$100M, confirmed exit.
- 50-79 (MEDIUM): Likely liquidity event, details missing. IPO rumors, M&A talks,
  Series C, unicorn milestone with named founders.
- 20-49 (LOW): Tangential — possible future liquidity. Ignore Series A/B.
- 1-19 (REJECT): No liquidity event — general market/industry commentary, opinion.

INVESTOR/BACKER WEALTH EVENTS:
- A NAMED billionaire/UHNW investor or backer of a company in an M&A deal, IPO, or
  major raise is HIGH priority — treat the backer as a key person.
- Patterns: "[Name]-backed", "backed by [Name]", "[Name]'s [Company]", "investor [Name]".
- "Richard Li-backed bolttech" in a $200M M&A = score 70+ and EXTRACT Richard Li.
- SKIP institutional backers with no named individual (Temasek, GIC, sovereign funds).

WEALTH ANGLE QUALITY — the wealthAngle field is graded; aim for 10/10:
- 10/10: names a specific person + the liquidity event + the amount.
- 7/10: names a person + event, amount vague.
- 4/10: company event but no individual named.
- 1/10: generic, no person/event.
NEVER write "No identifiable individual" if any person (founder, exec, or named
backer) appears — name them.

WORKED EXAMPLE — "Richard Li-backed bolttech in talks to acquire MoneyHero for US$200M":
  founderNames ["Richard Li"], investors ["Richard Li"], dealValue "$200M",
  priorityScore 75, wealthAngle "Richard Li (billionaire backer of bolttech) positioned
  to realize returns from the reported US$200M MoneyHero acquisition."

Required structured output:
- hqLocation       : "City, Country" of the subject company HQ, or null if unclear.
- founderLocations : array of {"name": "...", "location": "City, Country | null"} for
                     each named founder. Use null when location is not stated.
- seaEvidenceType  : one of "company_hq" | "founder_base" | "founder_roots"
                     | "operational_centre" | "wealth_event" | "none"
- seaEvidenceText  : a quoted or paraphrased passage from the article (15+ chars)
                     that supports seaEvidenceType. MUST mention a specific Target
                     Region city or country. Use empty string if seaEvidenceType
                     is "none".
- disqualifyingSignals : array of strings drawn from the NOT ENOUGH list above
                         (e.g. ["sea_investor_only"]). Empty array if none apply.
- regionRelevance  : true ONLY if seaEvidenceType is not "none" AND
                     disqualifyingSignals would not by themselves be the sole
                     reason for relevance.

Extract and return JSON:
{
  "companyNames": ["array of all companies mentioned"],
  "primaryCompany": "the main company this article is about",
  "founderNames": ["founders, key people, AND named billionaire investors/backers with ACTUAL NAMES. Include people described as 'backers'/'investors'/'X-backed' even if not the founder, e.g. 'Richard Li-backed bolttech' -> include 'Richard Li'. Empty array if no names."],
  "investors": ["array of investors mentioned — include anyone described as backer, supporter, or financier"],
  "summary": "1-2 sentence summary of what happened",
  "keyFinancials": {
    "fundingAmount": "e.g. $50M or null",
    "valuation": "e.g. $500M or null",
    "dealValue": "for M&A or null"
  },
  "priorityScore": 1-100,
  "priorityLevel": "high/medium/low",
  "matchedIndicators": ["IPO", "Series B", "Exit", etc],
  "wealthAngle": "WHO specifically gains wealth and HOW MUCH. Name the person even if an investor/backer rather than founder (e.g. 'Richard Li (backer of bolttech) positioned to realize returns from the $200M deal'). Say 'No identifiable individual' ONLY if no person is named anywhere.",
  "confidenceScore": 0-100,
  "hqLocation": "City, Country or null",
  "founderLocations": [{"name": "Founder Name", "location": "City, Country or null"}],
  "seaEvidenceType": "company_hq | founder_base | founder_roots | operational_centre | wealth_event | none",
  "seaEvidenceText": "supporting passage from the article (or empty string if none)",
  "disqualifyingSignals": ["array of disqualifier strings, may be empty"],
  "seaConnection": "Specific SEA connection sentence or null",
  "regionRelevance": true/false
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "google/gemini-2.5-flash-lite",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 2000,
      temperature: 0.2,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      log("[Pipeline S6] No response from AI for deep analysis", "pipeline");
      return null;
    }

    const extracted = JSON.parse(stripJsonFences(content));

    // Reject if not relevant to target regions (LLM verdict)
    if (extracted.regionRelevance === false) {
      logPipelineDecision({
        stage: 6,
        stageName: "Deep Analysis",
        articleHeadline: article.headline,
        decision: "REJECTED",
        reason: "Not relevant to target regions",
        confidenceScore: extracted.confidenceScore ?? 0,
        durationMs: Date.now() - startTime,
      });
      return null;
    }

    // Deterministic SEA-anchor guard: even if the LLM said regionRelevance=true,
    // verify structured evidence cannot rest on disqualifying signals (SEA
    // publisher / SEA investor / vague APAC expansion alone). This is the
    // hard backstop for the recurring problem where a SEA source/publisher or
    // SEA-based backer caused non-SEA stories (Anthropic, Hillhouse, ByteDance)
    // to be mis-classified as SEA leads.
    const guard = validateSeaAnchor({
      hqLocation: extracted.hqLocation ?? null,
      founderLocations: extracted.founderLocations ?? null,
      seaEvidenceType: extracted.seaEvidenceType ?? "none",
      seaEvidenceText: extracted.seaEvidenceText ?? extracted.seaConnection ?? "",
      disqualifyingSignals: extracted.disqualifyingSignals ?? null,
      llmRegionRelevance: extracted.regionRelevance ?? null,
    });
    if (!guard.passes) {
      logPipelineDecision({
        stage: 6,
        stageName: "Deep Analysis",
        articleHeadline: article.headline,
        decision: "REJECTED (SEA guard)",
        reason: `SEA anchor guard: ${guard.reason}`,
        confidenceScore: extracted.confidenceScore ?? 0,
        durationMs: Date.now() - startTime,
      });
      return null;
    }

    const priorityScore: number = extracted.priorityScore ?? 50;
    const priorityLevel: PriorityLevel =
      priorityScore >= 70 ? "high" : priorityScore >= 40 ? "medium" : "low";

    const leadData: Partial<InsertLead> = {
      headline: article.headline,
      sourceUrl: article.url,
      sourceName: article.source,
      sourceTier: article.sourceTier,
      publishedAt: article.publishedAt,
      companyNames: extracted.companyNames || [],
      founderNames: extracted.founderNames || [],
      investors: extracted.investors || [],
      aiSummary: extracted.summary || "",
      matchedKeywords: extracted.matchedIndicators || [],
      priorityScore,
      priorityLevel,
      region: article.region,
      status: "new",
      fetchMethod: article.fetchMethod,
      category: "news",
      seaConnection: extracted.seaConnection || extracted.seaEvidenceText || guard.reason,
    };

    const keyFinancials = {
      fundingAmount: extracted.keyFinancials?.fundingAmount || null,
      valuation: extracted.keyFinancials?.valuation || null,
      dealValue: extracted.keyFinancials?.dealValue || null,
    };

    const result: DeepAnalysisResult = {
      leadData,
      keyFinancials,
      wealthAngle: extracted.wealthAngle || "",
      confidenceScore: extracted.confidenceScore ?? 0,
      seaConnection: extracted.seaConnection || null,
    };

    logPipelineDecision({
      stage: 6,
      stageName: "Deep Analysis",
      articleHeadline: article.headline,
      decision: `ANALYZED (${priorityLevel} priority, score ${priorityScore})`,
      reason: extracted.wealthAngle || "Analysis complete",
      confidenceScore: result.confidenceScore,
      durationMs: Date.now() - startTime,
    });

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    log(`[Pipeline S6] Error in deep analysis: ${errorMessage}`, "pipeline");
    return null;
  }
}

// ============================================================================
// Stage 7: Web Search Enrichment
// ============================================================================

/**
 * Enriches a lead with web-searched founder and company information using
 * the existing enrichment infrastructure (Tavily + GPT-4o).
 *
 * @param companyNames - Companies mentioned in the article
 * @param founderNames - Founders/key people mentioned
 * @param region - Geographic region for search context
 * @returns Enrichment metadata including LinkedIn URLs, bios, and descriptions
 *
 * @example
 * const enrichment = await enrichLeadWithWebSearch(
 *   ["Acme Corp"], ["Jane Doe"], "Singapore"
 * );
 * if (enrichment.founderLinkedInUrl) {
 *   console.log("Found LinkedIn:", enrichment.founderLinkedInUrl);
 * }
 */
export async function enrichLeadWithWebSearch(
  companyNames: string[],
  founderNames: string[],
  region: string
): Promise<EnrichmentResult> {
  const startTime = Date.now();

  if (companyNames.length === 0) {
    logPipelineDecision({
      stage: 7,
      stageName: "Enrichment",
      articleHeadline: "(no companies)",
      decision: "SKIPPED",
      reason: "No company names provided for enrichment",
      confidenceScore: 0,
      durationMs: Date.now() - startTime,
    });

    return {
      founderLinkedInUrl: null,
      founderBio: null,
      companyDescription: null,
      enrichmentData: {},
      confidenceScore: 0,
    };
  }

  const primaryCompany = companyNames[0];

  try {
    const enrichment = await enrichSavedLead({
      companyNames,
      founderNames,
      region,
    });

    const formatted = formatEnrichmentForSavedLead(enrichment);

    // Determine overall confidence from individual enrichment results
    const founderConfidence = enrichment.founders[0]?.confidence;
    const companyConfidence = enrichment.companies[0]?.confidence;
    const confidenceScore = calculateEnrichmentConfidence(founderConfidence, companyConfidence);

    const result: EnrichmentResult = {
      founderLinkedInUrl: formatted.founderLinkedInUrl,
      founderBio: formatted.founderBio,
      companyDescription: formatted.companyDescription,
      enrichmentData: formatted.researchData as Record<string, unknown>,
      confidenceScore,
    };

    logPipelineDecision({
      stage: 7,
      stageName: "Enrichment",
      articleHeadline: primaryCompany,
      decision: `ENRICHED (founder: ${!!result.founderBio}, company: ${!!result.companyDescription})`,
      reason: `LinkedIn: ${result.founderLinkedInUrl ? "found" : "not found"}, ` +
              `Bio: ${result.founderBio ? "yes" : "no"}, ` +
              `Company: ${result.companyDescription ? "yes" : "no"}`,
      confidenceScore,
      durationMs: Date.now() - startTime,
    });

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    log(`[Pipeline S7] Enrichment failed for ${primaryCompany}: ${errorMessage}`, "pipeline");

    return {
      founderLinkedInUrl: null,
      founderBio: null,
      companyDescription: null,
      enrichmentData: {},
      confidenceScore: 0,
    };
  }
}

/**
 * Converts qualitative confidence levels to a numeric score (0-100).
 */
function calculateEnrichmentConfidence(
  founderConfidence?: "high" | "medium" | "low",
  companyConfidence?: "high" | "medium" | "low"
): number {
  const toScore = (level?: "high" | "medium" | "low"): number => {
    if (level === "high") return 90;
    if (level === "medium") return 60;
    if (level === "low") return 30;
    return 0;
  };

  const founderScore = toScore(founderConfidence);
  const companyScore = toScore(companyConfidence);

  // If both are available, average them; otherwise use whichever exists
  if (founderScore > 0 && companyScore > 0) {
    return Math.round((founderScore + companyScore) / 2);
  }
  return Math.max(founderScore, companyScore);
}

// ============================================================================
// Scan Progress & Main Scan Function
// ============================================================================

export interface ScanProgress {
  status: "scanning" | "processing" | "complete" | "error";
  currentSource?: string;
  articlesFound?: number;
  articlesProcessed?: number;
  totalArticles?: number;
  message?: string;
}

const scanProgress: Map<string, ScanProgress> = new Map();

export function getScanProgress(scanId: string): ScanProgress | undefined {
  return scanProgress.get(scanId);
}

export async function scanForLeads(scanId?: string): Promise<{ articlesScanned: number; matchesFound: number; newLeads: number; duplicatesSkipped: number; scanId: string }> {
  const currentScanId = scanId || crypto.randomUUID();
  const startTime = Date.now();
  
  scanProgress.set(currentScanId, { status: "scanning", message: "Initializing scan..." });

  const settings = await storage.getSettings();
  if (!settings) {
    scanProgress.set(currentScanId, { status: "error", message: "Settings not configured" });
    setTimeout(() => scanProgress.delete(currentScanId), 60000);
    throw new Error("Settings not configured");
  }
  
  const runCleanup = async () => {
    try {
      await storage.cleanupOldScanLogs(settings.logRetentionDays ?? 2);
    } catch (e) {
      console.error("Error cleaning up old scan logs:", e);
    }
  };

  scanProgress.set(currentScanId, { status: "scanning", message: "Fetching news from enabled sources..." });

  try {
    const activeSources = await storage.getActiveSources();
    const activeFeeds = await storage.getAllActiveRssFeeds();
    
    const feedsWithMeta: RssFeedWithMeta[] = activeFeeds.map(feed => ({
      ...feed,
      sourceName: feed.sourceName,
      sourceTier: feed.sourceTier,
    }));

    const defaultRegion = settings.regions[0] || "Singapore";

    // Keywords are no longer stored in settings. Pass an empty array so adapters
    // skip client-side keyword filtering -- the intelligent pipeline (Stage 1)
    // handles relevance filtering via the AI interest filter prompt instead.
    const legacyKeywords: string[] = [];

    const { articles, sourcesSearched, errors: fetchErrors, debugEntries } = await fetchAllArticles(
      activeSources,
      feedsWithMeta,
      legacyKeywords,
      {
        googleNewsEnabled: settings.googleNewsEnabled ?? false,
        rssEnabled: settings.rssEnabled ?? true,
        scrapingBeeEnabled: settings.scrapingBeeEnabled ?? false,
        defaultRegion,
      }
    );

    scanProgress.set(currentScanId, { 
      status: "processing", 
      currentSource: "Multiple sources",
      articlesFound: articles.length,
      articlesProcessed: 0,
      totalArticles: articles.length,
      message: `Found ${articles.length} matching articles, processing...` 
    });

    let newLeads = 0;
    let duplicatesSkipped = 0;
    let interestFiltered = 0;
    let publicCompaniesFiltered = 0;
    let noCompanySkipped = 0;
    let enrichedCount = 0;
    const createdLeads: InsertLead[] = [];
    const articlesProcessed: ArticleProcessed[] = [];
    const errors: string[] = [...fetchErrors];

    // --- Cross-scan URL deduplication ---
    // Track every URL we've ever fetched to avoid re-processing the same article
    // across multiple scans. This catches articles that failed pre-filter or Stage 1
    // in previous scans, which the leads-table dedup cannot catch.
    const uniqueArticles: RawArticle[] = [];
    for (const article of articles) {
      const urlHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(article.url))
        .then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''));

      const alreadyScanned = await storage.hasScannedUrl(urlHash);
      if (alreadyScanned) {
        duplicatesSkipped++;
        articlesProcessed.push({
          headline: article.headline,
          source: article.source,
          region: article.region,
          status: "skipped",
          reason: "URL already scanned within retention window",
          fetchMethod: article.fetchMethod,
        });
        continue;
      }
      uniqueArticles.push(article);
    }

    // Record all fetched URLs (even those that were deduplicated) so we don't fetch them again
    for (const article of articles) {
      await storage.recordScannedUrl(article.url, article.source);
    }

    log(`[Scan] Fetched ${articles.length} articles, ${uniqueArticles.length} unique after URL dedup (${duplicatesSkipped} skipped)`, "pipeline");

    scanProgress.set(currentScanId, {
      status: "processing",
      currentSource: "Multiple sources",
      articlesFound: uniqueArticles.length,
      articlesProcessed: 0,
      totalArticles: uniqueArticles.length,
      message: `Found ${uniqueArticles.length} unique articles after dedup, processing...`
    });

    const DEFAULT_INTEREST_FILTER_PROMPT = `You are a lead intelligence filter for a private banker focused on ultra-high-net-worth individuals. Determine if this article describes a wealth event relevant to private banking prospecting.

RELEVANT (pass these):
- IPOs or listings of specific private companies
- Large funding rounds (Series B+) with named founders
- Major exits/acquisitions where a specific individual or private company receives significant proceeds
- New ventures by wealthy founders or entrepreneurs
- Wealth transfers, inheritance, or family office activity involving named individuals
- Significant stake sales by named individuals

REJECT (filter these out):
- Government-to-government trade deals, bilateral agreements, or diplomatic economic pacts (e.g. "Country X signs $38B deal with Country Y")
- Macro-economic news (GDP, inflation, interest rates, trade policy)
- Public company stock price movements, analyst ratings, or earnings reports
- General industry trends without a specific bankable individual or private company
- Political news, elections, geopolitics
- Regulatory announcements unless they directly create a liquidity event for a named individual

KEY RULE: There must be a specific named person (founder, entrepreneur, family office principal) or a specific private company that could become a private banking client. If the article only mentions governments, public institutions, or unnamed "companies", reject it.`;

    const filterPrompt = settings.interestFilterPrompt || DEFAULT_INTEREST_FILTER_PROMPT;

    for (let i = 0; i < uniqueArticles.length; i++) {
      const article = uniqueArticles[i];

      scanProgress.set(currentScanId, {
        status: "processing",
        currentSource: article.source,
        articlesFound: uniqueArticles.length,
        articlesProcessed: i,
        totalArticles: uniqueArticles.length,
        message: `[${i+1}/${uniqueArticles.length}] Processing: ${article.headline.substring(0, 50)}...`
      });

      // --- Pre-check 0: Cheap keyword pre-filter (no API call) ---
      // Only send articles to the AI pipeline if they contain at least one business-relevant keyword.
      // This prevents sports, politics, weather etc. from burning API tokens.
      const PREFILTER_KEYWORDS = [
        'ipo', 'listing', 'funding', 'series a', 'series b', 'series c', 'series d',
        'acquisition', 'merger', 'acquire', 'buyout', 'takeover', 'stake', 'divestiture',
        'valuation', 'unicorn', 'billion', 'million', 'investment', 'investor', 'venture',
        'private equity', 'family office', 'wealth', 'high net worth', 'hnw', 'uhnw',
        'founder', 'entrepreneur', 'startup', 'fintech', 'proptech', 'biotech',
        'exit', 'spac', 'prospectus', 'debut', 'bourse', 'stock exchange',
        'fund', 'capital', 'raise', 'raised', 'backed', 'bankable',
        'sgx', 'hkex', 'idx', 'pse', 'catalist', 'mainboard', 'gem board',
        'real estate', 'property', 'conglomerate', 'tycoon', 'magnate', 'mogul',
        'succession', 'inheritance', 'trust', 'endowment', 'philanthropy',
        'private bank', 'asset management', 'hedge fund',
        'expansion', 'headquarter', 'relocat', 'launch',
        'revenue', 'profit', 'earnings', 'growth', 'deal', 'partnership',
      ];
      const articleText = `${article.headline} ${article.content}`.toLowerCase();
      const matchesPrefilter = PREFILTER_KEYWORDS.some(kw => articleText.includes(kw));
      if (!matchesPrefilter) {
        articlesProcessed.push({
          headline: article.headline,
          source: article.source,
          region: article.region,
          status: "skipped",
          reason: "Pre-filter: no business keywords found",
          fetchMethod: article.fetchMethod,
        });
        continue;
      }

      // --- Pre-check 1: URL dedup (free, no API call) ---
      const existingLead = await storage.getLeadByUrl(article.url);
      if (existingLead) {
        duplicatesSkipped++;
        articlesProcessed.push({
          headline: article.headline,
          source: article.source,
          region: article.region,
          status: "skipped",
          reason: "Duplicate - URL already in database",
          fetchMethod: article.fetchMethod,
        });
        continue;
      }

      try {
        // --- Stage 1: Interest Filter (cheap 256-token call) ---
        const interestResult = await passesInterestFilter(article, filterPrompt, settings.regions);
        if (!interestResult.passes) {
          interestFiltered++;
          articlesProcessed.push({
            headline: article.headline,
            source: article.source,
            region: article.region,
            status: "skipped",
            reason: `S1 Interest filter: ${interestResult.reason}`,
            fetchMethod: article.fetchMethod,
          });
          continue;
        }

        // --- Stage 2: Extract Primary Company ---
        const companyResult = await extractPrimaryCompany(article);
        if (!companyResult.companyName) {
          noCompanySkipped++;
          articlesProcessed.push({
            headline: article.headline,
            source: article.source,
            region: article.region,
            status: "skipped",
            reason: "S2 No company identified",
            fetchMethod: article.fetchMethod,
          });
          continue;
        }

        const companyName = companyResult.companyName;

        // --- Stage 3: Public Company Filter ---
        const publicResult = await isPublicCompany(companyName, article.headline);
        if (publicResult.isPublic) {
          publicCompaniesFiltered++;
          articlesProcessed.push({
            headline: article.headline,
            source: article.source,
            region: article.region,
            status: "skipped",
            reason: `S3 Public company filtered: ${publicResult.reason}`,
            fetchMethod: article.fetchMethod,
          });
          continue;
        }

        // --- Stage 4a: In-database company+story dedup ---
        // Check if we already have a lead about this company from the last 7 days
        const recentLeads = await storage.getRecentLeadsByCompany(companyName, 7);
        if (recentLeads && recentLeads.length > 0) {
          duplicatesSkipped++;
          articlesProcessed.push({
            headline: article.headline,
            source: article.source,
            region: article.region,
            status: "skipped",
            reason: `S4a Already have ${recentLeads.length} lead(s) about ${companyName} from past 7 days`,
            fetchMethod: article.fetchMethod,
          });
          continue;
        }

        // --- Stage 4b: Smart Deduplication (against saved leads) ---
        const dedupResult = await checkDuplication(companyName, article.headline, article.content.slice(0, 500));
        if (dedupResult.isDuplicate) {
          duplicatesSkipped++;
          articlesProcessed.push({
            headline: article.headline,
            source: article.source,
            region: article.region,
            status: "skipped",
            reason: `S4b Duplicate: ${dedupResult.reason}`,
            fetchMethod: article.fetchMethod,
          });
          continue;
        }

        // --- Stage 5: Full Article Content (Tier 1 only, uses ScrapingBee) ---
        const sourceTier = article.sourceTier || "tier3";
        const contentResult = await fetchFullArticleContent(article, sourceTier as SourceTier);
        const fullContent = contentResult.fullContent;

        // --- Stage 6: Deep Analysis (replaces extractLeadInfo) ---
        const deepResult = await deepAnalyzeArticle(article, fullContent, settings.regions);
        if (!deepResult) {
          articlesProcessed.push({
            headline: article.headline,
            source: article.source,
            region: article.region,
            status: "skipped",
            reason: "S6 Deep analysis rejected (not relevant or error)",
            fetchMethod: article.fetchMethod,
          });
          continue;
        }

        // --- Stage 7: Enrichment via Tavily/Brave web search ---
        let enrichResult: EnrichmentResult | null = null;
        try {
          const founderNames = deepResult.leadData.founderNames || [];
          const companyNames = deepResult.leadData.companyNames || [companyName];
          const region = article.region || settings.regions[0] || "Singapore";
          enrichResult = await enrichLeadWithWebSearch(companyNames, founderNames, region);
          if (enrichResult.founderBio || enrichResult.companyDescription) {
            enrichedCount++;
          }
        } catch (enrichError) {
          const msg = enrichError instanceof Error ? enrichError.message : "Unknown";
          log(`[Pipeline S7] Enrichment failed for ${companyName}: ${msg}`, "pipeline");
          // Non-fatal — save lead without enrichment
        }

        // --- Build pipeline reasoning for transparency ---
        const pipelineReasoning = [
          `S1 Interest: PASS (${interestResult.reason || 'relevant'})`,
          `S2 Company: ${companyName}`,
          `S3 Public: NO (${publicResult.reason || 'private company'})`,
          `S4 Dedup: PASS (new event)`,
          `S6 Analysis: ${deepResult.leadData.priorityLevel} priority (score ${deepResult.leadData.priorityScore})${deepResult.wealthAngle ? ` — ${deepResult.wealthAngle}` : ''}`,
          enrichResult?.founderBio ? `S7 Enrichment: founder bio found` : `S7 Enrichment: no additional data`,
        ].join('\n');

        // --- Save lead with enrichment data ---
        const lead = {
          ...deepResult.leadData,
          founderLinkedInUrl: enrichResult?.founderLinkedInUrl || null,
          founderBio: enrichResult?.founderBio || null,
          companyDescription: enrichResult?.companyDescription || null,
          fetchMethod: contentResult.fetchMethod || article.fetchMethod,
          pipelineReasoning,
        };

        await storage.createLead(lead as InsertLead);
        createdLeads.push(lead as InsertLead);
        newLeads++;

        articlesProcessed.push({
          headline: article.headline,
          source: article.source,
          region: article.region,
          status: "success",
          reason: `${deepResult.leadData.priorityLevel} priority (score ${deepResult.leadData.priorityScore}), enriched=${!!enrichResult?.founderBio}`,
          fetchMethod: (contentResult.fetchMethod || article.fetchMethod) as FetchMethod | undefined,
        });

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        errors.push(`Error processing "${article.headline}": ${errorMessage}`);
        articlesProcessed.push({
          headline: article.headline,
          source: article.source,
          region: article.region,
          status: "error",
          reason: errorMessage,
          fetchMethod: article.fetchMethod,
        });
      }
    }

    const durationMs = Date.now() - startTime;
    const matchesFound = newLeads + duplicatesSkipped;

    log(
      `[Scan Complete] ${articles.length} fetched, ${uniqueArticles.length} unique → ` +
      `${interestFiltered} interest-filtered, ${noCompanySkipped} no-company, ` +
      `${publicCompaniesFiltered} public-filtered, ${duplicatesSkipped} duplicates, ` +
      `${newLeads} new leads (${enrichedCount} enriched) [${durationMs}ms]`,
      "pipeline"
    );

    await storage.createScanLog({
      articlesScanned: uniqueArticles.length,
      matchesFound,
      newLeads,
      duplicatesSkipped,
      durationMs,
      sourcesSearched,
      articlesProcessed,
      errors: errors.length > 0 ? errors : null,
      scrapingBeeDebug: debugEntries.length > 0 ? debugEntries : null,
    });

    scanProgress.set(currentScanId, {
      status: "complete",
      articlesFound: uniqueArticles.length,
      articlesProcessed: uniqueArticles.length,
      totalArticles: uniqueArticles.length,
      message: `Complete! ${newLeads} new leads found.`
    });

    // Cleanup old URL tracking records (keep 7 days)
    try {
      const cleaned = await storage.cleanupOldScannedUrls(7);
      if (cleaned > 0) {
        log(`[Scan] Cleaned up ${cleaned} old scanned URL records`, "pipeline");
      }
    } catch (cleanupError) {
      log(`[Scan] Error cleaning up scanned URLs: ${cleanupError}`, "pipeline");
    }

    // Send notifications for new high-priority leads
    if (createdLeads.length > 0) {
      const highPriorityLeads = createdLeads.filter(l => l.priorityLevel === "high");
      if (highPriorityLeads.length > 0) {
        try {
          const leads = await storage.getAllLeads();
          const newHighPriorityLeads = leads.filter(l =>
            l.status === "new" &&
            l.priorityLevel === "high" &&
            createdLeads.some(cl => cl.sourceUrl === l.sourceUrl)
          );

          if (newHighPriorityLeads.length > 0) {
            // Send Telegram alert if enabled
            if (settings.telegramEnabled && settings.telegramChatId) {
              try {
                await sendLeadAlertTelegram(settings.telegramChatId, newHighPriorityLeads, settings.telegramTopicId);
                console.log(`Sent Telegram alert for ${newHighPriorityLeads.length} high-priority leads`);
              } catch (error) {
                console.error("Error sending lead alert via Telegram:", error);
              }
            }

            // Send email alert if enabled (legacy)
            if (settings.emailEnabled && settings.alertEmail) {
              try {
                await sendLeadAlertEmail(settings.alertEmail, newHighPriorityLeads);
                console.log(`Sent email alert for ${newHighPriorityLeads.length} high-priority leads`);
              } catch (error) {
                console.error("Error sending lead alert email:", error);
              }
            }
          }
        } catch (error) {
          console.error("Error sending lead alerts:", error);
        }
      }
    }

    setTimeout(() => {
      scanProgress.delete(currentScanId);
    }, 60000);

    return {
      articlesScanned: articles.length,
      matchesFound: articles.length,
      newLeads,
      duplicatesSkipped,
      scanId: currentScanId,
    };
  } finally {
    await runCleanup();
  }
}
