import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db";
import { isPublicHttpUrl } from "./url-safety";
import { callJsonStage } from "./llm-json";
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
export async function upsertPersonByName(
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

/** Mute people by name so their leads stop appearing (unless co-named with a
 * non-muted founder). Upserts the person and sets contact_meta status='muted'. */
export async function muteByNames(names: string[]): Promise<number> {
  const valid = (names || []).filter((n) => n && n.trim().length >= 2);
  await Promise.all(
    valid.map(async (name) => {
      const person = await upsertPersonByName(name, { source: "mute" });
      await db
        .insert(contactMeta)
        .values({ personId: person.id, status: "muted" })
        .onConflictDoUpdate({
          target: contactMeta.personId,
          set: { status: "muted", updatedAt: new Date() },
        });
    }),
  );
  return valid.length;
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

  const parsed = await callJsonStage<any>({
    model: MODEL,
    prompt,
    temperature: 0.1,
    label: "ContactsFromLink",
  });
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
      : status === "muted"
        ? sql`cm.status = 'muted'`
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

// ---------------------------------------------------------------------------
// Lead ↔ person context: what the dashboard chips and the person page need.
// Both live here (not in the route module) so the SQL sits next to the other
// person-centric queries and stays testable on its own.
// ---------------------------------------------------------------------------

/** Everything a lead card needs to know about a founder name it displays. */
export type PersonLookup = {
  /** The lowercased/trimmed name that was asked for — the client's map key. */
  queryName: string;
  personId: number;
  fullName: string;
  familyId: string | null;
  familyName: string | null;
  blocked: boolean;
  contactStatus: string | null;
  hasNotes: boolean;
  mentionCount: number;
  lastMentionedAt: string | null;
};

/** One page of leads names at most ~40 founders; the cap is a safety valve. */
const LOOKUP_NAME_LIMIT = 250;

/**
 * Resolve founder names to people rows in a SINGLE query. Matches
 * `people.full_name` or any alias, case-insensitively, skipping merged
 * duplicates. Names that match nothing are simply absent from the result.
 *
 * @param names Raw founder names as they appear on leads.
 * @returns One row per matched name (the most-mentioned person wins a tie).
 *
 * @example
 * const rows = await lookupPeopleByNames(["Anthony Tan", "Tan Hooi Ling"]);
 * const byName = new Map(rows.map((r) => [r.queryName, r]));
 */
export async function lookupPeopleByNames(names: string[]): Promise<PersonLookup[]> {
  const keys = Array.from(
    new Set((names ?? []).map((n) => (n || "").trim().toLowerCase()).filter((n) => n.length >= 2)),
  ).slice(0, LOOKUP_NAME_LIMIT);
  if (keys.length === 0) return [];

  const result = await db.execute(sql`
    -- The name list travels as one JSON param: drizzle expands a JS array in a
    -- template into a record ("cannot cast type record to text[]"), so jsonb is
    -- the reliable way to pass a variable-length list.
    WITH asked(key) AS (SELECT DISTINCT jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb)),
    matched AS (
      SELECT a.key,
             p.id,
             p.full_name,
             COALESCE(p.mention_count, 0) AS mention_count,
             p.last_mentioned_at,
             -- Prefer an exact full-name hit over an alias hit, then the person
             -- we've seen most often, so a name never resolves ambiguously.
             row_number() OVER (
               PARTITION BY a.key
               ORDER BY (lower(btrim(p.full_name)) = a.key) DESC,
                        COALESCE(p.mention_count, 0) DESC,
                        p.id ASC
             ) AS rn
      FROM asked a
      JOIN people p
        ON p.merged_into_id IS NULL
       AND (lower(btrim(p.full_name)) = a.key
            OR EXISTS (
              SELECT 1 FROM unnest(COALESCE(p.aliases, ARRAY[]::text[])) al
               WHERE lower(btrim(al)) = a.key
            ))
    )
    SELECT m.key                AS "queryName",
           m.id                 AS "personId",
           m.full_name          AS "fullName",
           fm.family_id         AS "familyId",
           f.name               AS "familyName",
           (pb.person_id IS NOT NULL) AS blocked,
           cm.status            AS "contactStatus",
           COALESCE(cm.notes IS NOT NULL AND btrim(cm.notes) <> '', false) AS "hasNotes",
           m.mention_count::int AS "mentionCount",
           m.last_mentioned_at  AS "lastMentionedAt"
    FROM matched m
    LEFT JOIN LATERAL (
      SELECT family_id FROM family_members WHERE person_id = m.id ORDER BY created_at ASC LIMIT 1
    ) fm ON TRUE
    LEFT JOIN families f ON f.id = fm.family_id
    LEFT JOIN person_blocks pb ON pb.person_id = m.id
    LEFT JOIN contact_meta cm ON cm.person_id = m.id
    WHERE m.rn = 1
  `);
  return result.rows as unknown as PersonLookup[];
}

/** One stacked event on the person page: a news lead, or a dated contact note. */
export type PersonTimelineEntry = {
  kind: "lead" | "note";
  id: string;
  date: string | null;
  headline: string | null;
  url: string | null;
  sourceName: string | null;
  priorityLevel: string | null;
  priorityScore: number | null;
  dealValue: string | null;
  status: string | null;
  saved: boolean;
  category: string | null;
  summary: string | null;
  companyNames: string[] | null;
};

/** Newest 100 events is plenty for a pre-call read; keeps the payload small. */
const TIMELINE_LIMIT = 100;

/** Turn a stored relationship edge into the wording the UI shows. */
function relationLabel(type: string, personIsFrom: boolean): string {
  if (type === "parent") return personIsFrom ? "Parent of" : "Child of";
  if (type === "spouse") return "Spouse of";
  if (type === "sibling") return "Sibling of";
  return type;
}

/**
 * Everything known about one person, stacked for a pre-call read: identity,
 * companies, contact meta, family memberships + relationships, coverage block,
 * and a merged timeline of every lead that names them plus their notes.
 *
 * @returns `null` when the person id doesn't exist (the caller 404s).
 */
export async function getPersonProfile(personId: number) {
  const [person] = await db.select().from(people).where(eq(people.id, personId));
  if (!person) return null;

  // A lead may name the person by an alias, so match on every known spelling.
  const nameKeys = Array.from(
    new Set(
      [person.fullName, ...(person.aliases ?? [])]
        .map((n) => (n || "").trim().toLowerCase())
        .filter((n) => n.length >= 2),
    ),
  );

  const [companyRows, contactRow, familyRows, relationshipRows, blockRows] = await Promise.all([
    db.execute(sql`
      -- DISTINCT ON: the same company can be linked more than once (one row
      -- per source article, plus duplicate company rows), and the page should
      -- show each name a single time.
      SELECT DISTINCT ON (lower(c.name)) c.name, pc.role
        FROM people_companies pc
        JOIN companies c ON c.id = pc.company_id
       WHERE pc.person_id = ${personId}
       ORDER BY lower(c.name) ASC, pc.role ASC NULLS LAST
    `),
    db.select().from(contactMeta).where(eq(contactMeta.personId, personId)),
    db.execute(sql`
      SELECT f.id AS "familyId", f.name AS "familyName", f.country
        FROM family_members fm
        JOIN families f ON f.id = fm.family_id
       WHERE fm.person_id = ${personId}
       ORDER BY f.name ASC
    `),
    db.execute(sql`
      SELECT r.id,
             r.type,
             r.family_id AS "familyId",
             r.source_url AS "sourceUrl",
             (r.from_person_id = ${personId}) AS "personIsFrom",
             other.id AS "personId",
             other.full_name AS "fullName"
        FROM family_relationships r
        JOIN people other
          ON other.id = CASE WHEN r.from_person_id = ${personId} THEN r.to_person_id ELSE r.from_person_id END
       WHERE r.from_person_id = ${personId} OR r.to_person_id = ${personId}
       ORDER BY r.type ASC, other.full_name ASC
    `),
    db.execute(sql`
      SELECT pb.origin, pb.reason, pb.covered_by AS "coveredBy",
             pb.created_at AS "createdAt", op.full_name AS "originName"
        FROM person_blocks pb
        LEFT JOIN people op ON op.id = pb.origin_person_id
       WHERE pb.person_id = ${personId}
    `),
  ]);

  const leadRows = nameKeys.length
    ? (
        await db.execute(sql`
          SELECT l.id,
                 l.headline,
                 l.source_url   AS url,
                 l.source_name  AS "sourceName",
                 l.published_at AS "publishedAt",
                 l.priority_level AS "priorityLevel",
                 l.priority_score AS "priorityScore",
                 l.status,
                 l.category,
                 l.ai_summary   AS "aiSummary",
                 l.company_names AS "companyNames",
                 COALESCE(
                   l.key_financials->>'dealValue',
                   l.key_financials->>'fundingAmount',
                   l.key_financials->>'valuation'
                 ) AS "dealValue",
                 EXISTS (SELECT 1 FROM saved_leads_v2 sl WHERE sl.lead_id = l.id) AS saved
            FROM leads_v2 l
           WHERE EXISTS (
                   SELECT 1 FROM unnest(l.founder_names) fn
                    WHERE lower(btrim(fn)) IN (
                      SELECT jsonb_array_elements_text(${JSON.stringify(nameKeys)}::jsonb)
                    )
                 )
           ORDER BY l.published_at DESC
           LIMIT ${TIMELINE_LIMIT}
        `)
      ).rows
    : [];

  const timeline: PersonTimelineEntry[] = (leadRows as any[]).map((l) => ({
    kind: "lead",
    id: String(l.id),
    date: l.publishedAt ?? null,
    headline: l.headline ?? null,
    url: l.url ?? null,
    sourceName: l.sourceName ?? null,
    priorityLevel: l.priorityLevel ?? null,
    priorityScore: l.priorityScore ?? null,
    dealValue: l.dealValue ?? null,
    status: l.status ?? null,
    saved: !!l.saved,
    category: l.category ?? null,
    summary: l.aiSummary ?? null,
    companyNames: l.companyNames ?? null,
  }));

  const contact = contactRow[0] ?? null;
  if (contact?.notes && contact.notes.trim()) {
    timeline.push({
      kind: "note",
      id: `note:${personId}`,
      date: (contact.updatedAt ?? contact.createdAt)?.toISOString() ?? null,
      headline: null,
      url: null,
      sourceName: null,
      priorityLevel: null,
      priorityScore: null,
      dealValue: null,
      status: null,
      saved: false,
      category: null,
      summary: contact.notes,
      companyNames: null,
    });
  }

  timeline.sort((a, b) => {
    const at = a.date ? new Date(a.date).getTime() : 0;
    const bt = b.date ? new Date(b.date).getTime() : 0;
    return bt - at;
  });

  const block = (blockRows.rows[0] as any) ?? null;

  return {
    person: {
      id: person.id,
      fullName: person.fullName,
      aliases: person.aliases ?? [],
      bio: person.bio,
      photoUrl: person.photoUrl,
      nationality: person.nationality,
      region: person.region,
      city: person.city,
      netWorthEstimate: person.netWorthEstimate,
      netWorthSource: person.netWorthSource,
      wealthSource: person.wealthSource,
      familyName: person.familyName,
      mentionCount: person.mentionCount ?? 0,
      lastMentionedAt: person.lastMentionedAt,
      firstSeenAt: person.firstSeenAt,
      mergedIntoId: person.mergedIntoId,
    },
    companies: companyRows.rows as unknown as { name: string; role: string | null }[],
    contact,
    families: familyRows.rows as unknown as { familyId: string; familyName: string; country: string | null }[],
    relationships: (relationshipRows.rows as any[]).map((r) => ({
      id: String(r.id),
      personId: Number(r.personId),
      fullName: r.fullName as string,
      familyId: (r.familyId ?? null) as string | null,
      sourceUrl: (r.sourceUrl ?? null) as string | null,
      relation: relationLabel(String(r.type), !!r.personIsFrom),
    })),
    block: block
      ? {
          origin: block.origin as "direct" | "propagated",
          reason: (block.reason ?? null) as string | null,
          coveredBy: (block.coveredBy ?? null) as string | null,
          originName: (block.originName ?? null) as string | null,
          createdAt: block.createdAt ?? null,
        }
      : null,
    timeline: timeline.slice(0, TIMELINE_LIMIT),
  };
}

export type PersonProfile = NonNullable<Awaited<ReturnType<typeof getPersonProfile>>>;
