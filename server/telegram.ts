import type { Lead } from "@shared/schema";

const TELEGRAM_API = 'https://api.telegram.org/bot';

async function sendTelegramMessage(chatId: string, text: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }
  
  if (!chatId) {
    throw new Error('Telegram chat ID not configured');
  }

  const response = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }),
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
  const header = `<b>🔔 ${leads.length} New Lead${leads.length > 1 ? 's' : ''} Found</b>\n\n`;
  
  const leadMessages = leads.map(lead => {
    const priorityIcon = lead.priorityLevel === 'high' ? '🔴' : lead.priorityLevel === 'medium' ? '🟡' : '🟢';
    return `${priorityIcon} <b>${lead.headline}</b>
<i>Companies:</i> ${lead.companyNames.join(', ')}
<i>People:</i> ${lead.founderNames.join(', ') || 'N/A'}
<i>Region:</i> ${lead.region} | Score: ${lead.priorityScore}
${lead.aiSummary}
<a href="${lead.sourceUrl}">Read more →</a>`;
  }).join('\n\n---\n\n');

  const message = header + leadMessages;
  
  // Telegram has a 4096 character limit, split if needed
  if (message.length > 4000) {
    // Send header + first lead, then remaining leads individually
    await sendTelegramMessage(chatId, header + 'Multiple leads found. Sending details...');
    for (const lead of leads) {
      const priorityIcon = lead.priorityLevel === 'high' ? '🔴' : lead.priorityLevel === 'medium' ? '🟡' : '🟢';
      const singleLead = `${priorityIcon} <b>${lead.headline}</b>
<i>Companies:</i> ${lead.companyNames.join(', ')}
<i>People:</i> ${lead.founderNames.join(', ') || 'N/A'}
<i>Region:</i> ${lead.region} | Score: ${lead.priorityScore}
${lead.aiSummary}
<a href="${lead.sourceUrl}">Read more →</a>`;
      await sendTelegramMessage(chatId, singleLead);
    }
  } else {
    await sendTelegramMessage(chatId, message);
  }
}

export async function getTelegramUpdates(): Promise<any[]> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }

  const response = await fetch(`${TELEGRAM_API}${token}/getUpdates`);
  const result = await response.json();
  
  if (!result.ok) {
    throw new Error(result.description || 'Failed to get Telegram updates');
  }
  
  return result.result || [];
}
