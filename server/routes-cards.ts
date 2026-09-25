/**
 * Business card scanner endpoints.
 *
 * Registered from inside `registerRoutes()` so they inherit the `/api/*` auth
 * middleware. Images arrive as data URLs in the JSON body (the same shape the
 * LLM gateway wants), which is why `express.json` carries a raised limit.
 */

import { randomUUID } from "crypto";
import type { Express } from "express";
import {
  cardCounts,
  cardVCard,
  deleteCard,
  getCard,
  listCards,
  reparseCard,
  saveCard,
  scanCard,
  validateImage,
} from "./card-scanner";
import { vcardFilename } from "./card-normalize";
import { draftFollowUp, listDueFollowUps, runFollowUpDigest, setFollowUp } from "./follow-ups";
import type { ParsedCard } from "./card-normalize";

export function registerCardRoutes(app: Express): void {
  /**
   * Scan one card. `images` is [front] or [front, back]; several separate
   * cards go through /api/cards/scan-batch instead.
   */
  app.post("/api/cards/scan", async (req, res) => {
    try {
      const { images, eventNote } = req.body ?? {};
      if (!Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ error: "images (array of data URLs) is required" });
      }
      const bad = images.map((i: string) => validateImage(i)).find(Boolean);
      if (bad) return res.status(400).json({ error: bad });

      const card = await scanCard({
        images,
        source: "web",
        eventNote: typeof eventNote === "string" ? eventNote : null,
        // Decoded in the browser, where canvas gives the raw pixels. A vCard
        // QR is exact data, so it overrides whatever the model reads.
        qr: req.body?.qr ?? null,
      });
      res.json(card);
    } catch (error) {
      console.error("Error scanning card:", error);
      res.status(500).json({ error: (error as Error).message || "Failed to scan card" });
    }
  });

  /**
   * Scan several cards in one go: each entry is its own card. They share a
   * batchId so the queue can group them. Cards are processed in sequence to
   * stay inside the gateway's rate limits; a failure on one does not stop
   * the rest (it lands as a `failed` row).
   */
  app.post("/api/cards/scan-batch", async (req, res) => {
    try {
      const { cards, eventNote } = req.body ?? {};
      if (!Array.isArray(cards) || cards.length === 0) {
        return res.status(400).json({ error: "cards (array of {images}) is required" });
      }
      if (cards.length > 25) return res.status(400).json({ error: "at most 25 cards per batch" });

      const batchId = randomUUID();
      const results = [];
      for (const entry of cards) {
        const images = Array.isArray(entry?.images) ? entry.images : [entry];
        const bad = images.map((i: string) => validateImage(i)).find(Boolean);
        if (bad) {
          results.push({ error: bad });
          continue;
        }
        try {
          results.push(
            await scanCard({
              images,
              source: "web",
              eventNote: typeof eventNote === "string" ? eventNote : null,
              batchId,
              qr: entry?.qr ?? null,
            }),
          );
        } catch (error) {
          results.push({ error: (error as Error).message });
        }
      }
      res.json({ batchId, cards: results });
    } catch (error) {
      console.error("Error scanning card batch:", error);
      res.status(500).json({ error: "Failed to scan batch" });
    }
  });

  /** The review queue. `?status=parsed|needs_review|failed|saved|all`. */
  app.get("/api/cards", async (req, res) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const [cards, counts] = await Promise.all([listCards(status), cardCounts()]);
      res.json({ cards, counts });
    } catch (error) {
      console.error("Error listing cards:", error);
      res.status(500).json({ error: "Failed to list cards" });
    }
  });

  app.get("/api/cards/:id", async (req, res) => {
    try {
      const card = await getCard(req.params.id);
      if (!card) return res.status(404).json({ error: "Card not found" });
      res.json(card);
    } catch (error) {
      console.error("Error fetching card:", error);
      res.status(500).json({ error: "Failed to fetch card" });
    }
  });

  /** Re-read the stored image, by default on the stronger vision model. */
  app.post("/api/cards/:id/reparse", async (req, res) => {
    try {
      const useFallback = req.body?.model !== "primary";
      res.json(await reparseCard(req.params.id, useFallback));
    } catch (error) {
      console.error("Error re-parsing card:", error);
      res.status(500).json({ error: (error as Error).message || "Failed to re-parse card" });
    }
  });

  /** Save the reviewed card as a Sensei contact. Body carries any edits. */
  app.post("/api/cards/:id/save", async (req, res) => {
    try {
      const { parsed, eventNote, mergeIntoPersonId } = req.body ?? {};
      const edits: Partial<ParsedCard> & { eventNote?: string | null; mergeIntoPersonId?: number | null } = {
        ...(parsed && typeof parsed === "object" ? (parsed as Partial<ParsedCard>) : {}),
        ...(typeof eventNote === "string" ? { eventNote } : {}),
        ...(typeof mergeIntoPersonId === "number" ? { mergeIntoPersonId } : {}),
      };
      res.json(await saveCard(req.params.id, edits));
    } catch (error) {
      console.error("Error saving card:", error);
      res.status(400).json({ error: (error as Error).message || "Failed to save card" });
    }
  });

  app.delete("/api/cards/:id", async (req, res) => {
    try {
      await deleteCard(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      console.error("Error deleting card:", error);
      res.status(500).json({ error: "Failed to delete card" });
    }
  });

  /** Set or clear a follow-up reminder on a person, in days from now. */
  app.post("/api/people/:id/follow-up", async (req, res) => {
    try {
      const personId = parseInt(req.params.id, 10);
      if (!Number.isFinite(personId)) return res.status(400).json({ error: "invalid person id" });
      const days = req.body?.days;
      const remindAt = await setFollowUp(personId, typeof days === "number" ? days : null);
      res.json({ remindAt });
    } catch (error) {
      console.error("Error setting follow-up:", error);
      res.status(500).json({ error: "Failed to set the reminder" });
    }
  });

  /** Draft the follow-up message from what the card and the notes actually say. */
  app.post("/api/people/:id/follow-up-draft", async (req, res) => {
    try {
      const personId = parseInt(req.params.id, 10);
      if (!Number.isFinite(personId)) return res.status(400).json({ error: "invalid person id" });
      const channel = req.body?.channel === "whatsapp" ? "whatsapp" : "email";
      res.json(await draftFollowUp(personId, channel));
    } catch (error) {
      console.error("Error drafting follow-up:", error);
      res.status(500).json({ error: (error as Error).message || "Failed to draft the message" });
    }
  });

  /** Everything due now, for the UI and for a manual digest run. */
  app.get("/api/follow-ups", async (_req, res) => {
    try {
      res.json({ due: await listDueFollowUps() });
    } catch (error) {
      console.error("Error listing follow-ups:", error);
      res.status(500).json({ error: "Failed to list follow-ups" });
    }
  });

  app.post("/api/follow-ups/digest", async (_req, res) => {
    try {
      res.json(await runFollowUpDigest("manual"));
    } catch (error) {
      console.error("Error sending follow-up digest:", error);
      res.status(500).json({ error: "Failed to send the digest" });
    }
  });

  /**
   * The contact as a .vcf the phone can import.
   *
   * Served INLINE by default: on iOS, `attachment` drops the file into Files
   * and the contact never reaches the address book without three more taps,
   * whereas an inline text/vcard makes Safari offer "Add to Contacts"
   * directly. `?download=1` forces the attachment form for desktop.
   */
  app.get("/api/cards/:id/vcard", async (req, res) => {
    try {
      const result = await cardVCard(req.params.id);
      if (!result) return res.status(404).json({ error: "Card not found or not parsed yet" });
      const asAttachment = req.query.download === "1";
      res.setHeader("Content-Type", "text/vcard; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `${asAttachment ? "attachment" : "inline"}; filename="${vcardFilename(result.parsed)}"`,
      );
      res.send(result.vcf);
    } catch (error) {
      console.error("Error building vCard:", error);
      res.status(500).json({ error: "Failed to build vCard" });
    }
  });
}
