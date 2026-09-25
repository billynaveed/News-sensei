/**
 * QR codes on business cards.
 *
 * Increasingly a card carries a QR instead of, or as well as, printed contact
 * details. When it holds a vCard the data is EXACT — no OCR, no model, no
 * guessing — so it is worth trying before the vision call and worth trusting
 * over it.
 *
 * Decoding happens in the browser: canvas already gives us the raw pixels, so
 * this needs no image-decoding dependency on the server. A card that arrives
 * through Telegram has no browser, so it falls back to the vision model.
 */

import jsQR from "jsqr";

export type QrPayloadKind = "vcard" | "mecard" | "linkedin" | "url" | "tel" | "email" | "text";

export interface QrResult {
  kind: QrPayloadKind;
  raw: string;
  /** Fields recovered from a vCard/MECARD payload. Exact, not inferred. */
  fields?: {
    fullName?: string;
    firstName?: string;
    lastName?: string;
    honorific?: string;
    company?: string;
    jobTitle?: string;
    emails?: string[];
    phones?: { value: string; label: string | null }[];
    website?: string;
    address?: string;
    note?: string;
  };
}

/** Read a QR code out of an image, or null when there is none. */
export async function decodeQrFromDataUrl(dataUrl: string): Promise<QrResult | null> {
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("not an image"));
      el.src = dataUrl;
    });
    const canvas = document.createElement("canvas");
    // A QR on a card photo is small; downscaling past ~1400px loses the modules.
    const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const found = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" });
    if (!found?.data) return null;
    return classifyQr(found.data);
  } catch {
    return null;
  }
}

/** What a QR payload actually is, and anything structured inside it. */
export function classifyQr(raw: string): QrResult {
  const text = raw.trim();
  if (/^BEGIN:VCARD/i.test(text)) return { kind: "vcard", raw: text, fields: parseVCard(text) };
  if (/^MECARD:/i.test(text)) return { kind: "mecard", raw: text, fields: parseMeCard(text) };
  if (/^(https?:\/\/)?([a-z0-9-]+\.)*linkedin\.com\//i.test(text)) return { kind: "linkedin", raw: text };
  if (/^https?:\/\//i.test(text)) return { kind: "url", raw: text };
  if (/^tel:/i.test(text)) return { kind: "tel", raw: text.replace(/^tel:/i, "") };
  if (/^mailto:/i.test(text)) return { kind: "email", raw: text.replace(/^mailto:/i, "") };
  return { kind: "text", raw: text };
}

/** Undo RFC 6350 line folding: a continuation line starts with a space or tab. */
function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^[ \t]/.test(line) && lines.length > 0) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  return lines;
}

function unescapeValue(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

/** Pull the fields we care about out of a vCard payload. */
export function parseVCard(text: string): NonNullable<QrResult["fields"]> {
  const out: NonNullable<QrResult["fields"]> = { emails: [], phones: [] };
  for (const line of unfold(text)) {
    const at = line.indexOf(":");
    if (at < 1) continue;
    const head = line.slice(0, at);
    const value = unescapeValue(line.slice(at + 1).trim());
    if (!value) continue;
    const [name, ...paramParts] = head.split(";");
    const key = name.toUpperCase();
    const params = paramParts.join(";").toUpperCase();

    if (key === "FN") out.fullName = value;
    else if (key === "N") {
      // N:Last;First;Middle;Prefix;Suffix
      const [last, first, , prefix] = value.split(";");
      if (last) out.lastName = last.trim();
      if (first) out.firstName = first.trim();
      if (prefix) out.honorific = prefix.trim();
    } else if (key === "ORG") out.company = value.split(";")[0].trim();
    else if (key === "TITLE") out.jobTitle = value;
    else if (key === "EMAIL") out.emails!.push(value);
    else if (key === "TEL") {
      // The TYPE parameter is the card's own label, which is better than a guess.
      const label = /CELL|MOBILE/.test(params) ? "Mobile" : /FAX/.test(params) ? "Fax" : /WORK/.test(params) ? "Work" : null;
      out.phones!.push({ value, label });
    } else if (key === "URL") out.website = value;
    else if (key === "ADR") out.address = value.split(";").filter(Boolean).join(", ");
    else if (key === "NOTE") out.note = value;
  }
  if (!out.fullName && (out.firstName || out.lastName)) {
    out.fullName = [out.firstName, out.lastName].filter(Boolean).join(" ");
  }
  return out;
}

/** MECARD is the older Japanese format still printed on plenty of cards. */
export function parseMeCard(text: string): NonNullable<QrResult["fields"]> {
  const out: NonNullable<QrResult["fields"]> = { emails: [], phones: [] };
  const body = text.replace(/^MECARD:/i, "").replace(/;;\s*$/, "");
  for (const part of body.split(";")) {
    const at = part.indexOf(":");
    if (at < 1) continue;
    const key = part.slice(0, at).toUpperCase();
    const value = part.slice(at + 1).trim();
    if (!value) continue;
    if (key === "N") {
      // MECARD writes the name "Last,First".
      const [last, first] = value.split(",");
      out.lastName = (last ?? "").trim() || undefined;
      out.firstName = (first ?? "").trim() || undefined;
      out.fullName = [out.firstName, out.lastName].filter(Boolean).join(" ") || value;
    } else if (key === "ORG") out.company = value;
    else if (key === "TEL") out.phones!.push({ value, label: null });
    else if (key === "EMAIL") out.emails!.push(value);
    else if (key === "URL") out.website = value;
    else if (key === "ADR") out.address = value;
    else if (key === "NOTE") out.note = value;
  }
  return out;
}
