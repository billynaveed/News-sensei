/**
 * Family review-queue endpoints.
 *
 * The original /api/families* CRUD lives in routes.ts; this module adds what
 * the review queue needs (approve, bulk approve, merge duplicates). Registered
 * from inside `registerRoutes()` so these inherit the `/api/*` auth middleware.
 */

import type { Express } from "express";
import { approveFamily, approveReviewedFamilies, mergeFamilies, mergePersons } from "./families";

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
}
