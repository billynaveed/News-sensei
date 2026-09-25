/**
 * Business card scanner — vision extraction, dedupe, enrichment, save.
 *
 * Flow: image(s) → vision model returns raw fields verbatim → card-normalize
 * shapes them (E.164 phones, honorifics, casing) → duplicate check against
 * existing people/contacts → row in `business_cards` for the review queue.
 * Enrichment runs afterwards and never blocks the parse, so a search outage
 * cannot lose a card.
 *
 * The model is asked only to READ. Every formatting decision is made by
 * `card-normalize.ts`, which is pure and unit-tested.
 */

import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "./db";
import { log } from "./log";
import { callJsonStage } from "./llm-json";
import { searchWeb } from "./web-search";
import { resolvePersonByName } from "./families";
import { ensureContactMeta, linkCompany } from "./contacts";
import { normalizeCard, normalizeLinkedIn, normalizeUrl, toVCard, type ParsedCard, type RawCard } from "./card-normalize";
import { businessCards, contactMeta, people, type BusinessCard } from "@shared/schema";

/** Vision-capable and cheap; the whole point is reading text off a photo. */
const VISION_MODEL = process.env.CARD_VISION_MODEL || "google/gemini-2.5-flash";
/** Fallback for messy, foil or heavily designed cards. */
const VISION_FALLBACK_MODEL = process.env.CARD_VISION_FALLBACK_MODEL || "anthropic/claude-sonnet-4";
const MAX_IMAGE_BYTES = parseInt(process.env.CARD_MAX_IMAGE_BYTES || "6000000", 10);

export const EXTRACTION_PROMPT = `You are reading a business card for a Singapore private banker's contact system.

Return ONLY JSON with this exact shape:
{
  "fullName": "the person's name EXACTLY as printed, including any honorific (Tan Sri, Dato', Dr) and keeping the printed word order",
  "nativeName": "the same person's name in Chinese/Japanese/Thai/Korean script if the card also prints it, else null",
  "jobTitle": "job title as printed, or null",
  "department": "department or division if printed separately from the title, else null",
  "company": "company name as printed (Latin script), or null",
  "nativeCompany": "company name in the other script if printed, else null",
  "phones": [{"value": "the number EXACTLY as printed, digits/spaces/dashes and all", "label": "the label printed next to it, verbatim: DID, HP, M, T, Tel, O, F, Fax, Mobile, 手机 ... or null if unlabelled"}],
  "emails": ["every email address on the card"],
  "websites": ["every website on the card"],
  "linkedin": "a LinkedIn URL or handle if printed, else null",
  "address": "the full postal address as printed, newlines preserved, or null",
  "addressCountry": "the country named in the address, or null if not printed",
  "otherText": "anything else worth keeping (tagline, licence number, WeChat ID), else null",
  "confidence": {"fullName": 0.0-1.0, "company": 0.0-1.0, "phones": 0.0-1.0, "emails": 0.0-1.0, "jobTitle": 0.0-1.0}
}

Rules:
- Transcribe, do NOT tidy. Keep ALL CAPS as ALL CAPS, keep the printed phone spacing, keep the honorific attached to the name. Formatting is handled downstream.
- Keep every phone number separate with its own printed label. The label matters: DID is a desk line, HP is a mobile in Singapore/Malaysia, F is a fax.
- If the card is bilingual, put the Latin-script values in the main fields and the other script in nativeName/nativeCompany. Never translate; transcribe.
- If several images are given, they are the FRONT and BACK of the SAME card: merge them into one result.
- Never invent a value. If something is not printed on the card, use null (or an empty array). A blank field is correct; a guessed field is not.
- confidence is your own reading confidence per field: 1.0 = crisp and unambiguous, below 0.6 = blurred, cropped or uncertain.`;

export interface ScanInput {
  images: string[];
  source?: "web" | "telegram";
  eventNote?: string | null;
  batchId?: string | null;
  /** Skip the web lookups (used by tests and by the batch path). */
  skipEnrichment?: boolean;
}

export interface DuplicateMatch {
  personId: number;
  fullName: string;
  reason: string;
}

/** Reject anything that is not an image data URL we can hand to the gateway. */
export function validateImage(image: string): string | null {
  if (typeof image !== "string" || !image.startsWith("data:image/")) {
    return "not an image data URL";
  }
  const [, base64 = ""] = image.split(",", 2);
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) return `image too large (${Math.round(bytes / 1e6)}MB, max ${Math.round(MAX_IMAGE_BYTES / 1e6)}MB)`;
  if (bytes < 1024) return "image too small to read";
  return null;
}

/** Ask the vision model to read the card. Throws on a hard failure. */
export async function extractCard(images: string[], model = VISION_MODEL): Promise<RawCard> {
  return await callJsonStage<RawCard>({
    model,
    prompt: EXTRACTION_PROMPT,
    images,
    maxTokens: 2000,
    temperature: 0,
    label: "CardScan",
    timeoutMs: 90_000,
  });
}

/**
 * Existing contacts this card probably already describes. Matching on an
 * exact email or E.164 phone is conclusive; a name match is a suggestion.
 * The same founder gets met repeatedly, and a second record silently splits
 * the history, so this runs before every save.
 */
export async function findDuplicates(card: ParsedCard): Promise<DuplicateMatch[]> {
  const found = new Map<number, DuplicateMatch>();
  const phones = [card.phoneMobile, card.phoneOffice].filter((p): p is string => !!p);
  const emails = card.emails.map((e) => e.toLowerCase());

  if (emails.length || phones.length) {
    const conditions = [
      ...(emails.length ? [inArray(sql`lower(${contactMeta.email})`, emails)] : []),
      ...(phones.length ? [inArray(contactMeta.phoneMobile, phones), inArray(contactMeta.phoneOffice, phones)] : []),
    ];
    const rows = await db
      .select({
        personId: contactMeta.personId,
        fullName: people.fullName,
        email: contactMeta.email,
      })
      .from(contactMeta)
      .innerJoin(people, eq(people.id, contactMeta.personId))
      .where(and(isNull(people.mergedIntoId), or(...conditions)))
      .limit(10);
    for (const r of rows) {
      const byEmail = r.email && emails.includes(r.email.toLowerCase());
      found.set(r.personId, {
        personId: r.personId,
        fullName: r.fullName,
        reason: byEmail ? `same email (${r.email})` : "same phone number",
      });
    }
  }

  if (card.fullName) {
    const rows = await db
      .select({ id: people.id, fullName: people.fullName })
      .from(people)
      .where(and(isNull(people.mergedIntoId), sql`lower(${people.fullName}) = lower(${card.fullName})`))
      .limit(5);
    for (const r of rows) {
      if (!found.has(r.id)) found.set(r.id, { personId: r.id, fullName: r.fullName, reason: "same name" });
    }
  }

  return Array.from(found.values());
}

export interface CardEnrichment {
  companyWebsite: string | null;
  companyDescription: string | null;
  linkedinUrl: string | null;
}

/**
 * Fill the gaps the card left, using the existing search stack. Anything that
 * cannot be verified stays null — a blank field beats a wrong one in front of
 * a client. Never throws; enrichment is a bonus, not a requirement.
 */
export async function enrichCard(card: ParsedCard): Promise<CardEnrichment> {
  const out: CardEnrichment = { companyWebsite: card.website, companyDescription: null, linkedinUrl: card.linkedin };
  if (!card.company) return out;

  try {
    if (!out.companyWebsite) {
      const res = await searchWeb(`${card.company} official website ${card.country ?? "Singapore"}`, {
        maxResults: 4,
        includeAnswer: false,
        priority: "background",
      });
      // Only trust a hit whose domain actually contains a word from the name.
      const token = card.company.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10);
      for (const r of res?.results ?? []) {
        const url = normalizeUrl(r.url);
        if (!url) continue;
        const host = new URL(url).hostname.replace(/[^a-z0-9]/g, "");
        if (token.length >= 4 && host.includes(token.slice(0, Math.min(8, token.length)))) {
          out.companyWebsite = `${new URL(url).protocol}//${new URL(url).hostname}`;
          break;
        }
      }
    }

    if (!out.linkedinUrl && card.fullName) {
      const res = await searchWeb(`"${card.fullName}" ${card.company} linkedin`, {
        maxResults: 4,
        includeAnswer: false,
        priority: "background",
      });
      for (const r of res?.results ?? []) {
        const li = normalizeLinkedIn(r.url);
        // Require the person's surname in the URL so we do not attach a stranger.
        const surname = (card.lastName ?? card.fullName).toLowerCase().replace(/[^a-z]/g, "");
        if (li && surname.length >= 3 && li.toLowerCase().replace(/[^a-z]/g, "").includes(surname)) {
          out.linkedinUrl = li;
          break;
        }
      }
    }
  } catch (error) {
    log(`[card-scan] enrichment failed for ${card.company}: ${(error as Error).message}`, "cards");
  }
  return out;
}

/**
 * Scan one card (front, or front+back) end to end and store it in the review
 * queue. A parse failure is recorded as a `failed` row rather than thrown
 * away, so nothing a user photographed disappears silently.
 */
export async function scanCard(input: ScanInput): Promise<BusinessCard> {
  const images = (input.images ?? []).slice(0, 2);
  for (const img of images) {
    const bad = validateImage(img);
    if (bad) throw new Error(bad);
  }
  if (images.length === 0) throw new Error("no image supplied");

  const base = {
    frontImage: images[0],
    backImage: images[1] ?? null,
    source: input.source ?? "web",
    eventNote: input.eventNote ?? null,
    batchId: input.batchId ?? null,
  };

  let raw: RawCard;
  let model = VISION_MODEL;
  try {
    raw = await extractCard(images, VISION_MODEL);
  } catch (error) {
    log(`[card-scan] primary model failed: ${(error as Error).message} — retrying on ${VISION_FALLBACK_MODEL}`, "cards");
    try {
      model = VISION_FALLBACK_MODEL;
      raw = await extractCard(images, VISION_FALLBACK_MODEL);
    } catch (fallbackError) {
      const message = (fallbackError as Error).message;
      const [row] = await db
        .insert(businessCards)
        .values({ ...base, status: "failed", error: message.slice(0, 500), model })
        .returning();
      log(`[card-scan] both models failed: ${message}`, "cards");
      return row;
    }
  }

  const parsed = normalizeCard(raw);
  const duplicates = await findDuplicates(parsed);
  const enrichment = input.skipEnrichment ? null : await enrichCard(parsed);
  if (enrichment?.companyWebsite && !parsed.website) parsed.website = enrichment.companyWebsite;
  if (enrichment?.linkedinUrl && !parsed.linkedin) parsed.linkedin = enrichment.linkedinUrl;

  // A card with no name, or nothing to reach the person by, needs a human.
  const reachable = parsed.emails.length > 0 || parsed.phones.some((p) => p.e164);
  const status = !parsed.fullName || !reachable ? "needs_review" : "parsed";

  const [row] = await db
    .insert(businessCards)
    .values({
      ...base,
      rawExtraction: raw as unknown as object,
      parsed: parsed as unknown as object,
      confidence: (raw.confidence ?? null) as unknown as object,
      duplicates: duplicates as unknown as object,
      enrichment: enrichment as unknown as object,
      status,
      model,
    })
    .returning();

  log(
    `[card-scan] ${parsed.fullName || "(no name)"}${parsed.company ? ` @ ${parsed.company}` : ""} — ` +
      `${parsed.phones.filter((p) => p.e164).length} phones, ${parsed.emails.length} emails, ` +
      `${duplicates.length} possible duplicates, model=${model} → ${status}`,
    "cards",
  );
  return row;
}

/** Re-run the parse on a stored card, optionally on the stronger model. */
export async function reparseCard(cardId: string, useFallback = true): Promise<BusinessCard> {
  const [card] = await db.select().from(businessCards).where(eq(businessCards.id, cardId));
  if (!card) throw new Error("card not found");
  const images = [card.frontImage, card.backImage].filter((i): i is string => !!i);
  if (images.length === 0) throw new Error("card has no stored image to re-read");

  const model = useFallback ? VISION_FALLBACK_MODEL : VISION_MODEL;
  try {
    const raw = await extractCard(images, model);
    const parsed = normalizeCard(raw);
    const duplicates = await findDuplicates(parsed);
    const reachable = parsed.emails.length > 0 || parsed.phones.some((p) => p.e164);
    const [row] = await db
      .update(businessCards)
      .set({
        rawExtraction: raw as unknown as object,
        parsed: parsed as unknown as object,
        confidence: (raw.confidence ?? null) as unknown as object,
        duplicates: duplicates as unknown as object,
        status: !parsed.fullName || !reachable ? "needs_review" : "parsed",
        model,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(businessCards.id, cardId))
      .returning();
    log(`[card-scan] re-parsed ${cardId} on ${model}: ${parsed.fullName || "(no name)"}`, "cards");
    return row;
  } catch (error) {
    const [row] = await db
      .update(businessCards)
      .set({ status: "failed", error: (error as Error).message.slice(0, 500), model, updatedAt: new Date() })
      .where(eq(businessCards.id, cardId))
      .returning();
    return row;
  }
}

/**
 * Turn a reviewed card into a Sensei contact: a `people` row (reusing an
 * existing one when the name matches a known spelling), the company link, and
 * the contact details on `contact_meta`. Existing values are never clobbered
 * by a blank — a second card for the same person only adds what it knows.
 */
export async function saveCard(
  cardId: string,
  edits?: Partial<ParsedCard> & { eventNote?: string | null; mergeIntoPersonId?: number | null },
): Promise<{ card: BusinessCard; personId: number; fullName: string }> {
  const [card] = await db.select().from(businessCards).where(eq(businessCards.id, cardId));
  if (!card) throw new Error("card not found");

  const parsed = { ...((card.parsed ?? {}) as ParsedCard), ...(edits ?? {}) } as ParsedCard;
  if (!parsed.fullName?.trim()) throw new Error("a name is required before saving");

  // An explicit merge target wins; otherwise the usual spelling-tolerant upsert.
  let personId: number;
  if (edits?.mergeIntoPersonId) {
    personId = edits.mergeIntoPersonId;
  } else {
    const { person } = await resolvePersonByName(parsed.fullName.trim(), {
      source: "business-card",
      nationality: parsed.country ?? null,
    });
    personId = person.id;
  }

  // Fill blanks on the person; never overwrite what the pipeline already knows.
  await db
    .update(people)
    .set({
      firstName: sql`coalesce(${people.firstName}, ${parsed.firstName ?? null})`,
      lastName: sql`coalesce(${people.lastName}, ${parsed.lastName ?? null})`,
      updatedAt: new Date(),
    })
    .where(eq(people.id, personId));

  if (parsed.company) await linkCompany(personId, parsed.company, "business-card", parsed.jobTitle);

  await ensureContactMeta(personId);
  const note = [edits?.eventNote ?? card.eventNote, parsed.otherText].filter(Boolean).join(" — ") || null;
  const other = parsed.phones.find((p) => p.e164 && p.slot !== "mobile" && p.slot !== "office")?.e164 ?? null;
  await db
    .update(contactMeta)
    .set({
      email: sql`coalesce(${contactMeta.email}, ${parsed.emails[0] ?? null})`,
      phoneMobile: sql`coalesce(${contactMeta.phoneMobile}, ${parsed.phoneMobile ?? null})`,
      phoneOffice: sql`coalesce(${contactMeta.phoneOffice}, ${parsed.phoneOffice ?? null})`,
      phoneOther: sql`coalesce(${contactMeta.phoneOther}, ${other})`,
      jobTitle: sql`coalesce(${contactMeta.jobTitle}, ${parsed.jobTitle ?? null})`,
      companyName: sql`coalesce(${contactMeta.companyName}, ${parsed.company ?? null})`,
      linkedinUrl: sql`coalesce(${contactMeta.linkedinUrl}, ${parsed.linkedin ?? null})`,
      website: sql`coalesce(${contactMeta.website}, ${parsed.website ?? null})`,
      address: sql`coalesce(${contactMeta.address}, ${parsed.address ?? null})`,
      honorific: sql`coalesce(${contactMeta.honorific}, ${parsed.honorific ?? null})`,
      nativeName: sql`coalesce(${contactMeta.nativeName}, ${parsed.nativeName ?? null})`,
      // The note is appended rather than replaced: "where we met" accumulates.
      notes: note
        ? sql`case when ${contactMeta.notes} is null or ${contactMeta.notes} = '' then ${note} else ${contactMeta.notes} || E'\n' || ${note} end`
        : contactMeta.notes,
      cardId: sql`coalesce(${contactMeta.cardId}, ${cardId})`,
      status: sql`case when ${contactMeta.status} = 'active' then 'saved' else ${contactMeta.status} end`,
      updatedAt: new Date(),
    })
    .where(eq(contactMeta.personId, personId));

  const [row] = await db
    .update(businessCards)
    .set({ status: "saved", personId, parsed: parsed as unknown as object, eventNote: edits?.eventNote ?? card.eventNote, updatedAt: new Date() })
    .where(eq(businessCards.id, cardId))
    .returning();

  log(`[card-scan] saved "${parsed.fullName}" as person #${personId}`, "cards");
  return { card: row, personId, fullName: parsed.fullName };
}

/** The review queue, newest first. `status` filters; "all" returns everything but saved. */
export async function listCards(status?: string, limit = 60): Promise<BusinessCard[]> {
  const base = db.select().from(businessCards).$dynamic();
  const query =
    status && status !== "all"
      ? base.where(eq(businessCards.status, status as BusinessCard["status"]))
      : base.where(ne(businessCards.status, "saved"));
  return await query.orderBy(desc(businessCards.createdAt)).limit(limit);
}

export async function getCard(cardId: string): Promise<BusinessCard | null> {
  const [card] = await db.select().from(businessCards).where(eq(businessCards.id, cardId));
  return card ?? null;
}

export async function deleteCard(cardId: string): Promise<void> {
  await db.delete(businessCards).where(eq(businessCards.id, cardId));
}

/** vCard text for a stored card, for the phone-contacts hand-off. */
export async function cardVCard(cardId: string): Promise<{ vcf: string; parsed: ParsedCard } | null> {
  const card = await getCard(cardId);
  if (!card?.parsed) return null;
  const parsed = card.parsed as ParsedCard;
  return { vcf: toVCard(parsed, { note: card.eventNote }), parsed };
}

/** Counts for the page header and the sidebar badge. */
export async function cardCounts(): Promise<Record<string, number>> {
  const rows = (await db.execute(sql`SELECT status, count(*)::int AS n FROM business_cards GROUP BY 1`)).rows as { status: string; n: number }[];
  const counts: Record<string, number> = { parsed: 0, needs_review: 0, failed: 0, saved: 0 };
  for (const r of rows) counts[r.status] = r.n;
  counts.pending = counts.parsed + counts.needs_review + counts.failed;
  return counts;
}
