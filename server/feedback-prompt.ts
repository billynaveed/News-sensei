import { storage } from "./storage";
import { getPositiveExamples } from "./pipeline-examples";

/**
 * Builds a "reject things like these" block from recent user-flagged bad leads,
 * to append to a scan filter prompt. This is the auto-improving loop: each
 * thumbs-down teaches the next scan. Bounded to the most recent N so the prompt
 * stays small. Returns "" when there's no feedback yet.
 */
async function negativeBlock(category: string | null, limit = 15): Promise<string> {
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

/**
 * "Pass things like these": articles the banker flagged as wrongly rejected
 * (pipeline_examples, expected=pass) plus the most recently saved leads. The
 * other half of the learning loop — misses teach the next scan too.
 */
export async function buildPositiveExamplesBlock(limit = 10): Promise<string> {
  const lines: string[] = [];
  try {
    for (const ex of await getPositiveExamples(limit)) {
      lines.push(`- "${ex.headline.slice(0, 120)}" — PASS${ex.note ? ` (${ex.note.slice(0, 100)})` : ""}`);
    }
  } catch { /* table may not exist yet; never break a scan */ }
  try {
    const saved = await storage.getAllSavedLeads();
    for (const sl of (saved ?? []).slice(0, 5)) {
      const headline = sl.lead?.headline;
      if (headline && !lines.some((l) => l.includes(headline.slice(0, 60)))) lines.push(`- "${String(headline).slice(0, 120)}" — PASS (banker saved this lead)`);
    }
  } catch { /* optional */ }
  if (lines.length === 0) return "";
  return (
    `\n\nBANKER-CONFIRMED RELEVANT — articles like these MUST pass ` +
    `(the banker flagged them as leads he wants; when in doubt about geography for a similar company, pass):\n${lines.join("\n")}`
  );
}

/** Both halves of the loop, for prompts that take one block. */
export async function buildLearningBlock(category: string | null): Promise<string> {
  const [neg, pos] = await Promise.all([negativeBlock(category), buildPositiveExamplesBlock()]);
  return neg + pos;
}

/** Kept under the original name: callers get negatives AND positives. */
export const buildNegativeExamplesBlock = buildLearningBlock;
