import OpenAI from "openai";
import { storage } from "./storage";
import { sendLeadAlertEmail } from "./sendgrid";
import type { InsertLead, PriorityLevel, SourceTier, SourceSearched, ArticleProcessed } from "@shared/schema";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

interface SimulatedArticle {
  headline: string;
  url: string;
  source: string;
  sourceTier: SourceTier;
  publishedAt: Date;
  content: string;
  region: string;
}

function generateSimulatedArticles(keywords: string[], regions: string[]): SimulatedArticle[] {
  const articles: SimulatedArticle[] = [
    {
      headline: "Singapore fintech startup Grab acquires stake in regional logistics firm for $450M",
      url: "https://example.com/grab-acquisition-" + Date.now(),
      source: "The Business Times",
      sourceTier: "tier1",
      publishedAt: new Date(Date.now() - Math.random() * 86400000 * 3),
      content: "Singapore-based super app Grab has announced the acquisition of a 35% stake in a leading Southeast Asian logistics company for $450 million. The deal marks one of the largest M&A transactions in the region this year. Founder Anthony Tan said the investment aligns with their long-term growth strategy.",
      region: "Singapore",
    },
    {
      headline: "Hong Kong PE firm completes $2B exit from manufacturing giant",
      url: "https://example.com/hk-pe-exit-" + Date.now(),
      source: "South China Morning Post",
      sourceTier: "tier1",
      publishedAt: new Date(Date.now() - Math.random() * 86400000 * 2),
      content: "A Hong Kong-based private equity firm has completed a landmark $2 billion exit from its investment in a major manufacturing conglomerate. The founders, including Li Wei Ming, are expected to realize significant personal gains from the transaction.",
      region: "Hong Kong",
    },
    {
      headline: "Vietnamese unicorn prepares for Nasdaq IPO valued at $3.5B",
      url: "https://example.com/vietnam-ipo-" + Date.now(),
      source: "VnExpress",
      sourceTier: "tier2",
      publishedAt: new Date(Date.now() - Math.random() * 86400000),
      content: "VNG Corporation, Vietnam's first unicorn, is preparing for a Nasdaq listing that could value the company at $3.5 billion. Founder Le Hong Minh has built the tech giant over two decades. Major investors include Tencent and GIC.",
      region: "Vietnam",
    },
    {
      headline: "Taiwan semiconductor founders cash out $800M in secondary sale",
      url: "https://example.com/taiwan-secondary-" + Date.now(),
      source: "Taiwan News",
      sourceTier: "tier2",
      publishedAt: new Date(Date.now() - Math.random() * 86400000 * 4),
      content: "The founding family of a leading Taiwan-based semiconductor supplier has sold an $800 million stake in a secondary transaction. The Chen family, led by patriarch Chen Ming-tao, retains a controlling interest in the company.",
      region: "Taiwan",
    },
    {
      headline: "Indonesian ride-hailing startup raises Series D at $1.2B valuation",
      url: "https://example.com/indo-series-d-" + Date.now(),
      source: "Tech in Asia",
      sourceTier: "tier2",
      publishedAt: new Date(Date.now() - Math.random() * 86400000 * 2),
      content: "Jakarta-based mobility startup has closed a $150 million Series D funding round, reaching unicorn status with a $1.2 billion valuation. Co-founders Agus Prasetyo and Maria Wijaya are now among Indonesia's youngest tech billionaires.",
      region: "Indonesia",
    },
    {
      headline: "Malaysian palm oil magnate divests family holdings for $600M",
      url: "https://example.com/malaysia-divestiture-" + Date.now(),
      source: "The Edge Markets",
      sourceTier: "tier1",
      publishedAt: new Date(Date.now() - Math.random() * 86400000 * 5),
      content: "Tycoon Tan Sri Robert Kuok's extended family has divested palm oil plantation holdings worth approximately $600 million. The asset sale is part of a broader family office restructuring.",
      region: "Malaysia",
    },
    {
      headline: "Thai real estate conglomerate announces $1.5B SPAC merger",
      url: "https://example.com/thai-spac-" + Date.now(),
      source: "Bangkok Post",
      sourceTier: "tier2",
      publishedAt: new Date(Date.now() - Math.random() * 86400000),
      content: "Central Group's property arm is set to go public through a $1.5 billion SPAC merger. The Chirathivat family, which controls the retail empire, will see their real estate holdings listed on the NYSE.",
      region: "Thailand",
    },
    {
      headline: "Philippine fintech founder sells majority stake to Japanese bank",
      url: "https://example.com/ph-fintech-sale-" + Date.now(),
      source: "Philippine Daily Inquirer",
      sourceTier: "tier3",
      publishedAt: new Date(Date.now() - Math.random() * 86400000 * 3),
      content: "The founder of a leading Philippine digital bank has sold a 51% stake to a major Japanese financial institution. Entrepreneur Carlos Santos is expected to realize over $200 million from the trade sale.",
      region: "Philippines",
    },
  ];

  return articles.filter(article => 
    regions.includes(article.region) &&
    keywords.some(kw => 
      article.headline.toLowerCase().includes(kw.toLowerCase()) ||
      article.content.toLowerCase().includes(kw.toLowerCase())
    )
  );
}

async function extractLeadInfo(article: SimulatedArticle, keywords: string[], summaryLength: string): Promise<Partial<InsertLead> | null> {
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

// In-memory scan progress tracking
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
    // Cleanup progress after delay even on error
    setTimeout(() => scanProgress.delete(currentScanId), 60000);
    throw new Error("Settings not configured");
  }
  
  // Helper function to ensure cleanup always runs
  const runCleanup = async () => {
    try {
      await storage.cleanupOldScanLogs(settings.logRetentionDays ?? 2);
    } catch (e) {
      console.error("Error cleaning up old scan logs:", e);
    }
  };

  scanProgress.set(currentScanId, { status: "scanning", message: "Searching news sources..." });

  try {
    const articles = generateSimulatedArticles(settings.keywords, settings.regions);
    
    // Track sources searched
    const sourceMap = new Map<string, { tier: SourceTier; count: number }>();
    articles.forEach(a => {
      const existing = sourceMap.get(a.source);
      if (existing) {
        existing.count++;
      } else {
        sourceMap.set(a.source, { tier: a.sourceTier, count: 1 });
      }
    });
    
    const sourcesSearched: SourceSearched[] = Array.from(sourceMap.entries()).map(([name, data]) => ({
      name,
      tier: data.tier,
      articlesFound: data.count,
    }));

    scanProgress.set(currentScanId, { 
      status: "processing", 
      currentSource: "Multiple sources",
      articlesFound: articles.length,
      articlesProcessed: 0,
      totalArticles: articles.length,
      message: `Found ${articles.length} articles, processing...` 
    });

    let newLeads = 0;
    let duplicatesSkipped = 0;
    const createdLeads: InsertLead[] = [];
    const articlesProcessed: ArticleProcessed[] = [];
    const errors: string[] = [];

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

    // Clean up progress after a delay
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
    // Always clean up old logs based on retention setting
    await runCleanup();
  }
}
