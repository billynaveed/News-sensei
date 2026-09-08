import type { Lead } from '@shared/schema';
import type { FounderEnrichmentResult, CompanyEnrichmentResult } from './founder-enrichment';

/**
 * Formats founder enrichment results for Telegram display
 */
export function formatFounderEnrichment(result: FounderEnrichmentResult): string {
  const sections: string[] = [];

  sections.push(`👤 <b>Founder Research: ${result.founderName}</b>\n`);

  if (result.biography) {
    sections.push(`<b>📝 Biography:</b>\n${result.biography}\n`);
  }

  if (result.professionalBackground) {
    sections.push(`<b>💼 Professional Background:</b>\n${result.professionalBackground}\n`);
  }

  if (result.education) {
    sections.push(`<b>🎓 Education:</b>\n${result.education}\n`);
  }

  if (result.notableAchievements) {
    sections.push(`<b>🏆 Notable Achievements:</b>\n${result.notableAchievements}\n`);
  }

  if (result.linkedInUrl) {
    sections.push(`<b>🔗 LinkedIn:</b> ${result.linkedInUrl}\n`);
  }

  // Add confidence indicator
  const confidenceIcon = result.confidence === 'high' ? '🟢' :
                        result.confidence === 'medium' ? '🟡' : '🔴';
  sections.push(`<b>Confidence:</b> ${confidenceIcon} ${result.confidence.charAt(0).toUpperCase() + result.confidence.slice(1)}`);

  if (result.sources && result.sources.length > 0) {
    sections.push(`<b>Sources:</b> ${result.sources.join(', ')}`);
  }

  return sections.join('\n');
}

/**
 * Formats company enrichment results for Telegram display
 */
export function formatCompanyEnrichment(result: CompanyEnrichmentResult): string {
  const sections: string[] = [];

  sections.push(`🏢 <b>Company Research: ${result.companyName}</b>\n`);

  if (result.description) {
    sections.push(`<b>📝 Description:</b>\n${result.description}\n`);
  }

  if (result.industry) {
    sections.push(`<b>🏭 Industry:</b> ${result.industry}\n`);
  }

  if (result.headquarters) {
    sections.push(`<b>📍 Headquarters:</b> ${result.headquarters}\n`);
  }

  if (result.founded) {
    sections.push(`<b>📅 Founded:</b> ${result.founded}\n`);
  }

  if (result.businessModel) {
    sections.push(`<b>💼 Business Model:</b> ${result.businessModel}\n`);
  }

  // Add confidence indicator
  const confidenceIcon = result.confidence === 'high' ? '🟢' :
                        result.confidence === 'medium' ? '🟡' : '🔴';
  sections.push(`<b>Confidence:</b> ${confidenceIcon} ${result.confidence.charAt(0).toUpperCase() + result.confidence.slice(1)}`);

  return sections.join('\n');
}

/**
 * Formats saved lead data for Telegram display
 */
export function formatSavedLeadEnrichment(savedLead: any, leadData: any): string {
  const sections: string[] = [];

  sections.push(`📌 <b>Saved Lead Research</b>\n`);
  sections.push(`<b>Article:</b> ${leadData.headline}`);
  sections.push(`<b>Source:</b> ${leadData.sourceName}\n`);

  if (savedLead.founderName || leadData.founderNames?.[0]) {
    const founderName = savedLead.founderName || leadData.founderNames[0];
    sections.push(`👤 <b>${founderName}</b>\n`);

    if (savedLead.founderBio) {
      sections.push(`<b>📝 Biography:</b>\n${savedLead.founderBio}\n`);
    }

    if (savedLead.founderLinkedInUrl) {
      sections.push(`<b>🔗 LinkedIn:</b> ${savedLead.founderLinkedInUrl}\n`);
    }
  }

  if (savedLead.companyName || leadData.companyNames?.[0]) {
    const companyName = savedLead.companyName || leadData.companyNames[0];
    sections.push(`🏢 <b>${companyName}</b>\n`);

    if (savedLead.companyDescription) {
      sections.push(`<b>📝 Description:</b>\n${savedLead.companyDescription}\n`);
    }
  }

  if (savedLead.notes) {
    sections.push(`<b>📋 Notes:</b>\n${savedLead.notes}\n`);
  }

  sections.push(`<b>🔗 Article Link:</b> ${leadData.sourceUrl}`);

  return sections.join('\n');
}

/**
 * Splits long messages to fit Telegram's 4096 character limit
 */
export function splitLongMessage(text: string, maxLength = 4000): string[] {
  if (text.length <= maxLength) return [text];

  const parts: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > maxLength) {
      if (current) parts.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }

  if (current) parts.push(current);
  return parts;
}

// ---------------------------------------------------------------------------
// Lead alerts — Telegram is the whole product on the phone, so the alert has to
// carry everything Billy needs to triage without opening the dashboard: the
// money, who got rich, where they live, and the wealth angle.
// ---------------------------------------------------------------------------

/** Telegram rejects any callback_data longer than 64 bytes. */
export const MAX_CALLBACK_BYTES = 64;

/**
 * Callback-data prefixes for lead alert buttons.
 *
 * Lead ids are 36-byte UUIDs, so every prefix must stay under 28 bytes.
 * `lead_save_` / `lead_dismiss_` / `lead_reviewed_` predate this table and are
 * kept byte-identical so alerts already sitting in the chat keep working.
 */
export const LEAD_CALLBACK = {
  save: "lead_save_",
  dismiss: "lead_dismiss_",
  reviewed: "lead_reviewed_",
  mute: "lead_mute_",
  good: "fb_good_",
  bad: "fb_bad_",
  higher: "fb_high_",
} as const;

/** Callback data for the inert "this is what happened" button. */
export const NOOP_CALLBACK = "noop";

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

/** HTML-escape text destined for a Telegram `parse_mode: HTML` message body. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** HTML-escape a value going into an attribute (e.g. an `href`). */
export function escapeHtmlAttr(value: unknown): string {
  return escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Builds `callback_data` for a lead button, warning loudly if it would breach
 * Telegram's 64-byte cap (Telegram silently rejects the whole sendMessage).
 */
export function leadCallbackData(prefix: string, leadId: string): string {
  const data = `${prefix}${leadId}`;
  const bytes = Buffer.byteLength(data, "utf8");
  if (bytes > MAX_CALLBACK_BYTES) {
    console.error(`[Telegram] callback_data is ${bytes} bytes (limit ${MAX_CALLBACK_BYTES}): ${data}`);
  }
  return data;
}

/** Row 1: the triage actions that change the lead's state. */
export function leadActionRow(leadId: string): InlineButton[] {
  return [
    { text: "💾 Save", callback_data: leadCallbackData(LEAD_CALLBACK.save, leadId) },
    { text: "🗑 Dismiss", callback_data: leadCallbackData(LEAD_CALLBACK.dismiss, leadId) },
    { text: "🔇 Mute founders", callback_data: leadCallbackData(LEAD_CALLBACK.mute, leadId) },
  ];
}

/** Row 2: the teaching actions that feed the learning loop, not the lead state. */
export function leadFeedbackRow(leadId: string): InlineButton[] {
  return [
    { text: "👍 Good lead", callback_data: leadCallbackData(LEAD_CALLBACK.good, leadId) },
    { text: "👎 Not a lead", callback_data: leadCallbackData(LEAD_CALLBACK.bad, leadId) },
    { text: "🎓 Should have scored higher", callback_data: leadCallbackData(LEAD_CALLBACK.higher, leadId) },
  ];
}

export function buildLeadKeyboard(leadId: string): InlineKeyboard {
  return { inline_keyboard: [leadActionRow(leadId), leadFeedbackRow(leadId)] };
}

/** A single inert button showing the outcome of the tap that was just made. */
export function statusRow(statusText: string): InlineButton[] {
  return [{ text: statusText, callback_data: NOOP_CALLBACK }];
}

/** Wealth angle is the one line Billy actually reads; keep it phone-sized. */
const WEALTH_ANGLE_MAX = 300;
/** Fallback body when the pipeline produced no wealth angle. */
const SUMMARY_MAX = 600;
/** Beyond this the founder line wraps badly on a phone. */
const MAX_FOUNDERS_SHOWN = 4;

export interface LeadAlertContext {
  /** Lower-cased founder name → city (or "City, Country"), when known. */
  founderCities?: Record<string, string>;
}

/** Collapse whitespace and cut to `max` chars on a word boundary. */
function clip(text: string, max: number): string {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  const cut = normalized.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

/** Normalised lookup key for a founder name. */
export function founderKey(name: string): string {
  return String(name ?? "").trim().toLowerCase();
}

/**
 * Founder residence the enrichment stage already stored on the lead itself.
 * Only the primary founder is enriched (see formatEnrichmentForSavedLead), so
 * this returns at most one entry; the DB lookup in telegram.ts fills the rest.
 */
export function founderCitiesFromLead(lead: Lead): Record<string, string> {
  const cities: Record<string, string> = {};
  const primary = (lead.founderNames || [])[0];
  if (!primary) return cities;

  const data = (lead.enrichmentData ?? {}) as Record<string, unknown>;
  const city = (typeof data.founderResidenceCity === "string" ? data.founderResidenceCity : "").trim();
  const country = (typeof data.founderResidenceCountry === "string" ? data.founderResidenceCountry : "").trim();
  // City-states enrich to city === country; "Singapore, Singapore" reads as a bug.
  const parts = country && country.toLowerCase() !== city.toLowerCase() ? [city, country] : [city || country];
  const label = parts.filter(Boolean).join(", ").trim();
  if (label) cities[founderKey(primary)] = label;
  return cities;
}

/** "💰 Deal $400M · Valuation $1.2B", or null when the pipeline found no numbers. */
function financialsLine(lead: Lead): string | null {
  const financials = lead.keyFinancials;
  if (!financials) return null;
  const parts = [
    financials.dealValue ? `Deal ${financials.dealValue}` : null,
    financials.fundingAmount ? `Raised ${financials.fundingAmount}` : null,
    financials.valuation ? `Valuation ${financials.valuation}` : null,
  ].filter((p): p is string => Boolean(p));
  return parts.length ? `💰 ${escapeHtml(parts.join(" · "))}` : null;
}

/** "👤 Rahul Shinghal (Singapore) · Arul Kumaravel", or null when nobody is named. */
function foundersLine(lead: Lead, cities: Record<string, string>): string | null {
  const names = (lead.founderNames || []).filter((n) => n && n.trim());
  if (names.length === 0) return null;

  const shown = names.slice(0, MAX_FOUNDERS_SHOWN).map((name) => {
    const city = cities[founderKey(name)];
    return city ? `${escapeHtml(name.trim())} <i>(${escapeHtml(city)})</i>` : escapeHtml(name.trim());
  });
  const hidden = names.length - shown.length;
  return `👤 ${shown.join(" · ")}${hidden > 0 ? ` +${hidden} more` : ""}`;
}

/**
 * Renders one lead as a phone-readable Telegram alert (HTML parse mode).
 *
 * Pure: everything it needs is on the lead plus the optional city map, so it
 * can be exercised without a database or the Telegram API.
 *
 * @param lead - The lead to render
 * @param ctx - Optional founder → city map merged over the lead's own enrichment
 * @returns HTML message body, well under Telegram's 4096-character limit
 *
 * @example
 * const text = buildLeadAlertMessage(lead, { founderCities: { "rahul shinghal": "Singapore" } });
 */
export function buildLeadAlertMessage(lead: Lead, ctx: LeadAlertContext = {}): string {
  const priorityIcon = lead.priorityLevel === "high" ? "🔴" : lead.priorityLevel === "medium" ? "🟡" : "🟢";
  const cities = { ...founderCitiesFromLead(lead), ...(ctx.founderCities ?? {}) };

  const companies = (lead.companyNames || []).filter((c) => c && c.trim());
  const facts = [
    financialsLine(lead),
    foundersLine(lead, cities),
    companies.length ? `🏢 ${escapeHtml(companies.join(", "))}` : null,
    `📍 ${escapeHtml(lead.region)} · <b>Score ${lead.priorityScore}</b>`,
  ].filter((line): line is string => Boolean(line));

  // The wealth angle is why this lead matters to a private banker; the generic
  // AI summary is only a fallback for older leads that predate the field.
  const angle = (lead.wealthAngle || "").trim();
  const body = angle ? clip(angle, WEALTH_ANGLE_MAX) : clip(lead.aiSummary || "", SUMMARY_MAX);

  const sections = [
    `${priorityIcon} <b>${escapeHtml(lead.headline)}</b>`,
    facts.join("\n"),
    body ? escapeHtml(body) : null,
    `<a href="${escapeHtmlAttr(lead.sourceUrl)}">Read full article →</a> · <i>${escapeHtml(lead.sourceName)}</i>`,
  ].filter((s): s is string => Boolean(s));

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Deep links back into the app
// ---------------------------------------------------------------------------

const DEFAULT_APP_URL = "http://localhost:5000";

/**
 * Public base URL of the Sensei app, for links inside Telegram messages.
 *
 * `PUBLIC_APP_URL` wins; `SERVER_URL` (the Telegram webhook host) and
 * `WEBAUTHN_ORIGIN` (set to https://sensei.billynaveed.com in production) are
 * the two places the real hostname is already configured.
 */
export function getAppBaseUrl(): string {
  const configured =
    process.env.PUBLIC_APP_URL ||
    process.env.SERVER_URL ||
    process.env.WEBAUTHN_ORIGIN ||
    (process.env.PORT ? `http://localhost:${process.env.PORT}` : DEFAULT_APP_URL);
  return configured.trim().replace(/\/+$/, "");
}

/** An HTML anchor to a path within the app. */
export function appLink(path: string, label: string): string {
  const url = `${getAppBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  return `<a href="${escapeHtmlAttr(url)}">${escapeHtml(label)}</a>`;
}

/** Footer every operational message ends with, so a bad ping is one tap from the evidence. */
export function debugPageLink(label = "🔧 Open the Debug page"): string {
  return appLink("/debug", label);
}
