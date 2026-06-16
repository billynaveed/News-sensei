/**
 * Comprehensive person/company research module for the /research command.
 * 
 * Searches saved leads → Brave web search → GPT-4o synthesis
 * into a UHNW private banking dossier.
 */

import { openai } from "./openai-client";
import { storage } from "./storage";
import { db } from "./db";
import { researchCache } from "@shared/schema";
import { eq, and, gt, ilike, or, sql } from "drizzle-orm";
import { stripJsonFences } from "./json-utils";


const BRAVE_API_KEY = process.env.BRAVE_API_KEY;

// Rate limiting: max 5 requests per hour
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface ResearchResult {
  name: string;
  entityType: "person" | "company";
  currentRole: string | null;
  company: string | null;
  previousRoles: string | null;
  education: string | null;
  wealthIndicators: string | null;
  recentNews: { title: string; url: string; snippet: string }[];
  netWorthEstimate: string | null;
  talkingPoints: string[];
  bankingNeeds: string[];
  linkedInUrl: string | null;
  confidence: "high" | "medium" | "low";
  sources: string[];
  savedLeadMatches: { id: string; headline: string; company: string }[];
  cachedAt?: Date;
}

/**
 * Check rate limit for a chat. Returns true if allowed.
 */
export function checkRateLimit(chatId: string): { allowed: boolean; remaining: number; resetIn?: number } {
  const now = Date.now();
  const timestamps = rateLimitMap.get(chatId) || [];
  const recent = timestamps.filter(t => now - t < RATE_WINDOW_MS);
  rateLimitMap.set(chatId, recent);

  if (recent.length >= RATE_LIMIT) {
    const oldest = recent[0];
    const resetIn = Math.ceil((oldest + RATE_WINDOW_MS - now) / 60000);
    return { allowed: false, remaining: 0, resetIn };
  }

  return { allowed: true, remaining: RATE_LIMIT - recent.length };
}

export function recordRateLimit(chatId: string): void {
  const timestamps = rateLimitMap.get(chatId) || [];
  timestamps.push(Date.now());
  rateLimitMap.set(chatId, timestamps);
}

/**
 * Check cache for recent research (within 24h)
 */
async function getCachedResearch(query: string): Promise<ResearchResult | null> {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const results = await db
      .select()
      .from(researchCache)
      .where(
        and(
          ilike(researchCache.query, query),
          gt(researchCache.createdAt, twentyFourHoursAgo)
        )
      )
      .limit(1);

    if (results.length > 0) {
      const cached = results[0];
      const result = cached.result as ResearchResult;
      result.cachedAt = cached.createdAt;
      return result;
    }
    return null;
  } catch (error) {
    console.error("[Research] Cache lookup failed:", error);
    return null;
  }
}

/**
 * Store research result in cache
 */
async function cacheResearch(query: string, result: ResearchResult): Promise<void> {
  try {
    await db.insert(researchCache).values({
      query: query.toLowerCase().trim(),
      entityType: result.entityType,
      result: result as any,
    });
  } catch (error) {
    console.error("[Research] Cache write failed:", error);
  }
}

/**
 * Search saved leads for matching person/company
 */
async function searchSavedLeads(query: string): Promise<{ id: string; headline: string; company: string }[]> {
  try {
    const allSaved = await storage.getAllSavedLeads();
    const queryLower = query.toLowerCase();
    const matches: { id: string; headline: string; company: string }[] = [];

    for (const saved of allSaved) {
      const lead = saved.lead;
      const founderMatch = lead.founderNames?.some((n: string) =>
        n.toLowerCase().includes(queryLower) || queryLower.includes(n.toLowerCase())
      );
      const companyMatch = lead.companyNames?.some((n: string) =>
        n.toLowerCase().includes(queryLower) || queryLower.includes(n.toLowerCase())
      );

      if (founderMatch || companyMatch) {
        matches.push({
          id: saved.id,
          headline: lead.headline,
          company: lead.companyNames?.[0] || "Unknown",
        });
      }
    }

    return matches;
  } catch (error) {
    console.error("[Research] Saved leads search failed:", error);
    return [];
  }
}

/**
 * Search Brave for multiple queries and aggregate results
 */
async function braveSearch(queries: string[]): Promise<{ title: string; url: string; content: string }[]> {
  if (!BRAVE_API_KEY) {
    console.warn("[Research] No BRAVE_API_KEY, skipping web search");
    return [];
  }

  const allResults: { title: string; url: string; content: string }[] = [];
  const seenUrls = new Set<string>();

  for (const query of queries) {
    try {
      const cleanQuery = query.replace(/"/g, '');
      const params = new URLSearchParams({ q: cleanQuery, count: "8" });

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

      if (!response.ok) continue;

      const data = await response.json() as any;
      const webResults = data.web?.results || [];

      for (const r of webResults) {
        if (!seenUrls.has(r.url)) {
          seenUrls.add(r.url);
          allResults.push({
            title: r.title || "",
            url: r.url || "",
            content: r.description || "",
          });
        }
      }

      // Small delay between searches to be nice to the API
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error: any) {
      console.error(`[Research] Brave search failed for "${query}":`, error.message);
    }
  }

  return allResults;
}

/**
 * Main research function - orchestrates the full pipeline
 */
export async function performResearch(query: string): Promise<ResearchResult> {
  console.log(`[Research] Starting comprehensive research for: "${query}"`);

  // 1. Check cache
  const cached = await getCachedResearch(query.toLowerCase().trim());
  if (cached) {
    console.log(`[Research] Cache hit for "${query}"`);
    return cached;
  }

  // 2. Search saved leads
  const savedLeadMatches = await searchSavedLeads(query);

  // 3. Run multiple Brave searches in parallel for breadth
  const searchQueries = [
    `${query} founder CEO biography`,
    `${query} net worth wealth funding`,
    `${query} recent news 2025 2026`,
    `${query} board director company`,
  ];

  const webResults = await braveSearch(searchQueries);

  // 4. Build context for GPT-4o
  const webContext = webResults.slice(0, 20).map((r, i) =>
    `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content}`
  ).join("\n\n");

  const savedContext = savedLeadMatches.length > 0
    ? `\n\nSAVED LEADS MATCHING "${query}":\n` +
      savedLeadMatches.map(m => `- Lead #${m.id}: ${m.headline} (${m.company})`).join("\n")
    : "";

  // 5. GPT-4o synthesis
  const prompt = `You are a research analyst for a UHNW (Ultra-High-Net-Worth) private banker in Southeast Asia. Your job is to create a comprehensive dossier on a person or company that helps the banker decide whether to pursue them as a client.

RESEARCH SUBJECT: "${query}"

WEB SEARCH RESULTS:
${webContext || "No web results found."}
${savedContext}

Based on ALL available information, create a comprehensive research dossier. Return a JSON object:

{
  "entityType": "person" or "company",
  "name": "Full name as found",
  "currentRole": "Current title and company (e.g. 'CEO at Acme Corp')",
  "company": "Primary company name",
  "previousRoles": "Previous roles, career history (2-3 sentences)",
  "education": "Educational background if available",
  "wealthIndicators": "ALL wealth signals: funding rounds raised, exits, board seats, property ownership, known assets, company valuations, stock holdings. Be specific with numbers where available.",
  "recentNews": [{"title": "...", "url": "...", "snippet": "..."}],
  "netWorthEstimate": "Estimated net worth range if publicly available or inferable, with reasoning. Say 'Not publicly available' if truly unknown.",
  "talkingPoints": ["3-5 recommended conversation starters based on their interests, recent activities, or achievements"],
  "bankingNeeds": ["3-5 potential private banking needs: IPO proceeds, exit liquidity, family office setup, wealth structuring, real estate financing, succession planning, etc. Be specific to their situation."],
  "linkedInUrl": "LinkedIn URL if identifiable from results, otherwise null",
  "confidence": "high/medium/low based on data quality",
  "sources": ["List of source URLs used"]
}

IMPORTANT:
- Focus on wealth signals relevant to private banking
- Be specific with numbers (funding amounts, valuations, deal sizes)
- If information is scarce, say so honestly - don't fabricate
- For recentNews, only include items actually found in search results with real URLs
- Banking needs should be specific to THIS person's situation, not generic
- Talking points should be personal and show the banker has done homework`;

  try {
    const response = await openai.chat.completions.create({
      model: "anthropic/claude-sonnet-4",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 3000,
      temperature: 0.3,
    });

    const parsed = JSON.parse(stripJsonFences(response.choices[0].message.content || "{}"));

    const result: ResearchResult = {
      name: parsed.name || query,
      entityType: parsed.entityType || "person",
      currentRole: parsed.currentRole || null,
      company: parsed.company || null,
      previousRoles: parsed.previousRoles || null,
      education: parsed.education || null,
      wealthIndicators: parsed.wealthIndicators || null,
      recentNews: Array.isArray(parsed.recentNews) ? parsed.recentNews : [],
      netWorthEstimate: parsed.netWorthEstimate || null,
      talkingPoints: Array.isArray(parsed.talkingPoints) ? parsed.talkingPoints : [],
      bankingNeeds: Array.isArray(parsed.bankingNeeds) ? parsed.bankingNeeds : [],
      linkedInUrl: parsed.linkedInUrl || null,
      confidence: parsed.confidence || "low",
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
      savedLeadMatches,
    };

    // 6. Cache the result
    await cacheResearch(query, result);

    return result;
  } catch (error: any) {
    console.error("[Research] GPT-4o synthesis failed:", error.message);

    // Return partial result with web data
    return {
      name: query,
      entityType: "person",
      currentRole: null,
      company: null,
      previousRoles: null,
      education: null,
      wealthIndicators: null,
      recentNews: webResults.slice(0, 5).map(r => ({ title: r.title, url: r.url, snippet: r.content })),
      netWorthEstimate: null,
      talkingPoints: [],
      bankingNeeds: [],
      linkedInUrl: null,
      confidence: "low",
      sources: webResults.slice(0, 5).map(r => r.url),
      savedLeadMatches,
    };
  }
}

/**
 * Format research result as a Telegram HTML message
 */
export function formatResearchTelegram(result: ResearchResult): string {
  const sections: string[] = [];
  const icon = result.entityType === "person" ? "👤" : "🏢";

  sections.push(`${icon} <b>Research Dossier: ${result.name}</b>`);

  if (result.cachedAt) {
    const ago = Math.round((Date.now() - result.cachedAt.getTime()) / 3600000);
    sections.push(`<i>📋 Cached result (${ago}h ago)</i>`);
  }

  if (result.savedLeadMatches.length > 0) {
    sections.push(`\n📌 <b>Saved Leads Match:</b>`);
    for (const m of result.savedLeadMatches) {
      sections.push(`  • ${m.headline} (${m.company})`);
    }
  }

  if (result.currentRole) {
    sections.push(`\n💼 <b>Current Role:</b> ${result.currentRole}`);
  }

  if (result.previousRoles) {
    sections.push(`\n📋 <b>Career History:</b>\n${result.previousRoles}`);
  }

  if (result.education) {
    sections.push(`\n🎓 <b>Education:</b> ${result.education}`);
  }

  if (result.wealthIndicators) {
    sections.push(`\n💰 <b>Wealth Indicators:</b>\n${result.wealthIndicators}`);
  }

  if (result.netWorthEstimate) {
    sections.push(`\n🏦 <b>Net Worth Estimate:</b> ${result.netWorthEstimate}`);
  }

  if (result.recentNews.length > 0) {
    sections.push(`\n📰 <b>Recent News:</b>`);
    for (const news of result.recentNews.slice(0, 5)) {
      sections.push(`  • <a href="${news.url}">${news.title}</a>`);
    }
  }

  if (result.talkingPoints.length > 0) {
    sections.push(`\n💬 <b>Recommended Talking Points:</b>`);
    for (const tp of result.talkingPoints) {
      sections.push(`  • ${tp}`);
    }
  }

  if (result.bankingNeeds.length > 0) {
    sections.push(`\n🏛️ <b>Potential Banking Needs:</b>`);
    for (const bn of result.bankingNeeds) {
      sections.push(`  • ${bn}`);
    }
  }

  const confIcon = result.confidence === "high" ? "🟢" : result.confidence === "medium" ? "🟡" : "🔴";
  sections.push(`\n${confIcon} <b>Confidence:</b> ${result.confidence}`);

  return sections.join("\n");
}
