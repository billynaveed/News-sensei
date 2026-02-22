/**
 * Web Search Integration using Tavily AI or Brave Search API
 *
 * Provides real-time web search capabilities for enriching lead information
 * with up-to-date data about company headquarters and founder residences.
 * 
 * Falls back to Brave Search if Tavily is not configured.
 */

import { tavily } from "@tavily/core";

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;

// Circuit breaker state
let circuitBreakerOpen = false;
let circuitBreakerResetTime = 0;
const CIRCUIT_BREAKER_TIMEOUT = 60000; // 1 minute

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string;
}

interface TavilySearchResponse {
  query: string;
  answer?: string;
  results: TavilySearchResult[];
  response_time: number;
}

interface SearchOptions {
  searchDepth?: "basic" | "advanced";
  maxResults?: number;
  includeAnswer?: boolean;
  timeRange?: "day" | "week" | "month" | "year";
  country?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
}

/**
 * Search using Brave Search API (fallback when Tavily is not configured)
 */
async function searchWithBrave(
  query: string,
  options: SearchOptions = {}
): Promise<TavilySearchResponse | null> {
  if (!BRAVE_API_KEY) {
    console.warn("[Web Search] Brave API key not configured, skipping web search");
    return null;
  }

  const { maxResults = 5, country } = options;

  try {
    const params = new URLSearchParams({
      q: query,
      count: String(maxResults),
    });
    // Note: Brave free tier doesn't support the 'country' parameter (returns 422)

    // Brave free tier can 422 on complex quoted queries — simplify
    const cleanQuery = query.replace(/"/g, '');
    console.info(`[Web Search] Brave query: "${cleanQuery}"`);
    const startTime = Date.now();

    params.set("q", cleanQuery);
    const response = await Promise.race([
      fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": BRAVE_API_KEY,
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Brave search timeout")), 10000)
      ),
    ]);

    if (!response.ok) {
      console.error(`[Web Search] Brave API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json() as any;
    const webResults = data.web?.results || [];
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.info(`[Web Search] Brave success: ${webResults.length} results in ${elapsed}s`);

    return {
      query,
      answer: data.summarizer?.summary || undefined,
      results: webResults.map((r: any) => ({
        title: r.title || "",
        url: r.url || "",
        content: r.description || "",
        score: 0.7, // Brave doesn't provide relevance scores, use reasonable default
      })),
      response_time: parseFloat(elapsed),
    };
  } catch (error: any) {
    console.error(`[Web Search] Brave search failed: ${error.message}`);
    return null;
  }
}

/**
 * Core web search function with retry logic and circuit breaker.
 * Uses Tavily if configured, otherwise falls back to Brave Search.
 */
async function searchWeb(
  query: string,
  options: SearchOptions = {}
): Promise<TavilySearchResponse | null> {
  // If Tavily is not configured, try Brave
  if (!TAVILY_API_KEY) {
    return searchWithBrave(query, options);
  }

  // Check circuit breaker
  if (circuitBreakerOpen) {
    if (Date.now() < circuitBreakerResetTime) {
      console.warn("[Web Search] Circuit breaker open, skipping search");
      return null;
    }
    // Reset circuit breaker
    circuitBreakerOpen = false;
    console.info("[Web Search] Circuit breaker reset");
  }

  const {
    searchDepth = "basic",
    maxResults = 5,
    includeAnswer = true,
    timeRange,
    country,
    includeDomains,
    excludeDomains,
  } = options;

  // Exponential backoff retry logic
  const maxRetries = 3;
  const baseDelay = 2000; // 2 seconds

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const tvly = tavily({ apiKey: TAVILY_API_KEY });

      const searchParams: any = {
        query,
        searchDepth,
        maxResults,
        includeAnswer,
      };

      if (timeRange) searchParams.timeRange = timeRange;
      if (country) searchParams.country = country;
      if (includeDomains) searchParams.includeDomains = includeDomains;
      if (excludeDomains) searchParams.excludeDomains = excludeDomains;

      console.info(`[Web Search] Query: "${query}" (attempt ${attempt + 1}/${maxRetries})`);

      const response = await Promise.race([
        tvly.search(searchParams),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Search timeout")), 10000)
        ),
      ]) as any;

      console.info(`[Web Search] Success: ${response.results.length} results in ${response.response_time}s`);

      return {
        query: response.query,
        answer: response.answer,
        results: response.results.map((r: any) => ({
          title: r.title,
          url: r.url,
          content: r.content,
          score: r.score,
          raw_content: r.raw_content,
        })),
        response_time: response.response_time,
      };
    } catch (error: any) {
      const isLastAttempt = attempt === maxRetries - 1;

      // Handle rate limiting (429)
      if (error.response?.status === 429) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
        console.warn(`[Web Search] Rate limited, retrying in ${delay}ms...`);

        if (!isLastAttempt) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }

      // Handle other errors
      if (isLastAttempt) {
        console.error(`[Web Search] Failed after ${maxRetries} attempts:`, error.message);

        // Open circuit breaker after repeated failures
        circuitBreakerOpen = true;
        circuitBreakerResetTime = Date.now() + CIRCUIT_BREAKER_TIMEOUT;
        console.warn("[Web Search] Circuit breaker opened for 1 minute");

        return null;
      }

      // Exponential backoff for retries
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
      console.warn(`[Web Search] Error: ${error.message}, retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return null;
}

/**
 * Search for company headquarters information
 */
export async function searchCompanyHeadquarters(
  companyName: string,
  region?: string
): Promise<TavilySearchResponse | null> {
  const regionFilter = region ? ` ${region}` : "";
  const query = `${companyName} company headquarters${regionFilter}`;

  const options: SearchOptions = {
    searchDepth: "basic",
    maxResults: 5,
    includeAnswer: true,
    timeRange: "year", // Prioritize recent data
  };

  // Add country filter for specific regions
  if (region) {
    const countryCode = getCountryCode(region);
    if (countryCode) {
      options.country = countryCode;
    }
  }

  return searchWeb(query, options);
}

/**
 * Search for founder residence information
 */
export async function searchFounderResidence(
  founderName: string,
  companyName: string,
  region?: string
): Promise<TavilySearchResponse | null> {
  const regionHint = region ? ` ${region}` : "";
  const query = `${founderName} ${companyName} founder CEO biography${regionHint}`;

  const options: SearchOptions = {
    searchDepth: "basic",
    maxResults: 5,
    includeAnswer: true,
    timeRange: "year",
  };

  if (region) {
    const countryCode = getCountryCode(region);
    if (countryCode) {
      options.country = countryCode;
    }
  }

  return searchWeb(query, options);
}

/**
 * Get ISO 3166-1 alpha-2 country code from region name
 */
function getCountryCode(region: string): string | null {
  const regionMap: Record<string, string> = {
    Singapore: "SG",
    Malaysia: "MY",
    Thailand: "TH",
    Indonesia: "ID",
    Philippines: "PH",
    Vietnam: "VN",
    "Hong Kong": "HK",
    Taiwan: "TW",
  };

  return regionMap[region] || null;
}

/**
 * Calculate confidence score from search results
 */
export function calculateSearchConfidence(
  searchResults: TavilySearchResponse | null,
  foundData: boolean
): "high" | "medium" | "low" {
  if (!searchResults || searchResults.results.length === 0) {
    return foundData ? "medium" : "low";
  }

  const results = searchResults.results;

  // Layer 1: Source Quality (number of results)
  let sourceQualityScore = 0;
  if (results.length >= 3) {
    sourceQualityScore = 1.0;
  } else if (results.length >= 2) {
    sourceQualityScore = 0.7;
  } else {
    sourceQualityScore = 0.4;
  }

  // Layer 2: Search Result Score (average relevance)
  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
  let searchResultScore = 0;
  if (avgScore > 0.8) {
    searchResultScore = 1.0;
  } else if (avgScore > 0.5) {
    searchResultScore = 0.6;
  } else {
    searchResultScore = 0.3;
  }

  // Layer 3: Tavily Answer Presence
  const tavilyAnswerBonus = searchResults.answer ? 0.1 : 0;

  // Final confidence calculation
  const finalConfidence =
    sourceQualityScore * 0.5 + searchResultScore * 0.3 + tavilyAnswerBonus * 0.2;

  if (finalConfidence > 0.8) return "high";
  if (finalConfidence > 0.5) return "medium";
  return "low";
}

/**
 * Format search results for GPT-4o context
 */
export function formatSearchContext(searchResults: TavilySearchResponse): string {
  const contextParts = searchResults.results.map((result, index) => {
    return `
## Source ${index + 1}: ${result.title}
URL: ${result.url}
Relevance Score: ${result.score.toFixed(2)}
Content: ${result.content}
`;
  });

  let context = contextParts.join("\n");

  if (searchResults.answer) {
    context = `# SEARCH SUMMARY\n${searchResults.answer}\n\n${context}`;
  }

  return context;
}

/**
 * Extract source URLs from search results
 */
export function extractSearchSources(searchResults: TavilySearchResponse | null): string[] {
  if (!searchResults) return [];
  return searchResults.results.map((r) => r.url);
}
