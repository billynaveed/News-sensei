/**
 * Business card scanning over Telegram.
 *
 * Photograph a card at the event, send it to the bot, get back the parsed
 * contact plus a .vcf to tap-save into the phone. An album (several photos
 * sent together) is collected on a short debounce and scanned as a batch,
 * because Telegram delivers each photo of an album as its own update.
 */

import { randomUUID } from "crypto";
import { log } from "./log";
import {
  answerCallbackQuery,
  downloadTelegramFileAsDataUrl,
  sendTelegramDocument,
  sendTelegramMessage,
  type TelegramUpdate,
} from "./telegram";
import { escapeHtml, getAppBaseUrl } from "./telegram-formatter";
import { cardVCard, deleteCard, getCard, reparseCard, saveCard, scanCard } from "./card-scanner";
import { vcardFilename, type ParsedCard } from "./card-normalize";

/** Callback prefixes. Kept short: Telegram caps callback_data at 64 bytes. */
export const CARD_CALLBACK = {
  save: "cs:",
  reparse: "cr:",
  discard: "cd:",
} as const;

type PhotoMessage = NonNullable<TelegramUpdate["message"]>;

/** Albums arrive as separate updates; hold them briefly and scan together. */
const albums = new Map<string, { chatId: string; threadId?: number; caption: string | null; fileIds: string[]; timer: NodeJS.Timeout }>();
const ALBUM_DEBOUNCE_MS = parseInt(process.env.CARD_ALBUM_DEBOUNCE_MS || "2500", 10);

/** True when this message carries something we should try to read as a card. */
export function isCardMessage(message: PhotoMessage | undefined): boolean {
  if (!message) return false;
  if (message.photo?.length) return true;
  return !!message.document?.mime_type?.startsWith("image/");
}

/** The largest photo size Telegram offers, or the document's file id. */
function fileIdOf(message: PhotoMessage): string | null {
  if (message.photo?.length) return message.photo[message.photo.length - 1].file_id;
  if (message.document?.mime_type?.startsWith("image/")) return message.document.file_id;
  return null;
}

/**
 * One line per field, showing exactly what will be saved. Phones are shown in
 * E.164 because that is what makes WhatsApp and the dialler work.
 */
export function formatCardForTelegram(card: ParsedCard, opts?: { duplicates?: { fullName: string; reason: string }[]; note?: string | null }): string {
  const lines: string[] = [];
  const name = [card.honorific, card.fullName, card.suffix].filter(Boolean).join(" ");
  lines.push(`<b>${escapeHtml(name || "(no name found)")}</b>`);
  if (card.nativeName) lines.push(escapeHtml(card.nativeName));
  const role = [card.jobTitle, card.company].filter(Boolean).join(" · ");
  if (role) lines.push(escapeHtml(role));
  if (card.department) lines.push(escapeHtml(card.department));

  const phoneLines = card.phones
    .filter((p) => p.e164 || p.raw)
    .map((p) => {
      const icon = p.slot === "mobile" ? "📱" : p.slot === "fax" ? "📠" : p.slot === "office" ? "☎️" : "📞";
      const value = p.e164 ? p.display ?? p.e164 : `${p.raw} <i>(could not read)</i>`;
      const ext = p.extension ? ` ext ${p.extension}` : "";
      return `${icon} ${escapeHtml(value)}${escapeHtml(ext)}`;
    });
  if (phoneLines.length) lines.push("", ...phoneLines);

  if (card.emails.length) lines.push("", ...card.emails.map((e) => `✉️ ${escapeHtml(e)}`));
  if (card.website) lines.push(`🌐 ${escapeHtml(card.website)}`);
  if (card.linkedin) lines.push(`🔗 ${escapeHtml(card.linkedin)}`);
  if (card.address) lines.push(`📍 ${escapeHtml(card.address)}`);
  if (opts?.note) lines.push("", `📝 ${escapeHtml(opts.note)}`);

  if (opts?.duplicates?.length) {
    lines.push("", "⚠️ <b>Possible duplicate</b>");
    for (const d of opts.duplicates.slice(0, 3)) {
      lines.push(`• ${escapeHtml(d.fullName)} — ${escapeHtml(d.reason)}`);
    }
    lines.push("<i>Saving will merge into the existing contact.</i>");
  }
  return lines.join("\n");
}

function cardKeyboard(cardId: string) {
  const base = getAppBaseUrl();
  const row2: { text: string; url?: string; callback_data?: string }[] = [
    { text: "🔄 Re-read", callback_data: `${CARD_CALLBACK.reparse}${cardId}` },
    { text: "🗑 Discard", callback_data: `${CARD_CALLBACK.discard}${cardId}` },
  ];
  if (base) row2.splice(1, 0, { text: "✏️ Fix", url: `${base}/scan?card=${cardId}` });
  return {
    inline_keyboard: [[{ text: "✅ Save contact", callback_data: `${CARD_CALLBACK.save}${cardId}` }], row2],
  };
}

/** Scan already-downloaded images and reply with the result. */
async function scanAndReply(
  chatId: string,
  images: string[],
  caption: string | null,
  threadId?: number,
  batchId?: string,
  index?: { n: number; of: number },
): Promise<void> {
  const prefix = index ? `<b>Card ${index.n} of ${index.of}</b>\n` : "";
  try {
    const card = await scanCard({ images, source: "telegram", eventNote: caption, batchId: batchId ?? null });
    if (card.status === "failed") {
      await sendTelegramMessage(chatId, `${prefix}❌ Could not read that card.\n<i>${escapeHtml(card.error ?? "unknown error")}</i>`, "HTML", undefined, threadId);
      return;
    }
    const parsed = card.parsed as ParsedCard;
    const duplicates = (card.duplicates ?? []) as { fullName: string; reason: string }[];
    await sendTelegramMessage(
      chatId,
      prefix + formatCardForTelegram(parsed, { duplicates, note: card.eventNote }),
      "HTML",
      cardKeyboard(card.id),
      threadId,
    );
  } catch (error) {
    await sendTelegramMessage(chatId, `${prefix}❌ Scan failed: ${escapeHtml((error as Error).message)}`, "HTML", undefined, threadId);
  }
}

/** Download every file id, dropping the ones Telegram will not give us. */
async function downloadAll(fileIds: string[]): Promise<string[]> {
  const images: string[] = [];
  for (const id of fileIds) {
    const dataUrl = await downloadTelegramFileAsDataUrl(id);
    if (dataUrl) images.push(dataUrl);
  }
  return images;
}

/**
 * Handle an incoming photo. A single photo is one card. An album is treated
 * as several separate cards (the common case: a stack photographed one after
 * another), which is why each gets its own message and buttons.
 */
export async function handleCardPhoto(message: PhotoMessage): Promise<void> {
  const chatId = message.chat.id.toString();
  const threadId = message.message_thread_id;
  const fileId = fileIdOf(message);
  if (!fileId) return;
  const caption = (message.caption ?? "").trim() || null;

  // Album: buffer until the rest of the group has arrived.
  if (message.media_group_id) {
    const key = `${chatId}:${message.media_group_id}`;
    const existing = albums.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.fileIds.push(fileId);
      existing.caption = existing.caption ?? caption;
      existing.timer = setTimeout(() => void flushAlbum(key), ALBUM_DEBOUNCE_MS);
      return;
    }
    albums.set(key, {
      chatId,
      threadId,
      caption,
      fileIds: [fileId],
      timer: setTimeout(() => void flushAlbum(key), ALBUM_DEBOUNCE_MS),
    });
    return;
  }

  await sendTelegramMessage(chatId, "🔍 Reading that card…", "HTML", undefined, threadId);
  const images = await downloadAll([fileId]);
  if (images.length === 0) {
    await sendTelegramMessage(chatId, "❌ Could not download that photo from Telegram.", "HTML", undefined, threadId);
    return;
  }
  await scanAndReply(chatId, images, caption, threadId);
}

/** Scan a buffered album: one card per photo, sharing a batch id. */
async function flushAlbum(key: string): Promise<void> {
  const album = albums.get(key);
  if (!album) return;
  albums.delete(key);
  const { chatId, threadId, caption, fileIds } = album;

  await sendTelegramMessage(chatId, `🔍 Reading ${fileIds.length} cards…`, "HTML", undefined, threadId);
  const batchId = randomUUID();
  let n = 0;
  for (const fileId of fileIds) {
    n++;
    const images = await downloadAll([fileId]);
    if (images.length === 0) {
      await sendTelegramMessage(chatId, `<b>Card ${n} of ${fileIds.length}</b>\n❌ Could not download that photo.`, "HTML", undefined, threadId);
      continue;
    }
    await scanAndReply(chatId, images, caption, threadId, batchId, { n, of: fileIds.length });
  }
  log(`[card-scan] telegram album ${key}: ${fileIds.length} cards`, "cards");
}

/** Route a `cs:`/`cr:`/`cd:` button press. Returns false when not ours. */
export async function handleCardCallback(callbackData: string, chatId: string, callbackQueryId: string, threadId?: number): Promise<boolean> {
  if (callbackData.startsWith(CARD_CALLBACK.save)) {
    const cardId = callbackData.slice(CARD_CALLBACK.save.length);
    try {
      const card = await getCard(cardId);
      const duplicates = (card?.duplicates ?? []) as { personId: number; fullName: string; reason: string }[];
      // A conclusive duplicate (same email/phone) merges rather than forking.
      const merge = duplicates.find((d) => d.reason !== "same name")?.personId ?? null;
      const { personId, fullName } = await saveCard(cardId, merge ? { mergeIntoPersonId: merge } : undefined);
      await answerCallbackQuery(callbackQueryId, "Saved");

      const vcard = await cardVCard(cardId);
      const base = getAppBaseUrl();
      const link = base ? `\n<a href="${base}/people/${personId}">Open ${escapeHtml(fullName)} in Sensei</a>` : "";
      if (vcard) {
        await sendTelegramDocument(
          chatId,
          vcard.vcf,
          vcardFilename(vcard.parsed),
          `✅ Saved <b>${escapeHtml(fullName)}</b>${merge ? " (merged into an existing contact)" : ""}. Tap the file to add them to your phone.${link}`,
          threadId,
        );
      } else {
        await sendTelegramMessage(chatId, `✅ Saved <b>${escapeHtml(fullName)}</b>.${link}`, "HTML", undefined, threadId);
      }
    } catch (error) {
      await answerCallbackQuery(callbackQueryId, "Save failed");
      await sendTelegramMessage(chatId, `❌ Could not save: ${escapeHtml((error as Error).message)}`, "HTML", undefined, threadId);
    }
    return true;
  }

  if (callbackData.startsWith(CARD_CALLBACK.reparse)) {
    const cardId = callbackData.slice(CARD_CALLBACK.reparse.length);
    await answerCallbackQuery(callbackQueryId, "Re-reading on the stronger model…");
    try {
      const card = await reparseCard(cardId, true);
      if (card.status === "failed") {
        await sendTelegramMessage(chatId, `❌ Still could not read it: <i>${escapeHtml(card.error ?? "")}</i>`, "HTML", undefined, threadId);
      } else {
        const parsed = card.parsed as ParsedCard;
        await sendTelegramMessage(
          chatId,
          `<b>Re-read</b>\n${formatCardForTelegram(parsed, { duplicates: (card.duplicates ?? []) as { fullName: string; reason: string }[], note: card.eventNote })}`,
          "HTML",
          cardKeyboard(card.id),
          threadId,
        );
      }
    } catch (error) {
      await sendTelegramMessage(chatId, `❌ Re-read failed: ${escapeHtml((error as Error).message)}`, "HTML", undefined, threadId);
    }
    return true;
  }

  if (callbackData.startsWith(CARD_CALLBACK.discard)) {
    const cardId = callbackData.slice(CARD_CALLBACK.discard.length);
    try {
      await deleteCard(cardId);
      await answerCallbackQuery(callbackQueryId, "Discarded");
      await sendTelegramMessage(chatId, "🗑 Card discarded.", "HTML", undefined, threadId);
    } catch {
      await answerCallbackQuery(callbackQueryId, "Could not discard");
    }
    return true;
  }

  return false;
}
