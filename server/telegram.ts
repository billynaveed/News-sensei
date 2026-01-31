import type { Lead, IpoFiling } from "@shared/schema";

const TELEGRAM_API = 'https://api.telegram.org/bot';

interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

interface InlineKeyboard {
  inline_keyboard: InlineKeyboardButton[][];
}

async function sendTelegramMessage(
  chatId: string,
  text: string,
  parseMode: 'HTML' | 'Markdown' = 'HTML',
  replyMarkup?: InlineKeyboard
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
  const header = `<b>🔔 ${leads.length} New Lead${leads.length > 1 ? 's' : ''} Found</b>\n\nReview each lead below and tap Save or Dismiss:`;
  await sendTelegramMessage(chatId, header);

  // Send each lead as a separate message with action buttons
  for (const lead of leads) {
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

    // Create inline keyboard with Save and Dismiss buttons
    const keyboard: InlineKeyboard = {
      inline_keyboard: [
        [
          { text: '💾 Save', callback_data: `save:${lead.id}` },
          { text: '❌ Dismiss', callback_data: `dismiss:${lead.id}` },
        ],
      ],
    };

    await sendTelegramMessage(chatId, message, 'HTML', keyboard);
  }
}

export async function getTelegramUpdates(offset?: number): Promise<any[]> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }

  const url = offset
    ? `${TELEGRAM_API}${token}/getUpdates?offset=${offset}`
    : `${TELEGRAM_API}${token}/getUpdates`;

  const response = await fetch(url);
  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.description || 'Failed to get Telegram updates');
  }

  return result.result || [];
}

export async function answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }

  const response = await fetch(`${TELEGRAM_API}${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    }),
  });

  const result = await response.json();

  if (!result.ok) {
    console.error('Failed to answer callback query:', result);
  }
}

export async function editMessageReplyMarkup(
  chatId: string,
  messageId: number,
  replyMarkup?: InlineKeyboard
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }

  const body: any = {
    chat_id: chatId,
    message_id: messageId,
  };

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  } else {
    body.reply_markup = { inline_keyboard: [] };
  }

  const response = await fetch(`${TELEGRAM_API}${token}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const result = await response.json();

  if (!result.ok) {
    console.error('Failed to edit message markup:', result);
  }
}

export async function sendCostAlert(
  chatId: string,
  type: "approaching_limit" | "limit_exceeded" | "model_failure",
  data: { currentCost?: number; limit?: number; message: string }
): Promise<void> {
  if (!chatId) return;

  const emoji = type === "limit_exceeded" ? "🛑" : "⚠️";
  const title = type === "limit_exceeded"
    ? "Cost Limit Exceeded"
    : type === "approaching_limit"
    ? "Cost Limit Warning"
    : "AI Model Failure";

  let message = `${emoji} <b>${title}</b>\n\n${data.message}`;

  if (data.currentCost !== undefined && data.limit !== undefined) {
    const percent = (data.currentCost / data.limit * 100).toFixed(0);
    message += `\n\n📊 <b>Usage:</b> ${percent}% ($${data.currentCost.toFixed(4)} / $${data.limit.toFixed(2)})`;
  }

  await sendTelegramMessage(chatId, message, "HTML");
}

export async function sendDailyCostSummary(
  chatId: string,
  summary: {
    date: string;
    totalScans: number;
    totalCost: number;
    tier1Cost: number;
    tier2Cost: number;
    leadsFound: number;
    limit: number;
  }
): Promise<void> {
  if (!chatId) return;

  const percent = (summary.totalCost / summary.limit * 100).toFixed(0);
  const costPerLead = summary.leadsFound > 0
    ? (summary.totalCost / summary.leadsFound).toFixed(4)
    : "N/A";

  const message = `📊 <b>Daily Cost Report</b>
<i>${summary.date}</i>

💰 <b>Total Cost:</b> $${summary.totalCost.toFixed(4)} / $${summary.limit.toFixed(2)} (${percent}%)

📈 <b>Breakdown:</b>
• Tier 1 (Filtering): $${summary.tier1Cost.toFixed(4)}
• Tier 2 (Extraction): $${summary.tier2Cost.toFixed(4)}

🔍 <b>Activity:</b>
• Scans: ${summary.totalScans}
• Leads: ${summary.leadsFound}
• Cost per lead: $${costPerLead}

${summary.totalCost >= summary.limit ? "🛑 Daily limit reached - scanning paused" : "✅ Within budget"}`;

  await sendTelegramMessage(chatId, message, "HTML");
}

export async function sendIpoFilingAlert(chatId: string, filing: IpoFiling): Promise<void> {
  if (!chatId) return;

  const exchangeIcon = filing.exchange === "HKEX" ? "🇭🇰" : "🇸🇬";
  const filingDateStr = filing.filingDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });

  let message = `${exchangeIcon} <b>New IPO Filing - ${filing.exchange}</b>

<b>${filing.companyName}</b>`;

  if (filing.stockCode) {
    message += ` (${filing.stockCode})`;
  }

  if (filing.businessDescription) {
    message += `\n\n<i>${filing.businessDescription}</i>`;
  }

  message += `\n\n📅 <b>Filing Date:</b> ${filingDateStr}`;

  if (filing.founders && filing.founders.length > 0) {
    message += `\n👤 <b>Founders:</b> ${filing.founders.slice(0, 3).join(', ')}${filing.founders.length > 3 ? '...' : ''}`;
  }

  if (filing.keyManagement && filing.keyManagement.length > 0) {
    message += `\n👔 <b>Key Management:</b> ${filing.keyManagement.slice(0, 3).join(', ')}${filing.keyManagement.length > 3 ? '...' : ''}`;
  }

  if (filing.ipoSize) {
    message += `\n💰 <b>IPO Size:</b> ~$${filing.ipoSize}M`;
  }

  message += `\n📍 <b>Region:</b> ${filing.region}`;
  message += `\n\n<a href="${filing.prospectusUrl}">View Prospectus →</a>`;

  // Create inline keyboard with action buttons
  const keyboard: InlineKeyboard = {
    inline_keyboard: [
      [
        { text: '💾 Save', callback_data: `ipo_save:${filing.id}` },
        { text: '❌ Dismiss', callback_data: `ipo_dismiss:${filing.id}` },
      ],
    ],
  };

  await sendTelegramMessage(chatId, message, 'HTML', keyboard);
}
