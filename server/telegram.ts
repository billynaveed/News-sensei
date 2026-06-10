import type { Lead } from "@shared/schema";

const TELEGRAM_API = 'https://api.telegram.org/bot';

/** Telegram callback_query object shape (subset of fields we use) */
export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; first_name: string };
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
  };
  data?: string;
}

/** Telegram update object shape (subset of fields we use) */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    // Present when the message was sent inside a forum supergroup topic.
    message_thread_id?: number;
    text?: string;
    from?: { id: number; first_name: string };
  };
  callback_query?: TelegramCallbackQuery;
  channel_post?: {
    message_id: number;
    chat: { id: number };
    message_thread_id?: number;
    text?: string;
  };
}

export async function sendTelegramMessage(
  chatId: string,
  text: string,
  parseMode: 'HTML' | 'Markdown' = 'HTML',
  replyMarkup?: any,
  messageThreadId?: number | null
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }

  if (!chatId) {
    throw new Error('Telegram chat ID not configured');
  }

  const body: any = {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  };

  // Route into a forum topic when configured (null/undefined => General).
  if (messageThreadId != null) {
    body.message_thread_id = messageThreadId;
  }

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  const response = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const result = await response.json();

  if (!result.ok) {
    console.error('Telegram API error:', result);
    throw new Error(result.description || 'Failed to send Telegram message');
  }

  return true;
}

export async function sendTestTelegramMessage(chatId: string, messageThreadId?: number | null): Promise<void> {
  const message = `
<b>Lead Intelligence - Test Alert</b>

This is a test message to confirm your Telegram alerts are configured correctly.

You will receive messages like this when new high-priority leads are found matching your keywords.

<i>Private Banking SEA Coverage</i>
`.trim();

  await sendTelegramMessage(chatId, message, 'HTML', undefined, messageThreadId);
}

export async function sendLeadAlertTelegram(chatId: string, leads: Lead[], messageThreadId?: number | null): Promise<void> {
  // Send header message
  const header = `<b>🔔 ${leads.length} New Lead${leads.length > 1 ? 's' : ''} Found</b>\n\n`;
  await sendTelegramMessage(chatId, header, 'HTML', undefined, messageThreadId);

  // Send each lead as a separate message with action buttons
  for (const lead of leads) {
    const priorityIcon = lead.priorityLevel === 'high' ? '🔴' : lead.priorityLevel === 'medium' ? '🟡' : '🟢';
    const message = `${priorityIcon} <b>${lead.headline}</b>

<i>Companies:</i> ${lead.companyNames.join(', ')}
<i>People:</i> ${lead.founderNames.join(', ') || 'N/A'}
<i>Region:</i> ${lead.region} | <b>Score: ${lead.priorityScore}</b>

${lead.aiSummary}

<a href="${lead.sourceUrl}">Read full article →</a>`;

    // Add inline keyboard with action buttons
    const keyboard = {
      inline_keyboard: [
        [
          { text: "💾 Save", callback_data: `lead_save_${lead.id}` },
          { text: "🗑️ Dismiss", callback_data: `lead_dismiss_${lead.id}` }
        ]
      ]
    };

    await sendTelegramMessage(chatId, message, 'HTML', keyboard, messageThreadId);
  }
}

export async function getTelegramUpdates(offset?: number): Promise<any[]> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }

  const params = offset ? `?offset=${offset}` : '';
  const response = await fetch(`${TELEGRAM_API}${token}/getUpdates${params}`);
  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.description || 'Failed to get Telegram updates');
  }

  return result.result || [];
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }

  const response = await fetch(`${TELEGRAM_API}${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text || 'Processing...',
      show_alert: false,
    }),
  });

  const result = await response.json();

  if (!result.ok) {
    console.error('Telegram API error:', result);
    return false;
  }

  return true;
}

/**
 * Registers a webhook URL with Telegram so updates are pushed via HTTP POST
 * instead of pulled via getUpdates polling.
 *
 * @param webhookUrl - The publicly accessible HTTPS URL for the webhook endpoint
 * @returns true if the webhook was set successfully
 */
export async function setWebhook(webhookUrl: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }

  console.log(`Setting Telegram webhook to: ${webhookUrl}`);

  const response = await fetch(`${TELEGRAM_API}${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
      // When configured, Telegram echoes this back in the
      // X-Telegram-Bot-Api-Secret-Token header so the webhook can verify
      // that incoming updates genuinely originate from Telegram.
      ...(process.env.TELEGRAM_WEBHOOK_SECRET
        ? { secret_token: process.env.TELEGRAM_WEBHOOK_SECRET }
        : {}),
    }),
  });

  const result = await response.json();

  if (!result.ok) {
    console.error('Failed to set Telegram webhook:', result);
    throw new Error(result.description || 'Failed to set webhook');
  }

  console.log('Telegram webhook set successfully');
  return true;
}

/**
 * Removes the current webhook, allowing the bot to fall back to getUpdates polling.
 *
 * @returns true if the webhook was deleted successfully
 */
export async function deleteWebhook(): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }

  console.log('Deleting Telegram webhook...');

  const response = await fetch(`${TELEGRAM_API}${token}/deleteWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ drop_pending_updates: false }),
  });

  const result = await response.json();

  if (!result.ok) {
    console.error('Failed to delete Telegram webhook:', result);
    return false;
  }

  console.log('Telegram webhook deleted');
  return true;
}

/**
 * Edits the inline keyboard (reply markup) of an existing message.
 * Used to replace action buttons with a status indicator after a callback is processed.
 *
 * @param chatId - The chat where the message lives
 * @param messageId - The message_id of the message to edit
 * @param newReplyMarkup - New inline keyboard markup, or undefined to remove all buttons
 * @returns true if the edit succeeded
 */
export async function editMessageReplyMarkup(
  chatId: string,
  messageId: number,
  newReplyMarkup?: object
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }

  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
  };

  if (newReplyMarkup) {
    body.reply_markup = newReplyMarkup;
  } else {
    // Pass empty inline_keyboard to remove all buttons
    body.reply_markup = { inline_keyboard: [] };
  }

  const response = await fetch(`${TELEGRAM_API}${token}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const result = await response.json();

  if (!result.ok) {
    // Telegram returns an error if markup is unchanged -- not a real failure
    if (result.description?.includes('message is not modified')) {
      return true;
    }
    console.error('Failed to edit message reply markup:', result);
    return false;
  }

  return true;
}

/**
 * Appends a status line to an existing message and removes its inline buttons.
 * This provides visual feedback that a button action was processed.
 *
 * @param chatId - The chat where the message lives
 * @param messageId - The message_id of the message to edit
 * @param originalText - The original message text (HTML) that should be preserved
 * @param statusText - The status indicator to append (e.g. "Saved", "Reviewed")
 */
export async function editMessageWithStatus(
  chatId: string,
  messageId: number,
  statusText: string
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }

  // We edit the reply markup to show a single disabled-looking button with the status
  // This approach avoids needing the original message text (which we may not have)
  const statusMarkup = {
    inline_keyboard: [
      [{ text: statusText, callback_data: 'noop' }]
    ]
  };

  return editMessageReplyMarkup(chatId, messageId, statusMarkup);
}
