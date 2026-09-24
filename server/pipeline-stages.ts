import { storage } from "./storage";
import { log } from "./log";
import type { RawArticle } from "./adapters";
import { callJsonStage } from "./llm-json";
import { getPrompt, render } from "./prompts";

const STAGE_MODEL = "google/gemini-2.5-flash-lite";

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

  // The editable criteria block (Stage 1) is supplied by the caller; the
  // regional rules, article and output shape are appended from the prompt store.
  const prompt =
    `${filterPrompt}\n\n` +
    render(await getPrompt("stage1_regional_rules"), {
      regions: regionsStr,
      headline: article.headline,
      snippet: article.content.slice(0, 500),
      source: article.source,
    });

  try {
    const result = await callJsonStage<any>({
      model: STAGE_MODEL,
      prompt,
      maxTokens: 256,
      temperature: 0.2,
      label: "S1 Interest Filter",
    });
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

  const prompt = render(await getPrompt("stage2_company"), {
    headline: article.headline,
    content: article.content.slice(0, 500),
  });

  try {
    const result = await callJsonStage<any>({
      model: STAGE_MODEL,
      prompt,
      maxTokens: 128,
      temperature: 0.2,
      label: "S2 Company Extraction",
    });
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

  const prompt = render(await getPrompt("stage3_public"), {
    companyName,
    headline: articleHeadline,
  });

  try {
    const result = await callJsonStage<any>({
      model: STAGE_MODEL,
      prompt,
      maxTokens: 256,
      temperature: 0.2,
      label: "S3 Public Company Filter",
    });
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

      const prompt = render(await getPrompt("stage4_dedup"), {
      existingSummary,
      headline: newArticleHeadline,
      snippet: newArticleSnippet.slice(0, 500),
    });

    const comparison = await callJsonStage<any>({
      model: STAGE_MODEL,
      prompt,
      maxTokens: 256,
      temperature: 0.2,
      label: "S4 Deduplication",
    });
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
