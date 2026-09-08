/**
 * Person endpoints: the lead↔person bridge.
 *
 * `/api/people/lookup` is what the dashboard calls once per page of leads to
 * decide which chips (family / notes / seen N×) belong next to a founder name.
 * `/api/people/:id/profile` backs the person page — one stacked history of
 * every mention, deal, family link and note for a person.
 *
 * Registered from inside `registerRoutes()` so these inherit the `/api/*` auth
 * middleware.
 */

import type { Express } from "express";
import {
  getPersonProfile,
  lookupPeopleByNames,
  updateContactMeta,
} from "./contacts";

/** Parse a positive integer path param; NaN/negatives are rejected upstream. */
function parsePersonId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function registerPeopleRoutes(app: Express): void {
  /**
   * GET /api/people/lookup?names=a,b,c
   *
   * Batch name → person resolution for the lead feed. Names are matched against
   * `people.full_name` and aliases, case-insensitively. Unknown names are
   * omitted rather than returned as nulls, so the response stays small.
   */
  app.get("/api/people/lookup", async (req, res) => {
    try {
      const raw = typeof req.query.names === "string" ? req.query.names : "";
      const names = raw.split(",").map((n) => n.trim()).filter(Boolean);
      if (names.length === 0) return res.json([]);
      // Names change only when the visible page changes, and the underlying
      // rows move slowly — a short cache keeps rapid paging off the database.
      res.set("Cache-Control", "private, max-age=60");
      res.json(await lookupPeopleByNames(names));
    } catch (error) {
      console.error("Error looking up people by name:", error);
      res.status(500).json({ message: "Failed to look up people" });
    }
  });

  /** GET /api/people/:id/profile — header, family links, block, timeline. */
  app.get("/api/people/:id/profile", async (req, res) => {
    try {
      const personId = parsePersonId(req.params.id);
      if (personId === null) return res.status(400).json({ message: "Invalid person id" });
      const profile = await getPersonProfile(personId);
      if (!profile) return res.status(404).json({ message: "Person not found" });
      res.json(profile);
    } catch (error) {
      console.error("Error building person profile:", error);
      res.status(500).json({ message: "Failed to load person" });
    }
  });

  /**
   * PATCH /api/people/:id/notes — private notes for a person.
   *
   * Writes the same `contact_meta.notes` column the Contacts page uses, so a
   * note taken here shows up there and vice versa.
   */
  app.patch("/api/people/:id/notes", async (req, res) => {
    try {
      const personId = parsePersonId(req.params.id);
      if (personId === null) return res.status(400).json({ message: "Invalid person id" });
      const { notes } = req.body ?? {};
      if (typeof notes !== "string") return res.status(400).json({ message: "notes must be a string" });
      res.json(await updateContactMeta(personId, { notes }));
    } catch (error) {
      console.error("Error saving person notes:", error);
      res.status(500).json({ message: "Failed to save notes" });
    }
  });
}
