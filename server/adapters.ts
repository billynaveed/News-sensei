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
  useScrapingBeeForRss?: boolean;
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

    // Only keep articles published in the last 12 hours
    const RSS_CUTOFF_HOURS = 12;
    const rssCutoffTime = new Date(Date.now() - RSS_CUTOFF_HOURS * 60 * 60 * 1000);

    for (const item of parsed.items) {
      if (!item.title || !item.link) continue;

      // Skip articles older than 12 hours
      const pubDate = item.pubDate ? new Date(item.pubDate) : null;
      if (pubDate && pubDate < rssCutoffTime) continue;

      const content = item.contentSnippet || item.content || item.summary || "";
      const combinedText = `${item.title} ${content}`.toLowerCase();

      // When keywords array is empty, skip keyword filtering (AI pipeline handles relevance)
      // When keywords array is empty, skip keyword filtering (AI pipeline handles relevance)
      if (keywords.length > 0) {
        const matchesKeyword = keywords.some(kw =>
          combinedText.includes(kw.toLowerCase())
        );
        if (!matchesKeyword) continue;
      }

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

export async function fetchRssViaScrapingBee(
  feed: RssFeedWithMeta,
  keywords: string[],
  defaultRegion: string = "Singapore"
): Promise<AdapterResult> {
  const articles: RawArticle[] = [];
  const errors: string[] = [];
  const startTime = Date.now();

  const debugEntry: ScrapingBeeDebugEntry = {
    sourceName: `${feed.sourceName} - ${feed.name} (via ScrapingBee)`,
    sourceId: feed.sourceId,
    timestamp: new Date().toISOString(),
    method: "rss",
    request: {
      url: feed.url,
      renderJs: false,
      extractRules: "N/A - RSS via ScrapingBee proxy",
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
      url: feed.url,
      render_js: "false",
    });

    const response = await fetch(`https://app.scrapingbee.com/api/v1?${params.toString()}`, {
      method: "GET",
      headers: { "Accept": "application/xml, text/xml, */*" },
    });

    debugEntry.response.status = response.status;
    debugEntry.response.statusText = response.statusText;
    debugEntry.response.latencyMs = Date.now() - startTime;

    const responseText = await response.text();
    debugEntry.response.rawResponseSnippet = responseText.slice(0, 3000);

    if (!response.ok) {
      debugEntry.error = `HTTP ${response.status}: ${responseText.slice(0, 500)}`;
      errors.push(`ScrapingBee RSS error for ${feed.sourceName}: ${response.status}`);
      return { articles, errors, debugEntry };
    }

    const parsed = await rssParser.parseString(responseText);

    // Only keep articles published in the last 12 hours
    const RSS_CUTOFF_HOURS = 12;
    const rssCutoffTime = new Date(Date.now() - RSS_CUTOFF_HOURS * 60 * 60 * 1000);

    for (const item of parsed.items) {
      if (!item.title || !item.link) continue;

      // Skip articles older than 12 hours
      const pubDate = item.pubDate ? new Date(item.pubDate) : null;
      if (pubDate && pubDate < rssCutoffTime) continue;

      const content = item.contentSnippet || item.content || item.summary || "";
      const combinedText = `${item.title} ${content}`.toLowerCase();

      if (keywords.length > 0) {
        const matchesKeyword = keywords.some(kw =>
        combinedText.includes(kw.toLowerCase())
      );

        if (!matchesKeyword) continue;
      }

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

    debugEntry.response.extractedCount = parsed.items.length;
    debugEntry.response.matchedCount = articles.length;
    debugEntry.response.rawResponseSnippet = `Found ${parsed.items.length} items, ${articles.length} matched keywords`;

  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    errors.push(`Failed to fetch RSS via ScrapingBee from ${feed.sourceName} - ${feed.name}: ${message}`);
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

    // Only keep articles published in the last 12 hours
    const RSS_CUTOFF_HOURS = 12;
    const rssCutoffTime = new Date(Date.now() - RSS_CUTOFF_HOURS * 60 * 60 * 1000);

    for (const item of parsed.items) {
      if (!item.title || !item.link) continue;

      // Skip articles older than 12 hours
      const pubDate = item.pubDate ? new Date(item.pubDate) : null;
      if (pubDate && pubDate < rssCutoffTime) continue;

      const content = item.contentSnippet || item.content || item.summary || "";
      const combinedText = `${item.title} ${content}`.toLowerCase();

      if (keywords.length > 0) {
        const matchesKeyword = keywords.some(kw =>
        combinedText.includes(kw.toLowerCase())
      );

        if (!matchesKeyword) continue;
      }

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
      
      if (keywords.length > 0) {
        const matchesKeyword = keywords.some(kw => 
        combinedText.includes(kw.toLowerCase())
      );

        if (!matchesKeyword) continue;
      }

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

/**
 * Fetches articles using ScrapingBee with premium proxy and JS rendering.
 * Used for Tier 1 sources (Bloomberg, FT, etc.) to maximize content quality
 * from paywalled or JS-heavy sites.
 *
 * @param source - The news source to scrape
 * @param keywords - Keywords for article filtering
 * @param defaultRegion - Fallback region when article has no explicit region
 * @param usePremium - When true, enables premium_proxy, render_js, and full resource loading
 */
export async function fetchFromScrapingBeePremium(
  source: Source,
  keywords: string[],
  defaultRegion: string = "Singapore",
  usePremium: boolean = true
): Promise<AdapterResult> {
  const articles: RawArticle[] = [];
  const errors: string[] = [];
  const startTime = Date.now();

  const premiumExtractRules = JSON.stringify({
    articles: {
      selector: "article, .article, .post, .story, .news-item, [class*='article'], [class*='story'], a[href*='/article'], a[href*='/news'], a[href*='/story']",
      type: "list",
      output: {
        headline: "h1, h2, h3, .title, .headline, a",
        link: { selector: "a", output: "@href" },
        summary: "p, .summary, .excerpt, .description",
        date: "time, .date, .timestamp, [datetime]"
      }
    },
    article_text: {
      selector: "article, .article-body, .story-body, main",
      type: "item",
      output: "text"
    }
  });

  const debugEntry: ScrapingBeeDebugEntry = {
    sourceName: `${source.name} (Premium ScrapingBee)`,
    sourceId: source.id,
    timestamp: new Date().toISOString(),
    method: "scrapingbee_premium",
    request: {
      url: `https://${source.domain}`,
      renderJs: usePremium,
      extractRules: premiumExtractRules,
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
      extract_rules: premiumExtractRules,
    });

    if (usePremium) {
      params.set("premium_proxy", "true");
      params.set("render_js", "true");
      params.set("block_resources", "false");
    } else {
      params.set("render_js", "false");
    }

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
      errors.push(`Premium ScrapingBee error for ${source.name}: ${response.status} - ${responseText.slice(0, 500)}`);
      return { articles, errors, debugEntry };
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(responseText) as Record<string, unknown>;
    } catch {
      debugEntry.error = `JSON parse error: ${responseText.slice(0, 200)}`;
      errors.push(`Premium ScrapingBee JSON parse error for ${source.name}`);
      return { articles, errors, debugEntry };
    }

    const extractedArticles = (data.articles as Array<Record<string, unknown>>) || [];
    const articleText = typeof data.article_text === "string" ? data.article_text : "";
    debugEntry.response.extractedCount = extractedArticles.length;

    for (const item of extractedArticles) {
      if (!item.headline || !item.link) continue;

      const headline = typeof item.headline === "string" ? item.headline.trim() : "";
      if (!headline) continue;

      let articleUrl = item.link as string;
      if (articleUrl && !articleUrl.startsWith("http")) {
        try {
          articleUrl = new URL(articleUrl, `https://${source.domain}`).toString();
        } catch {
          continue;
        }
      }

      const summary = typeof item.summary === "string" ? item.summary.trim() : "";
      // Use extracted article_text as enhanced content when available
      const enhancedContent = articleText || summary;
      const combinedText = `${headline} ${summary} ${articleText}`.toLowerCase();

      if (keywords.length > 0) {
        const matchesKeyword = keywords.some(kw =>
          combinedText.includes(kw.toLowerCase())
        );
        if (!matchesKeyword) continue;
      }

      articles.push({
        headline,
        url: articleUrl,
        source: source.name,
        sourceTier: source.tier as SourceTier,
        publishedAt: item.date ? new Date(item.date as string) : new Date(),
        content: enhancedContent.slice(0, 5000),
        region: defaultRegion,
        fetchMethod: "scrapingbee_premium",
      });
    }

    debugEntry.response.matchedCount = articles.length;

    if (extractedArticles.length === 0) {
      debugEntry.error = "No articles extracted - premium selectors may not match page structure";
    } else if (articles.length === 0) {
      debugEntry.error = `${extractedArticles.length} articles extracted but 0 matched keywords`;
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    debugEntry.error = message;
    debugEntry.response.latencyMs = Date.now() - startTime;
    errors.push(`Premium ScrapingBee fetch failed for ${source.name}: ${message}`);
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

/**
 * Normalizes a URL for deduplication by standardizing protocol, removing
 * tracking parameters, and stripping hash fragments.
 */
function normalizeUrl(url: string): string {
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
}

/**
 * Deduplicates articles by normalized URL, keeping the first occurrence.
 */
function deduplicateArticles(articles: RawArticle[]): RawArticle[] {
  const seen = new Set<string>();
  return articles.filter(article => {
    const normalized = normalizeUrl(article.url);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/**
 * Collects articles, errors, and debug entries from an AdapterResult into
 * the provided accumulator arrays. Returns the number of articles added.
 */
function collectAdapterResult(
  result: AdapterResult,
  articles: RawArticle[],
  errors: string[],
  debugEntries: ScrapingBeeDebugEntry[]
): number {
  articles.push(...result.articles);
  errors.push(...result.errors);
  if (result.debugEntry) {
    debugEntries.push(result.debugEntry);
  }
  return result.articles.length;
}

/**
 * Builds all fetch promises for a single Tier 1 source, running RSS
 * and Google News in parallel. ScrapingBee is NOT used here for article
 * discovery — it's reserved for Stage 5 (premium full-article paywall bypass)
 * to conserve API credits.
 */
function buildTier1FetchPromises(
  source: Source,
  feeds: RssFeedWithMeta[],
  keywords: string[],
  options: ScanningOptions
): Promise<AdapterResult>[] {
  const promises: Promise<AdapterResult>[] = [];

  if (options.rssEnabled) {
    const sourceFeeds = feeds.filter(f => f.sourceName === source.name);
    for (const feed of sourceFeeds) {
      // Never use ScrapingBee for RSS fetching — standard RSS is free
      promises.push(fetchFromRssFeed(feed, keywords, options.defaultRegion));
    }
  }

  if (options.googleNewsEnabled) {
    promises.push(fetchFromGoogleNews(source, keywords, options.defaultRegion));
  }

  // ScrapingBee intentionally NOT used for discovery.
  // It's reserved for Stage 5 premium paywall bypass in scanner.ts.

  return promises;
}

/**
 * Fetches articles from all active sources using the configured scanning methods.
 *
 * Tier 1 sources run all enabled methods (RSS, Google News, ScrapingBee) in
 * PARALLEL to maximize content quality from premium sources like Bloomberg and FT.
 *
 * Other tiers use fallback logic: ScrapingBee only activates when RSS and
 * Google News return zero articles for a given source.
 *
 * All results are combined and deduplicated by normalized URL.
 */
export async function fetchAllArticles(
  activeSources: Source[],
  activeFeeds: RssFeedWithMeta[],
  keywords: string[],
  options: ScanningOptions
): Promise<FetchAllArticlesResult> {
  const allArticles: RawArticle[] = [];
  const allErrors: string[] = [];
  const debugEntries: ScrapingBeeDebugEntry[] = [];

  if (activeSources.length === 0) {
    return { articles: [], sourcesSearched: [], errors: ["No active sources configured"], debugEntries: [] };
  }

  const sourceArticleCounts = new Map<string, number>();
  const tier1Sources = activeSources.filter(s => s.tier === "tier1");
  const otherSources = activeSources.filter(s => s.tier !== "tier1");

  // --- Tier 1: All enabled methods in parallel per source ---
  if (tier1Sources.length > 0) {
    const tier1SourcePromises = tier1Sources.map(async (source) => {
      const promises = buildTier1FetchPromises(source, activeFeeds, keywords, options);
      if (promises.length === 0) return;

      const results = await Promise.allSettled(promises);
      let sourceCount = 0;

      for (const result of results) {
        if (result.status === "fulfilled") {
          sourceCount += collectAdapterResult(result.value, allArticles, allErrors, debugEntries);
        } else {
          const message = result.reason instanceof Error ? result.reason.message : "Unknown error";
          allErrors.push(`Tier 1 parallel fetch failed for ${source.name}: ${message}`);
        }
      }

      sourceArticleCounts.set(source.name, sourceCount);
    });

    await Promise.all(tier1SourcePromises);
  }

  // --- Other tiers: Sequential with ScrapingBee as fallback ---
  const otherTierFeeds = activeFeeds.filter(
    f => !tier1Sources.some(s => s.name === f.sourceName)
  );

  if (options.rssEnabled) {
    for (const feed of otherTierFeeds) {
      try {
        // Always use standard RSS — no ScrapingBee for discovery
        const result = await fetchFromRssFeed(feed, keywords, options.defaultRegion);

        const count = collectAdapterResult(result, allArticles, allErrors, debugEntries);
        const currentCount = sourceArticleCounts.get(feed.sourceName) || 0;
        sourceArticleCounts.set(feed.sourceName, currentCount + count);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        allErrors.push(`Error fetching RSS feed ${feed.name}: ${message}`);
      }
    }
  }

  if (options.googleNewsEnabled) {
    for (const source of otherSources) {
      try {
        const result = await fetchFromGoogleNews(source, keywords, options.defaultRegion);
        const count = collectAdapterResult(result, allArticles, allErrors, debugEntries);
        const currentCount = sourceArticleCounts.get(source.name) || 0;
        sourceArticleCounts.set(source.name, currentCount + count);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        allErrors.push(`Error fetching Google News for ${source.name}: ${message}`);
      }
    }
  }

  // ScrapingBee NOT used for article discovery (conserves API credits).
  // It's only used in Stage 5 (scanner.ts) for premium paywall bypass on Tier 1 articles.

  // Build sources searched summary
  const sourcesSearched = activeSources.map(source => ({
    name: source.name,
    tier: source.tier as SourceTier,
    articlesFound: sourceArticleCounts.get(source.name) || 0,
  }));

  const dedupedArticles = deduplicateArticles(allArticles);

  return { articles: dedupedArticles, sourcesSearched, errors: allErrors, debugEntries };
}
