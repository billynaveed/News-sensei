import type { Lead } from "@shared/schema";

const TELEGRAM_API = 'https://api.telegram.org/bot';

export async function sendTelegramMessage(
  chatId: string,
  text: string,
  parseMode: 'HTML' | 'Markdown' = 'HTML',
  replyMarkup?: any
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

export async function sendTestTelegramMessage(chatId: string): Promise<void> {
  const message = `
<b>Lead Intelligence - Test Alert</b>

This is a test message to confirm your Telegram alerts are configured correctly.

You will receive messages like this when new high-priority leads are found matching your keywords.

<i>Private Banking SEA Coverage</i>
`.trim();

  await sendTelegramMessage(chatId, message);
}

export async function sendLeadAlertTelegram(chatId: string, leads: Lead[]): Promise<void> {
  // Send header message
  const header = `<b>🔔 ${leads.length} New Lead${leads.length > 1 ? 's' : ''} Found</b>\n\n`;
  await sendTelegramMessage(chatId, header);

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
          { text: "✅ Mark Reviewed", callback_data: `lead_reviewed_${lead.id}` }
        ],
        [
          { text: "🗑️ Dismiss", callback_data: `lead_dismiss_${lead.id}` }
        ]
      ]
    };

    await sendTelegramMessage(chatId, message, 'HTML', keyboard);
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
