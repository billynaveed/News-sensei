import { and, eq } from 'drizzle-orm';
import { leadFeedback, type Lead } from '@shared/schema';
import { getTelegramUpdates, sendTelegramMessage, answerCallbackQuery, editMessageWithStatus, editMessageReplyMarkup, type TelegramUpdate } from './telegram';
import { handleStartCommand, handleHelpCommand, handleResearchCommand, handleLeadsCommand, handleSaveCallback, handleHereCommand, handleTeachCommand, handleHealthCommand } from './telegram-commands';
import { LEAD_CALLBACK, leadActionRow, statusRow,
  escapeHtml,
} from './telegram-formatter';
import { upsertExample } from './pipeline-examples';
import { muteByNames } from './contacts';
import { blockByNames } from './families';
import { storage } from './storage';
import { db } from './db';
import { handleCardCallback, handleCardPhoto, isCardMessage } from './telegram-cards';

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

      case 'teach':
        await handleTeachCommand(args, chatId, settings, messageThreadId);
        break;

      case 'health':
        await handleHealthCommand(chatId, settings, messageThreadId);
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

      // Handle lead action callbacks. Prefixes come from telegram-formatter so
      // the button that was rendered and the branch that handles it can never
      // drift apart (they used to be a literal and a hand-counted substring).
      const leadRoutes: [string, (leadId: string) => Promise<void>][] = [
        [LEAD_CALLBACK.save, (id) => handleLeadSaveCallback(id, chatId, callbackQueryId, messageId)],
        [LEAD_CALLBACK.reviewed, (id) => handleLeadReviewedCallback(id, chatId, callbackQueryId, messageId)],
        [LEAD_CALLBACK.dismiss, (id) => handleLeadDismissCallback(id, chatId, callbackQueryId, messageId)],
        [LEAD_CALLBACK.mute, (id) => handleLeadMuteCallback(id, chatId, callbackQueryId, messageId)],
        [LEAD_CALLBACK.covered, (id) => handleLeadCoveredCallback(id, chatId, callbackQueryId, messageId)],
        [LEAD_CALLBACK.good, (id) => handleLeadFeedbackCallback(id, 'good', chatId, callbackQueryId, messageId)],
        [LEAD_CALLBACK.bad, (id) => handleLeadFeedbackCallback(id, 'bad', chatId, callbackQueryId, messageId)],
        [LEAD_CALLBACK.higher, (id) => handleScoredTooLowCallback(id, chatId, callbackQueryId, messageId)],
      ];

      for (const [prefix, handle] of leadRoutes) {
        if (callbackData.startsWith(prefix)) {
          await handle(callbackData.slice(prefix.length));
          return;
        }
      }

      // Business card buttons (save / re-read / discard).
      if (await handleCardCallback(callbackData, chatId, callbackQueryId, callbackQuery.message?.message_thread_id)) {
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

    // A photo (or an image sent as a file) is a business card to scan.
    if (isCardMessage(update.message)) {
      await handleCardPhoto(update.message!);
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

/** Marks every ui_lead_feedback row that came from a Telegram button tap. */
const TELEGRAM_FEEDBACK_REASON = "telegram";

/** Note stored on the reference example when Billy says a lead was under-scored. */
const SCORED_TOO_LOW_NOTE = "Billy: should have scored higher (Telegram)";

/**
 * Shows the outcome of a button tap on the message itself.
 *
 * State-changing taps (save / dismiss / mute) replace the whole keyboard, which
 * is also what makes a double-tap a no-op. Feedback taps replace only the second
 * row, so Billy can still save or dismiss the lead after rating it.
 */
async function showTapResult(
  chatId: string,
  messageId: number | undefined,
  statusText: string,
  keepActionsForLeadId?: string,
): Promise<void> {
  if (!messageId) return;
  if (keepActionsForLeadId) {
    await editMessageReplyMarkup(chatId, messageId, {
      inline_keyboard: [leadActionRow(keepActionsForLeadId), statusRow(statusText)],
    });
    return;
  }
  await editMessageWithStatus(chatId, messageId, statusText);
}

/** Loads the lead behind a callback, telling the user when it has gone away. */
async function loadLeadForCallback(
  leadId: string,
  chatId: string,
  callbackQueryId: string,
  messageId?: number,
): Promise<Lead | null> {
  const lead = await storage.getLeadById(leadId);
  if (lead) return lead;
  await answerCallbackQuery(callbackQueryId, "❌ Lead no longer available");
  await showTapResult(chatId, messageId, "❌ Lead not found");
  return null;
}

/** Uniform failure path: tell the user, and leave the message showing why. */
async function reportCallbackError(
  context: string,
  error: unknown,
  chatId: string,
  callbackQueryId: string,
  messageId?: number,
): Promise<void> {
  console.error(`Error ${context}:`, error);
  await answerCallbackQuery(callbackQueryId, "⚠️ Error, please try again");
  await showTapResult(chatId, messageId, "⚠️ Error - try again");
}

/**
 * Handles the "🔇 Mute founders" button.
 *
 * Mirrors what the dashboard does (POST /api/founders/mute then PATCH the lead
 * to dismissed), but calls the same storage/contacts functions directly instead
 * of looping back through HTTP.
 */
/**
 * "⛔ Covered": the founders on this lead are already banked elsewhere. Blocks
 * each of them and, per Billy's rule, their parents too — then says exactly
 * who was blocked, because a silent block would be worse than none.
 */
async function handleLeadCoveredCallback(
  leadId: string,
  chatId: string,
  callbackQueryId: string,
  messageId?: number,
): Promise<void> {
  try {
    const lead = await loadLeadForCallback(leadId, chatId, callbackQueryId, messageId);
    if (!lead) return;

    const names = (lead.founderNames || []).filter((n) => n && n.trim().length >= 2);
    if (names.length === 0) {
      await answerCallbackQuery(callbackQueryId, "No founders named on this lead");
      return;
    }

    const { blocked, skipped } = await blockByNames(names, "Covered by another banker", null);
    if (blocked.length === 0) {
      await answerCallbackQuery(callbackQueryId, "Nobody on this lead is in Sensei yet");
      await sendTelegramMessage(
        chatId,
        `⛔ Could not mark anyone as covered — ${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} not in Sensei yet.`,
        "HTML",
      );
      return;
    }

    const propagated = blocked.flatMap((b) => b.parents);
    await answerCallbackQuery(callbackQueryId, `⛔ Blocked ${blocked.length}`);
    const lines = [
      `⛔ <b>Marked as covered</b>`,
      ...blocked.map((b) => `• ${escapeHtml(b.name)}${b.parents.length ? ` — and ${escapeHtml(b.parents.join(", "))} (parents)` : ""}`),
    ];
    if (skipped.length) lines.push(`<i>Not in Sensei yet: ${escapeHtml(skipped.join(", "))}</i>`);
    if (propagated.length) lines.push("", "<i>Parents are blocked automatically: a covered child means the parents are covered too.</i>");
    await sendTelegramMessage(chatId, lines.join("\n"), "HTML");
  } catch (error) {
    console.error("Error handling covered callback:", error);
    await answerCallbackQuery(callbackQueryId, "Could not mark as covered");
  }
}

async function handleLeadMuteCallback(
  leadId: string,
  chatId: string,
  callbackQueryId: string,
  messageId?: number,
): Promise<void> {
  try {
    const lead = await loadLeadForCallback(leadId, chatId, callbackQueryId, messageId);
    if (!lead) return;

    const names = (lead.founderNames || []).filter((n) => n && n.trim().length >= 2);
    if (names.length === 0) {
      // Nothing to mute — leave the keyboard intact so Save/Dismiss still work.
      await answerCallbackQuery(callbackQueryId, "No founders named on this lead");
      return;
    }

    const muted = await muteByNames(names);
    await storage.updateLeadStatus(leadId, "dismissed");

    await answerCallbackQuery(callbackQueryId, `🔇 Muted ${muted} founder${muted === 1 ? "" : "s"}`);
    const shown = names.slice(0, 2).join(", ");
    const extra = names.length - Math.min(names.length, 2);
    await showTapResult(chatId, messageId, `🔇 Muted ${shown}${extra > 0 ? ` +${extra}` : ""} · dismissed`);
  } catch (error) {
    await reportCallbackError("muting lead founders", error, chatId, callbackQueryId, messageId);
  }
}

/**
 * Handles "👍 Good lead" / "👎 Not a lead".
 *
 * Writes one ui_lead_feedback row; the scan prompts read the bad ones back as
 * negative examples (see feedback-prompt.ts), which is the whole point. The
 * lead's own status is deliberately left alone — this is a rating, not triage.
 */
async function handleLeadFeedbackCallback(
  leadId: string,
  rating: "good" | "bad",
  chatId: string,
  callbackQueryId: string,
  messageId?: number,
): Promise<void> {
  const label = rating === "good" ? "👍 Good lead" : "👎 Not a lead";
  try {
    const lead = await loadLeadForCallback(leadId, chatId, callbackQueryId, messageId);
    if (!lead) return;

    // The keyboard edit already prevents a second tap; this guards the race
    // where two updates for the same tap arrive before the edit lands.
    const [existing] = await db
      .select({ id: leadFeedback.id })
      .from(leadFeedback)
      .where(and(eq(leadFeedback.leadId, leadId), eq(leadFeedback.reason, TELEGRAM_FEEDBACK_REASON)))
      .limit(1);

    if (!existing) {
      await db.insert(leadFeedback).values({
        leadId: lead.id,
        rating,
        reason: TELEGRAM_FEEDBACK_REASON,
        headline: lead.headline,
        category: lead.category,
        region: lead.region,
        companyNames: lead.companyNames,
        founderNames: lead.founderNames,
      });
    }

    await answerCallbackQuery(callbackQueryId, existing ? "Already recorded" : "Thanks — noted");
    await showTapResult(chatId, messageId, `${label} — noted`, leadId);
  } catch (error) {
    await reportCallbackError("recording lead feedback", error, chatId, callbackQueryId, messageId);
  }
}

/**
 * Handles "🎓 Should have scored higher".
 *
 * Turns the article into a reference example expecting a pass, so the nightly
 * regression run and the scan prompts both learn from it. Upsert-by-URL makes a
 * repeat tap (or the same article arriving twice) harmless.
 */
async function handleScoredTooLowCallback(
  leadId: string,
  chatId: string,
  callbackQueryId: string,
  messageId?: number,
): Promise<void> {
  try {
    const lead = await loadLeadForCallback(leadId, chatId, callbackQueryId, messageId);
    if (!lead) return;

    await upsertExample({
      url: lead.sourceUrl,
      headline: lead.headline,
      expected: "pass",
      note: SCORED_TOO_LOW_NOTE,
    });

    await answerCallbackQuery(callbackQueryId, "🎓 Taught — added to reference examples");
    await showTapResult(chatId, messageId, "🎓 Taught: should score higher", leadId);
  } catch (error) {
    await reportCallbackError("teaching from lead", error, chatId, callbackQueryId, messageId);
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
