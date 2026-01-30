import OpenAI from "openai";
import { storage } from "./storage";
import { sendLeadAlertEmail } from "./sendgrid";
import { fetchAllArticles, type RawArticle, type RssFeedWithMeta } from "./adapters";
import type { InsertLead, PriorityLevel, SourceTier, SourceSearched, ArticleProcessed, ScrapingBeeDebugEntry } from "@shared/schema";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

async function extractLeadInfo(article: RawArticle, keywords: string[], summaryLength: string): Promise<Partial<InsertLead> | null> {
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
2. "founderNames": array of founder/key person names mentioned  
3. "investors": array of investors mentioned (if any)
4. "summary": ${summaryPrompt}
5. "matchedKeywords": array of these keywords that match: ${keywords.join(", ")}
6. "priorityScore": number 1-100 based on wealth potential (consider deal size, founder liquidity, timing)
7. "priorityLevel": "high" (score 70+), "medium" (score 40-69), or "low" (score below 40)

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

    addScanLog(currentScanId, "info", `🤖 Processing ${articles.length} articles with AI...`);

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
        const leadInfo = await extractLeadInfo(article, settings.keywords, settings.summaryLength);
        if (leadInfo && leadInfo.companyNames && leadInfo.companyNames.length > 0) {
          await storage.createLead(leadInfo as InsertLead);
          createdLeads.push(leadInfo as InsertLead);
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
        } else {
          addScanLog(currentScanId, "info", `⊘ No companies found in: ${article.headline.substring(0, 60)}...`);
          articlesProcessed.push({
            headline: article.headline,
            source: article.source,
            region: article.region,
            status: "skipped",
            reason: "No company names extracted",
            fetchMethod: article.fetchMethod,
          });
        }
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
