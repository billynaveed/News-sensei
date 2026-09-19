/**
 * Family review-queue endpoints.
 *
 * The original /api/families* CRUD lives in routes.ts; this module adds what
 * the review queue needs (approve, bulk approve, merge duplicates) plus the
 * maintenance actions (dedupe, requeue a full pass, reseed a market).
 * Registered from inside `registerRoutes()` so these inherit the `/api/*`
 * auth middleware.
 */

import type { Express } from "express";
import {
  approveFamily,
  approveReviewedFamilies,
  dedupeExactNamePeople,
  mergeFamilies,
  mergeOverlappingFamilies,
  mergePersons,
  pruneThinFamilies,
  type DedupeReport,
} from "./families";
import { requeueAllFamilies, seedFamilies } from "./family-research";

/** Narrow an unknown body value to a non-empty id string. */
function asId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function registerFamilyRoutes(app: Express): void {
  /** Accept the researcher's tree: needs_review | failed → done. */
  app.post("/api/families/:id/approve", async (req, res) => {
    try {
      const changed = await approveFamily(req.params.id);
      if (!changed) return res.status(404).json({ message: "Family not found or already approved" });
      res.json({ ok: true });
    } catch (error) {
      console.error("Error approving family:", error);
      res.status(500).json({ message: "Failed to approve family" });
    }
  });

  /**
   * Clear the safe majority of the queue in one go. Defaults to Billy's rule:
   * at least 3 members and confidence medium or better.
   */
  app.post("/api/families/review/approve-all", async (req, res) => {
    try {
      const { minMembers, minConfidence } = req.body ?? {};
      const members = typeof minMembers === "number" && minMembers >= 1 ? Math.floor(minMembers) : 3;
      const level = minConfidence === "high" ? "high" : "medium";
      res.json(await approveReviewedFamilies(members, level));
    } catch (error) {
      console.error("Error bulk-approving families:", error);
      res.status(500).json({ message: "Failed to bulk-approve families" });
    }
  });

  /**
   * Fold a duplicate family into another ("Kwek Leng Beng family" →
   * "Kwek family"). Members and edges move; the source family is deleted.
   */
  app.post("/api/families/:id/merge", async (req, res) => {
    try {
      const targetId = asId(req.body?.targetId);
      if (!targetId) return res.status(400).json({ message: "targetId required" });
      if (targetId === req.params.id) return res.status(400).json({ message: "Cannot merge a family into itself" });
      res.json(await mergeFamilies(req.params.id, targetId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to merge families";
      console.error("Error merging families:", error);
      res.status(/not found|itself/i.test(message) ? 400 : 500).json({ message });
    }
  });

  /**
   * Fold a duplicate person into another ("Leng Beng Kwek" → "Kwek Leng Beng").
   * The duplicate is tombstoned via people.merged_into_id, not deleted.
   */
  app.post("/api/persons/:personId/merge", async (req, res) => {
    try {
      const sourcePersonId = parseInt(req.params.personId, 10);
      const targetPersonId = typeof req.body?.targetPersonId === "number" ? req.body.targetPersonId : NaN;
      if (!Number.isFinite(sourcePersonId)) return res.status(400).json({ message: "invalid personId" });
      if (!Number.isFinite(targetPersonId)) return res.status(400).json({ message: "targetPersonId required" });
      res.json(await mergePersons(sourcePersonId, targetPersonId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to merge people";
      console.error("Error merging people:", error);
      res.status(/not found|themselves|already been merged/i.test(message) ? 400 : 500).json({ message });
    }
  });

  /** Start a new research pass over every agent-built family (trees are extended, never cleared). */
  app.post("/api/families/research/requeue-all", async (_req, res) => {
    try {
      res.json({ requeued: await requeueAllFamilies() });
    } catch (error) {
      console.error("Error requeueing all families:", error);
      res.status(500).json({ error: "Failed to requeue families" });
    }
  });

  /** Seed one market again (e.g. ?market=VN after pruning its noise). */
  app.post("/api/families/research/seed/:market", async (req, res) => {
    try {
      res.json(await seedFamilies(req.params.market));
    } catch (error) {
      console.error("Error seeding market:", error);
      res.status(500).json({ error: (error as Error).message || "Failed to seed market" });
    }
  });

  /**
   * Fold exact-name duplicate people and overlapping seed families.
   * `?dryRun=1` only reports what would change.
   */
  app.post("/api/families/maintenance/dedupe", async (req, res) => {
    try {
      const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
      const report: DedupeReport = {
        dryRun,
        people: await dedupeExactNamePeople(dryRun),
        families: await mergeOverlappingFamilies(dryRun),
      };
      res.json(report);
    } catch (error) {
      console.error("Error deduping families:", error);
      res.status(500).json({ error: "Failed to dedupe" });
    }
  });

  /** Delete one-person, edge-less, still-in-review seed families of a country. */
  app.post("/api/families/maintenance/prune/:country", async (req, res) => {
    try {
      const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
      res.json(await pruneThinFamilies(req.params.country, dryRun));
    } catch (error) {
      console.error("Error pruning families:", error);
      res.status(500).json({ error: "Failed to prune families" });
    }
  });
}
