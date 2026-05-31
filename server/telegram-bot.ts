import { getTelegramUpdates, sendTelegramMessage, answerCallbackQuery, editMessageWithStatus, type TelegramUpdate } from './telegram';
import { handleStartCommand, handleHelpCommand, handleResearchCommand, handleLeadsCommand, handleSaveCallback, handleHereCommand } from './telegram-commands';
import { storage } from './storage';

/** Whether the bot is operating in webhook mode (true) or polling mode (false) */
let webhookMode = false;

let pollingInterval: NodeJS.Timeout | null = null;
let updateOffset = 0;
let isPolling = false;

// Track users waiting for research input (chatId -> true)
export const awaitingResearchInput = new Map<string, boolean>();

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
  // In groups, commands often arrive as "/here@BotName" — strip the @mention.
  const command = parts[0].toLowerCase().split('@')[0];
  const args = parts.slice(1);

  return { command, args };
}

/**
 * Routes a command to the appropriate handler
 */
async function routeCommand(command: string, args: string[], chatId: string, messageThreadId?: number): Promise<void> {
  try {
    // /here is a setup command — it must work even before settings exist, since
    // its whole job is to capture where alerts should go.
    if (command === 'here') {
      await handleHereCommand(chatId, messageThreadId);
      return;
    }

    const settings = await storage.getSettings();
    if (!settings) {
      await sendTelegramMessage(chatId, "⚠️ Settings not configured. Please configure the application first.", 'HTML', undefined, messageThreadId);
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
        await sendTelegramMessage(chatId, `❌ Unknown command: /${command}\n\nUse /help to see available commands.`, 'HTML', undefined, messageThreadId);
    }
  } catch (error) {
    console.error('Error routing command:', error);
    await sendTelegramMessage(chatId, "⚠️ Something went wrong. Please try again.", 'HTML', undefined, messageThreadId);
  }
}

/**
 * Handles a single Telegram update (message or callback).
 * Exported so the webhook endpoint can delegate to it directly.
 */
export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  try {
    // Handle callback queries (button clicks)
    if (update.callback_query) {
      const callbackQuery = update.callback_query;
      const chatId = callbackQuery.message?.chat.id.toString() || '';
      const callbackData = callbackQuery.data || '';
      const callbackQueryId = callbackQuery.id;
      const messageId = callbackQuery.message?.message_id;

      console.log(`Received callback from chat ${chatId}: ${callbackData}`);

      // Ignore noop callbacks (status indicator buttons)
      if (callbackData === 'noop') {
        await answerCallbackQuery(callbackQueryId);
        return;
      }

      // Handle lead action callbacks
      if (callbackData.startsWith('lead_save_')) {
        const leadId = callbackData.substring(10); // Remove 'lead_save_' prefix
        await handleLeadSaveCallback(leadId, chatId, callbackQueryId, messageId);
        return;
      }

      if (callbackData.startsWith('lead_reviewed_')) {
        const leadId = callbackData.substring(14); // Remove 'lead_reviewed_' prefix
        await handleLeadReviewedCallback(leadId, chatId, callbackQueryId, messageId);
        return;
      }

      if (callbackData.startsWith('lead_dismiss_')) {
        const leadId = callbackData.substring(13); // Remove 'lead_dismiss_' prefix
        await handleLeadDismissCallback(leadId, chatId, callbackQueryId, messageId);
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
    // Forum-topic thread the message came from (undefined in non-forum chats).
    const messageThreadId = update.message.message_thread_id;

    console.log(`Received message from chat ${chatId}${messageThreadId ? ` (topic ${messageThreadId})` : ''}: ${text}`);

    const parsed = parseCommand(text);
    if (!parsed) {
      // Check if we're waiting for research input from this user
      if (awaitingResearchInput.get(chatId)) {
        awaitingResearchInput.delete(chatId);
        const query = text.trim();
        if (query) {
          console.log(`Received research input from ${chatId}: ${query}`);
          const settings = await storage.getSettings();
          if (settings) {
            await handleResearchCommand(query.split(/\s+/), chatId, settings);
          }
          return;
        }
      }
      // Not a command and not awaiting input, ignore
      return;
    }

    console.log(`Processing command: /${parsed.command} with args:`, parsed.args);
    await routeCommand(parsed.command, parsed.args, chatId, messageThreadId);

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
 * Handles save button click for a lead.
 * Creates a saved_leads entry, updates lead status, and edits the message buttons.
 */
async function handleLeadSaveCallback(
  leadId: string,
  chatId: string,
  callbackQueryId: string,
  messageId?: number
): Promise<void> {
  try {
    const lead = await storage.getLeadById(leadId);
    if (!lead) {
      await answerCallbackQuery(callbackQueryId, "❌ Lead no longer available");
      if (messageId) {
        await editMessageWithStatus(chatId, messageId, "❌ Lead not found");
      }
      return;
    }

    // Check if already saved
    const existingSaved = await storage.getSavedLeadByLeadId(leadId);
    if (existingSaved) {
      await answerCallbackQuery(callbackQueryId, "✅ Already saved");
      if (messageId) {
        await editMessageWithStatus(chatId, messageId, "✅ Saved");
      }
      return;
    }

    // Create saved lead entry (this also sets lead status to "saved")
    await storage.createSavedLead({
      leadId: leadId,
      notes: "Saved from Telegram notification",
    });

    await answerCallbackQuery(callbackQueryId, "✅ Lead saved!");

    // Replace buttons with status indicator
    if (messageId) {
      await editMessageWithStatus(chatId, messageId, "✅ Saved");
    }
  } catch (error) {
    console.error('Error saving lead:', error);
    await answerCallbackQuery(callbackQueryId, "⚠️ Error, please try again");
    if (messageId) {
      await editMessageWithStatus(chatId, messageId, "⚠️ Error - try again");
    }
  }
}

/**
 * Handles reviewed button click for a lead.
 * Updates lead status and edits the message buttons.
 */
async function handleLeadReviewedCallback(
  leadId: string,
  chatId: string,
  callbackQueryId: string,
  messageId?: number
): Promise<void> {
  try {
    const lead = await storage.getLeadById(leadId);
    if (!lead) {
      await answerCallbackQuery(callbackQueryId, "❌ Lead no longer available");
      if (messageId) {
        await editMessageWithStatus(chatId, messageId, "❌ Lead not found");
      }
      return;
    }

    await storage.updateLeadStatus(leadId, "reviewed");
    await answerCallbackQuery(callbackQueryId, "✅ Marked as reviewed");

    // Replace buttons with status indicator
    if (messageId) {
      await editMessageWithStatus(chatId, messageId, "✅ Reviewed");
    }
  } catch (error) {
    console.error('Error marking lead as reviewed:', error);
    await answerCallbackQuery(callbackQueryId, "⚠️ Error, please try again");
    if (messageId) {
      await editMessageWithStatus(chatId, messageId, "⚠️ Error - try again");
    }
  }
}

/**
 * Handles dismiss button click for a lead.
 * Updates lead status and edits the message buttons.
 */
async function handleLeadDismissCallback(
  leadId: string,
  chatId: string,
  callbackQueryId: string,
  messageId?: number
): Promise<void> {
  try {
    const lead = await storage.getLeadById(leadId);
    if (!lead) {
      await answerCallbackQuery(callbackQueryId, "❌ Lead no longer available");
      if (messageId) {
        await editMessageWithStatus(chatId, messageId, "❌ Lead not found");
      }
      return;
    }

    await storage.updateLeadStatus(leadId, "dismissed");
    await answerCallbackQuery(callbackQueryId, "🗑️ Lead dismissed");

    // Replace buttons with status indicator
    if (messageId) {
      await editMessageWithStatus(chatId, messageId, "🗑️ Dismissed");
    }
  } catch (error) {
    console.error('Error dismissing lead:', error);
    await answerCallbackQuery(callbackQueryId, "⚠️ Error, please try again");
    if (messageId) {
      await editMessageWithStatus(chatId, messageId, "⚠️ Error - try again");
    }
  }
}

/**
 * Enables webhook mode, disabling the polling loop.
 * Call this when the webhook endpoint has been registered with Telegram.
 */
export function enableWebhookMode(): void {
  webhookMode = true;
  // Stop polling if it was already running
  if (pollingInterval) {
    console.log('Switching to webhook mode, stopping polling...');
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

/**
 * Returns whether the bot is in webhook mode.
 */
export function isWebhookMode(): boolean {
  return webhookMode;
}

/**
 * Starts the Telegram bot polling loop.
 * Skips polling if the bot is in webhook mode (updates arrive via HTTP POST instead).
 */
export async function startBot(): Promise<void> {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log('TELEGRAM_BOT_TOKEN not configured, skipping bot startup');
    return;
  }

  if (webhookMode) {
    console.log('Telegram bot in webhook mode, skipping polling startup');
    return;
  }

  if (pollingInterval) {
    console.log('Telegram bot already running');
    return;
  }

  console.log('Starting Telegram bot in polling mode...');

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
    console.log('Stopping Telegram bot polling...');
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}
