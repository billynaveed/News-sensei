import { sendTelegramMessage, answerCallbackQuery } from './telegram';
import { enrichFounderInfo, enrichCompanyInfo, type FounderEnrichmentResult, type CompanyEnrichmentResult } from './founder-enrichment';
import { formatFounderEnrichment, formatCompanyEnrichment, formatSavedLeadEnrichment, splitLongMessage } from './telegram-formatter';
import { performResearch, formatResearchTelegram, checkRateLimit, recordRateLimit, type ResearchResult } from './research';
import { storage } from './storage';
import type { Settings } from '@shared/schema';
import OpenAI from 'openai';
import { stripJsonFences } from './json-utils';

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

// Store research results temporarily for saving
interface PendingResearch {
  type: 'founder' | 'company';
  founderResult?: FounderEnrichmentResult;
  companyResult?: CompanyEnrichmentResult;
  timestamp: number;
}

const pendingResearch = new Map<string, PendingResearch>();

// Clean up old research results (older than 1 hour)
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const toDelete: string[] = [];
  pendingResearch.forEach((research, id) => {
    if (research.timestamp < oneHourAgo) {
      toDelete.push(id);
    }
  });
  toDelete.forEach(id => pendingResearch.delete(id));
}, 5 * 60 * 1000); // Run every 5 minutes

/**
 * Handles the /start command
 */
export async function handleStartCommand(chatId: string): Promise<void> {
  const message = `👋 <b>Welcome to Sensei Research Bot!</b>

I can help you research founders and companies on-demand.

<b>Available Commands:</b>
/help - Show this help message
/research &lt;name&gt; - Research a founder or company
/research saved &lt;id&gt; - Enrich a saved lead
/leads - Show recent saved leads

<b>Examples:</b>
/research Elon Musk
/research Tesla
/research saved 123
/leads

Send /help for more details!`;

  await sendTelegramMessage(chatId, message);
}

/**
 * Handles the /help command
 */
export async function handleHelpCommand(chatId: string): Promise<void> {
  const message = `📖 <b>Sensei Research Bot - Help</b>

<b>Commands:</b>

<b>/research &lt;name&gt;</b>
Research any founder or company. I'll automatically detect whether it's a person or company and fetch relevant information.

Examples:
• /research Elon Musk
• /research Tesla
• /research Jensen Huang

<b>/research saved &lt;id&gt;</b>
Enrich a specific saved lead with detailed founder and company information. Use /leads to find lead IDs.

Example:
• /research saved 123

<b>/leads</b>
Show your recent saved leads with their IDs, so you can enrich them.

<b>Authorization:</b>
This bot only responds to the authorized chat ID configured in your settings.

<b>Need help?</b> Contact your administrator.`;

  await sendTelegramMessage(chatId, message);
}

/**
 * Classifies if a query is about a founder (person) or company using AI
 */
async function classifyEntity(query: string): Promise<"founder" | "company"> {
  try {
    const prompt = `Determine if "${query}" refers to a PERSON (founder/CEO/executive) or COMPANY/ORGANIZATION.

Rules:
- If it's a person's name (e.g., "Elon Musk", "Jensen Huang"), return "founder"
- If it's a company/organization name (e.g., "Tesla", "NVIDIA", "Goldman Sachs"), return "company"
- If ambiguous, consider common knowledge

Return JSON: {"type": "founder" | "company"}`;

    const response = await openai.chat.completions.create({
      model: "google/gemini-2.5-flash-lite",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    });

    const result = JSON.parse(stripJsonFences(response.choices[0].message.content || '{"type": "company"}'));
    return result.type === "founder" ? "founder" : "company";
  } catch (error) {
    console.error('Error classifying entity:', error);
    // Default to company if classification fails
    return "company";
  }
}

/**
 * Handles /leads command - shows recent saved leads
 */
export async function handleLeadsCommand(chatId: string): Promise<void> {
  try {
    const savedLeads = await storage.getAllSavedLeads();

    if (savedLeads.length === 0) {
      await sendTelegramMessage(chatId, "📋 No saved leads found.");
      return;
    }

    // Show up to 10 most recent
    const recentLeads = savedLeads.slice(0, 10);

    let message = "📋 <b>Recent Saved Leads:</b>\n\n";

    for (const saved of recentLeads) {
      const lead = saved.lead;
      const company = lead.companyNames?.[0] || "Unknown";
      const founder = lead.founderNames?.[0] || "Unknown";
      message += `<b>ID ${saved.id}:</b> ${company} - ${founder}\n`;
      message += `📰 ${lead.headline.substring(0, 60)}...\n\n`;
    }

    message += `\nUse <code>/research saved &lt;id&gt;</code> to enrich a lead.`;

    await sendTelegramMessage(chatId, message);
  } catch (error) {
    console.error('Error listing saved leads:', error);
    await sendTelegramMessage(chatId, "⚠️ Something went wrong while fetching saved leads.");
  }
}

/**
 * Handles /research saved <id> command - enriches a saved lead
 */
async function handleResearchSaved(leadIdStr: string, chatId: string, settings: Settings): Promise<void> {
  try {
    const leadId = parseInt(leadIdStr, 10);
    if (isNaN(leadId)) {
      await sendTelegramMessage(chatId, "❌ Invalid lead ID. Please provide a numeric ID.");
      return;
    }

    const savedLead = await storage.getSavedLeadById(leadId.toString());
    if (!savedLead) {
      await sendTelegramMessage(chatId, "❌ Saved lead not found.");
      return;
    }

    const lead = savedLead.lead;

    // Check if already enriched
    const isEnriched = savedLead.founderBio && savedLead.companyDescription;

    if (isEnriched) {
      // Show existing data
      const formatted = formatSavedLeadEnrichment(savedLead, lead);
      const parts = splitLongMessage(formatted);
      for (const part of parts) {
        await sendTelegramMessage(chatId, part);
      }
      return;
    }

    // Need to enrich
    await sendTelegramMessage(chatId, "🔍 Enriching saved lead...");

    const region = settings.regions?.[0] || "Singapore";
    const founderName = lead.founderNames?.[0];
    const companyName = lead.companyNames?.[0];

    let founderResult = null;
    let companyResult = null;

    // Enrich founder if available
    if (founderName) {
      try {
        founderResult = await enrichFounderInfo(founderName, companyName || "", region);
      } catch (error) {
        console.error('Error enriching founder:', error);
      }
    }

    // Enrich company if available
    if (companyName) {
      try {
        companyResult = await enrichCompanyInfo(companyName, region);
      } catch (error) {
        console.error('Error enriching company:', error);
      }
    }

    // Update saved lead with enrichment data
    const updates: any = {};
    if (founderResult) {
      updates.founderBio = founderResult.biography;
      updates.founderLinkedInUrl = founderResult.linkedInUrl;
      updates.founderName = founderName;
    }
    if (companyResult) {
      updates.companyDescription = companyResult.description;
      updates.companyName = companyName;
    }

    if (Object.keys(updates).length > 0) {
      await storage.updateSavedLead(leadId.toString(), updates);
    }

    // Format and send results
    const enrichedLead = { ...savedLead, ...updates };
    const formatted = formatSavedLeadEnrichment(enrichedLead, lead);
    const parts = splitLongMessage(formatted);

    for (const part of parts) {
      await sendTelegramMessage(chatId, part);
    }

  } catch (error) {
    console.error('Error researching saved lead:', error);
    await sendTelegramMessage(chatId, "⚠️ Something went wrong. Please try again.");
  }
}

/**
 * Main handler for /research command
 * 
 * Enhanced version: searches saved leads → Brave web search → GPT-4o synthesis
 * into a comprehensive UHNW private banking dossier.
 */
export async function handleResearchCommand(args: string[], chatId: string, settings: Settings): Promise<void> {
  // Authorization check
  if (chatId !== settings.telegramChatId) {
    await sendTelegramMessage(chatId, "⛔ This bot is private. Unauthorized access attempt logged.");
    console.warn(`Unauthorized /research attempt from chat ID: ${chatId}`);
    return;
  }

  // Handle /research saved <id>
  if (args[0] === "saved" && args[1]) {
    return handleResearchSaved(args[1], chatId, settings);
  }

  // Ad-hoc research
  const query = args.join(" ").trim();

  if (!query) {
    // Import here to avoid circular dependency
    const { awaitingResearchInput } = await import('./telegram-bot');
    awaitingResearchInput.set(chatId, true);
    await sendTelegramMessage(chatId, `🔍 <b>Who would you like me to research?</b>\n\nType a person's name or company:`);
    return;
  }

  // Rate limit check
  const rateCheck = checkRateLimit(chatId);
  if (!rateCheck.allowed) {
    await sendTelegramMessage(chatId, `⏳ Rate limit reached (${RATE_LIMIT_MSG} per hour). Try again in ~${rateCheck.resetIn} minutes.`);
    return;
  }

  try {
    await sendTelegramMessage(chatId, `🔍 <b>Researching "${query}"...</b>\n\nSearching saved leads, web sources, and synthesizing dossier. This may take 15-30 seconds.`);

    // Record the rate limit usage
    recordRateLimit(chatId);

    // Run the comprehensive research pipeline
    const result = await performResearch(query);

    if (result.confidence === "low" && !result.currentRole && !result.wealthIndicators && result.recentNews.length === 0) {
      await sendTelegramMessage(chatId, `❌ Limited information found for "<b>${query}</b>".\n\nTry:\n• Full name with company: <code>/research John Tan Grab</code>\n• Company name: <code>/research Grab Holdings</code>`);
      return;
    }

    // Store for save button
    const researchId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    pendingResearch.set(researchId, {
      type: result.entityType === 'person' ? 'founder' : 'company',
      founderResult: result.entityType === 'person' ? {
        founderName: result.name,
        companyName: result.company || "",
        linkedInUrl: result.linkedInUrl,
        biography: [result.currentRole, result.previousRoles, result.wealthIndicators].filter(Boolean).join("\n\n"),
        professionalBackground: result.previousRoles,
        education: result.education,
        notableAchievements: result.wealthIndicators,
        residenceCity: null,
        residenceCountry: null,
        confidence: result.confidence,
        sources: result.sources,
      } : undefined,
      companyResult: result.entityType === 'company' ? {
        companyName: result.name,
        description: [result.currentRole, result.wealthIndicators].filter(Boolean).join("\n\n"),
        industry: null,
        founded: null,
        headquarters: null,
        businessModel: null,
        confidence: result.confidence,
      } : undefined,
      timestamp: Date.now(),
    });

    // Format and send
    const formatted = formatResearchTelegram(result);
    const parts = splitLongMessage(formatted);

    for (let i = 0; i < parts.length - 1; i++) {
      await sendTelegramMessage(chatId, parts[i]);
    }

    // Last part with save button
    const saveButton = {
      inline_keyboard: [
        [{ text: "💾 Save to Leads", callback_data: `save_${researchId}` }]
      ]
    };
    await sendTelegramMessage(chatId, parts[parts.length - 1], 'HTML', saveButton);

  } catch (error) {
    console.error('Error in research command:', error);
    await sendTelegramMessage(chatId, "⚠️ Something went wrong. Please try again.");
  }
}

const RATE_LIMIT_MSG = "5";

/**
 * Handles save callback from inline button
 */
export async function handleSaveCallback(researchId: string, chatId: string, callbackQueryId: string): Promise<void> {
  try {
    // Get the research data
    const research = pendingResearch.get(researchId);

    if (!research) {
      await answerCallbackQuery(callbackQueryId, "❌ Research data expired. Please research again.");
      return;
    }

    await answerCallbackQuery(callbackQueryId, "💾 Saving to leads...");

    // Create a lead entry
    const now = new Date();
    let leadData: any;
    let savedLeadData: any = {};

    if (research.type === 'founder' && research.founderResult) {
      const founder = research.founderResult;
      leadData = {
        headline: `Research: ${founder.founderName}${founder.companyName ? ` - ${founder.companyName}` : ''}`,
        sourceUrl: founder.linkedInUrl || `https://telegram.research/${researchId}`,
        sourceName: "Telegram Research",
        sourceTier: "tier1" as const,
        publishedAt: now,
        companyNames: founder.companyName ? [founder.companyName] : [],
        founderNames: [founder.founderName],
        aiSummary: founder.biography || "No summary available",
        matchedKeywords: ["Manual Research"],
        region: "Global",
        priorityScore: 75,
        priorityLevel: "high" as const,
        investors: [],
      };

      savedLeadData = {
        founderName: founder.founderName,
        founderBio: founder.biography,
        founderLinkedInUrl: founder.linkedInUrl,
        companyName: founder.companyName,
      };
    } else if (research.type === 'company' && research.companyResult) {
      const company = research.companyResult;
      leadData = {
        headline: `Research: ${company.companyName}`,
        sourceUrl: `https://telegram.research/${researchId}`,
        sourceName: "Telegram Research",
        sourceTier: "tier1" as const,
        publishedAt: now,
        companyNames: [company.companyName],
        founderNames: [],
        aiSummary: company.description || "No summary available",
        matchedKeywords: ["Manual Research"],
        region: "Global",
        priorityScore: 75,
        priorityLevel: "high" as const,
        investors: [],
      };

      savedLeadData = {
        companyName: company.companyName,
        companyDescription: company.description,
      };
    }

    // Create the lead
    const lead = await storage.createLead(leadData);

    // Update lead status to saved
    await storage.updateLeadStatus(lead.id, "saved");

    // Create saved lead entry with enrichment data
    const savedLead = await storage.createSavedLead({
      leadId: lead.id,
      ...savedLeadData,
    });

    // Clean up the research data
    pendingResearch.delete(researchId);

    await sendTelegramMessage(chatId, `✅ <b>Saved to Leads!</b>\n\nLead ID: ${savedLead.id}\n\nYou can view it in the Sensei dashboard or use <code>/leads</code> to see all saved leads.`);

  } catch (error) {
    console.error('Error saving research:', error);
    await answerCallbackQuery(callbackQueryId, "❌ Failed to save");
    await sendTelegramMessage(chatId, "⚠️ Failed to save the research. Please try again.");
  }
}
