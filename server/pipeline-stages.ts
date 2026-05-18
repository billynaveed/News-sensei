import OpenAI from "openai";
import { storage } from "./storage";
import { enrichSavedLead, formatEnrichmentForSavedLead } from "./founder-enrichment";
import { log } from "./log";
import type { RawArticle } from "./adapters";
import type { InsertLead, PriorityLevel, SourceTier } from "@shared/schema";
import { stripJsonFences } from "./json-utils";

// ============================================================================
// OpenAI Client
// ============================================================================

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

// Local gemma4 on Mac Mini via Ollama (free but slow).
// Disabled by default — Mac Mini was decommissioned 2026-05-18, ROADMAP §P0.
// To re-enable: set OLLAMA_ENABLED=true in .env.
const OLLAMA_ENABLED = process.env.OLLAMA_ENABLED === "true";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://100.110.246.23:11434/v1";
const ollama = OLLAMA_ENABLED
  ? new OpenAI({ apiKey: "ollama", baseURL: OLLAMA_BASE_URL, timeout: 120_000 })
  : null;

const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY;

// ============================================================================
// Pipeline Stage Result Types
// ============================================================================

/** Stage 1 result: whether an article passes the semantic interest filter */
export interface InterestFilterResult {
  passes: boolean;
  reason: string;
  confidenceScore: number;
}

/** Stage 2 result: the primary company extracted from an article */
export interface CompanyExtractionResult {
  companyName: string | null;
  confidenceScore: number;
}

/** Stage 3 result: whether a company is publicly listed */
export interface PublicCompanyCheckResult {
  isPublic: boolean;
  reason: string;
  confidenceScore: number;
}

/** Stage 4 result: deduplication check against saved leads */
export interface DuplicationCheckResult {
  isDuplicate: boolean;
  isUpdate: boolean;
  existingSavedLeadId: string | null;
  reason: string;
  confidenceScore: number;
}

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
}

/** Stage 7 result: enrichment metadata from web search */
export interface EnrichmentResult {
  founderLinkedInUrl: string | null;
  founderBio: string | null;
  companyDescription: string | null;
  enrichmentData: Record<string, unknown>;
  confidenceScore: number;
}

// ============================================================================
// Timeout & Content Limits
// ============================================================================

/** Maximum time (ms) to wait for a ScrapingBee premium fetch before aborting */
const SCRAPINGBEE_TIMEOUT_MS = 15_000;

/** Maximum time (ms) to wait for the deep analysis OpenAI call */
const DEEP_ANALYSIS_TIMEOUT_MS = 120_000; // Increased for local-gemma4 (~46s per call)

/** Maximum time (ms) to allow for Stage 7 enrichment before giving up */
const ENRICHMENT_TIMEOUT_MS = 45_000;

/** Maximum characters of article content sent to GPT-4o for deep analysis */
const MAX_CONTENT_FOR_ANALYSIS = 6_000;

// ============================================================================
// Shared Helpers
// ============================================================================

/**
 * Creates a promise that rejects after the specified timeout.
 * Used with Promise.race to enforce maximum durations on external API calls.
 */
function createTimeoutPromise<T>(ms: number, message: string): Promise<T> {
  return new Promise<T>((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

// ============================================================================
// Pipeline Audit Logging
// ============================================================================

/** Structured log entry for pipeline decision tracking and debugging */
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
 * This provides a full audit trail for debugging filtering decisions.
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
// Stage 1: Semantic Interest Filter
// ============================================================================

/**
 * Determines whether an article is relevant to private banking lead generation
 * using a configurable LLM prompt instead of simple keyword matching.
 *
 * The filter prompt is user-editable in Settings, allowing fine-tuning of what
 * constitutes a relevant wealth event without code changes.
 *
 * Decision logic: article passes only when the AI returns relevant=true AND
 * confidenceScore exceeds the 60% threshold.
 *
 * @param article - The raw article to evaluate (headline + content snippet used)
 * @param filterPrompt - User-configurable prompt defining relevance criteria
 * @param targetRegions - Geographic regions of interest (e.g. ["Singapore", "Indonesia"])
 * @returns Whether the article passes the filter, with reasoning and confidence
 *
 * @example
 * const result = await passesInterestFilter(article, settings.interestFilterPrompt, settings.regions);
 * if (!result.passes) {
 *   console.log(`Filtered out: ${result.reason}`);
 * }
 */
export async function passesInterestFilter(
  article: RawArticle,
  filterPrompt: string,
  targetRegions: string[]
): Promise<InterestFilterResult> {
  const startTime = Date.now();

  const regionsStr = targetRegions.join(", ");

  const prompt = `${filterPrompt}

CRITICAL REGIONAL FILTER (SEA / HK / Taiwan, strict).
Target Regions: ${regionsStr}.

Pass on geography ONLY if the article itself shows ONE of:
  (a) the SUBJECT company is HEADQUARTERED in a Target Region, OR
  (b) a NAMED founder is BASED in a Target Region (current home / office), OR
  (c) a NAMED founder has CREDIBLE ROOTS in a Target Region (born, raised,
      educated, family, previously based there), OR
  (d) the SUBJECT company has a STRONG OPERATIONAL CENTRE in a Target Region
      (regional HQ, primary office with leadership, principal market with
      on-the-ground leadership), OR
  (e) the article EXPLICITLY concerns a wealth liquidity event for a
      SEA / HK / Taiwan founder, family, or private company.

REJECT — these signals alone do NOT make an article SEA-relevant:
  - The publisher or source domain is SEA (Tech in Asia, Business Times,
    Straits Times, KrASIA, DealStreetAsia, The Edge, e27, SCMP, CNA, Hubbis).
    A SEA outlet covering a US / European / Mainland-China company is NOT
    a SEA story.
  - An investor, backer, fund, or LP is SEA-based (GIC, Temasek, Khazanah,
    EDBI, family offices, sovereign funds, Hillhouse-LPs, etc.) but the
    company itself is not. Investor identity does NOT establish SEA
    relevance for the SUBJECT company.
  - Vague "Asia expansion", "APAC growth", "Asian customers", regional
    distribution, or partner network with no concrete office, founder, or
    HQ in a Target Region.
  - Mainland China entities (Beijing, Shanghai, Shenzhen, Guangzhou,
    Hangzhou — e.g. ByteDance, Tencent, Alibaba mainland operations) are
    NOT in scope. Mainland China is excluded; only HK and Taiwan count.
  - Global companies (Anthropic, OpenAI, SpaceX, Stripe) where the only
    SEA tie is a SEA backer or a SEA-published article.

If you cannot point to a specific sentence in the article that establishes
(a)–(e), mark relevant=false.

Article Headline: ${article.headline}
Article Snippet: ${article.content.slice(0, 500)}
Source: ${article.source}
Target Regions: ${regionsStr}

Return JSON:
{
  "relevant": true/false,
  "reason": "Brief explanation. If relevant, name which of (a)-(e) applies and quote the supporting passage. If not relevant, name the disqualifying signal (sea_publisher_only / sea_investor_only / vague_apac_expansion / mainland_china_only / global_company_no_sea_anchor).",
  "confidenceScore": 0-100
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "google/gemini-2.5-flash-lite",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 256,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return { passes: false, reason: "No response from AI", confidenceScore: 0 };
    }

    const result = JSON.parse(stripJsonFences(content));
    const confidenceScore: number = result.confidenceScore ?? 0;
    const passes = result.relevant === true && confidenceScore > 60;

    const filterResult: InterestFilterResult = {
      passes,
      reason: result.reason || "No reason provided",
      confidenceScore,
    };

    logPipelineDecision({
      stage: 1,
      stageName: "Interest Filter",
      articleHeadline: article.headline,
      decision: passes ? "PASS" : "REJECT",
      reason: filterResult.reason,
      confidenceScore,
      durationMs: Date.now() - startTime,
    });

    return filterResult;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    log(`[Pipeline S1] Error in interest filter: ${errorMessage}`, "pipeline");
    return {
      passes: false,
      reason: `Interest filter error: ${errorMessage}`,
      confidenceScore: 0,
    };
  }
}

// ============================================================================
// Stage 2: Primary Company Extraction
// ============================================================================

/**
 * Extracts the primary company name from an article's headline and content snippet.
 * This is a fast, lightweight extraction used early in the pipeline before committing
 * to more expensive stages (public company check, deduplication, deep analysis).
 *
 * Returns null when no clear company is mentioned, which signals the pipeline
 * to skip the article.
 *
 * @param article - The raw article to extract the company from
 * @returns The primary company name and confidence, or null companyName if none found
 *
 * @example
 * const { companyName } = await extractPrimaryCompany(article);
 * if (!companyName) {
 *   console.log("No clear company mentioned, skipping");
 * }
 */
export async function extractPrimaryCompany(
  article: RawArticle
): Promise<CompanyExtractionResult> {
  const startTime = Date.now();

  const prompt = `Extract the PRIMARY company that this article is ABOUT (the subject), not the publisher/source.

CRITICAL RULES:
- News publishers (Bloomberg, Reuters, Nikkei, The Edge, Business Times, CNA, SCMP, Tech in Asia, KrASIA, DealStreetAsia, e27, Straits Times, Hubbis) are NEVER the primary company. They are sources.
- If the headline says "Company X does Y — Bloomberg", the primary company is "Company X", NOT Bloomberg.
- Use the company's commonly known name. Examples:
  - "Digital Bank Maya" → "Maya" (also known as PayMaya, Voyager Innovations)
  - "Grab Holdings" or "Grab" → "Grab"
  - "GoTo Group" or "Gojek Tokopedia" → "GoTo"
- If multiple companies are mentioned in an M&A context (A acquires B), the PRIMARY company is whichever is more relevant as a lead (usually the one being acquired/IPO-ing/raising funds).

Headline: ${article.headline}
Content: ${article.content.slice(0, 300)}

Return JSON: { "companyName": "string or null", "confidenceScore": 0-100 }`;

  try {
    const response = await openai.chat.completions.create({
      model: "google/gemini-2.5-flash-lite",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 128,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return { companyName: null, confidenceScore: 0 };
    }

    const result = JSON.parse(stripJsonFences(content));
    const companyName: string | null = result.companyName || null;
    const confidenceScore: number = result.confidenceScore ?? 0;

    logPipelineDecision({
      stage: 2,
      stageName: "Company Extraction",
      articleHeadline: article.headline,
      decision: companyName ? `FOUND: ${companyName}` : "NONE",
      reason: companyName ? `Extracted company "${companyName}"` : "No clear company mentioned",
      confidenceScore,
      durationMs: Date.now() - startTime,
    });

    return { companyName, confidenceScore };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    log(`[Pipeline S2] Error extracting company: ${errorMessage}`, "pipeline");
    return { companyName: null, confidenceScore: 0 };
  }
}

// ============================================================================
// Stage 3: Public Company Filter
// ============================================================================

/**
 * Determines whether a company is publicly listed on a stock exchange.
 * Companies preparing for IPO (still private) are NOT flagged as public,
 * since pre-IPO founders are prime private banking prospects.
 *
 * Decision logic: company is flagged as public only when the AI returns
 * isPublic=true AND confidence exceeds the 70% threshold. This conservative
 * approach avoids accidentally filtering out private companies.
 *
 * On error, defaults to isPublic=false to prevent false filtering.
 *
 * @param companyName - Name of the company to check
 * @param articleHeadline - Headline providing context for the check
 * @returns Whether the company is public, with reasoning and confidence
 *
 * @example
 * const result = await isPublicCompany("Grab Holdings", "Grab reports Q3 earnings");
 * if (result.isPublic) {
 *   console.log("Skipping public company:", result.reason);
 * }
 */
export async function isPublicCompany(
  companyName: string,
  articleHeadline: string
): Promise<PublicCompanyCheckResult> {
  const startTime = Date.now();

  const prompt = `Determine if this company is publicly listed/traded:

Company: ${companyName}
Article Headline: ${articleHeadline}

A company is PUBLIC if:
- It trades on a stock exchange (SGX, NASDAQ, NYSE, HKEX, SET, IDX, etc)
- Article mentions stock ticker symbols
- Described as "publicly traded" or "listed company"

A company is PRIVATE if:
- Not yet listed
- Article discusses FUTURE IPO (company is still private)
- No mention of trading or stock tickers
- Described as a startup, private company, or privately held

Return JSON:
{
  "isPublic": true/false,
  "reason": "Brief explanation",
  "confidence": 0-100
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "google/gemini-2.5-flash-lite",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 256,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return { isPublic: false, reason: "No response from AI", confidenceScore: 0 };
    }

    const result = JSON.parse(stripJsonFences(content));
    const confidenceScore: number = result.confidence ?? 0;
    const isPublic = result.isPublic === true && confidenceScore > 70;

    const checkResult: PublicCompanyCheckResult = {
      isPublic,
      reason: result.reason || "No reason provided",
      confidenceScore,
    };

    logPipelineDecision({
      stage: 3,
      stageName: "Public Company Filter",
      articleHeadline,
      decision: isPublic ? "PUBLIC (filtered)" : "PRIVATE (pass)",
      reason: checkResult.reason,
      confidenceScore,
      durationMs: Date.now() - startTime,
    });

    return checkResult;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    log(`[Pipeline S3] Error checking public company: ${errorMessage}`, "pipeline");
    // On error, assume private to avoid false filtering
    return {
      isPublic: false,
      reason: `Public company check error: ${errorMessage}`,
      confidenceScore: 0,
    };
  }
}

// ============================================================================
// Stage 4: Smart Deduplication
// ============================================================================

/**
 * Checks whether an article is about a company already tracked in saved leads,
 * and if so, whether the new article contains substantially new information.
 *
 * Three possible outcomes:
 * 1. NEW COMPANY -- company not found in saved leads, proceed normally
 * 2. UPDATE -- company exists but article has substantially new info (>40% new)
 * 3. DUPLICATE -- company exists and article covers the same ground
 *
 * The "update" path allows follow-up articles (e.g. a new funding round for
 * the same company) to flow through the pipeline while filtering out rehashed
 * coverage of the same event.
 *
 * On error, defaults to not-duplicate to avoid missing leads.
 *
 * @param companyName - Primary company name from the article
 * @param newArticleHeadline - Headline of the new article
 * @param newArticleSnippet - Content snippet of the new article
 * @returns Deduplication result with update detection
 *
 * @example
 * const result = await checkDuplication("Grab", "Grab raises $500M Series H", snippet);
 * if (result.isDuplicate) {
 *   console.log("Duplicate, skipping:", result.reason);
 * } else if (result.isUpdate) {
 *   console.log("Update to existing lead:", result.existingSavedLeadId);
 * }
 */
export async function checkDuplication(
  companyName: string,
  newArticleHeadline: string,
  newArticleSnippet: string
): Promise<DuplicationCheckResult> {
  const startTime = Date.now();

  try {
    // Step 1: Check if company exists in saved_leads
    const existingSavedLead = await storage.getSavedLeadByCompanyName(companyName);

    if (!existingSavedLead) {
      const result: DuplicationCheckResult = {
        isDuplicate: false,
        isUpdate: false,
        existingSavedLeadId: null,
        reason: "New company, not in saved leads database",
        confidenceScore: 100,
      };

      logPipelineDecision({
        stage: 4,
        stageName: "Deduplication",
        articleHeadline: newArticleHeadline,
        decision: "NEW COMPANY",
        reason: result.reason,
        confidenceScore: result.confidenceScore,
        durationMs: Date.now() - startTime,
      });

      return result;
    }

    // Step 2: Compare new article to saved article using AI
    const existingSummary = existingSavedLead.lead.aiSummary || existingSavedLead.lead.headline;

    const prompt = `Compare these two articles about the same company:

SAVED ARTICLE SUMMARY:
${existingSummary}

NEW ARTICLE:
Headline: ${newArticleHeadline}
Snippet: ${newArticleSnippet.slice(0, 500)}

Determine if the new article contains SUBSTANTIALLY NEW information.

Substantially new means:
- Different funding round or amount
- New acquisition or exit event
- Significant business development
- Different time period or stage

NOT substantially new:
- Same event, different wording
- Minor updates to same story
- Similar information already covered

Return JSON:
{
  "substantiallyNew": true/false,
  "percentNew": 0-100,
  "reason": "Explanation of what's new or why it's duplicate"
}`;

    const response = await openai.chat.completions.create({
      model: "google/gemini-2.5-flash-lite",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 256,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return {
        isDuplicate: false,
        isUpdate: false,
        existingSavedLeadId: existingSavedLead.id,
        reason: "Could not compare articles (no AI response)",
        confidenceScore: 0,
      };
    }

    const comparison = JSON.parse(stripJsonFences(content));
    const percentNew: number = comparison.percentNew ?? 0;

    if (comparison.substantiallyNew === true && percentNew > 40) {
      const result: DuplicationCheckResult = {
        isDuplicate: false,
        isUpdate: true,
        existingSavedLeadId: existingSavedLead.id,
        reason: comparison.reason || "Contains substantially new information",
        confidenceScore: percentNew,
      };

      logPipelineDecision({
        stage: 4,
        stageName: "Deduplication",
        articleHeadline: newArticleHeadline,
        decision: "UPDATE",
        reason: result.reason,
        confidenceScore: percentNew,
        durationMs: Date.now() - startTime,
      });

      return result;
    }

    const result: DuplicationCheckResult = {
      isDuplicate: true,
      isUpdate: false,
      existingSavedLeadId: existingSavedLead.id,
      reason: comparison.reason || "Duplicate of existing saved lead",
      confidenceScore: 100 - percentNew,
    };

    logPipelineDecision({
      stage: 4,
      stageName: "Deduplication",
      articleHeadline: newArticleHeadline,
      decision: "DUPLICATE",
      reason: result.reason,
      confidenceScore: result.confidenceScore,
      durationMs: Date.now() - startTime,
    });

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    log(`[Pipeline S4] Error in deduplication check: ${errorMessage}`, "pipeline");
    // On error, assume not duplicate to avoid missing leads
    return {
      isDuplicate: false,
      isUpdate: false,
      existingSavedLeadId: null,
      reason: `Deduplication check error: ${errorMessage}`,
      confidenceScore: 0,
    };
  }
}

// ============================================================================
// Stage 5: Full Article Content Fetch
// ============================================================================

/**
 * Fetches full article content for deeper analysis. For Tier 1 sources with
 * ScrapingBee configured, uses premium extraction (JS rendering, premium proxies,
 * structured extract rules) to bypass paywalls and extract high-quality text.
 * For other tiers, returns the existing snippet content from RSS/Google News.
 *
 * Cost: ~5-10 ScrapingBee credits per premium request (Tier 1 only).
 * Timeout: 15 seconds for premium fetch, then falls back to existing content.
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
      const premiumContent = await fetchViaPremiumScrapingBee(article.url);

      if (premiumContent && premiumContent.length > article.content.length) {
        const result: FullArticleContentResult = {
          fullContent: premiumContent,
          fetchMethod: "scrapingbee_premium",
          contentLength: premiumContent.length,
        };

        logPipelineDecision({
          stage: 5,
          stageName: "Full Article Fetch",
          articleHeadline: article.headline,
          decision: "PREMIUM FETCH",
          reason: `Fetched ${premiumContent.length} chars via ScrapingBee premium (was ${article.content.length})`,
          confidenceScore: 95,
          durationMs: Date.now() - startTime,
        });

        return result;
      }

      // Premium fetch returned less content than snippet; use existing
      log(
        `[Pipeline S5] Premium fetch returned less content ` +
        `(${premiumContent?.length ?? 0} chars) than existing ` +
        `(${article.content.length} chars), falling back`,
        "pipeline"
      );
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
 * Calls ScrapingBee with premium settings: JS rendering enabled, premium proxy
 * for bypassing paywalls, full resource loading, and structured extract rules
 * targeting common article body selectors across major news sites.
 *
 * Uses AbortSignal.timeout for enforcing the SCRAPINGBEE_TIMEOUT_MS limit.
 *
 * @returns Extracted article text, or null if extraction failed or returned empty
 */
async function fetchViaPremiumScrapingBee(articleUrl: string): Promise<string | null> {
  if (!SCRAPINGBEE_API_KEY) return null;

  const params = new URLSearchParams({
    api_key: SCRAPINGBEE_API_KEY,
    url: articleUrl,
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

  const response = await fetch(
    `https://app.scrapingbee.com/api/v1?${params.toString()}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(SCRAPINGBEE_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    log(
      `[Pipeline S5] ScrapingBee premium returned HTTP ${response.status}`,
      "pipeline"
    );
    return null;
  }

  const data = await response.json();
  const extractedText: string = data.article_text || "";
  return extractedText.length > 0 ? extractedText : null;
}

/**
 * Builds a fallback result using the article's existing content when premium
 * fetch is unavailable, fails, or returns less content than the snippet.
 */
function buildFallbackResult(
  article: RawArticle,
  startTime: number
): FullArticleContentResult {
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
 * Uses GPT-4o with extended token output (max_completion_tokens: 2000) for
 * thorough extraction of:
 * - All companies, founders, and investors mentioned
 * - Key financial metrics (funding amount, valuation, deal value)
 * - Priority scoring based on wealth/liquidity potential
 * - A "wealth angle" explaining the private banking opportunity
 *
 * Content is truncated to MAX_CONTENT_FOR_ANALYSIS (6000 chars) to stay within
 * reasonable input token budgets while capturing the core article substance.
 *
 * Returns null when the article is not relevant to the target regions, allowing
 * the pipeline to skip it cleanly.
 *
 * @param article - The raw article metadata (headline, source, URL, etc.)
 * @param fullContent - Complete article text from Stage 5
 * @param targetRegions - Geographic regions of interest (e.g. ["Singapore", "Indonesia"])
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

  const truncatedContent = fullContent.slice(0, MAX_CONTENT_FOR_ANALYSIS);
  const regionsStr = targetRegions.join(", ");

  const prompt = `Perform deep analysis of this news article for UHNW private banking lead generation.

The ONLY purpose of this system is to find founders/entrepreneurs who are about to receive significant liquid wealth (>$10M) from a specific event — making them potential private banking clients.

FULL ARTICLE:
Headline: ${article.headline}
Source: ${article.source}
Content: ${truncatedContent}

Target Regions: ${regionsStr}

PRIORITY SCORING GUIDE:
- 80-100 (HIGH): Clear liquidity event with named founder(s). IPO filing, acquisition with disclosed price, Series D+ or large late-stage raise >$100M, confirmed exit. Money is changing hands imminently.
- 50-79 (MEDIUM): Likely liquidity event but details missing. Early IPO rumors, M&A talks, Series C raise, unicorn milestone with named founders.
- 20-49 (LOW): Tangential — might lead to future liquidity. Series C without details, strategic investment, company growth story with no imminent event. Ignore Series A/B entirely.
- 1-19 (REJECT): No liquidity event. General market news, industry commentary, opinion pieces, company operations, policy analysis, investment advice articles.

CRITICAL: If the article is general market commentary, investment advice, industry analysis, or opinion without a SPECIFIC company undergoing a SPECIFIC liquidity event — score it 1-19 regardless of how "relevant to banking" it might seem.

INVESTOR/BACKER WEALTH EVENTS:
- If a billionaire or UHNW investor is named as backing a company involved in an M&A deal, IPO, or major funding round, this is HIGH priority.
- Example: "Richard Li-backed bolttech" in a $200M M&A deal = score 70+ (the backer's wealth and influence make this a private banking opportunity)
- Look for patterns like "[Name]-backed", "[Name]'s [Company]", "backed by [Name]", "investor [Name]".
- Score 70+ when: named UHNW/backer + disclosed deal value or significant event + M&A/IPO/funding context.

Extract and return JSON:
{
  "companyNames": ["array of companies MENTIONED IN the article — NEVER include the news publisher/source (Bloomberg, Reuters, Nikkei, The Edge, Business Times, CNA, SCMP, Tech in Asia, KrASIA, DealStreetAsia, e27, Straits Times, Hubbis, etc)"],
  "primaryCompany": "the main company this article is ABOUT (the subject, not the publisher). Use commonly known name (e.g. 'Maya' not 'Digital Bank Maya')",
  "founderNames": ["array of founders, key people, AND named billionaire investors/backers WITH ACTUAL NAMES. Include people described as 'backers', 'investors', 'supported by', 'X-backed' even if they are not the founder. Example: if article says 'Richard Li-backed bolttech', include 'Richard Li'. If no names mentioned, use empty array []"],
  "investors": ["array of investors mentioned — include anyone described as backer, supporter, or financier"],
  "summary": "2-3 paragraphs: what happened, deal size/valuation, and the SPECIFIC liquidity event. If no liquidity event exists, say so clearly.",
  "keyFinancials": {
    "fundingAmount": "e.g. $50M or null",
    "valuation": "e.g. $500M or null",
    "dealValue": "for M&A or null"
  },
  "priorityScore": 1-100,
  "priorityLevel": "high/medium/low",
  "matchedIndicators": ["IPO", "Series C", "Exit", "M&A", etc — only real indicators, not aspirational ones],
  "wealthAngle": "WHO specifically is getting wealthy and HOW MUCH? Name the person even if they are an investor/backer rather than a founder. Example: 'Richard Li (billionaire backer of bolttech) positioned to realize returns from the $200M MoneyHero acquisition'. If no individual is named anywhere in the article, say 'No identifiable individual'",
  "confidenceScore": 0-100,
  "regionRelevance": true/false,
  "category": "news or lifestyle — classify as 'news' if this is a business/finance/funding/M&A/IPO/startup article, or 'lifestyle' if it covers luxury, real estate, philanthropy, personal life, travel, culture, society events, or celebrity wealth"
}`;

  try {
    // Try local gemma4 (Mac Mini via Ollama) first when enabled — free but slow.
    // When OLLAMA_ENABLED is unset/false, go straight to OpenRouter Gemini.
    let response: OpenAI.Chat.Completions.ChatCompletion | null = null;
    let usedModel = "";

    if (ollama) {
      try {
        log(`[Pipeline S6] Attempting local-gemma4...`, "pipeline");
        response = await Promise.race([
          ollama.chat.completions.create({
            model: "gemma4:latest",
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 2000,
            temperature: 0.3,
          }),
          createTimeoutPromise<never>(DEEP_ANALYSIS_TIMEOUT_MS, "Local gemma4 timed out"),
        ]);
        usedModel = "local-gemma4";
        log(`[Pipeline S6] Local gemma4 succeeded`, "pipeline");
      } catch (primaryError) {
        const primaryMsg = primaryError instanceof Error ? primaryError.message : "Unknown error";
        log(`[Pipeline S6] Local gemma4 failed: ${primaryMsg}, falling back to gemini-2.5-flash-lite`, "pipeline");
        response = null;
      }
    }

    if (!response) {
      try {
        response = await Promise.race([
          openai.chat.completions.create({
            model: "google/gemini-2.5-flash-lite",
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 2000,
            response_format: { type: "json_object" },
          }),
          createTimeoutPromise<never>(DEEP_ANALYSIS_TIMEOUT_MS, "Gemini flash fallback timed out"),
        ]);
        usedModel = "gemini-2.5-flash-lite";
        log(`[Pipeline S6] Gemini flash ${ollama ? "fallback " : ""}succeeded`, "pipeline");
      } catch (fallbackError) {
        const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : "Unknown error";
        log(`[Pipeline S6] Gemini flash ${ollama ? "fallback " : ""}failed: ${fallbackMsg}`, "pipeline");
        throw fallbackError;
      }
    }

    const content = response.choices[0]?.message?.content;
    if (!content) {
      log("[Pipeline S6] No response from AI for deep analysis", "pipeline");
      return null;
    }

    const extracted = JSON.parse(stripJsonFences(content));

    // Reject if not relevant to target regions
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
      category: extracted.category === "lifestyle" ? "lifestyle" : "news",
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
 * the existing enrichment infrastructure (Tavily web search + GPT-4o synthesis).
 *
 * The enrichment process:
 * 1. Searches Tavily for real-time info about the founder and company
 * 2. Uses GPT-4o to synthesize search results into structured data
 * 3. Extracts LinkedIn URLs, biographies, and company descriptions
 * 4. Falls back gracefully if any step fails (returns empty result, does not throw)
 *
 * Performance: Each enrichment takes ~3-5 seconds (2 web searches + 2 GPT-4o calls).
 * A scan with 10 qualified leads adds ~30-50 seconds total.
 *
 * Timeout: 45 seconds maximum; if enrichment takes longer the lead is saved
 * without enrichment data and can be enriched later via the saved leads UI.
 *
 * @param companyNames - Companies mentioned in the article (first is primary)
 * @param founderNames - Founders/key people mentioned (first is primary)
 * @param region - Geographic region for search context (e.g. "Singapore")
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

    return buildEmptyEnrichmentResult();
  }

  const primaryCompany = companyNames[0];

  try {
    // Run enrichment with a timeout to prevent blocking the scan pipeline
    const enrichment = await Promise.race([
      enrichSavedLead({
        companyNames,
        founderNames,
        region,
      }),
      createTimeoutPromise<never>(ENRICHMENT_TIMEOUT_MS, "Enrichment timed out"),
    ]);

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
      reason:
        `LinkedIn: ${result.founderLinkedInUrl ? "found" : "not found"}, ` +
        `Bio: ${result.founderBio ? "yes" : "no"}, ` +
        `Company: ${result.companyDescription ? "yes" : "no"}`,
      confidenceScore,
      durationMs: Date.now() - startTime,
    });

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    log(`[Pipeline S7] Enrichment failed for ${primaryCompany}: ${errorMessage}`, "pipeline");

    return buildEmptyEnrichmentResult();
  }
}

// ============================================================================
// Stage 7 Helpers
// ============================================================================

/**
 * Returns an empty enrichment result used when enrichment is skipped or fails.
 * The lead proceeds through the pipeline without enrichment data; the user
 * can manually trigger enrichment later from the saved leads UI.
 */
function buildEmptyEnrichmentResult(): EnrichmentResult {
  return {
    founderLinkedInUrl: null,
    founderBio: null,
    companyDescription: null,
    enrichmentData: {},
    confidenceScore: 0,
  };
}

/**
 * Converts qualitative confidence levels from the enrichment subsystem
 * (founder-enrichment.ts) into a numeric 0-100 score for consistent
 * pipeline reporting and audit logging.
 *
 * When both founder and company confidence are available, returns the average.
 * When only one is available, returns that score. When neither exists, returns 0.
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
