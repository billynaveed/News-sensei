import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { storage } from "./storage";
import { sendLeadAlertEmail } from "./sendgrid";
import { sendLeadAlertTelegram, sendCostAlert } from "./telegram";
import { fetchAllArticles, type RawArticle, type RssFeedWithMeta } from "./adapters";
import type { InsertLead, PriorityLevel, SourceTier, SourceSearched, ArticleProcessed, ScrapingBeeDebugEntry } from "@shared/schema";
import { CostTracker, type TokenUsage } from "./ai-cost-tracker";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const anthropic = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY })
  : null;

/**
 * Tier 1: Semantic relevance check to filter articles before expensive extraction
 */
async function semanticRelevanceCheck(
  article: RawArticle,
  keywords: string[]
): Promise<{ relevant: boolean; confidence: string; reason: string; tokensUsed: TokenUsage; modelUsed: string } | null> {
  const prompt = `Is this article relevant for private banking wealth leads?

Article: ${article.headline}
Content: ${article.content.slice(0, 500)}

Target events: ${keywords.join(", ")}

Return JSON:
{
  "relevant": true/false,
  "confidence": "high" | "medium" | "low",
  "reason": "brief 1-sentence explanation"
}`;

  // Try GPT-4o-mini first
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 100,
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(response.choices[0].message.content || "{}");
    return {
      ...result,
      tokensUsed: {
        input: response.usage?.prompt_tokens || 0,
        output: response.usage?.completion_tokens || 0,
      },
      modelUsed: "gpt-4o-mini",
    };
  } catch (error) {
    console.log("GPT-4o-mini failed, trying Claude Haiku...", error);

    // Fallback to Claude Haiku
    if (anthropic) {
      try {
        const response = await anthropic.messages.create({
          model: "claude-3-5-haiku-20241022",
          max_tokens: 100,
          messages: [{ role: "user", content: prompt }],
        });

        const content = response.content[0].type === "text" ? response.content[0].text : "{}";
        const result = JSON.parse(content);
        return {
          ...result,
          tokensUsed: {
            input: response.usage.input_tokens,
            output: response.usage.output_tokens,
          },
          modelUsed: "claude-haiku",
        };
      } catch (claudeError) {
        console.error("Claude Haiku also failed", claudeError);
      }
    }

    // Both failed
    return null;
  }
}

/**
 * Determine if an article should proceed to Tier 2 based on confidence threshold
 */
function shouldProceedToTier2(
  confidence: string,
  threshold: "conservative" | "balanced" | "aggressive"
): boolean {
  switch (threshold) {
    case "conservative":
      return confidence === "high";
    case "balanced":
      return confidence === "high" || confidence === "medium";
    case "aggressive":
      return true;
    default:
      return confidence === "high" || confidence === "medium";
  }
}

async function extractLeadInfo(article: RawArticle, keywords: string[], summaryLength: string): Promise<(Partial<InsertLead> & { tokensUsed: TokenUsage }) | null> {
  const summaryPrompt = summaryLength === "brief" 
    ? "Write a 1-2 sentence summary."
    : summaryLength === "detailed"
    ? "Write a detailed paragraph summary."
    : "Write a summary with actionable recommendations for a private banker.";

  const prompt = `Analyze this news article and extract wealth-related lead information for a private banker.

Article:
Headline: ${article.headline}
Source: ${article.source}
Content: ${article.content}

Extract and return a JSON object with:
1. "companyNames": array of company names mentioned
2. "companyDescription": a single one-line description (max 100 chars) of the main company's business/industry. Format: "Company that does X" or "X company focused on Y"
3. "founderNames": array of founder/key person names mentioned
4. "investors": array of investors mentioned (if any)
5. "summary": ${summaryPrompt}
6. "matchedKeywords": array of these keywords that match: ${keywords.join(", ")}
7. "priorityScore": number 1-100 based on wealth potential (consider deal size, founder liquidity, timing)
8. "priorityLevel": "high" (score 70+), "medium" (score 40-69), or "low" (score below 40)

Return only valid JSON, no markdown.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 1024,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    const extracted = JSON.parse(content);

    return {
      headline: article.headline,
      sourceUrl: article.url,
      sourceName: article.source,
      sourceTier: article.sourceTier,
      publishedAt: article.publishedAt,
      companyNames: extracted.companyNames || [],
      companyDescription: extracted.companyDescription || null,
      founderNames: extracted.founderNames || [],
      investors: extracted.investors || [],
      aiSummary: extracted.summary || "",
      matchedKeywords: extracted.matchedKeywords || [],
      priorityScore: extracted.priorityScore || 50,
      priorityLevel: extracted.priorityLevel || "medium",
      region: article.region,
      status: "new",
      fetchMethod: article.fetchMethod,
      tokensUsed: {
        input: response.usage?.prompt_tokens || 0,
        output: response.usage?.completion_tokens || 0,
      },
    };
  } catch (error) {
    console.error("Error extracting lead info:", error);
    return null;
  }
}

export interface ScanProgress {
  status: "scanning" | "processing" | "complete" | "error";
  currentSource?: string;
  articlesFound?: number;
  articlesProcessed?: number;
  totalArticles?: number;
  message?: string;
}

export interface ScanLogEvent {
  timestamp: number;
  type: "info" | "success" | "warning" | "error";
  message: string;
  details?: any;
}

const scanProgress: Map<string, ScanProgress> = new Map();
const scanLogs: Map<string, ScanLogEvent[]> = new Map();

export function getScanProgress(scanId: string): ScanProgress | undefined {
  return scanProgress.get(scanId);
}

export function getScanLogs(scanId: string): ScanLogEvent[] {
  return scanLogs.get(scanId) || [];
}

function addScanLog(scanId: string, type: "info" | "success" | "warning" | "error", message: string, details?: any) {
  if (!scanLogs.has(scanId)) {
    scanLogs.set(scanId, []);
  }
  const logs = scanLogs.get(scanId)!;
  logs.push({
    timestamp: Date.now(),
    type,
    message,
    details,
  });
  // Keep only last 500 logs to prevent memory issues
  if (logs.length > 500) {
    logs.shift();
  }
}

export async function scanForLeads(scanId?: string): Promise<{ articlesScanned: number; matchesFound: number; newLeads: number; duplicatesSkipped: number; scanId: string }> {
  const currentScanId = scanId || crypto.randomUUID();
  const startTime = Date.now();

  // Initialize logs for this scan
  scanLogs.set(currentScanId, []);

  scanProgress.set(currentScanId, { status: "scanning", message: "Initializing scan..." });
  addScanLog(currentScanId, "info", "🚀 Starting new scan...");

  const settings = await storage.getSettings();
  if (!settings) {
    scanProgress.set(currentScanId, { status: "error", message: "Settings not configured" });
    addScanLog(currentScanId, "error", "Settings not configured");
    // Keep logs for 5 minutes after completion
    setTimeout(() => {
      scanProgress.delete(currentScanId);
      scanLogs.delete(currentScanId);
    }, 300000);
    throw new Error("Settings not configured");
  }

  addScanLog(currentScanId, "info", "Settings loaded successfully", {
    keywords: settings.keywords.length,
    regions: settings.regions.length,
    googleNewsEnabled: settings.googleNewsEnabled,
    rssEnabled: settings.rssEnabled,
    scrapingBeeEnabled: settings.scrapingBeeEnabled,
  });
  
  const runCleanup = async () => {
    try {
      await storage.cleanupOldScanLogs(settings.logRetentionDays ?? 2);
    } catch (e) {
      console.error("Error cleaning up old scan logs:", e);
    }
  };

  scanProgress.set(currentScanId, { status: "scanning", message: "Fetching news from enabled sources..." });
  addScanLog(currentScanId, "info", "📰 Fetching articles from enabled sources...");

  try {
    const activeSources = await storage.getActiveSources();
    const activeFeeds = await storage.getAllActiveRssFeeds();

    addScanLog(currentScanId, "info", `Found ${activeSources.length} active sources and ${activeFeeds.length} RSS feeds`);

    const feedsWithMeta: RssFeedWithMeta[] = activeFeeds.map(feed => ({
      ...feed,
      sourceName: feed.sourceName,
      sourceTier: feed.sourceTier,
    }));

    const defaultRegion = settings.regions[0] || "Singapore";

    addScanLog(currentScanId, "info", "🔍 Searching with keywords", {
      keywords: settings.keywords.slice(0, 5).join(", ") + (settings.keywords.length > 5 ? "..." : ""),
      totalKeywords: settings.keywords.length
    });

    const { articles, sourcesSearched, errors: fetchErrors, debugEntries } = await fetchAllArticles(
      activeSources,
      feedsWithMeta,
      settings.keywords,
      {
        googleNewsEnabled: settings.googleNewsEnabled ?? false,
        rssEnabled: settings.rssEnabled ?? true,
        scrapingBeeEnabled: settings.scrapingBeeEnabled ?? false,
        defaultRegion,
      }
    );

    // Log sources searched
    for (const source of sourcesSearched) {
      addScanLog(currentScanId, "success", `✓ ${source.name}: Found ${source.articlesFound} articles`, {
        tier: source.tier,
        articlesFound: source.articlesFound,
      });
    }

    // Log fetch errors
    if (fetchErrors.length > 0) {
      for (const error of fetchErrors) {
        addScanLog(currentScanId, "warning", `⚠️ ${error}`);
      }
    }

    scanProgress.set(currentScanId, {
      status: "processing",
      currentSource: "Multiple sources",
      articlesFound: articles.length,
      articlesProcessed: 0,
      totalArticles: articles.length,
      message: `Found ${articles.length} matching articles, processing...`
    });

    addScanLog(currentScanId, "info", `🤖 Processing ${articles.length} articles with two-tier AI pipeline...`);

    // Initialize cost tracker
    const costTracker = new CostTracker();
    const modelsFailed: string[] = [];
    let tier1Filtered = 0;

    // Check daily cost limit before scan
    const dailySpending = await storage.getDailySpending();
    const costLimit = settings.dailyCostLimitUsd || 10.0;
    if (dailySpending >= costLimit) {
      const message = `❌ Daily cost limit exceeded: $${dailySpending.toFixed(2)} / $${costLimit.toFixed(2)}`;
      if (settings.telegramEnabled && settings.telegramChatId) {
        await sendCostAlert(settings.telegramChatId, "limit_exceeded", {
          currentCost: dailySpending,
          limit: costLimit,
          message
        });
      }
      addScanLog(currentScanId, "error", message);
      throw new Error(message);
    }

    addScanLog(currentScanId, "info", `💰 Daily spending: $${dailySpending.toFixed(4)} / $${costLimit.toFixed(2)}`);

    let newLeads = 0;
    let duplicatesSkipped = 0;
    const createdLeads: InsertLead[] = [];
    const articlesProcessed: ArticleProcessed[] = [];
    const errors: string[] = [...fetchErrors];

    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];

      scanProgress.set(currentScanId, {
        status: "processing",
        currentSource: article.source,
        articlesFound: articles.length,
        articlesProcessed: i,
        totalArticles: articles.length,
        message: `Processing: ${article.headline.substring(0, 50)}...`
      });

      // Log every article being processed
      addScanLog(currentScanId, "info", `Processing (${i + 1}/${articles.length}): ${article.headline.substring(0, 60)}...`, {
        source: article.source,
        url: article.url,
      });

      // Check cost limit during scan (soft check at 80%)
      const currentSpending = await storage.getDailySpending();
      if (currentSpending >= costLimit * 0.8 && currentSpending < costLimit) {
        if (settings.telegramEnabled && settings.telegramChatId) {
          await sendCostAlert(settings.telegramChatId, "approaching_limit", {
            currentCost: currentSpending,
            limit: costLimit,
            message: `⚠️ Approaching cost limit: $${currentSpending.toFixed(2)} / $${costLimit.toFixed(2)}`
          });
        }
      }

      // Duplicate check
      const existingLead = await storage.getLeadByUrl(article.url);
      if (existingLead) {
        duplicatesSkipped++;
        addScanLog(currentScanId, "warning", `⏭️ Duplicate skipped: ${article.headline.substring(0, 60)}...`);
        articlesProcessed.push({
          headline: article.headline,
          source: article.source,
          region: article.region,
          status: "skipped",
          reason: "Duplicate - already in database",
          fetchMethod: article.fetchMethod,
        });
        continue;
      }

      try {
        // TIER 1: Semantic relevance check
        const relevanceCheck = await semanticRelevanceCheck(article, settings.keywords);

        if (!relevanceCheck) {
          // Both AI models failed - use keyword fallback
          const hasKeyword = settings.keywords.some(kw =>
            article.headline.toLowerCase().includes(kw.toLowerCase()) ||
            article.content.toLowerCase().includes(kw.toLowerCase())
          );

          if (!hasKeyword) {
            // Log and skip
            addScanLog(currentScanId, "warning", `⊘ AI filter failed, no keyword match: ${article.headline.substring(0, 60)}...`);
            articlesProcessed.push({
              headline: article.headline,
              source: article.source,
              region: article.region,
              status: "skipped",
              reason: "No keyword match (AI filter failed)",
              fetchMethod: article.fetchMethod,
            });

            modelsFailed.push("tier1-both");
            continue;
          }

          // Passed keyword fallback, send alert
          if (settings.telegramEnabled && settings.telegramChatId) {
            await sendCostAlert(settings.telegramChatId, "model_failure", {
              message: `⚠️ AI filters failed for article: ${article.headline}. Using keyword fallback.`
            });
          }
          addScanLog(currentScanId, "warning", `⚠️ AI models failed, using keyword fallback for: ${article.headline.substring(0, 60)}...`);
        } else {
          // Track Tier 1 tokens
          costTracker.addTier1(relevanceCheck.tokensUsed, relevanceCheck.modelUsed);

          // Check confidence threshold
          if (!shouldProceedToTier2(relevanceCheck.confidence, settings.confidenceThreshold || "balanced")) {
            addScanLog(currentScanId, "info", `⊘ Low confidence (${relevanceCheck.confidence}): ${article.headline.substring(0, 60)}...`);
            articlesProcessed.push({
              headline: article.headline,
              source: article.source,
              region: article.region,
              status: "skipped",
              reason: `Low confidence (${relevanceCheck.confidence}): ${relevanceCheck.reason}`,
              fetchMethod: article.fetchMethod,
            });
            tier1Filtered++;
            continue;
          }

          addScanLog(currentScanId, "success", `✓ Tier 1 passed (${relevanceCheck.confidence}): ${article.headline.substring(0, 60)}...`);
        }

        // TIER 2: Full extraction
        const leadInfo = await extractLeadInfo(article, settings.keywords, settings.summaryLength);

        if (!leadInfo) {
          addScanLog(currentScanId, "error", `❌ Tier 2 extraction failed: ${article.headline.substring(0, 60)}...`);
          articlesProcessed.push({
            headline: article.headline,
            source: article.source,
            region: article.region,
            status: "error",
            reason: "Extraction failed",
            fetchMethod: article.fetchMethod,
          });
          continue;
        }

        // Track Tier 2 tokens
        costTracker.addTier2(leadInfo.tokensUsed, "gpt-4o");

        // Validate and create lead
        if (!leadInfo.companyNames || leadInfo.companyNames.length === 0) {
          addScanLog(currentScanId, "info", `⊘ No companies found in: ${article.headline.substring(0, 60)}...`);
          articlesProcessed.push({
            headline: article.headline,
            source: article.source,
            region: article.region,
            status: "skipped",
            reason: "No company names extracted",
            fetchMethod: article.fetchMethod,
          });
          continue;
        }

        // Create lead
        const { tokensUsed, ...leadData } = leadInfo;
        await storage.createLead(leadData as InsertLead);
        createdLeads.push(leadData as InsertLead);
        newLeads++;
        addScanLog(currentScanId, "success", `✨ New lead created: ${leadInfo.companyNames.join(", ")}`, {
          headline: article.headline,
          priorityLevel: leadInfo.priorityLevel,
          priorityScore: leadInfo.priorityScore,
        });
        articlesProcessed.push({
          headline: article.headline,
          source: article.source,
          region: article.region,
          status: "success",
          fetchMethod: article.fetchMethod,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        errors.push(`Error processing "${article.headline}": ${errorMessage}`);
        addScanLog(currentScanId, "error", `❌ Error processing article: ${errorMessage}`, {
          headline: article.headline.substring(0, 60),
        });
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

    addScanLog(currentScanId, "info", "💾 Saving scan results to database...");

    // Get cost totals
    const costTotals = costTracker.getTotals();

    addScanLog(currentScanId, "info", `💰 Total cost: $${costTotals.totalCostUsd.toFixed(4)} (Tier 1: $${costTotals.tier1CostUsd.toFixed(4)}, Tier 2: $${costTotals.tier2CostUsd.toFixed(4)})`);

    await storage.createScanLog({
      articlesScanned: articles.length,
      matchesFound: articles.length,
      newLeads,
      duplicatesSkipped,
      durationMs,
      sourcesSearched,
      articlesProcessed,
      errors: errors.length > 0 ? errors : null,
      scrapingBeeDebug: debugEntries.length > 0 ? debugEntries : null,
      tier1TokensUsed: costTotals.tier1TokensUsed,
      tier2TokensUsed: costTotals.tier2TokensUsed,
      tier1CostUsd: costTotals.tier1CostUsd,
      tier2CostUsd: costTotals.tier2CostUsd,
      totalCostUsd: costTotals.totalCostUsd,
      modelsFailed: modelsFailed.length > 0 ? modelsFailed : null,
      tier1Filtered,
    });

    scanProgress.set(currentScanId, {
      status: "complete",
      articlesFound: articles.length,
      articlesProcessed: articles.length,
      totalArticles: articles.length,
      message: `Complete! ${newLeads} new leads found.`
    });

    addScanLog(currentScanId, "success", `🎉 Scan complete!`, {
      articlesScanned: articles.length,
      newLeads,
      duplicatesSkipped,
      duration: `${(durationMs / 1000).toFixed(1)}s`,
    });

    if (settings.emailEnabled && settings.alertEmail && createdLeads.length > 0) {
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
            await sendLeadAlertEmail(settings.alertEmail, newHighPriorityLeads);
          }
        } catch (error) {
          console.error("Error sending lead alert email:", error);
        }
      }
    }

    if (settings.telegramEnabled && settings.telegramChatId && createdLeads.length > 0) {
      try {
        const leads = await storage.getAllLeads();
        const newLeadsWithIds = leads.filter(l =>
          l.status === "new" &&
          createdLeads.some(cl => cl.sourceUrl === l.sourceUrl)
        );
        if (newLeadsWithIds.length > 0) {
          addScanLog(currentScanId, "info", `📱 Sending ${newLeadsWithIds.length} leads to Telegram...`);
          await sendLeadAlertTelegram(settings.telegramChatId, newLeadsWithIds);
          addScanLog(currentScanId, "success", `✓ Telegram notification sent`);
        }
      } catch (error) {
        console.error("Error sending Telegram alert:", error);
        addScanLog(currentScanId, "error", `Failed to send Telegram notification: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    // Keep logs for 5 minutes after completion
    setTimeout(() => {
      scanProgress.delete(currentScanId);
      scanLogs.delete(currentScanId);
    }, 300000);

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
