import Parser from "rss-parser";
import type { Source, SourceTier, ScrapingBeeDebugEntry } from "@shared/schema";

const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY;

export interface RawArticle {
  headline: string;
  url: string;
  source: string;
  sourceTier: SourceTier;
  publishedAt: Date;
  content: string;
  region: string;
}

export interface AdapterResult {
  articles: RawArticle[];
  errors: string[];
  debugEntry?: ScrapingBeeDebugEntry;
}

export interface SourceAdapter {
  fetchArticles(source: Source, keywords: string[]): Promise<AdapterResult>;
}

const rssParser = new Parser({
  timeout: 15000,
  maxRedirects: 5,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  },
  customFields: {
    item: [['media:content', 'media'], ['dc:creator', 'creator']],
  },
});

export class RSSAdapter implements SourceAdapter {
  async fetchArticles(source: Source, keywords: string[]): Promise<AdapterResult> {
    const articles: RawArticle[] = [];
    const errors: string[] = [];

    if (!source.rssUrl) {
      return { articles, errors: [`No RSS URL configured for ${source.name}`] };
    }

    try {
      const feed = await rssParser.parseURL(source.rssUrl);
      
      for (const item of feed.items) {
        if (!item.title || !item.link) continue;

        const content = item.contentSnippet || item.content || item.summary || "";
        const combinedText = `${item.title} ${content}`.toLowerCase();
        
        const matchesKeyword = keywords.some(kw => 
          combinedText.includes(kw.toLowerCase())
        );

        if (!matchesKeyword) continue;

        articles.push({
          headline: item.title,
          url: item.link,
          source: source.name,
          sourceTier: source.tier as SourceTier,
          publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
          content: content.slice(0, 2000),
          region: source.region || "Singapore",
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      errors.push(`Failed to fetch RSS from ${source.name}: ${message}`);
    }

    return { articles, errors };
  }
}

export class ManualAdapter implements SourceAdapter {
  async fetchArticles(_source: Source, _keywords: string[]): Promise<AdapterResult> {
    return { articles: [], errors: [] };
  }
}

export class ScrapingBeeAdapter implements SourceAdapter {
  async fetchArticles(source: Source, keywords: string[]): Promise<AdapterResult> {
    const articles: RawArticle[] = [];
    const errors: string[] = [];
    const startTime = Date.now();

    const extractRules = JSON.stringify({
      articles: {
        selector: "article, .article, .post, .story, .news-item, [class*='article'], [class*='story'], a[href*='/article'], a[href*='/news'], a[href*='/story']",
        type: "list",
        output: {
          headline: "h1, h2, h3, .title, .headline, a",
          link: { selector: "a", output: "@href" },
          summary: "p, .summary, .excerpt, .description",
          date: "time, .date, .timestamp, [datetime]"
        }
      }
    });

    const debugEntry: ScrapingBeeDebugEntry = {
      sourceName: source.name,
      sourceId: source.id,
      timestamp: new Date().toISOString(),
      method: "scrapingbee",
      request: {
        url: source.url,
        renderJs: false,
        extractRules: extractRules,
      },
      response: {
        status: 0,
        statusText: "",
        latencyMs: 0,
        rawResponseSnippet: "",
        extractedCount: 0,
        matchedCount: 0,
      },
    };

    if (!SCRAPINGBEE_API_KEY) {
      debugEntry.error = "ScrapingBee API key not configured";
      debugEntry.response.latencyMs = Date.now() - startTime;
      return { articles, errors: ["ScrapingBee API key not configured"], debugEntry };
    }

    try {
      const params = new URLSearchParams({
        api_key: SCRAPINGBEE_API_KEY,
        url: source.url,
        render_js: "false",
        extract_rules: extractRules,
      });

      const response = await fetch(`https://app.scrapingbee.com/api/v1?${params.toString()}`, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });

      debugEntry.response.status = response.status;
      debugEntry.response.statusText = response.statusText;
      debugEntry.response.latencyMs = Date.now() - startTime;

      const responseText = await response.text();
      debugEntry.response.rawResponseSnippet = responseText.slice(0, 3000);

      if (!response.ok) {
        debugEntry.error = `HTTP ${response.status}: ${responseText.slice(0, 500)}`;
        errors.push(`ScrapingBee error for ${source.name}: ${response.status} - ${responseText}`);
        return { articles, errors, debugEntry };
      }

      let data: any;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        debugEntry.error = `JSON parse error: ${responseText.slice(0, 200)}`;
        errors.push(`ScrapingBee JSON parse error for ${source.name}`);
        return { articles, errors, debugEntry };
      }

      const extractedArticles = data.articles || [];
      debugEntry.response.extractedCount = extractedArticles.length;

      for (const item of extractedArticles) {
        if (!item.headline || !item.link) continue;

        const headline = typeof item.headline === 'string' ? item.headline.trim() : '';
        if (!headline) continue;

        let articleUrl = item.link;
        if (articleUrl && !articleUrl.startsWith("http")) {
          try {
            const baseUrl = new URL(source.url);
            articleUrl = new URL(articleUrl, baseUrl.origin).toString();
          } catch {
            continue;
          }
        }

        const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
        const combinedText = `${headline} ${summary}`.toLowerCase();
        
        const matchesKeyword = keywords.some(kw => 
          combinedText.includes(kw.toLowerCase())
        );

        if (!matchesKeyword) continue;

        articles.push({
          headline,
          url: articleUrl,
          source: source.name,
          sourceTier: source.tier as SourceTier,
          publishedAt: item.date ? new Date(item.date) : new Date(),
          content: summary.slice(0, 2000),
          region: source.region || "Singapore",
        });
      }

      debugEntry.response.matchedCount = articles.length;

      if (extractedArticles.length === 0) {
        debugEntry.error = "No articles extracted - selectors may not match page structure";
      } else if (articles.length === 0) {
        debugEntry.error = `${extractedArticles.length} articles extracted but 0 matched keywords`;
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      debugEntry.error = message;
      debugEntry.response.latencyMs = Date.now() - startTime;
      errors.push(`ScrapingBee fetch failed for ${source.name}: ${message}`);
    }

    return { articles, errors, debugEntry };
  }
}

export class ScrapeAdapter implements SourceAdapter {
  private scrapingBeeAdapter = new ScrapingBeeAdapter();
  private rssAdapter = new RSSAdapter();

  async fetchArticles(source: Source, keywords: string[]): Promise<AdapterResult> {
    const sbResult = await this.scrapingBeeAdapter.fetchArticles(source, keywords);
    
    if (sbResult.articles.length > 0) {
      return sbResult;
    }

    if (source.rssUrl) {
      const rssResult = await this.rssAdapter.fetchArticles(source, keywords);
      return {
        articles: rssResult.articles,
        errors: [...sbResult.errors, ...rssResult.errors],
      };
    }

    return sbResult;
  }
}

export function getAdapter(type: string): SourceAdapter {
  switch (type) {
    case "rss":
      return new RSSAdapter();
    case "scrape":
      return new ScrapeAdapter();
    case "api":
    case "manual":
    default:
      return new ManualAdapter();
  }
}

export interface FetchAllArticlesResult {
  articles: RawArticle[];
  sourcesSearched: { name: string; tier: SourceTier; articlesFound: number }[];
  errors: string[];
  debugEntries: ScrapingBeeDebugEntry[];
}

export async function fetchAllArticles(
  sources: Source[], 
  keywords: string[]
): Promise<FetchAllArticlesResult> {
  const allArticles: RawArticle[] = [];
  const allErrors: string[] = [];
  const sourcesSearched: { name: string; tier: SourceTier; articlesFound: number }[] = [];
  const debugEntries: ScrapingBeeDebugEntry[] = [];

  const scrapingBeeAdapter = new ScrapingBeeAdapter();
  const rssAdapter = new RSSAdapter();

  for (const source of sources) {
    try {
      let articles: RawArticle[] = [];
      const sourceErrors: string[] = [];
      let usedFallback = false;

      if (SCRAPINGBEE_API_KEY) {
        const sbResult = await scrapingBeeAdapter.fetchArticles(source, keywords);
        articles = sbResult.articles;
        sourceErrors.push(...sbResult.errors);
        
        if (sbResult.debugEntry) {
          debugEntries.push(sbResult.debugEntry);
        }
      }

      if (articles.length === 0 && source.rssUrl) {
        usedFallback = true;
        const rssStartTime = Date.now();
        const rssResult = await rssAdapter.fetchArticles(source, keywords);
        articles = rssResult.articles;
        sourceErrors.push(...rssResult.errors);

        const rssDebugEntry: ScrapingBeeDebugEntry = {
          sourceName: source.name,
          sourceId: source.id,
          timestamp: new Date().toISOString(),
          method: "fallback_rss",
          request: {
            url: source.rssUrl || "",
            renderJs: false,
            extractRules: "N/A - RSS Feed",
          },
          response: {
            status: rssResult.errors.length > 0 ? 500 : 200,
            statusText: rssResult.errors.length > 0 ? "Error" : "OK",
            latencyMs: Date.now() - rssStartTime,
            rawResponseSnippet: rssResult.errors.length > 0 ? rssResult.errors.join("; ") : `Found ${articles.length} articles matching keywords`,
            extractedCount: articles.length,
            matchedCount: articles.length,
          },
          fallbackReason: "ScrapingBee returned 0 articles",
          error: rssResult.errors.length > 0 ? rssResult.errors.join("; ") : undefined,
        };
        debugEntries.push(rssDebugEntry);
      }

      allArticles.push(...articles);
      allErrors.push(...sourceErrors);
      
      sourcesSearched.push({
        name: source.name,
        tier: source.tier as SourceTier,
        articlesFound: articles.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      allErrors.push(`Error fetching from ${source.name}: ${message}`);
      sourcesSearched.push({
        name: source.name,
        tier: source.tier as SourceTier,
        articlesFound: 0,
      });

      debugEntries.push({
        sourceName: source.name,
        sourceId: source.id,
        timestamp: new Date().toISOString(),
        method: "scrapingbee",
        request: {
          url: source.url,
          renderJs: false,
          extractRules: "N/A - Exception thrown",
        },
        response: {
          status: 0,
          statusText: "Exception",
          latencyMs: 0,
          rawResponseSnippet: "",
          extractedCount: 0,
          matchedCount: 0,
        },
        error: message,
      });
    }
  }

  const normalizeUrl = (url: string): string => {
    try {
      const parsed = new URL(url);
      parsed.protocol = "https:";
      parsed.searchParams.delete("utm_source");
      parsed.searchParams.delete("utm_medium");
      parsed.searchParams.delete("utm_campaign");
      parsed.searchParams.delete("ref");
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return url.toLowerCase().trim();
    }
  };

  const seen = new Set<string>();
  const dedupedArticles = allArticles.filter(article => {
    const normalizedUrl = normalizeUrl(article.url);
    if (seen.has(normalizedUrl)) return false;
    seen.add(normalizedUrl);
    return true;
  });

  return { articles: dedupedArticles, sourcesSearched, errors: allErrors, debugEntries };
}
