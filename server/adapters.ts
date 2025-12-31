import Parser from "rss-parser";
import type { Source, SourceTier } from "@shared/schema";

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
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; LeadIntelligence/1.0)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
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

export class ScrapeAdapter implements SourceAdapter {
  async fetchArticles(source: Source, _keywords: string[]): Promise<AdapterResult> {
    return { 
      articles: [], 
      errors: [`Scraping not yet implemented for ${source.name}`] 
    };
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

  for (const source of sources) {
    try {
      const adapter = getAdapter(source.type || "manual");
      const result = await adapter.fetchArticles(source, keywords);
      
      allArticles.push(...result.articles);
      allErrors.push(...result.errors);
      
      sourcesSearched.push({
        name: source.name,
        tier: source.tier as SourceTier,
        articlesFound: result.articles.length,
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
