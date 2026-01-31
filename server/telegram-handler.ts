import { getTelegramUpdates, answerCallbackQuery, editMessageReplyMarkup, sendLeadAlertTelegram } from "./telegram";
import { storage } from "./storage";
import { scanForLeads } from "./scanner";
import type { LeadStatus } from "@shared/schema";

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

        default:
          await sendTelegramMessage(chatId, '❓ Unknown command. Send /help to see available commands.');
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

<b>Analytics:</b>
/stats - Show lead statistics

<b>Actions:</b>
/scan - Start a new news scan

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

    const message = `${priorityIcon} <b>${lead.headline}</b>

<i>Companies:</i> ${companyInfo}
<i>People:</i> ${lead.founderNames.join(', ') || 'N/A'}
<i>Region:</i> ${lead.region} | Score: ${lead.priorityScore}

${lead.aiSummary}

<a href="${lead.sourceUrl}">Read more →</a>`;

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

async function handleCallbackQuery(callbackQuery: any) {
  const { id: callbackQueryId, data, message } = callbackQuery;

  if (!data) return;

  try {
    // Parse callback data: "action:leadId"
    const [action, leadId] = data.split(':');

    if (!leadId || !['save', 'dismiss'].includes(action)) {
      await answerCallbackQuery(callbackQueryId, 'Invalid action');
      return;
    }

    // Update lead status
    const status: LeadStatus = action === 'save' ? 'saved' : 'dismissed';
    const updatedLead = await storage.updateLeadStatus(leadId, status);

    if (!updatedLead) {
      await answerCallbackQuery(callbackQueryId, 'Lead not found');
      return;
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

    console.log(`Lead ${leadId} marked as ${status} via Telegram`);
  } catch (error) {
    console.error("Error handling callback query:", error);
    await answerCallbackQuery(callbackQueryId, 'Error processing action');
  }
}
