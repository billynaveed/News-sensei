import Parser from "rss-parser";
import type { Source, SourceTier } from "@shared/schema";

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

    if (!SCRAPINGBEE_API_KEY) {
      return { articles, errors: ["ScrapingBee API key not configured"] };
    }

    try {
      const params = new URLSearchParams({
        api_key: SCRAPINGBEE_API_KEY,
        url: source.url,
        render_js: "false",
        extract_rules: JSON.stringify({
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
        })
      });

      const response = await fetch(`https://app.scrapingbee.com/api/v1?${params.toString()}`, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });

      if (!response.ok) {
        const errorText = await response.text();
        errors.push(`ScrapingBee error for ${source.name}: ${response.status} - ${errorText}`);
        return { articles, errors };
      }

      const data = await response.json();
      const extractedArticles = data.articles || [];

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
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      errors.push(`ScrapingBee fetch failed for ${source.name}: ${message}`);
    }

    return { articles, errors };
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

export async function fetchAllArticles(
  sources: Source[], 
  keywords: string[]
): Promise<{ articles: RawArticle[]; sourcesSearched: { name: string; tier: SourceTier; articlesFound: number }[]; errors: string[] }> {
  const allArticles: RawArticle[] = [];
  const allErrors: string[] = [];
  const sourcesSearched: { name: string; tier: SourceTier; articlesFound: number }[] = [];

  const scrapingBeeAdapter = new ScrapingBeeAdapter();
  const rssAdapter = new RSSAdapter();

  for (const source of sources) {
    try {
      let articles: RawArticle[] = [];
      const sourceErrors: string[] = [];

      if (SCRAPINGBEE_API_KEY) {
        const sbResult = await scrapingBeeAdapter.fetchArticles(source, keywords);
        articles = sbResult.articles;
        sourceErrors.push(...sbResult.errors);
      }

      if (articles.length === 0 && source.rssUrl) {
        const rssResult = await rssAdapter.fetchArticles(source, keywords);
        articles = rssResult.articles;
        sourceErrors.push(...rssResult.errors);
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

  return { articles: dedupedArticles, sourcesSearched, errors: allErrors };
}
