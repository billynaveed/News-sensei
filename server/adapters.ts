import Parser from "rss-parser";
import type { Source, SourceTier, RssFeed, ScrapingBeeDebugEntry, FetchMethod } from "@shared/schema";

const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY;

export interface RawArticle {
  headline: string;
  url: string;
  source: string;
  sourceTier: SourceTier;
  publishedAt: Date;
  content: string;
  region: string;
  fetchMethod: FetchMethod;
}

export interface AdapterResult {
  articles: RawArticle[];
  errors: string[];
  debugEntry?: ScrapingBeeDebugEntry;
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

export interface RssFeedWithMeta extends RssFeed {
  sourceName: string;
  sourceTier: string;
}

export async function fetchFromRssFeed(
  feed: RssFeedWithMeta,
  keywords: string[],
  defaultRegion: string = "Singapore"
): Promise<AdapterResult> {
  const articles: RawArticle[] = [];
  const errors: string[] = [];
  const startTime = Date.now();

  const debugEntry: ScrapingBeeDebugEntry = {
    sourceName: `${feed.sourceName} - ${feed.name}`,
    sourceId: feed.sourceId,
    timestamp: new Date().toISOString(),
    method: "rss",
    request: {
      url: feed.url,
      renderJs: false,
      extractRules: "N/A - RSS Feed",
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

  try {
    const parsed = await rssParser.parseURL(feed.url);
    
    for (const item of parsed.items) {
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
        source: feed.sourceName,
        sourceTier: feed.sourceTier as SourceTier,
        publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
        content: content.slice(0, 2000),
        region: defaultRegion,
        fetchMethod: "rss",
      });
    }

    debugEntry.response.status = 200;
    debugEntry.response.statusText = "OK";
    debugEntry.response.latencyMs = Date.now() - startTime;
    debugEntry.response.extractedCount = parsed.items.length;
    debugEntry.response.matchedCount = articles.length;
    debugEntry.response.rawResponseSnippet = `Found ${parsed.items.length} items, ${articles.length} matched keywords`;

  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    errors.push(`Failed to fetch RSS from ${feed.sourceName} - ${feed.name}: ${message}`);
    debugEntry.error = message;
    debugEntry.response.status = 500;
    debugEntry.response.statusText = "Error";
    debugEntry.response.latencyMs = Date.now() - startTime;
    debugEntry.response.rawResponseSnippet = message;
  }

  return { articles, errors, debugEntry };
}

export async function fetchFromGoogleNews(
  source: Source,
  keywords: string[],
  defaultRegion: string = "Singapore"
): Promise<AdapterResult> {
  const articles: RawArticle[] = [];
  const errors: string[] = [];
  const startTime = Date.now();

  const debugEntry: ScrapingBeeDebugEntry = {
    sourceName: `${source.name} (Google News)`,
    sourceId: source.id,
    timestamp: new Date().toISOString(),
    method: "google_news",
    request: {
      url: `Google News search: site:${source.domain}`,
      renderJs: false,
      extractRules: "N/A - Google News RSS",
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

  try {
    const searchQuery = encodeURIComponent(`site:${source.domain}`);
    const googleNewsRssUrl = `https://news.google.com/rss/search?q=${searchQuery}&hl=en&gl=SG&ceid=SG:en`;
    
    const parsed = await rssParser.parseURL(googleNewsRssUrl);
    
    for (const item of parsed.items) {
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
        region: defaultRegion,
        fetchMethod: "google_news",
      });
    }

    debugEntry.response.status = 200;
    debugEntry.response.statusText = "OK";
    debugEntry.response.latencyMs = Date.now() - startTime;
    debugEntry.response.extractedCount = parsed.items.length;
    debugEntry.response.matchedCount = articles.length;
    debugEntry.response.rawResponseSnippet = `Found ${parsed.items.length} items, ${articles.length} matched keywords`;

  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    errors.push(`Failed to fetch Google News for ${source.name}: ${message}`);
    debugEntry.error = message;
    debugEntry.response.status = 500;
    debugEntry.response.statusText = "Error";
    debugEntry.response.latencyMs = Date.now() - startTime;
  }

  return { articles, errors, debugEntry };
}

export async function fetchFromScrapingBee(
  source: Source,
  keywords: string[],
  defaultRegion: string = "Singapore"
): Promise<AdapterResult> {
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
      url: `https://${source.domain}`,
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
    const targetUrl = `https://${source.domain}`;
    const params = new URLSearchParams({
      api_key: SCRAPINGBEE_API_KEY,
      url: targetUrl,
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
          articleUrl = new URL(articleUrl, `https://${source.domain}`).toString();
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
        region: defaultRegion,
        fetchMethod: "scrapingbee",
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

export interface FetchAllArticlesResult {
  articles: RawArticle[];
  sourcesSearched: { name: string; tier: SourceTier; articlesFound: number }[];
  errors: string[];
  debugEntries: ScrapingBeeDebugEntry[];
}

export interface ScanningOptions {
  googleNewsEnabled: boolean;
  rssEnabled: boolean;
  scrapingBeeEnabled: boolean;
  defaultRegion: string;
}

export async function fetchAllArticles(
  activeSources: Source[],
  activeFeeds: RssFeedWithMeta[],
  keywords: string[],
  options: ScanningOptions
): Promise<FetchAllArticlesResult> {
  const allArticles: RawArticle[] = [];
  const allErrors: string[] = [];
  const sourcesSearched: { name: string; tier: SourceTier; articlesFound: number }[] = [];
  const debugEntries: ScrapingBeeDebugEntry[] = [];
  
  if (activeSources.length === 0) {
    return { articles: [], sourcesSearched: [], errors: ["No active sources configured"], debugEntries: [] };
  }

  const sourceArticleCounts: Map<string, number> = new Map();

  if (options.rssEnabled) {
    for (const feed of activeFeeds) {
      try {
        const result = await fetchFromRssFeed(feed, keywords, options.defaultRegion);
        allArticles.push(...result.articles);
        allErrors.push(...result.errors);
        if (result.debugEntry) {
          debugEntries.push(result.debugEntry);
        }
        
        const currentCount = sourceArticleCounts.get(feed.sourceName) || 0;
        sourceArticleCounts.set(feed.sourceName, currentCount + result.articles.length);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        allErrors.push(`Error fetching RSS feed ${feed.name}: ${message}`);
      }
    }
  }

  if (options.googleNewsEnabled) {
    for (const source of activeSources) {
      try {
        const result = await fetchFromGoogleNews(source, keywords, options.defaultRegion);
        allArticles.push(...result.articles);
        allErrors.push(...result.errors);
        if (result.debugEntry) {
          debugEntries.push(result.debugEntry);
        }
        
        const currentCount = sourceArticleCounts.get(source.name) || 0;
        sourceArticleCounts.set(source.name, currentCount + result.articles.length);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        allErrors.push(`Error fetching Google News for ${source.name}: ${message}`);
      }
    }
  }

  if (options.scrapingBeeEnabled && SCRAPINGBEE_API_KEY) {
    for (const source of activeSources) {
      const currentCount = sourceArticleCounts.get(source.name) || 0;
      if (currentCount > 0) continue;
      
      try {
        const result = await fetchFromScrapingBee(source, keywords, options.defaultRegion);
        allArticles.push(...result.articles);
        allErrors.push(...result.errors);
        if (result.debugEntry) {
          result.debugEntry.fallbackReason = "No articles from RSS/Google News";
          debugEntries.push(result.debugEntry);
        }
        
        sourceArticleCounts.set(source.name, currentCount + result.articles.length);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        allErrors.push(`Error with ScrapingBee for ${source.name}: ${message}`);
      }
    }
  }

  for (const source of activeSources) {
    sourcesSearched.push({
      name: source.name,
      tier: source.tier as SourceTier,
      articlesFound: sourceArticleCounts.get(source.name) || 0,
    });
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
