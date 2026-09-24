import { storage } from "./storage";
import { sendLeadAlertTelegram } from "./telegram";
import { fetchAllArticles, type RawArticle, type RssFeedWithMeta } from "./adapters";
import { callJsonStage } from "./llm-json";
import { getPrompt, render } from "./prompts";
import { enrichSavedLead, formatEnrichmentForSavedLead } from "./founder-enrichment";
import { passesInterestFilter, extractPrimaryCompany, isPublicCompany, checkDuplication } from "./pipeline-stages";
import { validateSeaAnchor } from "./sea-guard";
import { priorityLevelFor } from "./lead-scoring";
import { matchesBusinessPrefilter } from "./prefilter";
import { buildNegativeExamplesBlock } from "./feedback-prompt";
import { linkLeadFoundersToContacts } from "./contacts";
import { foundersKeepLead } from "./founder-geo";
import { shouldAttemptGeoRescue, resolveCompanyHq, hqNote } from "./geo-rescue";
import { discoverFounders } from "./founder-discovery";
import { scrapeUrl, extractArticleText } from "./scraper";
import { log } from "./log";
import type { InsertLead, PriorityLevel, SourceTier, FetchMethod, SourceSearched, ArticleProcessed, ScrapingBeeDebugEntry, Settings } from "@shared/schema";


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

  // Fetch the full page through the scraping provider when the snippet is thin
  // or the source is Tier 1 (paywalled/premium). Deep analysis needs the body:
  // a 300-char RSS snippet rarely names founders or deal terms.
  const minChars = parseInt(process.env.SCRAPER_S5_MIN_CHARS || "1500", 10);
  if (sourceTier === "tier1" || article.content.length < minChars) {
    const scraped = await scrapeUrl(article.url, { timeoutMs: 20_000 });
    if (scraped.ok) {
      const { text } = extractArticleText(scraped.body);
      if (text.length > article.content.length) {
        logPipelineDecision({
          stage: 5,
          stageName: "Full Article Fetch",
          articleHeadline: article.headline,
          decision: "SCRAPED",
          reason: `Fetched ${text.length} chars via ${scraped.provider}${scraped.cost ? ` (${scraped.cost} credits)` : ""}`,
          confidenceScore: 95,
          durationMs: Date.now() - startTime,
        });
        return { fullContent: text, fetchMethod: "scraped", contentLength: text.length };
      }
    } else if (scraped.provider !== "none") {
      log(`[Pipeline S5] scrape failed (${scraped.error}), falling back to existing content`, "pipeline");
    }
  }

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

  const prompt = render(await getPrompt("stage6_analysis"), {
    headline: article.headline,
    source: article.source,
    content: fullContent.slice(0, 6000),
    regions: targetRegions.join(", "),
  });

  try {
    const extracted = await callJsonStage<any>({
      model: "google/gemini-2.5-flash-lite",
      prompt,
      maxTokens: 3000,
      temperature: 0.2,
      label: "S6 Deep Analysis",
    });

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
    const priorityLevel: PriorityLevel = priorityLevelFor(priorityScore);

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

/** Which per-scan skip counter (if any) an article outcome should increment. */
type SkipCounter = "interestFiltered" | "noCompanySkipped" | "publicCompaniesFiltered" | "duplicatesSkipped";

interface ArticleOutcome {
  /** The scan-log entry for this article (always present, exactly one per article). */
  processed: ArticleProcessed;
  /** Skip counter to bump, if this article was filtered out. */
  bump?: SkipCounter;
  /** The created lead, if the article produced one (already persisted). */
  lead?: InsertLead;
  /** Whether enrichment added founder bio or company description (for enrichedCount). */
  enriched?: boolean;
  /** Error message to append to the scan's error list, if the pipeline threw. */
  error?: string;
}

/**
 * Runs one article through the full pipeline (pre-filter → S1 interest →
 * S2 company → S3 public → S4 dedup → S5 content → S6 analysis → S7 enrichment),
 * persisting a lead on success. Returns a structured outcome the scan loop uses
 * to update counters/logs — extracted from scanForLeads so each stage is legible
 * and the orchestration stays flat. Behavior is identical to the prior inline loop.
 */
export interface ProcessOptions {
  /**
   * Judge only: run the decision stages (S1-S3, S5-S6b) but skip dedup gates
   * and never persist a lead. Used by the nightly reference-example run, where
   * an article that is already a lead must still be judged on its merits.
   */
  dryRun?: boolean;
}

async function processArticle(
  article: RawArticle,
  filterPrompt: string,
  settings: Settings,
  opts: ProcessOptions = {},
): Promise<ArticleOutcome> {
  const base = {
    headline: article.headline,
    source: article.source,
    region: article.region,
    fetchMethod: article.fetchMethod,
    url: article.url,
  };

  // --- Pre-check 0: Cheap keyword pre-filter (no API call) ---
  if (!matchesBusinessPrefilter(article)) {
    return { processed: { ...base, status: "skipped", reason: "Pre-filter: no business keywords found" } };
  }

  // --- Pre-check 1: URL dedup (free, no API call) ---
  const existingLead = opts.dryRun ? undefined : await storage.getLeadByUrl(article.url);
  if (existingLead) {
    return {
      processed: { ...base, status: "skipped", reason: "Duplicate - URL already in database" },
      bump: "duplicatesSkipped",
    };
  }

  try {
    // --- Stage 1: Interest Filter (cheap 256-token call) ---
    let interestResult = await passesInterestFilter(article, filterPrompt, settings.regions);
    let verifiedNote: string | null = null;
    if (!interestResult.passes && shouldAttemptGeoRescue(article, interestResult.reason)) {
      // --- Stage 1b: Geography rescue. S1 only sees the snippet, so a SEA
      // company whose HQ isn't stated there gets rejected as "non-SEA". For
      // deal-shaped articles, verify the subject company's HQ before giving up.
      const probe = await extractPrimaryCompany(article);
      if (probe.companyName) {
        const hq = await resolveCompanyHq(probe.companyName);
        if (hq.isSea) {
          verifiedNote = hqNote(hq);
          interestResult = {
            passes: true,
            reason: `hq_verified (${hq.resolvedVia}): ${probe.companyName} — ${[hq.hqCity, hq.hqCountry].filter(Boolean).join(", ") || hq.founderBase}; S1 had said: ${interestResult.reason}`,
            confidenceScore: hq.confidence,
          };
          log(`[Pipeline S1b] RESCUED "${article.headline}" — ${verifiedNote}`, "pipeline");
        } else {
          log(`[Pipeline S1b] no rescue for ${probe.companyName} (${hq.resolvedVia}: ${hq.hqCountry ?? "unknown"})`, "pipeline");
        }
      }
    }
    if (!interestResult.passes) {
      return {
        processed: { ...base, status: "skipped", reason: `S1 Interest filter: ${interestResult.reason}` },
        bump: "interestFiltered",
      };
    }
    if (verifiedNote) article = { ...article, content: `${verifiedNote} ${article.content}` };

    // --- Stage 2: Extract Primary Company ---
    const companyResult = await extractPrimaryCompany(article);
    if (!companyResult.companyName) {
      return {
        processed: { ...base, status: "skipped", reason: "S2 No company identified" },
        bump: "noCompanySkipped",
      };
    }
    const companyName = companyResult.companyName;

    // --- Stage 3: Public Company Filter ---
    const publicResult = await isPublicCompany(companyName, article.headline);
    if (publicResult.isPublic) {
      return {
        processed: { ...base, status: "skipped", reason: `S3 Public company filtered: ${publicResult.reason}` },
        bump: "publicCompaniesFiltered",
      };
    }

    // --- Stage 4a: In-database company+story dedup (last 7 days) ---
    const recentLeads = opts.dryRun ? [] : await storage.getRecentLeadsByCompany(companyName, 7);
    if (recentLeads && recentLeads.length > 0) {
      return {
        processed: { ...base, status: "skipped", reason: `S4a Already have ${recentLeads.length} lead(s) about ${companyName} from past 7 days` },
        bump: "duplicatesSkipped",
      };
    }

    // --- Stage 4b: Smart Deduplication (against saved leads) ---
    const dedupResult = opts.dryRun ? { isDuplicate: false } as Awaited<ReturnType<typeof checkDuplication>> : await checkDuplication(companyName, article.headline, article.content.slice(0, 500));
    if (dedupResult.isDuplicate) {
      return {
        processed: { ...base, status: "skipped", reason: `S4b Duplicate: ${dedupResult.reason}` },
        bump: "duplicatesSkipped",
      };
    }

    // --- Stage 5: Full Article Content (Tier 1 only, uses ScrapingBee) ---
    const sourceTier = article.sourceTier || "tier3";
    const contentResult = await fetchFullArticleContent(article, sourceTier as SourceTier);
    const fullContent = verifiedNote ? `${verifiedNote} ${contentResult.fullContent}` : contentResult.fullContent;

    // --- Stage 6: Deep Analysis ---
    const deepResult = await deepAnalyzeArticle(article, fullContent, settings.regions);
    if (!deepResult) {
      return { processed: { ...base, status: "skipped", reason: "S6 Deep analysis rejected (not relevant or error)" } };
    }

    // --- Stage 6a: Founder discovery. Wire stories about an acquisition often
    // name only the acquirer's people; the target's founders are the lead.
    // Runs for every medium+ lead: the model often names whoever is quoted
    // (an acquirer exec) rather than the target's founders. Discovered founders
    // go first; names the article gave are kept after them.
    if ((deepResult.leadData.priorityScore ?? 0) >= 50) {
      const found = await discoverFounders(companyName, article.region || settings.regions[0] || null);
      if (found.length > 0) {
        const existing = (deepResult.leadData.founderNames || []).filter((n) => !found.some((f) => f.name.toLowerCase() === n.toLowerCase()));
        deepResult.leadData.founderNames = [...found.map((f) => f.name), ...existing];
        const roles = found.map((f) => `${f.name}${f.role ? ` (${f.role})` : ""}${f.location ? `, ${f.location}` : ""}`).join("; ");
        deepResult.leadData.aiSummary = `${deepResult.leadData.aiSummary || ""} ${companyName} founders (web-identified): ${roles}.`.trim();
      }
    }

    // --- Stage 6b: Founder geography (ask the model where the person lives) ---
    const geoCheck = await foundersKeepLead(
      deepResult.leadData.founderNames || [],
      deepResult.leadData.companyNames || [companyName],
    );
    if (!geoCheck.keep) {
      return { processed: { ...base, status: "skipped", reason: `S6b Geo: ${geoCheck.reason}` }, bump: "interestFiltered" };
    }

    // --- Stage 7: Enrichment via Tavily/Brave web search ---
    let enrichResult: EnrichmentResult | null = null;
    try {
      const founderNames = deepResult.leadData.founderNames || [];
      const companyNames = deepResult.leadData.companyNames || [companyName];
      const region = article.region || settings.regions[0] || "Singapore";
      enrichResult = await enrichLeadWithWebSearch(companyNames, founderNames, region);
    } catch (enrichError) {
      const msg = enrichError instanceof Error ? enrichError.message : "Unknown";
      log(`[Pipeline S7] Enrichment failed for ${companyName}: ${msg}`, "pipeline");
      // Non-fatal — save lead without enrichment
    }
    const enriched = !!(enrichResult?.founderBio || enrichResult?.companyDescription);

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
      keyFinancials: deepResult.keyFinancials,
      wealthAngle: deepResult.wealthAngle || null,
      seaConnection: deepResult.seaConnection || null,
      founderLinkedInUrl: enrichResult?.founderLinkedInUrl || null,
      founderBio: enrichResult?.founderBio || null,
      companyDescription: enrichResult?.companyDescription || null,
      fetchMethod: contentResult.fetchMethod || article.fetchMethod,
      pipelineReasoning,
    };

    if (opts.dryRun) {
      return {
        processed: { ...base, status: "success", reason: `[dry run] ${deepResult.leadData.priorityLevel} priority (score ${deepResult.leadData.priorityScore}) — ${companyName}; founders: ${(deepResult.leadData.founderNames || []).join(", ") || "none"}` },
      };
    }

    await storage.createLead(lead as InsertLead);

    // Surface the founders as contacts (non-fatal).
    await linkLeadFoundersToContacts(
      deepResult.leadData.founderNames || [],
      deepResult.leadData.companyNames || [companyName],
      article.region,
      article.url,
    ).catch(() => {});

    return {
      processed: {
        ...base,
        status: "success",
        reason: `${deepResult.leadData.priorityLevel} priority (score ${deepResult.leadData.priorityScore}), enriched=${!!enrichResult?.founderBio}`,
        fetchMethod: (contentResult.fetchMethod || article.fetchMethod) as FetchMethod | undefined,
      },
      lead: lead as InsertLead,
      enriched,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      processed: { ...base, status: "error", reason: errorMessage },
      error: `Error processing "${article.headline}": ${errorMessage}`,
    };
  }
}

/**
 * Push one article URL through the full pipeline on demand (e.g. a deal Billy
 * saw elsewhere). Fetches the page, extracts title + body, and runs the same
 * processArticle as a scan. Returns the outcome so the caller sees why an
 * article was rejected, if it was.
 */
export async function ingestArticleUrl(url: string, opts: ProcessOptions = {}): Promise<{ outcome: ArticleProcessed; leadId?: string }> {
  const settings = await storage.getSettings();
  if (!settings) throw new Error("Settings not configured");

  // Direct fetch first (free); scraping provider when the site blocks bots
  // (CoinDesk 429s plain fetches) or renders client-side (Tech in Asia).
  let html = "";
  let via = "direct";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) html = await res.text();
  } catch { /* fall through to scraper */ }
  let extracted = html ? extractArticleText(html) : { title: "", text: "", publishedAt: null };
  if (!extracted.title || extracted.text.length < 200) {
    const scraped = await scrapeUrl(url, { timeoutMs: 30_000 });
    if (scraped.ok) { extracted = extractArticleText(scraped.body); via = scraped.provider; }
    if (!extracted.title || extracted.text.length < 200) {
      const rendered = await scrapeUrl(url, { render: true, timeoutMs: 60_000 });
      if (rendered.ok) { extracted = extractArticleText(rendered.body); via = `${rendered.provider}+render`; }
    }
  }
  const headline = extracted.title;
  const content = extracted.text.slice(0, 8000);
  if (!headline || content.length < 200) throw new Error("Could not extract article text from page (direct fetch and scraper both failed)");
  log(`[Ingest] fetched ${url} via ${via} (${content.length} chars)`, "pipeline");
  const published = extracted.publishedAt;
  const article: RawArticle = {
    headline,
    url,
    source: `${new URL(url).hostname.replace(/^www\./, "")} (manual)`,
    sourceTier: "tier2",
    publishedAt: published ? new Date(published) : new Date(),
    content,
    region: settings.regions[0] || "Singapore",
    fetchMethod: "rss",
  };

  const filterPrompt = (await getPrompt("stage1_interest")) + await buildNegativeExamplesBlock("news");
  const outcome = await processArticle(article, filterPrompt, settings, opts);
  if (!opts.dryRun) await storage.recordScannedUrl(url, article.source).catch(() => {});
  if (outcome.error) throw new Error(outcome.error);
  const created = outcome.lead ? await storage.getLeadByUrl(url) : undefined;
  log(`[Ingest] ${url} → ${outcome.processed.status}: ${outcome.processed.reason}`, "pipeline");
  return { outcome: outcome.processed, leadId: created?.id };
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

    // Append user-flagged false positives so each thumbs-down sharpens the filter.
    const filterPrompt = (await getPrompt("stage1_interest"))
      + await buildNegativeExamplesBlock("news");

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

      const outcome = await processArticle(article, filterPrompt, settings);
      articlesProcessed.push(outcome.processed);
      if (outcome.error) errors.push(outcome.error);
      if (outcome.bump === "interestFiltered") interestFiltered++;
      else if (outcome.bump === "noCompanySkipped") noCompanySkipped++;
      else if (outcome.bump === "publicCompaniesFiltered") publicCompaniesFiltered++;
      else if (outcome.bump === "duplicatesSkipped") duplicatesSkipped++;
      if (outcome.lead) {
        createdLeads.push(outcome.lead);
        newLeads++;
        if (outcome.enriched) enrichedCount++;
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
