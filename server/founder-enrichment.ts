import { log } from "./log";
import { callJsonStage } from "./llm-json";
import {
  searchFounderResidence,
  searchCompanyHeadquarters,
  formatSearchContext,
  extractSearchSources,
  calculateSearchConfidence,
} from "./web-search";


export interface FounderEnrichmentResult {
  founderName: string;
  companyName: string;
  linkedInUrl: string | null;
  biography: string | null;
  professionalBackground: string | null;
  education: string | null;
  notableAchievements: string | null;
  residenceCity: string | null;
  residenceCountry: string | null;
  confidence: "high" | "medium" | "low";
  sources: string[];
}

export interface CompanyEnrichmentResult {
  companyName: string;
  description: string | null;
  industry: string | null;
  founded: string | null;
  headquarters: string | null;
  businessModel: string | null;
  confidence: "high" | "medium" | "low";
}

/**
 * Enriches founder information using web search + AI analysis (RAG pattern)
 *
 * This function implements a hybrid approach:
 * 1. Searches the web using Tavily AI for real-time information
 * 2. Uses GPT-4o to synthesize search results with knowledge base
 * 3. Falls back to knowledge-only if web search fails
 *
 * @param founderName - Name of the founder/key person
 * @param companyName - Company they're associated with
 * @param region - Geographic region
 * @returns Enriched founder information with residence data
 */
export async function enrichFounderInfoWithSearch(
  founderName: string,
  companyName: string,
  region: string = "Singapore"
): Promise<FounderEnrichmentResult> {
  try {
    log(`[Web Search] Enriching founder: ${founderName} at ${companyName}`, "enrichment");

    // Step 1: Retrieve - Web search for real-time information
    const searchResults = await searchFounderResidence(founderName, companyName, region);

    // Step 2: Format Context - Structure search results for GPT-4o
    let searchContext = "";
    if (searchResults) {
      searchContext = `# REAL-TIME WEB SEARCH RESULTS\n${formatSearchContext(searchResults)}\n\n`;
      log(`[Web Search] Found ${searchResults.results.length} results for ${founderName}`, "enrichment");
    } else {
      log(`[Web Search] No search results, falling back to knowledge base`, "enrichment");
    }

    // Step 3: Generate - GPT-4o synthesis with structured prompt
    const prompt = `# ROLE
You are a research assistant gathering professional information about business leaders.

${searchContext}# TASK
Extract information about ${founderName} at ${companyName} in ${region}.

# INSTRUCTIONS
1. PRIORITIZE web search results for current information (residence, recent achievements)
2. Use your knowledge base to SUPPLEMENT and VERIFY search results
3. For residenceCity/residenceCountry: ONLY include if explicitly mentioned in search results or you have high confidence
4. If search results contradict knowledge, trust recent web data
5. Be honest about confidence level
6. LinkedIn URL should only be included if you're highly confident it's correct

# OUTPUT FORMAT (JSON only)
{
  "linkedInUrl": string | null,
  "biography": "A comprehensive 2-3 paragraph biography covering their role, background, and impact",
  "professionalBackground": "Summary of their career history and previous roles",
  "education": "Educational background if available",
  "notableAchievements": "Key achievements, awards, or recognitions",
  "residenceCity": string | null,
  "residenceCountry": string | null,
  "confidence": "high" | "medium" | "low",
  "sources": ["List of information sources"]
}

Important:
- If you cannot find specific information, use null
- For residence: be conservative, only include if explicitly stated
- Focus on factual, verifiable information
- Return ONLY the JSON object, no markdown formatting`;

    const enrichmentData = await callJsonStage<any>({
      model: "anthropic/claude-sonnet-4",
      prompt,
      maxTokens: 1500,
      label: "Founder Enrichment",
    });

    // Extract web search sources
    const webSources = searchResults ? extractSearchSources(searchResults) : [];
    const allSources = [...webSources, ...(enrichmentData.sources || [])];

    // Calculate confidence based on search results
    const hasResidence = !!(enrichmentData.residenceCity || enrichmentData.residenceCountry);
    const searchConfidence = calculateSearchConfidence(searchResults, hasResidence);

    // Merge AI confidence with search confidence (take lower of the two)
    const aiConfidence = enrichmentData.confidence || "low";
    const finalConfidence =
      aiConfidence === "low" || searchConfidence === "low" ? "low" :
      aiConfidence === "medium" || searchConfidence === "medium" ? "medium" : "high";

    const result: FounderEnrichmentResult = {
      founderName,
      companyName,
      linkedInUrl: enrichmentData.linkedInUrl || null,
      biography: enrichmentData.biography || null,
      professionalBackground: enrichmentData.professionalBackground || null,
      education: enrichmentData.education || null,
      notableAchievements: enrichmentData.notableAchievements || null,
      residenceCity: enrichmentData.residenceCity || null,
      residenceCountry: enrichmentData.residenceCountry || null,
      confidence: finalConfidence,
      sources: allSources,
    };

    log(`[Web Search] Enrichment complete for ${founderName} (confidence: ${result.confidence}, residence: ${result.residenceCity || 'N/A'})`, "enrichment");
    return result;

  } catch (error) {
    // No knowledge-only fallback: an ungrounded LLM bio presented with a
    // confidence label is worse than an honest blank.
    log(`[Web Search] Founder enrichment failed for ${founderName}: ${error}`, "enrichment");
    return { founderName, companyName, linkedInUrl: null, biography: null, professionalBackground: null, education: null, notableAchievements: null, residenceCity: null, residenceCountry: null, confidence: "low", sources: [] };
  }
}

/**
 * Enriches company information using web search + AI analysis
 *
 * @param companyName - Name of the company
 * @param region - Geographic region
 * @returns Enriched company information with accurate headquarters
 */
export async function enrichCompanyInfoWithSearch(
  companyName: string,
  region: string = "Singapore"
): Promise<CompanyEnrichmentResult> {
  try {
    log(`[Web Search] Enriching company: ${companyName}`, "enrichment");

    // Step 1: Retrieve - Web search for HQ information
    const searchResults = await searchCompanyHeadquarters(companyName, region);

    // Step 2: Format Context
    let searchContext = "";
    if (searchResults) {
      searchContext = `# REAL-TIME WEB SEARCH RESULTS\n${formatSearchContext(searchResults)}\n\n`;
      log(`[Web Search] Found ${searchResults.results.length} results for ${companyName}`, "enrichment");
    } else {
      log(`[Web Search] No search results, falling back to knowledge base`, "enrichment");
    }

    // Step 3: Generate - GPT-4o synthesis
    const prompt = `# ROLE
You are a research assistant gathering information about companies.

${searchContext}# TASK
Extract information about ${companyName} in ${region}.

# INSTRUCTIONS
1. PRIORITIZE web search results for current headquarters location
2. Use your knowledge base to SUPPLEMENT and VERIFY search results
3. If search results show a different HQ than your knowledge, trust the search results
4. Be specific with headquarters (include city and country)
5. Be honest about confidence level

# OUTPUT FORMAT (JSON only)
{
  "description": "A comprehensive 2-3 sentence description of what the company does",
  "industry": "Primary industry/sector",
  "founded": "Year founded if available",
  "headquarters": "Full headquarters location (city, country)",
  "businessModel": "Brief explanation of their business model and revenue streams",
  "confidence": "high" | "medium" | "low"
}

Important:
- If you cannot find specific information, use null
- Focus on factual, verifiable information
- Be concise but comprehensive
- Return ONLY the JSON object, no markdown formatting`;

    const enrichmentData = await callJsonStage<any>({
      model: "anthropic/claude-sonnet-4",
      prompt,
      maxTokens: 1000,
      label: "Company Enrichment",
    });

    // Calculate confidence based on search results
    const hasHeadquarters = !!enrichmentData.headquarters;
    const searchConfidence = calculateSearchConfidence(searchResults, hasHeadquarters);

    const aiConfidence = enrichmentData.confidence || "low";
    const finalConfidence =
      aiConfidence === "low" || searchConfidence === "low" ? "low" :
      aiConfidence === "medium" || searchConfidence === "medium" ? "medium" : "high";

    const result: CompanyEnrichmentResult = {
      companyName,
      description: enrichmentData.description || null,
      industry: enrichmentData.industry || null,
      founded: enrichmentData.founded || null,
      headquarters: enrichmentData.headquarters || null,
      businessModel: enrichmentData.businessModel || null,
      confidence: finalConfidence,
    };

    log(`[Web Search] Company enrichment complete for ${companyName} (confidence: ${result.confidence}, HQ: ${result.headquarters || 'N/A'})`, "enrichment");
    return result;

  } catch (error) {
    log(`[Web Search] Company enrichment failed for ${companyName}: ${error}`, "enrichment");
    return { companyName, description: null, industry: null, founded: null, headquarters: null, businessModel: null, confidence: "low" };
  }
}

/**
 * Enriches a saved lead with founder and company information
 *
 * This is the main function that should be called when a lead is saved
 * to automatically populate research fields.
 *
 * @param leadData - The lead data with company and founder names
 * @returns Combined enrichment results
 */
export async function enrichSavedLead(leadData: {
  companyNames: string[];
  founderNames: string[];
  region: string;
}) {
  const results: {
    founders: FounderEnrichmentResult[];
    companies: CompanyEnrichmentResult[];
  } = {
    founders: [],
    companies: [],
  };

  try {
    // Always enrich company information if we have a company name
    if (leadData.companyNames.length > 0) {
      const primaryCompany = leadData.companyNames[0];
      log(`Starting enrichment for company: ${primaryCompany}`, "enrichment");

      const companyInfo = await enrichCompanyInfoWithSearch(
        primaryCompany,
        leadData.region
      );
      results.companies.push(companyInfo);
    }

    // Enrich founder information only if we have founder names
    if (leadData.founderNames.length > 0 && leadData.companyNames.length > 0) {
      const primaryFounder = leadData.founderNames[0];
      const primaryCompany = leadData.companyNames[0];

      log(`Starting enrichment for founder: ${primaryFounder} at ${primaryCompany}`, "enrichment");

      const founderInfo = await enrichFounderInfoWithSearch(
        primaryFounder,
        primaryCompany,
        leadData.region
      );
      results.founders.push(founderInfo);
    } else {
      log(`Skipping founder enrichment - no founder names provided`, "enrichment");
    }

    return results;

  } catch (error) {
    log(`Error in enrichSavedLead: ${error}`, "enrichment");
    return results;
  }
}

/**
 * Helper function to format enrichment results into saved lead metadata
 */
export function formatEnrichmentForSavedLead(enrichment: {
  founders: FounderEnrichmentResult[];
  companies: CompanyEnrichmentResult[];
}) {
  const founder = enrichment.founders[0];
  const company = enrichment.companies[0];

  const formatted = {
    founderLinkedInUrl: founder?.linkedInUrl || null,
    founderBio: founder?.biography || null,
    companyDescription: company?.description || null,
    researchData: {
      founderProfessionalBackground: founder?.professionalBackground || null,
      founderEducation: founder?.education || null,
      founderAchievements: founder?.notableAchievements || null,
      founderResidenceCity: founder?.residenceCity || null,
      founderResidenceCountry: founder?.residenceCountry || null,
      companyIndustry: company?.industry || null,
      companyFounded: company?.founded || null,
      companyHeadquarters: company?.headquarters || null,
      companyBusinessModel: company?.businessModel || null,
      enrichmentConfidence: {
        founder: founder?.confidence || null,
        company: company?.confidence || null,
      },
      sources: [...(founder?.sources || []), ...(company ? ["Company research"] : [])],
      searchQueries: [] as string[],
      enrichedAt: new Date().toISOString(),
    },
  };

  log(`Formatted enrichment data: company=${!!company?.description}, founder=${!!founder?.biography}`, "enrichment");
  return formatted;
}
