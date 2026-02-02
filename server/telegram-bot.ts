import { getTelegramUpdates, sendTelegramMessage, answerCallbackQuery } from './telegram';
import { handleStartCommand, handleHelpCommand, handleResearchCommand, handleLeadsCommand, handleSaveCallback } from './telegram-commands';
import { storage } from './storage';

let pollingInterval: NodeJS.Timeout | null = null;
let updateOffset = 0;
let isPolling = false;

/**
 * Parses a command from message text
 * Returns { command: string, args: string[] }
 */
function parseCommand(text: string): { command: string; args: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  return { command, args };
}

/**
 * Routes a command to the appropriate handler
 */
async function routeCommand(command: string, args: string[], chatId: string): Promise<void> {
  try {
    const settings = await storage.getSettings();
    if (!settings) {
      await sendTelegramMessage(chatId, "⚠️ Settings not configured. Please configure the application first.");
      return;
    }

    switch (command) {
      case 'start':
        await handleStartCommand(chatId);
        break;

      case 'help':
        await handleHelpCommand(chatId);
        break;

      case 'research':
        await handleResearchCommand(args, chatId, settings);
        break;

      case 'leads':
        await handleLeadsCommand(chatId);
        break;

      default:
        await sendTelegramMessage(chatId, `❌ Unknown command: /${command}\n\nUse /help to see available commands.`);
    }
  } catch (error) {
    console.error('Error routing command:', error);
    await sendTelegramMessage(chatId, "⚠️ Something went wrong. Please try again.");
  }
}

/**
 * Handles a single Telegram update (message or callback)
 */
async function handleUpdate(update: any): Promise<void> {
  try {
    // Handle callback queries (button clicks)
    if (update.callback_query) {
      const callbackQuery = update.callback_query;
      const chatId = callbackQuery.message.chat.id.toString();
      const callbackData = callbackQuery.callback_data;
      const callbackQueryId = callbackQuery.id;

      console.log(`Received callback from chat ${chatId}: ${callbackData}`);

      // Handle lead action callbacks
      if (callbackData.startsWith('lead_save_')) {
        const leadId = callbackData.substring(10); // Remove 'lead_save_' prefix
        await handleLeadSaveCallback(leadId, chatId, callbackQueryId);
        return;
      }

      if (callbackData.startsWith('lead_reviewed_')) {
        const leadId = callbackData.substring(14); // Remove 'lead_reviewed_' prefix
        await handleLeadReviewedCallback(leadId, chatId, callbackQueryId);
        return;
      }

      if (callbackData.startsWith('lead_dismiss_')) {
        const leadId = callbackData.substring(13); // Remove 'lead_dismiss_' prefix
        await handleLeadDismissCallback(leadId, chatId, callbackQueryId);
        return;
      }

      // Handle research save callback
      if (callbackData.startsWith('save_')) {
        const researchId = callbackData.substring(5); // Remove 'save_' prefix
        await handleSaveCallback(researchId, chatId, callbackQueryId);
        return;
      }

      return;
    }

    // Handle regular messages
    if (!update.message?.text) {
      return;
    }

    const chatId = update.message.chat.id.toString();
    const text = update.message.text;

    console.log(`Received message from chat ${chatId}: ${text}`);

    const parsed = parseCommand(text);
    if (!parsed) {
      // Not a command, ignore
      return;
    }

    console.log(`Processing command: /${parsed.command} with args:`, parsed.args);
    await routeCommand(parsed.command, parsed.args, chatId);

  } catch (error) {
    console.error('Error handling update:', error);
  }
}

/**
 * Main polling loop
 */
async function pollUpdates(): Promise<void> {
  if (isPolling) {
    return; // Prevent concurrent polling
  }

  isPolling = true;

  try {
    const updates = await getTelegramUpdates(updateOffset);

    for (const update of updates) {
      await handleUpdate(update);
      updateOffset = update.update_id + 1;
    }
  } catch (error) {
    console.error('Error polling Telegram updates:', error);
  } finally {
    isPolling = false;
  }
}

/**
 * Handles save button click for a lead
 */
async function handleLeadSaveCallback(leadId: string, chatId: string, callbackQueryId: string): Promise<void> {
  try {
    const lead = await storage.getLeadById(leadId);
    if (!lead) {
      await answerCallbackQuery(callbackQueryId, "❌ Lead not found");
      return;
    }

    // Update lead status to saved
    await storage.updateLeadStatus(leadId, "saved");

    // Create saved lead entry
    await storage.createSavedLead({
      leadId: leadId,
      notes: "Saved from Telegram notification",
    });

    await answerCallbackQuery(callbackQueryId, "✅ Lead saved!");
    await sendTelegramMessage(chatId, `💾 <b>Lead Saved!</b>\n\n"${lead.headline}"\n\nYou can view it in the dashboard or use /leads to see all saved leads.`);
  } catch (error) {
    console.error('Error saving lead:', error);
    await answerCallbackQuery(callbackQueryId, "❌ Failed to save");
  }
}

/**
 * Handles reviewed button click for a lead
 */
async function handleLeadReviewedCallback(leadId: string, chatId: string, callbackQueryId: string): Promise<void> {
  try {
    const lead = await storage.getLeadById(leadId);
    if (!lead) {
      await answerCallbackQuery(callbackQueryId, "❌ Lead not found");
      return;
    }

    await storage.updateLeadStatus(leadId, "reviewed");
    await answerCallbackQuery(callbackQueryId, "✅ Marked as reviewed");
    await sendTelegramMessage(chatId, `✅ "${lead.headline}" marked as reviewed.`);
  } catch (error) {
    console.error('Error marking lead as reviewed:', error);
    await answerCallbackQuery(callbackQueryId, "❌ Failed to update");
  }
}

/**
 * Handles dismiss button click for a lead
 */
async function handleLeadDismissCallback(leadId: string, chatId: string, callbackQueryId: string): Promise<void> {
  try {
    const lead = await storage.getLeadById(leadId);
    if (!lead) {
      await answerCallbackQuery(callbackQueryId, "❌ Lead not found");
      return;
    }

    await storage.updateLeadStatus(leadId, "dismissed");
    await answerCallbackQuery(callbackQueryId, "🗑️ Lead dismissed");
    await sendTelegramMessage(chatId, `🗑️ "${lead.headline}" dismissed.`);
  } catch (error) {
    console.error('Error dismissing lead:', error);
    await answerCallbackQuery(callbackQueryId, "❌ Failed to dismiss");
  }
}

/**
 * Starts the Telegram bot polling loop
 */
export async function startBot(): Promise<void> {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log('TELEGRAM_BOT_TOKEN not configured, skipping bot startup');
    return;
  }

  if (pollingInterval) {
    console.log('Telegram bot already running');
    return;
  }

  console.log('Starting Telegram bot, polling for updates...');

  // Start polling every 2 seconds
  pollingInterval = setInterval(() => {
    pollUpdates().catch(err => {
      console.error('Error in polling loop:', err);
    });
  }, 2000);

  // Do an immediate poll
  pollUpdates().catch(err => {
    console.error('Error in initial poll:', err);
  });
}

/**
 * Stops the Telegram bot polling loop
 */
export async function stopBot(): Promise<void> {
  if (pollingInterval) {
    console.log('Stopping Telegram bot...');
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}
