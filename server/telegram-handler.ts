import { getTelegramUpdates, answerCallbackQuery, editMessageReplyMarkup, sendLeadAlertTelegram } from "./telegram";
import { storage } from "./storage";
import { scanForLeads } from "./scanner";
import { scanHkexIpos } from "./ipo-scanner";
import { enrichLead } from "./lead-enrichment";
import type { LeadStatus, IpoFilingStatus } from "@shared/schema";

const TELEGRAM_API = 'https://api.telegram.org/bot';

let lastUpdateId = 0;
let pollingInterval: NodeJS.Timeout | null = null;

export function startTelegramPolling() {
  if (pollingInterval) {
    return; // Already polling
  }

  console.log("Starting Telegram polling for commands and button presses...");

  pollingInterval = setInterval(async () => {
    try {
      const updates = await getTelegramUpdates(lastUpdateId + 1);

      for (const update of updates) {
        lastUpdateId = Math.max(lastUpdateId, update.update_id);

        // Handle text messages (commands)
        if (update.message?.text) {
          await handleTextMessage(update.message);
        }

        // Handle callback queries (button presses)
        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
        }
      }
    } catch (error) {
      console.error("Error polling Telegram updates:", error);
    }
  }, 2000); // Poll every 2 seconds
}

export function stopTelegramPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log("Stopped Telegram polling");
  }
}

async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
}

async function handleTextMessage(message: any) {
  const chatId = message.chat.id.toString();
  const text = message.text.trim();

  console.log(`Received Telegram command: ${text} from ${message.from.first_name}`);

  try {
    // Handle commands
    if (text.startsWith('/')) {
      const command = text.split(' ')[0].toLowerCase();

      switch (command) {
        case '/start':
        case '/help':
          await handleHelpCommand(chatId);
          break;

        case '/leads':
        case '/saved':
          await handleLeadsCommand(chatId, 'saved');
          break;

        case '/new':
          await handleLeadsCommand(chatId, 'new');
          break;

        case '/dismissed':
          await handleLeadsCommand(chatId, 'dismissed');
          break;

        case '/all':
          await handleLeadsCommand(chatId, 'all');
          break;

        case '/stats':
          await handleStatsCommand(chatId);
          break;

        case '/scan':
          await handleScanCommand(chatId);
          break;

        case '/ipos':
          await handleIposCommand(chatId, 'new');
          break;

        case '/iposcan':
          await handleIpoScanCommand(chatId);
          break;

        default:
          // Check if it's a /research command
          if (command.startsWith('/research')) {
            const founderName = text.replace('/research', '').trim();
            if (founderName) {
              await handleResearchCommand(chatId, founderName);
            } else {
              await sendTelegramMessage(chatId, '❓ Please provide a founder name. Example: /research Elon Musk');
            }
          } else {
            await sendTelegramMessage(chatId, '❓ Unknown command. Send /help to see available commands.');
          }
      }
    }
  } catch (error) {
    console.error("Error handling text message:", error);
    await sendTelegramMessage(chatId, '❌ Error processing command. Please try again.');
  }
}

async function handleHelpCommand(chatId: string) {
  const helpText = `<b>🤖 Lead Intelligence Bot</b>

Available commands:

<b>Lead Management:</b>
/leads, /saved - View your saved leads
/new - View new leads requiring review
/dismissed - View dismissed leads
/all - View all leads

<b>IPO Filings:</b>
/ipos - View new IPO filings
/iposcan - Scan for new IPO filings

<b>Analytics:</b>
/stats - Show lead statistics

<b>Actions:</b>
/scan - Start a new news scan

<b>Research:</b>
/research [name] - Look up founder profile
Example: /research Elon Musk

<b>Help:</b>
/help - Show this help message

You can also interact with leads using the Save/Dismiss buttons when they're sent to you!`;

  await sendTelegramMessage(chatId, helpText);
}

async function handleLeadsCommand(chatId: string, status: string) {
  const leads = await storage.getAllLeads();
  let filteredLeads;

  if (status === 'all') {
    filteredLeads = leads;
  } else {
    filteredLeads = leads.filter(l => l.status === status);
  }

  if (filteredLeads.length === 0) {
    await sendTelegramMessage(chatId, `📋 No ${status} leads found.`);
    return;
  }

  // Send header
  const statusEmoji = status === 'saved' ? '💾' : status === 'new' ? '🆕' : status === 'dismissed' ? '❌' : '📋';
  await sendTelegramMessage(chatId, `${statusEmoji} <b>${status.toUpperCase()} Leads (${filteredLeads.length})</b>\n\nShowing top 5:`);

  // Send first 5 leads
  for (const lead of filteredLeads.slice(0, 5)) {
    const priorityIcon = lead.priorityLevel === 'high' ? '🔴' : lead.priorityLevel === 'medium' ? '🟡' : '🟢';
    const companyInfo = lead.companyDescription
      ? `${lead.companyNames.join(', ')}\n<i>${lead.companyDescription}</i>`
      : lead.companyNames.join(', ');

    let message = `${priorityIcon} <b>${lead.headline}</b>

<i>Companies:</i> ${companyInfo}
<i>People:</i> ${lead.founderNames.join(', ') || 'N/A'}
<i>Region:</i> ${lead.region} | Score: ${lead.priorityScore}

${lead.aiSummary}`;

    // Add LinkedIn profiles if available
    if (lead.linkedinProfiles && lead.linkedinProfiles.length > 0) {
      message += `\n\n<b>🔗 LinkedIn:</b>\n`;
      lead.linkedinProfiles.forEach(url => {
        message += `• ${url}\n`;
      });
    }

    // Add investors if available
    if (lead.investors && lead.investors.length > 0) {
      message += `\n<b>💰 Investors:</b>\n`;
      lead.investors.forEach(inv => {
        message += `• ${inv}\n`;
      });
    }

    message += `\n\n<a href="${lead.sourceUrl}">Read more →</a>`;

    await sendTelegramMessage(chatId, message);

    // Small delay between messages
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  if (filteredLeads.length > 5) {
    await sendTelegramMessage(chatId, `... and ${filteredLeads.length - 5} more leads.`);
  }
}

async function handleStatsCommand(chatId: string) {
  const leads = await storage.getAllLeads();

  // Calculate stats
  const byStatus = {
    new: leads.filter(l => l.status === 'new').length,
    reviewed: leads.filter(l => l.status === 'reviewed').length,
    saved: leads.filter(l => l.status === 'saved').length,
    contacted: leads.filter(l => l.status === 'contacted').length,
    dismissed: leads.filter(l => l.status === 'dismissed').length,
  };

  const byPriority = {
    high: leads.filter(l => l.priorityLevel === 'high').length,
    medium: leads.filter(l => l.priorityLevel === 'medium').length,
    low: leads.filter(l => l.priorityLevel === 'low').length,
  };

  const statsText = `<b>📊 Lead Statistics</b>

<b>Total Leads:</b> ${leads.length}

<b>By Status:</b>
• New: ${byStatus.new}
• Reviewed: ${byStatus.reviewed}
• Saved: ${byStatus.saved}
• Contacted: ${byStatus.contacted}
• Dismissed: ${byStatus.dismissed}

<b>By Priority:</b>
• 🔴 High: ${byPriority.high}
• 🟡 Medium: ${byPriority.medium}
• 🟢 Low: ${byPriority.low}`;

  await sendTelegramMessage(chatId, statsText);
}

async function handleScanCommand(chatId: string) {
  await sendTelegramMessage(chatId, '🔍 Starting news scan... This may take a minute.');

  try {
    const result = await scanForLeads();

    const resultText = `✅ <b>Scan Complete!</b>

• Articles scanned: ${result.articlesScanned}
• New leads found: ${result.newLeads}
• Duplicates skipped: ${result.duplicatesSkipped}

${result.newLeads > 0 ? 'New leads will be sent to you shortly! 🎉' : 'No new leads found this time.'}`;

    await sendTelegramMessage(chatId, resultText);
  } catch (error) {
    await sendTelegramMessage(chatId, '❌ Error running scan. Please try again later.');
    console.error("Error in scan command:", error);
  }
}

async function handleIposCommand(chatId: string, status: string) {
  const filings = await storage.getAllIpoFilings();
  let filteredFilings;

  if (status === 'all') {
    filteredFilings = filings;
  } else {
    filteredFilings = filings.filter(f => f.status === status);
  }

  if (filteredFilings.length === 0) {
    await sendTelegramMessage(chatId, `📋 No ${status} IPO filings found.`);
    return;
  }

  // Send header
  const statusEmoji = '🏢';
  await sendTelegramMessage(chatId, `${statusEmoji} <b>IPO FILINGS (${filteredFilings.length})</b>\n\nShowing top 5:`);

  // Send first 5 filings
  for (const filing of filteredFilings.slice(0, 5)) {
    const exchangeIcon = filing.exchange === "HKEX" ? "🇭🇰" : "🇸🇬";
    const filingDateStr = filing.filingDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });

    let message = `${exchangeIcon} <b>${filing.companyName}</b>`;
    if (filing.stockCode) {
      message += ` (${filing.stockCode})`;
    }

    if (filing.businessDescription) {
      message += `\n\n<i>${filing.businessDescription}</i>`;
    }

    message += `\n\n📅 ${filingDateStr} | 📍 ${filing.region}`;

    if (filing.founders && filing.founders.length > 0) {
      message += `\n👤 ${filing.founders.slice(0, 2).join(', ')}`;
    }

    message += `\n\n<a href="${filing.prospectusUrl}">View Prospectus →</a>`;

    await sendTelegramMessage(chatId, message);

    // Small delay between messages
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  if (filteredFilings.length > 5) {
    await sendTelegramMessage(chatId, `... and ${filteredFilings.length - 5} more IPO filings.`);
  }
}

async function handleIpoScanCommand(chatId: string) {
  await sendTelegramMessage(chatId, '🏢 Starting IPO scan... This may take a minute.');

  try {
    const result = await scanHkexIpos({ parsePdfs: true, maxPdfsToProcess: 3 });

    const resultText = `✅ <b>IPO Scan Complete!</b>

• Listings scanned: ${result.scanned}
• New filings found: ${result.newFilings}
• Duplicates skipped: ${result.duplicatesSkipped}

${result.newFilings > 0 ? 'New IPO filings will be sent to you shortly! 🎉' : 'No new IPO filings found this time.'}`;

    await sendTelegramMessage(chatId, resultText);
  } catch (error) {
    await sendTelegramMessage(chatId, '❌ Error running IPO scan. Please try again later.');
    console.error("Error in IPO scan command:", error);
  }
}

async function handleResearchCommand(chatId: string, founderName: string) {
  await sendTelegramMessage(chatId, `🔍 Researching <b>${founderName}</b>...`);

  try {
    const { storage } = await import("./storage");

    // Search for existing profile
    let profile = await storage.getFounderProfileByName(founderName);

    if (!profile) {
      // Try fuzzy search
      const results = await storage.searchFounderProfiles(founderName);
      if (results.length > 0) {
        profile = results[0];
      }
    }

    if (profile) {
      // Format and send existing profile
      let profileText = `👤 <b>${profile.name}</b>\n`;

      if (profile.currentRole && profile.currentCompany) {
        profileText += `\n🏢 ${profile.currentRole} at ${profile.currentCompany}`;
      }

      if (profile.bio) {
        profileText += `\n\n📝 ${profile.bio}`;
      }

      if (profile.education && profile.education.length > 0) {
        profileText += `\n\n🎓 <b>Education:</b>\n${profile.education.map(e => `  • ${e}`).join('\n')}`;
      }

      if (profile.previousCompanies && profile.previousCompanies.length > 0) {
        profileText += `\n\n💼 <b>Previous:</b>\n${profile.previousCompanies.map(c => `  • ${c}`).join('\n')}`;
      }

      if (profile.notableInvestments && profile.notableInvestments.length > 0) {
        profileText += `\n\n💰 <b>Investments:</b>\n${profile.notableInvestments.map(i => `  • ${i}`).join('\n')}`;
      }

      if (profile.notableExits && profile.notableExits.length > 0) {
        profileText += `\n\n🚀 <b>Exits:</b>\n${profile.notableExits.map(e => `  • ${e}`).join('\n')}`;
      }

      if (profile.estimatedNetWorth) {
        profileText += `\n\n💎 <b>Est. Net Worth:</b> ${profile.estimatedNetWorth}`;
      }

      if (profile.keyAchievements && profile.keyAchievements.length > 0) {
        profileText += `\n\n🏆 <b>Achievements:</b>\n${profile.keyAchievements.map(a => `  • ${a}`).join('\n')}`;
      }

      if (profile.linkedinUrl) {
        profileText += `\n\n🔗 <a href="${profile.linkedinUrl}">LinkedIn</a>`;
      }

      await sendTelegramMessage(chatId, profileText);
    } else {
      await sendTelegramMessage(chatId, `❌ No profile found for <b>${founderName}</b>.\n\n💡 Profiles are created when leads are enriched.`);
    }
  } catch (error) {
    await sendTelegramMessage(chatId, '❌ Error fetching profile. Please try again.');
    console.error("Error in research command:", error);
  }
}

async function handleCallbackQuery(callbackQuery: any) {
  const { id: callbackQueryId, data, message } = callbackQuery;

  if (!data) return;

  try {
    // Parse callback data: "action:id" or "ipo_action:id"
    const parts = data.split(':');

    if (parts.length !== 2) {
      await answerCallbackQuery(callbackQueryId, 'Invalid action');
      return;
    }

    const [action, id] = parts;

    // Handle IPO filing actions
    if (action === 'ipo_save' || action === 'ipo_dismiss') {
      const ipoStatus: IpoFilingStatus = action === 'ipo_save' ? 'reviewed' : 'dismissed';
      const updatedFiling = await storage.updateIpoFilingStatus(id, ipoStatus);

      if (!updatedFiling) {
        await answerCallbackQuery(callbackQueryId, 'IPO filing not found');
        return;
      }

      // Remove buttons from the message
      if (message?.chat?.id && message?.message_id) {
        await editMessageReplyMarkup(
          message.chat.id.toString(),
          message.message_id
        );
      }

      const actionText = action === 'ipo_save' ? '💾 Saved' : '❌ Dismissed';
      await answerCallbackQuery(callbackQueryId, `${actionText} successfully!`);

      console.log(`IPO filing ${id} marked as ${ipoStatus} via Telegram`);
      return;
    }

    // Handle lead actions
    if (!['save', 'dismiss'].includes(action)) {
      await answerCallbackQuery(callbackQueryId, 'Invalid action');
      return;
    }

    // Update lead status
    const status: LeadStatus = action === 'save' ? 'saved' : 'dismissed';
    const updatedLead = await storage.updateLeadStatus(id, status);

    if (!updatedLead) {
      await answerCallbackQuery(callbackQueryId, 'Lead not found');
      return;
    }

    // If saving the lead, enrich it with LinkedIn and investors
    if (action === 'save') {
      const chatId = message.chat.id.toString();
      await sendTelegramMessage(chatId, '🔍 Researching LinkedIn profiles and investors...');

      try {
        const enrichmentData = await enrichLead({
          companyNames: updatedLead.companyNames,
          founderNames: updatedLead.founderNames,
          region: updatedLead.region,
          companyDescription: updatedLead.companyDescription,
        });

        await storage.enrichLead(id, enrichmentData.linkedinProfiles, enrichmentData.investors);

        // Send enriched data to Telegram
        let enrichmentMessage = `✅ <b>Lead Enriched!</b>\n\n`;

        if (enrichmentData.linkedinProfiles.length > 0) {
          enrichmentMessage += `<b>🔗 LinkedIn Profiles:</b>\n`;
          enrichmentData.linkedinProfiles.forEach(url => {
            enrichmentMessage += `• ${url}\n`;
          });
        } else {
          enrichmentMessage += `<b>🔗 LinkedIn Profiles:</b> None found\n`;
        }

        if (enrichmentData.investors.length > 0) {
          enrichmentMessage += `\n<b>💰 Investors:</b>\n`;
          enrichmentData.investors.forEach(inv => {
            enrichmentMessage += `• ${inv}\n`;
          });
        } else {
          enrichmentMessage += `\n<b>💰 Investors:</b> None found`;
        }

        await sendTelegramMessage(chatId, enrichmentMessage);
      } catch (error) {
        console.error("Error enriching lead:", error);
        await sendTelegramMessage(chatId, '⚠️ Could not complete enrichment. Lead has been saved without enrichment data.');
      }
    }

    // Remove buttons from the message
    if (message?.chat?.id && message?.message_id) {
      await editMessageReplyMarkup(
        message.chat.id.toString(),
        message.message_id
      );
    }

    // Send confirmation
    const actionText = action === 'save' ? '💾 Saved' : '❌ Dismissed';
    await answerCallbackQuery(callbackQueryId, `${actionText} successfully!`);

    console.log(`Lead ${id} marked as ${status} via Telegram`);
  } catch (error) {
    console.error("Error handling callback query:", error);
    await answerCallbackQuery(callbackQueryId, 'Error processing action');
  }
}
