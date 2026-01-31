import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const anthropic = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY })
  : null;

/**
 * Find LinkedIn profiles for founders using web search and AI
 */
export async function findLinkedInProfiles(
  founderNames: string[],
  companyName: string,
  region: string
): Promise<string[]> {
  const profiles: string[] = [];

  for (const founderName of founderNames.slice(0, 3)) { // Limit to first 3 founders
    try {
      console.log(`Searching LinkedIn for: ${founderName} at ${companyName}`);

      // Use AI to construct optimal LinkedIn search and predict the most likely profile URL
      const searchPrompt = `Find the LinkedIn profile URL for:
Name: ${founderName}
Company: ${companyName}
Region: ${region}

Based on LinkedIn URL patterns, construct the most likely profile URL.
LinkedIn profile URLs follow the pattern: https://www.linkedin.com/in/[username]

Common patterns:
- First name + last name: john-doe
- First initial + last name: j-doe
- Full name with middle initial: john-m-doe
- Name with numbers: john-doe-123

Return ONLY the most likely LinkedIn URL in this format:
https://www.linkedin.com/in/[predicted-username]

If you cannot confidently predict, return: UNKNOWN`;

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: searchPrompt }],
        max_completion_tokens: 100,
        temperature: 0.3,
      });

      const linkedinUrl = response.choices[0]?.message?.content?.trim();

      if (linkedinUrl && linkedinUrl.includes("linkedin.com/in/") && linkedinUrl !== "UNKNOWN") {
        profiles.push(linkedinUrl);
        console.log(`  ✓ Found: ${linkedinUrl}`);
      } else {
        console.log(`  ✗ Could not find LinkedIn for ${founderName}`);
      }
    } catch (error) {
      console.error(`Error finding LinkedIn for ${founderName}:`, error);
    }
  }

  return profiles;
}

/**
 * Research company investors using web search and AI
 */
export async function researchInvestors(
  companyName: string,
  region: string,
  companyDescription?: string
): Promise<string[]> {
  try {
    console.log(`Researching investors for: ${companyName}`);

    // Use AI to research investors based on available information
    const researchPrompt = `Research the investors and backers of this company:

Company: ${companyName}
Region: ${region}
${companyDescription ? `Description: ${companyDescription}` : ''}

Based on your knowledge (up to January 2025), list the known investors, venture capital firms, or backers of this company.

Return the response in this format:
INVESTORS: [List investor names separated by commas]

If this is a publicly listed company (IPO), return:
INVESTORS: Public company (listed on [exchange])

If you don't have information about investors, return:
INVESTORS: Unknown

Examples:
- "Sequoia Capital, Andreessen Horowitz, Tiger Global"
- "Public company (listed on NASDAQ)"
- "Unknown"`;

    let investorResponse: string | null = null;

    // Try OpenAI first
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: researchPrompt }],
        max_completion_tokens: 200,
        temperature: 0.3,
      });

      investorResponse = response.choices[0]?.message?.content?.trim() || null;
    } catch (error) {
      console.log("GPT failed, trying Claude...");

      // Fallback to Claude
      if (anthropic) {
        const response = await anthropic.messages.create({
          model: "claude-3-5-haiku-20241022",
          max_tokens: 200,
          messages: [{ role: "user", content: researchPrompt }],
        });

        investorResponse = response.content[0].type === "text"
          ? response.content[0].text
          : null;
      }
    }

    if (!investorResponse) {
      console.log("  ✗ Could not research investors");
      return [];
    }

    // Parse the response
    const match = investorResponse.match(/INVESTORS:\s*(.+)/i);
    if (!match) {
      console.log("  ✗ Unexpected response format");
      return [];
    }

    const investorsText = match[1].trim();

    // Check for special cases
    if (investorsText.toLowerCase().includes("unknown")) {
      console.log("  ○ No investor information available");
      return [];
    }

    if (investorsText.toLowerCase().includes("public company")) {
      console.log(`  ✓ ${investorsText}`);
      return [investorsText];
    }

    // Parse comma-separated list
    const investors = investorsText
      .split(",")
      .map(inv => inv.trim())
      .filter(inv => inv.length > 0);

    if (investors.length > 0) {
      console.log(`  ✓ Found ${investors.length} investors: ${investors.slice(0, 3).join(", ")}${investors.length > 3 ? "..." : ""}`);
      return investors;
    }

    return [];
  } catch (error) {
    console.error(`Error researching investors for ${companyName}:`, error);
    return [];
  }
}

/**
 * Enrich a lead with LinkedIn profiles and investor information
 */
export async function enrichLead(lead: {
  companyNames: string[];
  founderNames: string[];
  region: string;
  companyDescription?: string | null;
}): Promise<{
  linkedinProfiles: string[];
  investors: string[];
}> {
  const companyName = lead.companyNames[0] || "Unknown Company";

  console.log(`\nEnriching lead: ${companyName}`);

  // Run both enrichments in parallel
  const [linkedinProfiles, investors] = await Promise.all([
    findLinkedInProfiles(lead.founderNames, companyName, lead.region),
    researchInvestors(companyName, lead.region, lead.companyDescription),
  ]);

  console.log(`Enrichment complete: ${linkedinProfiles.length} LinkedIn profiles, ${investors.length} investors\n`);

  return {
    linkedinProfiles,
    investors,
  };
}
