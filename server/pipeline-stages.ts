import OpenAI from "openai";
import { openai } from "./openai-client";
import { storage } from "./storage";
import { log } from "./log";
import type { RawArticle } from "./adapters";
import { stripJsonFences } from "./json-utils";

// Local gemma4 on Mac Mini via Ollama (free but slow).
// Disabled by default — Mac Mini was decommissioned 2026-05-18, ROADMAP §P0.
// To re-enable: set OLLAMA_ENABLED=true in .env.
const OLLAMA_ENABLED = process.env.OLLAMA_ENABLED === "true";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://100.110.246.23:11434/v1";
const ollama = OLLAMA_ENABLED
  ? new OpenAI({ apiKey: "ollama", baseURL: OLLAMA_BASE_URL, timeout: 120_000 })
  : null;

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
      temperature: 0.2,
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
      temperature: 0.2,
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
      temperature: 0.2,
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
      temperature: 0.2,
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
