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

      const existingLead = await storage.getLeadByUrl(article.url);
      if (existingLead) {
        duplicatesSkipped++;
        articlesProcessed.push({
          headline: article.headline,
          source: article.source,
          region: article.region,
          status: "skipped",
          reason: "Duplicate - already in database",
        });
        continue;
      }

      try {
        const leadInfo = await extractLeadInfo(article, settings.keywords, settings.summaryLength);
        if (leadInfo && leadInfo.companyNames && leadInfo.companyNames.length > 0) {
          await storage.createLead(leadInfo as InsertLead);
          createdLeads.push(leadInfo as InsertLead);
          newLeads++;
          articlesProcessed.push({
            headline: article.headline,
            source: article.source,
            region: article.region,
            status: "success",
          });
        } else {
          articlesProcessed.push({
            headline: article.headline,
            source: article.source,
            region: article.region,
            status: "skipped",
            reason: "No company names extracted",
          });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        errors.push(`Error processing "${article.headline}": ${errorMessage}`);
        articlesProcessed.push({
          headline: article.headline,
          source: article.source,
          region: article.region,
          status: "error",
          reason: errorMessage,
        });
      }
    }

    const durationMs = Date.now() - startTime;

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
