/**
 * Job-change watch on saved contacts.
 *
 * This is the one feature Sansan and Eight are genuinely loved for, and for a
 * private banker it is not trivia: a founder who sells, steps down, or moves
 * to a new venture has almost always just had a liquidity event. Knowing
 * within a week is the difference between a warm call and reading about it.
 *
 * Deliberately slow and cheap: a handful of contacts a day, drawn from the
 * background search budget, longest-unchecked first. Nothing is written to a
 * contact automatically — a detected change is reported for Billy to confirm,
 * because a wrong "congratulations on the new role" is worse than silence.
 */

import cron, { type ScheduledTask } from "node-cron";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { log } from "./log";
import { callJsonStage } from "./llm-json";
import { searchWeb } from "./web-search";
import { storage } from "./storage";
import { sendTelegramMessage } from "./telegram";
import { escapeHtml, getAppBaseUrl } from "./telegram-formatter";

const MODEL = process.env.JOB_CHANGE_MODEL || "google/gemini-2.5-flash";
/** 08:40 SGT = 00:40 UTC, before the follow-up digest. */
const CRON = process.env.JOB_CHANGE_CRON || "40 0 * * *";
const ENABLED = process.env.JOB_CHANGE_ENABLED !== "false";
const PER_RUN = parseInt(process.env.JOB_CHANGE_PER_RUN || "8", 10);
/** Don't re-check the same person more often than this. */
const RECHECK_DAYS = parseInt(process.env.JOB_CHANGE_RECHECK_DAYS || "30", 10);

let task: ScheduledTask | null = null;
let running = false;

export interface WatchedContact {
  personId: number;
  fullName: string;
  jobTitle: string | null;
  company: string | null;
  lastCheckedAt: string | null;
}

export interface JobChangeFinding {
  personId: number;
  fullName: string;
  changed: boolean;
  /** What we hold now. */
  knownRole: string | null;
  /** What the sources say, when that differs. */
  newRole: string | null;
  newCompany: string | null;
  /** Why this matters to a banker, in one line. */
  wealthAngle: string | null;
  confidence: "high" | "medium" | "low";
  sourceUrl: string | null;
}

/**
 * Saved contacts worth watching: someone whose role we actually know, checked
 * longest ago (or never). A contact with no company is skipped — there would
 * be nothing to compare against and the search would be noise.
 */
export async function listWatchedContacts(limit = PER_RUN): Promise<WatchedContact[]> {
  return (await db.execute(sql`
    SELECT cm.person_id AS "personId",
           p.full_name   AS "fullName",
           cm.job_title  AS "jobTitle",
           cm.company_name AS "company",
           cm.job_checked_at AS "lastCheckedAt"
      FROM contact_meta cm
      JOIN people p ON p.id = cm.person_id
     WHERE cm.status = 'saved'
       AND p.merged_into_id IS NULL
       AND cm.company_name IS NOT NULL
       AND (cm.job_checked_at IS NULL OR cm.job_checked_at < now() - (${RECHECK_DAYS} || ' days')::interval)
       AND NOT EXISTS (SELECT 1 FROM person_blocks pb WHERE pb.person_id = cm.person_id)
     ORDER BY cm.job_checked_at ASC NULLS FIRST, cm.updated_at DESC
     LIMIT ${limit}
  `)).rows as unknown as WatchedContact[];
}

/**
 * Ask the web whether this person's role has moved. Returns `changed: false`
 * whenever the sources do not clearly say otherwise — the default has to be
 * "no news", because a false positive costs a relationship.
 */
export async function checkOneContact(contact: WatchedContact): Promise<JobChangeFinding> {
  const known = [contact.jobTitle, contact.company].filter(Boolean).join(", ") || contact.company || "";
  const unchanged: JobChangeFinding = {
    personId: contact.personId,
    fullName: contact.fullName,
    changed: false,
    knownRole: known || null,
    newRole: null,
    newCompany: null,
    wealthAngle: null,
    confidence: "low",
    sourceUrl: null,
  };

  const res = await searchWeb(`"${contact.fullName}" ${contact.company ?? ""} appointed OR "steps down" OR "new role" OR resigns OR joins`, {
    maxResults: 6,
    includeAnswer: false,
    priority: "background",
  });
  const results = res?.results ?? [];
  if (results.length === 0) return unchanged;

  const context = results
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${(r.content || "").slice(0, 700)}`)
    .join("\n\n");

  const prompt = `A private banker holds this contact:
- Name: ${contact.fullName}
- Role on file: ${known || "unknown"}

Below are recent search results about them. Decide whether their ROLE OR EMPLOYER has actually changed since the role on file.

${context}

Return ONLY JSON:
{"changed": true|false, "newRole": "their current title, or null", "newCompany": "their current employer, or null", "wealthAngle": "one line on why this matters to a private banker (a sale, an exit, a step down, a new venture), or null", "confidence": "high|medium|low", "sourceUrl": "the URL that supports this, or null"}

Rules:
- Default to {"changed": false}. Only say true when a source plainly states a NEW role or employer that differs from the role on file.
- A profile page repeating the role on file is NOT a change. Neither is an article that merely mentions them.
- Someone else with the same name is NOT a change — check the company and context match.
- Never infer a change from a job title being worded differently ("CEO" vs "Chief Executive Officer").
- confidence "high" only when a named, dated source states it.`;

  try {
    const out = await callJsonStage<Partial<JobChangeFinding>>({
      model: MODEL,
      prompt,
      maxTokens: 500,
      temperature: 0,
      label: "JobChange",
      timeoutMs: 60_000,
    });
    return {
      ...unchanged,
      changed: out.changed === true,
      newRole: out.newRole ?? null,
      newCompany: out.newCompany ?? null,
      wealthAngle: out.wealthAngle ?? null,
      confidence: (out.confidence as JobChangeFinding["confidence"]) ?? "low",
      sourceUrl: out.sourceUrl ?? null,
    };
  } catch (error) {
    log(`[job-changes] check failed for ${contact.fullName}: ${(error as Error).message}`, "jobchanges");
    return unchanged;
  }
}

/** Stamp the check so the same person is not re-searched tomorrow. */
async function markChecked(personId: number): Promise<void> {
  await db.execute(sql`UPDATE contact_meta SET job_checked_at = now() WHERE person_id = ${personId}`);
}

/**
 * One pass over the queue. Findings are reported, never written to the
 * contact: the banker confirms, because acting on a wrong change is worse
 * than missing a right one.
 */
export async function runJobChangeCheck(reason = "cron"): Promise<{ checked: number; found: JobChangeFinding[] }> {
  if (running) return { checked: 0, found: [] };
  running = true;
  try {
    const contacts = await listWatchedContacts();
    if (contacts.length === 0) {
      log(`[job-changes] nobody due (${reason})`, "jobchanges");
      return { checked: 0, found: [] };
    }

    const found: JobChangeFinding[] = [];
    for (const contact of contacts) {
      const finding = await checkOneContact(contact);
      await markChecked(contact.personId);
      // Low confidence is noise; a banker gets one shot at "congratulations".
      if (finding.changed && finding.confidence !== "low") found.push(finding);
    }

    if (found.length > 0) await notifyJobChanges(found);
    log(`[job-changes] checked ${contacts.length}, ${found.length} change(s) worth reporting (${reason})`, "jobchanges");
    return { checked: contacts.length, found };
  } finally {
    running = false;
  }
}

async function notifyJobChanges(found: JobChangeFinding[]): Promise<boolean> {
  const settings = await storage.getSettings();
  const chatId = settings?.telegramChatId;
  if (!settings?.telegramEnabled || !chatId) return false;

  const base = getAppBaseUrl();
  const lines = [`💼 <b>${found.length} contact${found.length === 1 ? " has" : "s have"} moved</b>`, ""];
  for (const f of found) {
    const link = base ? `<a href="${base}/people/${f.personId}">${escapeHtml(f.fullName)}</a>` : `<b>${escapeHtml(f.fullName)}</b>`;
    lines.push(`• ${link}`);
    lines.push(`   was: ${escapeHtml(f.knownRole ?? "unknown")}`);
    lines.push(`   now: ${escapeHtml([f.newRole, f.newCompany].filter(Boolean).join(", ") || "changed")}`);
    if (f.wealthAngle) lines.push(`   <i>${escapeHtml(f.wealthAngle)}</i>`);
    if (f.sourceUrl) lines.push(`   <a href="${escapeHtml(f.sourceUrl)}">source</a>`);
  }
  lines.push("", "<i>Not applied automatically — open the contact to confirm and update.</i>");
  await sendTelegramMessage(chatId, lines.join("\n"), "HTML", undefined, settings.telegramTopicId ?? undefined);
  return true;
}

export function startJobChanges(): void {
  stopJobChanges();
  if (!ENABLED) {
    console.log("Job-change watch disabled (JOB_CHANGE_ENABLED=false)");
    return;
  }
  task = cron.schedule(CRON, () => { void runJobChangeCheck("cron"); });
  console.log(`Job-change watch started (cron "${CRON}", ${PER_RUN}/day, re-check every ${RECHECK_DAYS}d)`);
}

export function stopJobChanges(): void {
  if (task) { task.stop(); task = null; }
}
