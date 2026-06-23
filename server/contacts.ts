import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db";
import { openai } from "./openai-client";
import { isPublicHttpUrl } from "./url-safety";
import { stripJsonFences } from "./json-utils";
import { log } from "./log";
import {
  people,
  companies,
  peopleCompanies,
  contactMeta,
  lifestyleArticles,
  lifestyleLeadPeople,
  leads,
  type Person,
} from "@shared/schema";

const MODEL = "google/gemini-2.5-flash-lite";

/** Find an un-merged person by name, or create one. Updates lastMentionedAt. */
async function upsertPersonByName(
  fullName: string,
  extra?: { location?: string | null; source?: string | null; nationality?: string | null },
): Promise<Person> {
  const normalized = fullName.trim();
  const [existing] = await db
    .select()
    .from(people)
    .where(and(eq(people.fullName, normalized), isNull(people.mergedIntoId)))
    .limit(1);

  if (existing) {
    const newSources = extra?.source && !(existing.sources ?? []).includes(extra.source)
      ? [...(existing.sources ?? []), extra.source]
      : existing.sources;
    await db
      .update(people)
      .set({
        lastMentionedAt: new Date(),
        mentionCount: sql`coalesce(${people.mentionCount}, 0) + 1`,
        city: existing.city || extra?.location || null,
        sources: newSources,
        updatedAt: new Date(),
      })
      .where(eq(people.id, existing.id));
    return existing;
  }

  const [created] = await db
    .insert(people)
    .values({
      fullName: normalized,
      city: extra?.location || null,
      nationality: extra?.nationality || null,
      sources: extra?.source ? [extra.source] : [],
      mentionCount: 1,
      lastMentionedAt: new Date(),
    })
    .returning();
  return created;
}

/** Link a company to a person (idempotent). */
async function linkCompany(personId: number, companyName: string | null | undefined, source: string) {
  const name = (companyName || "").trim();
  if (!name) return;
  const [existing] = await db.select().from(companies).where(eq(companies.name, name)).limit(1);
  const company = existing || (await db.insert(companies).values({ name, sourceUrls: [source] }).returning())[0];
  await db
    .insert(peopleCompanies)
    .values({ personId, companyId: company.id, source })
    .onConflictDoNothing();
}

/** Ensure a contact_meta row exists for a person (defaults to active). */
export async function ensureContactMeta(personId: number) {
  await db.insert(contactMeta).values({ personId }).onConflictDoNothing();
}

/** Update a contact's lifecycle fields (status / email / remindAt / notes). */
export async function updateContactMeta(
  personId: number,
  fields: { status?: string; email?: string | null; remindAt?: Date | null; notes?: string | null },
) {
  await ensureContactMeta(personId);
  await db
    .update(contactMeta)
    .set({ ...fields, updatedAt: new Date() } as any)
    .where(eq(contactMeta.personId, personId));
  const [row] = await db.select().from(contactMeta).where(eq(contactMeta.personId, personId));
  return row;
}

/**
 * Turn a news lead's founders into contacts: upsert a person per founder and
 * link the company. Article linkage is by name-match (leads.founderNames), so
 * the lead shows up under the contact automatically. Non-fatal by design.
 */
export async function linkLeadFoundersToContacts(
  founderNames: string[],
  companyNames: string[],
  region: string | null | undefined,
  sourceUrl: string,
) {
  for (const name of founderNames || []) {
    if (!name || name.trim().length < 2) continue;
    try {
      const person = await upsertPersonByName(name, { source: sourceUrl, location: region ?? null });
      for (const c of companyNames || []) await linkCompany(person.id, c, sourceUrl);
    } catch (e) {
      log(`[contacts] failed to link founder "${name}": ${e instanceof Error ? e.message : e}`, "contacts");
    }
  }
}

/** Create a contact by typed name (active by default). */
export async function createContactByName(name: string) {
  const person = await upsertPersonByName(name, { source: "manual" });
  await ensureContactMeta(person.id);
  return person;
}

/** Fetch + extract named people from a URL, creating/merging contacts. */
export async function createContactsFromLink(url: string): Promise<{ created: number; names: string[] }> {
  if (!isPublicHttpUrl(url)) throw new Error("URL is not a fetchable public address");
  let html = "";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
      signal: AbortSignal.timeout(12000),
    });
    html = await res.text();
  } catch (e) {
    throw new Error(`Could not fetch the link: ${e instanceof Error ? e.message : "unknown error"}`);
  }
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);

  const prompt = `Extract every NAMED individual from this article who could be a private-banking contact (founders, executives, investors, heirs, tycoons, philanthropists, named wealthy people). Skip institutions and unnamed people. For each give company and location if stated. Return JSON only:
{"people":[{"full_name":"string","company":"string|null","location":"City, Country|null"}]}

Text:
${text}`;

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
    response_format: { type: "json_object" },
  });
  const parsed = JSON.parse(stripJsonFences(response.choices[0]?.message?.content || '{"people":[]}'));
  const extracted: any[] = Array.isArray(parsed.people) ? parsed.people : [];

  const names: string[] = [];
  for (const p of extracted) {
    if (!p?.full_name) continue;
    const person = await upsertPersonByName(p.full_name, { location: p.location, source: url });
    await linkCompany(person.id, p.company, url);
    await ensureContactMeta(person.id);
    names.push(p.full_name);
  }
  log(`[contacts] extracted ${names.length} contact(s) from ${url}`, "contacts");
  return { created: names.length, names };
}

/** List contacts (people + meta + company/article aggregates) for a status view. */
export async function listContacts(status: string, search?: string, limit = 200) {
  const statusCond =
    status === "saved"
      ? sql`cm.status = 'saved'`
      : status === "deleted"
        ? sql`cm.status = 'deleted'`
        : status === "due"
          ? sql`cm.status IS DISTINCT FROM 'deleted' AND cm.remind_at IS NOT NULL AND cm.remind_at <= now()`
          : sql`(cm.status IS NULL OR cm.status = 'active')`;
  const searchCond = search ? sql`AND p.full_name ILIKE ${"%" + search + "%"}` : sql``;

  const result = await db.execute(sql`
    SELECT p.id,
           p.full_name      AS "fullName",
           p.region,
           p.city,
           p.nationality,
           p.bio,
           p.net_worth_estimate AS "netWorthEstimate",
           p.mention_count  AS "mentionCount",
           p.last_mentioned_at AS "lastMentionedAt",
           p.sources,
           cm.email,
           COALESCE(cm.status, 'active') AS status,
           cm.remind_at     AS "remindAt",
           cm.notes,
           (SELECT array_agg(DISTINCT c.name) FROM people_companies pc JOIN companies c ON c.id = pc.company_id WHERE pc.person_id = p.id) AS companies,
           ((SELECT count(*) FROM lifestyle_lead_people llp WHERE llp.person_id = p.id)
            + (SELECT count(*) FROM leads_v2 l WHERE l.founder_names @> ARRAY[p.full_name]))::int AS "articleCount"
    FROM people p
    LEFT JOIN contact_meta cm ON cm.person_id = p.id
    WHERE p.merged_into_id IS NULL AND ${statusCond} ${searchCond}
    ORDER BY COALESCE(cm.updated_at, p.last_mentioned_at, p.created_at) DESC NULLS LAST
    LIMIT ${limit}
  `);
  return result.rows;
}

/** Count contacts whose reminder is due (for a nav badge). */
export async function countDueContacts(): Promise<number> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM contact_meta WHERE status IS DISTINCT FROM 'deleted' AND remind_at IS NOT NULL AND remind_at <= now()`);
  return Number((r.rows[0] as any)?.n ?? 0);
}

/** Articles linked to a contact: lifestyle mentions + any manual source URLs. */
export async function getContactArticles(personId: number) {
  const articles = await db
    .select({
      url: lifestyleArticles.url,
      headline: lifestyleArticles.headline,
      title: lifestyleArticles.title,
      summary: lifestyleArticles.summary,
      eventType: lifestyleArticles.eventType,
      publishedAt: lifestyleArticles.publishedAt,
    })
    .from(lifestyleLeadPeople)
    .innerJoin(lifestyleArticles, eq(lifestyleLeadPeople.lifestyleLeadId, lifestyleArticles.id))
    .where(eq(lifestyleLeadPeople.personId, personId))
    .orderBy(desc(lifestyleArticles.publishedAt))
    .limit(50);

  const [p] = await db.select({ fullName: people.fullName, sources: people.sources }).from(people).where(eq(people.id, personId));

  // News leads that name this person as a founder.
  const newsLeads = p?.fullName
    ? await db
        .select({
          url: leads.sourceUrl,
          headline: leads.headline,
          title: leads.headline,
          summary: leads.aiSummary,
          eventType: leads.category,
          publishedAt: leads.publishedAt,
        })
        .from(leads)
        .where(sql`${leads.founderNames} @> ARRAY[${p.fullName}]::text[]`)
        .orderBy(desc(leads.publishedAt))
        .limit(50)
    : [];

  const seen = new Set(articles.map((a) => a.url));
  const news = newsLeads.filter((n) => !seen.has(n.url)).map((n) => ({ ...n, eventType: n.eventType || "news" }));
  news.forEach((n) => seen.add(n.url));

  const extraSources = (p?.sources ?? [])
    .filter((u) => u && u !== "manual" && !seen.has(u))
    .map((u) => ({ url: u, headline: u, title: u, summary: null as string | null, eventType: "source", publishedAt: null as Date | null }));

  return [...articles, ...news, ...extraSources];
}
