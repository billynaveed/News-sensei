import { storage } from "./storage";

/**
 * Builds a "reject things like these" block from recent user-flagged bad leads,
 * to append to a scan filter prompt. This is the auto-improving loop: each
 * thumbs-down teaches the next scan. Bounded to the most recent N so the prompt
 * stays small. Returns "" when there's no feedback yet.
 */
export async function buildNegativeExamplesBlock(category: string | null, limit = 15): Promise<string> {
  let bad;
  try {
    bad = await storage.getRecentBadFeedback(category, limit);
  } catch {
    return ""; // never let the feedback loop break a scan
  }
  if (!bad || bad.length === 0) return "";

  const lines = bad.map((f) => {
    const who = [...(f.founderNames ?? []), ...(f.companyNames ?? [])]
      .filter(Boolean)
      .join(", ");
    const subject = (f.headline || who || "(unnamed)").slice(0, 120);
    const reason = f.reason || "not relevant";
    const note = f.note ? `: ${f.note.slice(0, 80)}` : "";
    return `- "${subject}" — REJECT (${reason}${note})`;
  });

  return (
    `\n\nUSER-FLAGGED FALSE POSITIVES — reject articles that look like these ` +
    `(a banker marked them not relevant for the stated reason):\n${lines.join("\n")}`
  );
}
