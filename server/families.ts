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

export async function listFamilies(search?: string, country?: string) {
  const searchCond = search ? sql`AND f.name ILIKE ${"%" + search + "%"}` : sql``;
  const countryCond = country ? sql`AND f.country = ${country}` : sql``;
  const result = await db.execute(sql`
    SELECT f.*,
           f.net_worth_estimate AS "netWorthEstimate",
           f.research_status    AS "researchStatus",
           f.primary_companies  AS "primaryCompanies",
           (SELECT count(*)::int FROM family_members fm WHERE fm.family_id = f.id) AS "memberCount",
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
  const person = await upsertPersonByName(name, { source: "family-manual" });
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
