import { and, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { log } from "./log";
import { upsertPersonByName } from "./contacts";
import {
  families,
  familyMembers,
  familyRelationships,
  personBlocks,
  people,
  type Family,
  type FamilyRelationship,
  type Person,
} from "@shared/schema";

/** How a newly added member relates to an existing one (UI wording). */
export type MemberRelation = {
  toPersonId: number;
  type: "parent_of" | "child_of" | "spouse_of" | "sibling_of";
};

/** Canonicalize a UI relation into a stored edge (parent→child, spouse, sibling). */
function toEdge(newPersonId: number, rel: MemberRelation): { fromPersonId: number; toPersonId: number; type: "parent" | "spouse" | "sibling" } {
  switch (rel.type) {
    case "parent_of": return { fromPersonId: newPersonId, toPersonId: rel.toPersonId, type: "parent" };
    case "child_of": return { fromPersonId: rel.toPersonId, toPersonId: newPersonId, type: "parent" };
    case "spouse_of": return { fromPersonId: newPersonId, toPersonId: rel.toPersonId, type: "spouse" };
    case "sibling_of": return { fromPersonId: newPersonId, toPersonId: rel.toPersonId, type: "sibling" };
  }
}

/**
 * `families.confidence` is free text that carries both the level and, for rows
 * the researcher could not finish, why: "low: only 1 member found",
 * "error: no search results". These two fragments split it in SQL so the
 * review queue can show the level and the reason separately.
 */
const CONFIDENCE_LEVEL_SQL = sql`lower(nullif(split_part(coalesce(f.confidence, ''), ':', 1), ''))`;
const CONFIDENCE_NOTE_SQL = sql`nullif(btrim(substr(coalesce(f.confidence, ''), strpos(coalesce(f.confidence, ''), ':') + 1)), '')`;

export async function listFamilies(search?: string, country?: string) {
  const searchCond = search ? sql`AND f.name ILIKE ${"%" + search + "%"}` : sql``;
  const countryCond = country ? sql`AND f.country = ${country}` : sql``;
  const result = await db.execute(sql`
    SELECT f.*,
           f.net_worth_estimate AS "netWorthEstimate",
           f.research_status    AS "researchStatus",
           f.research_attempts  AS "researchAttempts",
           f.researched_at      AS "researchedAt",
           f.primary_companies  AS "primaryCompanies",
           ${CONFIDENCE_LEVEL_SQL} AS "confidenceLevel",
           CASE WHEN strpos(coalesce(f.confidence, ''), ':') > 0 THEN ${CONFIDENCE_NOTE_SQL} END AS "reviewNote",
           coalesce(array_length(f.source_urls, 1), 0) AS "sourceCount",
           (SELECT count(*)::int FROM family_members fm WHERE fm.family_id = f.id) AS "memberCount",
           (SELECT count(*)::int FROM family_relationships fr WHERE fr.family_id = f.id) AS "relationshipCount",
           (SELECT count(*)::int FROM family_members fm
              JOIN person_blocks pb ON pb.person_id = fm.person_id
             WHERE fm.family_id = f.id) AS "blockedCount"
    FROM families f
    WHERE TRUE ${searchCond} ${countryCond}
    ORDER BY f.name ASC
    LIMIT 500
  `);
  return result.rows;
}

export async function createFamily(input: { name: string; country?: string | null; description?: string | null }): Promise<Family> {
  const [created] = await db
    .insert(families)
    .values({
      name: input.name.trim(),
      country: input.country?.trim() || null,
      description: input.description?.trim() || null,
      researchStatus: "manual",
    })
    .returning();
  return created;
}

export async function deleteFamily(familyId: string) {
  // Removes the tree structure only — people and their blocks stay.
  await db.delete(familyRelationships).where(eq(familyRelationships.familyId, familyId));
  await db.delete(familyMembers).where(eq(familyMembers.familyId, familyId));
  await db.delete(families).where(eq(families.id, familyId));
}

/** Full payload for the family page: members (w/ person + block info) + edges. */
export async function getFamilyDetail(familyId: string) {
  const [family] = await db.select().from(families).where(eq(families.id, familyId));
  if (!family) return null;

  const members = (await db.execute(sql`
    SELECT p.id,
           p.full_name AS "fullName",
           p.aliases,
           p.bio,
           p.photo_url AS "photoUrl",
           p.nationality,
           p.city,
           p.net_worth_estimate AS "netWorthEstimate",
           p.wealth_source AS "wealthSource",
           (SELECT array_agg(DISTINCT c.name) FROM people_companies pc JOIN companies c ON c.id = pc.company_id WHERE pc.person_id = p.id) AS companies,
           pb.id IS NOT NULL AS "blocked",
           pb.origin AS "blockOrigin",
           pb.reason AS "blockReason",
           pb.covered_by AS "blockCoveredBy",
           op.full_name AS "blockOriginName"
    FROM family_members fm
    JOIN people p ON p.id = fm.person_id
    LEFT JOIN person_blocks pb ON pb.person_id = p.id
    LEFT JOIN people op ON op.id = pb.origin_person_id
    WHERE fm.family_id = ${familyId} AND p.merged_into_id IS NULL
    ORDER BY p.full_name ASC
  `)).rows;

  const relationships = await db
    .select()
    .from(familyRelationships)
    .where(eq(familyRelationships.familyId, familyId));

  return { family, members, relationships };
}

/**
 * Add a person to a family by name (creates or reuses the people row) with an
 * optional relation to an existing member. Idempotent on the membership.
 */
export async function addFamilyMember(
  familyId: string,
  name: string,
  relation?: MemberRelation,
) {
  // resolvePersonByName (not upsertPersonByName) so "Leng Beng Kwek" links to
  // the existing "Kwek Leng Beng" instead of creating a second row.
  const { person } = await resolvePersonByName(name, { source: "family-manual" });
  await db
    .insert(familyMembers)
    .values({ familyId, personId: person.id })
    .onConflictDoNothing();
  if (relation && relation.toPersonId !== person.id) {
    const edge = toEdge(person.id, relation);
    await db
      .insert(familyRelationships)
      .values({ familyId, ...edge, confidence: "manual" })
      .onConflictDoNothing();
  }
  return person;
}

/** Remove a member and any edges that touch them within this family. */
export async function removeFamilyMember(familyId: string, personId: number) {
  await db.delete(familyRelationships).where(
    and(
      eq(familyRelationships.familyId, familyId),
      sql`(${familyRelationships.fromPersonId} = ${personId} OR ${familyRelationships.toPersonId} = ${personId})`,
    ),
  );
  await db.delete(familyMembers).where(
    and(eq(familyMembers.familyId, familyId), eq(familyMembers.personId, personId)),
  );
}

export async function addRelationship(
  familyId: string,
  fromPersonId: number,
  toPersonId: number,
  type: "parent" | "spouse" | "sibling",
): Promise<FamilyRelationship | undefined> {
  if (fromPersonId === toPersonId) throw new Error("Cannot relate a person to themselves");
  const [row] = await db
    .insert(familyRelationships)
    .values({ familyId, fromPersonId, toPersonId, type, confidence: "manual" })
    .onConflictDoNothing()
    .returning();
  return row;
}

export async function deleteRelationship(id: string) {
  await db.delete(familyRelationships).where(eq(familyRelationships.id, id));
}

/**
 * Block a person (direct) plus optional relatives (propagated). A propagated
 * row records which direct block caused it; an existing direct block is never
 * downgraded, but a propagated one upgrades to direct if Billy blocks that
 * person explicitly later.
 */
export async function blockPersons(
  directPersonId: number,
  alsoBlockPersonIds: number[],
  reason?: string | null,
  coveredBy?: string | null,
) {
  await db
    .insert(personBlocks)
    .values({ personId: directPersonId, origin: "direct", reason: reason ?? null, coveredBy: coveredBy ?? null })
    .onConflictDoUpdate({
      target: personBlocks.personId,
      set: { origin: "direct", originPersonId: null, reason: reason ?? null, coveredBy: coveredBy ?? null },
    });

  const others = Array.from(new Set(alsoBlockPersonIds)).filter((id) => id !== directPersonId);
  for (const personId of others) {
    // onConflictDoNothing: never overwrite an existing block (direct or from
    // another propagation chain).
    await db
      .insert(personBlocks)
      .values({
        personId,
        origin: "propagated",
        originPersonId: directPersonId,
        reason: reason ?? null,
        coveredBy: coveredBy ?? null,
      })
      .onConflictDoNothing();
  }
  log(`[families] blocked person ${directPersonId} (+${others.length} propagated)`, "families");
  return { blocked: 1 + others.length };
}

/**
 * Unblock a person. If their block was direct, its propagated blocks are
 * removed too (they only existed because of this one).
 */
export async function unblockPerson(personId: number) {
  const [existing] = await db.select().from(personBlocks).where(eq(personBlocks.personId, personId));
  if (!existing) return { removed: 0 };
  let removed = 1;
  if (existing.origin === "direct") {
    const cascaded = await db
      .delete(personBlocks)
      .where(eq(personBlocks.originPersonId, personId))
      .returning({ id: personBlocks.id });
    removed += cascaded.length;
  }
  await db.delete(personBlocks).where(eq(personBlocks.personId, personId));
  return { removed };
}

/** Blocked list for the feed badge: names + aliases + why + family link. */
export async function listBlockedPersons() {
  const result = await db.execute(sql`
    SELECT pb.person_id AS "personId",
           p.full_name  AS "fullName",
           p.aliases,
           pb.origin,
           pb.reason,
           pb.covered_by AS "coveredBy",
           op.full_name  AS "originName",
           (SELECT fm.family_id FROM family_members fm WHERE fm.person_id = pb.person_id LIMIT 1) AS "familyId"
    FROM person_blocks pb
    JOIN people p ON p.id = pb.person_id
    LEFT JOIN people op ON op.id = pb.origin_person_id
    WHERE p.merged_into_id IS NULL
    ORDER BY p.full_name ASC
  `);
  return result.rows;
}

// ---------------------------------------------------------------------------
// Person identity: reuse people rows across spelling variants
// ---------------------------------------------------------------------------

/**
 * Identity key for a person's name: case-, punctuation- and order-insensitive.
 * "Kwek Leng Beng", "kwek leng beng" and "Leng Beng Kwek" all collapse to the
 * same key so the researcher reuses one `people` row instead of creating three.
 */
export function normalizeNameKey(name: string): string {
  return (name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/['’`]/g, "")               // O'Brien → obrien (one token, not two)
    .replace(/[^a-z0-9\s]/g, " ")        // other punctuation → space (Tan-Lim → tan lim)
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/**
 * Find an existing `people` row whose name (or one of its aliases) is the same
 * person under a different spelling, else create one. The candidate set is
 * narrowed in SQL by the longest name token, then compared on the normalized
 * key in JS — cheap enough for one call per researched member.
 *
 * When a variant spelling matches, it is recorded in the survivor's `aliases`
 * so the feed's blocked-name matching keeps working for both spellings.
 *
 * @returns the person plus whether an existing row was reused under a variant.
 */
export async function resolvePersonByName(
  name: string,
  extra?: { source?: string | null; nationality?: string | null; location?: string | null },
): Promise<{ person: Person; reusedVariant: boolean }> {
  const trimmed = name.trim();
  const key = normalizeNameKey(trimmed);
  const tokens = key.split(" ").filter((t) => t.length > 1);

  if (key) {
    // Longest token keeps the candidate scan narrow; every spelling variant of
    // the same name shares its tokens, only their order/case/punctuation differ.
    const anchor = tokens.sort((a, b) => b.length - a.length)[0] ?? key;
    const candidates = (await db.execute(sql`
      SELECT id, full_name AS "fullName", aliases
      FROM people
      WHERE merged_into_id IS NULL
        AND (full_name ILIKE ${"%" + anchor + "%"} OR ${anchor} = ANY (coalesce(aliases, '{}')))
      ORDER BY coalesce(mention_count, 0) DESC, id ASC
      LIMIT 50
    `)).rows as { id: number; fullName: string; aliases: string[] | null }[];

    const match = candidates.find(
      (c) =>
        normalizeNameKey(c.fullName) === key ||
        (c.aliases ?? []).some((a) => normalizeNameKey(a) === key),
    );
    if (match) {
      const isExact = match.fullName === trimmed;
      if (!isExact && !(match.aliases ?? []).includes(trimmed)) {
        await db
          .update(people)
          .set({ aliases: [...(match.aliases ?? []), trimmed], updatedAt: new Date() })
          .where(eq(people.id, match.id));
      }
      // Route through the normal upsert so mention counts / sources still tick.
      const person = await upsertPersonByName(match.fullName, extra);
      return { person, reusedVariant: !isExact };
    }
  }

  return { person: await upsertPersonByName(trimmed, extra), reusedVariant: false };
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

/** Accept the researcher's tree as-is: the family leaves the review queue. */
export async function approveFamily(familyId: string): Promise<boolean> {
  const updated = await db
    .update(families)
    .set({ researchStatus: "done", updatedAt: new Date() })
    .where(and(eq(families.id, familyId), sql`${families.researchStatus} <> 'done'`))
    .returning({ id: families.id });
  return updated.length > 0;
}

/**
 * Bulk-approve the review queue's safe majority: families the researcher
 * flagged but which already have enough members and were not low-confidence.
 * Defaults match the button ("≥3 members and confidence ≥ medium").
 */
export async function approveReviewedFamilies(
  minMembers = 3,
  minConfidence: "medium" | "high" = "medium",
): Promise<{ approved: number; ids: string[] }> {
  const levels = minConfidence === "high" ? ["high"] : ["medium", "high"];
  const levelList = sql.join(
    levels.map((l) => sql`${l}`),
    sql`, `,
  );
  const updated = (await db.execute(sql`
    UPDATE families f
       SET research_status = 'done', updated_at = now()
     WHERE f.research_status = 'needs_review'
       AND ${CONFIDENCE_LEVEL_SQL} IN (${levelList})
       AND (SELECT count(*) FROM family_members fm WHERE fm.family_id = f.id) >= ${minMembers}
    RETURNING f.id
  `)).rows as { id: string }[];
  log(`[families] bulk-approved ${updated.length} reviewed families`, "families");
  return { approved: updated.length, ids: updated.map((r) => r.id) };
}

// ---------------------------------------------------------------------------
// Merging duplicates
// ---------------------------------------------------------------------------

function dedupeStrings(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = (v ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Merge a duplicate family into another (e.g. the seeder's "Kwek Leng Beng
 * family" into "Kwek family"): members and relationships move to the target,
 * duplicates/conflicts are dropped, blank fields on the target are filled from
 * the source, and the source family row is deleted. People are untouched.
 */
export async function mergeFamilies(sourceId: string, targetId: string) {
  if (sourceId === targetId) throw new Error("Cannot merge a family into itself");
  const [source] = await db.select().from(families).where(eq(families.id, sourceId));
  if (!source) throw new Error("Source family not found");
  const [target] = await db.select().from(families).where(eq(families.id, targetId));
  if (!target) throw new Error("Target family not found");

  return await db.transaction(async (tx) => {
    const movedMembers = (await tx.execute(sql`
      INSERT INTO family_members (family_id, person_id)
      SELECT ${targetId}, fm.person_id
        FROM family_members fm
       WHERE fm.family_id = ${sourceId}
         AND NOT EXISTS (
           SELECT 1 FROM family_members t
            WHERE t.family_id = ${targetId} AND t.person_id = fm.person_id
         )
      RETURNING id
    `)).rows.length;

    // An edge is a conflict when the target already relates the same pair the
    // same way (spouse/sibling are symmetric, so either direction counts).
    const movedRelationships = (await tx.execute(sql`
      UPDATE family_relationships r
         SET family_id = ${targetId}
       WHERE r.family_id = ${sourceId}
         AND NOT EXISTS (
           SELECT 1 FROM family_relationships t
            WHERE t.family_id = ${targetId}
              AND t.type = r.type
              AND ((t.from_person_id = r.from_person_id AND t.to_person_id = r.to_person_id)
                OR (r.type <> 'parent' AND t.from_person_id = r.to_person_id AND t.to_person_id = r.from_person_id))
         )
      RETURNING r.id
    `)).rows.length;

    await tx
      .update(families)
      .set({
        description: target.description ?? source.description,
        country: target.country ?? source.country,
        netWorthEstimate: target.netWorthEstimate ?? source.netWorthEstimate,
        patriarchPersonId: target.patriarchPersonId ?? source.patriarchPersonId,
        primaryCompanies: dedupeStrings([...(target.primaryCompanies ?? []), ...(source.primaryCompanies ?? [])]).slice(0, 5),
        sourceUrls: dedupeStrings([...(target.sourceUrls ?? []), ...(source.sourceUrls ?? [])]).slice(0, 20),
        updatedAt: new Date(),
      })
      .where(eq(families.id, targetId));

    const skippedRelationships = (await tx.execute(sql`
      DELETE FROM family_relationships WHERE family_id = ${sourceId} RETURNING id
    `)).rows.length;
    await tx.execute(sql`DELETE FROM family_members WHERE family_id = ${sourceId}`);
    await tx.execute(sql`DELETE FROM families WHERE id = ${sourceId}`);

    log(
      `[families] merged "${source.name}" into "${target.name}": +${movedMembers} members, +${movedRelationships} edges, ${skippedRelationships} duplicate edges dropped`,
      "families",
    );
    return { movedMembers, movedRelationships, skippedRelationships, targetId, targetName: target.name };
  });
}

/**
 * Merge two `people` rows that are the same person under variant spellings.
 * The duplicate is tombstoned with `merged_into_id` (never deleted — other
 * tables still reference it) and its family memberships, relationships, blocks
 * and company links are repointed at the survivor, dropping anything that would
 * duplicate a row the survivor already has. The old spelling becomes an alias.
 */
export async function mergePersons(sourcePersonId: number, targetPersonId: number) {
  if (sourcePersonId === targetPersonId) throw new Error("Cannot merge a person into themselves");
  const [source] = await db.select().from(people).where(eq(people.id, sourcePersonId));
  if (!source) throw new Error("Source person not found");
  const [target] = await db.select().from(people).where(eq(people.id, targetPersonId));
  if (!target) throw new Error("Target person not found");
  if (source.mergedIntoId) throw new Error("Source person has already been merged");
  if (target.mergedIntoId) throw new Error("Target person has already been merged");

  return await db.transaction(async (tx) => {
    const movedMemberships = (await tx.execute(sql`
      INSERT INTO family_members (family_id, person_id)
      SELECT fm.family_id, ${targetPersonId}
        FROM family_members fm
       WHERE fm.person_id = ${sourcePersonId}
         AND NOT EXISTS (
           SELECT 1 FROM family_members t
            WHERE t.family_id = fm.family_id AND t.person_id = ${targetPersonId}
         )
      RETURNING id
    `)).rows.length;
    await tx.execute(sql`DELETE FROM family_members WHERE person_id = ${sourcePersonId}`);

    // Edges between the two rows describe a person relating to themselves.
    const droppedSelfEdges = (await tx.execute(sql`
      DELETE FROM family_relationships
       WHERE (from_person_id = ${sourcePersonId} AND to_person_id = ${targetPersonId})
          OR (from_person_id = ${targetPersonId} AND to_person_id = ${sourcePersonId})
      RETURNING id
    `)).rows.length;

    // Repoint, skipping edges the survivor already has (family_rel_uq is on
    // from/to/type; spouse and sibling also conflict in reverse).
    const repointedFrom = (await tx.execute(sql`
      UPDATE family_relationships r
         SET from_person_id = ${targetPersonId}
       WHERE r.from_person_id = ${sourcePersonId}
         AND NOT EXISTS (
           SELECT 1 FROM family_relationships t
            WHERE t.type = r.type
              AND ((t.from_person_id = ${targetPersonId} AND t.to_person_id = r.to_person_id)
                OR (r.type <> 'parent' AND t.from_person_id = r.to_person_id AND t.to_person_id = ${targetPersonId}))
         )
      RETURNING r.id
    `)).rows.length;
    const repointedTo = (await tx.execute(sql`
      UPDATE family_relationships r
         SET to_person_id = ${targetPersonId}
       WHERE r.to_person_id = ${sourcePersonId}
         AND NOT EXISTS (
           SELECT 1 FROM family_relationships t
            WHERE t.type = r.type
              AND ((t.to_person_id = ${targetPersonId} AND t.from_person_id = r.from_person_id)
                OR (r.type <> 'parent' AND t.to_person_id = r.from_person_id AND t.from_person_id = ${targetPersonId}))
         )
      RETURNING r.id
    `)).rows.length;
    // Whatever still points at the duplicate is an edge the survivor already
    // has (or a self-edge) — redundant either way.
    const droppedRelationships =
      droppedSelfEdges +
      (await tx.execute(sql`
        DELETE FROM family_relationships
         WHERE from_person_id = ${sourcePersonId} OR to_person_id = ${sourcePersonId}
        RETURNING id
      `)).rows.length;

    // person_blocks.person_id is unique: the survivor's own block wins.
    await tx.execute(sql`
      UPDATE person_blocks
         SET person_id = ${targetPersonId}
       WHERE person_id = ${sourcePersonId}
         AND NOT EXISTS (SELECT 1 FROM person_blocks t WHERE t.person_id = ${targetPersonId})
    `);
    await tx.execute(sql`DELETE FROM person_blocks WHERE person_id = ${sourcePersonId}`);
    await tx.execute(sql`UPDATE person_blocks SET origin_person_id = ${targetPersonId} WHERE origin_person_id = ${sourcePersonId}`);

    await tx.execute(sql`
      UPDATE people_companies pc
         SET person_id = ${targetPersonId}
       WHERE pc.person_id = ${sourcePersonId}
         AND NOT EXISTS (
           SELECT 1 FROM people_companies t
            WHERE t.person_id = ${targetPersonId} AND t.company_id = pc.company_id
         )
    `);
    await tx.execute(sql`DELETE FROM people_companies WHERE person_id = ${sourcePersonId}`);

    const aliases = dedupeStrings([
      ...(target.aliases ?? []),
      source.fullName,
      ...(source.aliases ?? []),
    ]).filter((a) => a !== target.fullName);

    await tx
      .update(people)
      .set({
        aliases,
        // Fill blanks only — the survivor's own data always wins.
        bio: target.bio ?? source.bio,
        photoUrl: target.photoUrl ?? source.photoUrl,
        nationality: target.nationality ?? source.nationality,
        city: target.city ?? source.city,
        familyName: target.familyName ?? source.familyName,
        netWorthEstimate: target.netWorthEstimate ?? source.netWorthEstimate,
        wealthSource: target.wealthSource ?? source.wealthSource,
        updatedAt: new Date(),
      })
      .where(eq(people.id, targetPersonId));

    await tx
      .update(people)
      .set({ mergedIntoId: targetPersonId, updatedAt: new Date() })
      .where(eq(people.id, sourcePersonId));

    log(
      `[families] merged person "${source.fullName}" (#${sourcePersonId}) into "${target.fullName}" (#${targetPersonId})`,
      "families",
    );
    return {
      targetPersonId,
      targetName: target.fullName,
      movedMemberships,
      repointedRelationships: repointedFrom + repointedTo,
      droppedRelationships,
      aliases,
    };
  });
}

// ---------------------------------------------------------------------------
// Maintenance: duplicates the research agent and the lifestyle scanner left
// behind (exact-name people, seed families that are the same family twice).
// ---------------------------------------------------------------------------

/**
 * Fold members of one family that are the same name under different rows
 * (normalized key match). Oldest row survives. Returns how many were merged.
 */
export async function dedupeFamilyMembers(familyId: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT p.id, p.full_name AS "fullName"
      FROM family_members fm JOIN people p ON p.id = fm.person_id
     WHERE fm.family_id = ${familyId} AND p.merged_into_id IS NULL
     ORDER BY p.id ASC
  `)).rows as { id: number; fullName: string }[];
  const byKey = new Map<string, number>();
  let merged = 0;
  for (const r of rows) {
    const key = normalizeNameKey(r.fullName);
    if (!key) continue;
    const survivor = byKey.get(key);
    if (survivor === undefined) {
      byKey.set(key, r.id);
      continue;
    }
    await mergePersons(r.id, survivor);
    merged++;
  }
  return merged;
}

export interface DedupeReport {
  dryRun: boolean;
  people: { merged: number; groups: { survivor: string; duplicates: number[] }[] };
  families: { merged: number; pairs: { source: string; target: string; reason: string }[] };
}

/**
 * Merge every live `people` row that shares its exact name (case- and
 * whitespace-insensitive) with an older row. Same-name-different-person is
 * possible in theory, but every group found so far was one tycoon inserted
 * twice by two scanners, and the survivor keeps the other's name as an alias
 * so nothing is lost if a split is ever needed.
 */
export async function dedupeExactNamePeople(dryRun = false): Promise<DedupeReport["people"]> {
  const groups = (await db.execute(sql`
    SELECT array_agg(id ORDER BY id) AS ids, min(full_name) AS name
      FROM people
     WHERE merged_into_id IS NULL
     GROUP BY lower(regexp_replace(full_name, '\\s+', ' ', 'g'))
    HAVING count(*) > 1
  `)).rows as { ids: number[]; name: string }[];
  let merged = 0;
  const out: { survivor: string; duplicates: number[] }[] = [];
  for (const g of groups) {
    const [survivor, ...dups] = g.ids;
    out.push({ survivor: `${g.name} (#${survivor})`, duplicates: dups });
    if (dryRun) continue;
    for (const d of dups) {
      await mergePersons(d, survivor);
      merged++;
    }
  }
  return { merged, groups: out };
}

type OverlapPair = { sourceId: string; source: string; targetId: string; target: string; reason: string };

/**
 * Seed families that are the same family twice: same country and either the
 * same patriarch, or at least three shared members making up 60%+ of the
 * smaller family. The survivor is the family with the fewer-word name (the
 * "Wee family" form over "Wee Ee Cheong family"), then the surname more of
 * the members carry, then the bigger tree.
 * Marriages legitimately link two families through one or two shared people
 * (a daughter and her husband), which is why the bar is three.
 */
async function findOverlappingFamilies(): Promise<OverlapPair[]> {
  const rows = (await db.execute(sql`
    WITH sized AS (
      SELECT f.id, f.name, f.country, f.patriarch_person_id,
             (SELECT count(*)::int FROM family_members m WHERE m.family_id = f.id) AS members
        FROM families f
    ), shared AS (
      SELECT a.id AS a_id, b.id AS b_id,
             (SELECT count(*)::int FROM family_members m1 JOIN family_members m2 ON m1.person_id = m2.person_id
               WHERE m1.family_id = a.id AND m2.family_id = b.id) AS n
        FROM sized a JOIN sized b ON a.id < b.id AND a.country = b.country
    )
    SELECT a.id AS a_id, a.name AS a_name, a.members AS a_members,
           b.id AS b_id, b.name AS b_name, b.members AS b_members,
           (a.patriarch_person_id IS NOT NULL AND a.patriarch_person_id = b.patriarch_person_id) AS same_patriarch,
           s.n AS shared,
           -- How many people across both trees carry each family's surname
           -- (first word of the name): "Tanoto" beats "Ganda" for a tree of Tanotos.
           (SELECT count(*)::int FROM family_members m JOIN people p ON p.id = m.person_id
             WHERE m.family_id IN (a.id, b.id) AND lower(p.full_name) LIKE '%' || lower(split_part(a.name, ' ', 1)) || '%') AS a_hits,
           (SELECT count(*)::int FROM family_members m JOIN people p ON p.id = m.person_id
             WHERE m.family_id IN (a.id, b.id) AND lower(p.full_name) LIKE '%' || lower(split_part(b.name, ' ', 1)) || '%') AS b_hits
      FROM shared s JOIN sized a ON a.id = s.a_id JOIN sized b ON b.id = s.b_id
     WHERE (a.patriarch_person_id IS NOT NULL AND a.patriarch_person_id = b.patriarch_person_id)
        OR (s.n >= 3 AND s.n * 10 >= LEAST(a.members, b.members) * 6)
     ORDER BY a.name, b.name
  `)).rows as {
    a_id: string; a_name: string; a_members: number;
    b_id: string; b_name: string; b_members: number;
    same_patriarch: boolean; shared: number; a_hits: number; b_hits: number;
  }[];
  const words = (name: string) => name.trim().split(/\s+/).length;
  // Survivor: fewer-word name, then the surname more members carry, then the
  // bigger tree, then the shorter string.
  const rank = (name: string, hits: number, members: number) => [-words(name), hits, members, -name.length];
  return rows.map((r) => {
    const ra = rank(r.a_name, r.a_hits, r.a_members);
    const rb = rank(r.b_name, r.b_hits, r.b_members);
    const cmp = ra.findIndex((v, i) => v !== rb[i]);
    const aWins = cmp === -1 || ra[cmp] > rb[cmp];
    return {
      sourceId: aWins ? r.b_id : r.a_id,
      source: aWins ? r.b_name : r.a_name,
      targetId: aWins ? r.a_id : r.b_id,
      target: aWins ? r.a_name : r.b_name,
      reason: r.same_patriarch ? "same patriarch" : `${r.shared} shared members`,
    };
  });
}

/**
 * Merge overlapping seed families (see `findOverlappingFamilies`). Merging
 * one pair can change the others (a three-way overlap collapses to one), so
 * the search reruns after every merge instead of merging a stale list.
 */
export async function mergeOverlappingFamilies(dryRun = false): Promise<DedupeReport["families"]> {
  const strip = (p: OverlapPair) => ({ source: p.source, target: p.target, reason: p.reason });
  if (dryRun) return { merged: 0, pairs: (await findOverlappingFamilies()).map(strip) };
  const pairs: DedupeReport["families"]["pairs"] = [];
  for (let guard = 0; guard < 100; guard++) {
    const [next] = await findOverlappingFamilies();
    if (!next) break;
    await mergeFamilies(next.sourceId, next.targetId);
    pairs.push(strip(next));
  }
  return { merged: pairs.length, pairs };
}

/**
 * Delete seed families that never became a tree: one member (the seeded
 * anchor), no edges, still in the review queue. Used to retire the Vietnam
 * pass-1 noise before reseeding. People rows are kept.
 */
export async function pruneThinFamilies(country: string, dryRun = false): Promise<{ deleted: number; names: string[] }> {
  const rows = (await db.execute(sql`
    SELECT f.id, f.name
      FROM families f
     WHERE f.country = ${country}
       AND f.research_status = 'needs_review'
       AND (SELECT count(*) FROM family_members m WHERE m.family_id = f.id) <= 1
       AND NOT EXISTS (SELECT 1 FROM family_relationships r WHERE r.family_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM person_blocks b JOIN family_members m ON m.person_id = b.person_id WHERE m.family_id = f.id)
     ORDER BY f.name
  `)).rows as { id: string; name: string }[];
  if (!dryRun) {
    for (const r of rows) await deleteFamily(r.id);
    if (rows.length) log(`[families] pruned ${rows.length} one-person seed families in ${country}`, "families");
  }
  return { deleted: dryRun ? 0 : rows.length, names: rows.map((r) => r.name) };
}
