/**
 * Follow-up reminders and drafted messages.
 *
 * The 48 hours after meeting someone is where most of these leads die. A
 * scanned card already records who they are and where you met them, so the
 * only missing pieces were a nudge at the right time and a first draft of the
 * message, which is the part people put off.
 *
 * `contact_meta.remind_at` already existed but nothing ever fired on it.
 */

import cron, { type ScheduledTask } from "node-cron";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { log } from "./log";
import { callJsonStage } from "./llm-json";
import { sendTelegramMessage } from "./telegram";
import { escapeHtml, getAppBaseUrl } from "./telegram-formatter";
import { storage } from "./storage";

const MODEL = process.env.FOLLOWUP_MODEL || "anthropic/claude-sonnet-4";
/** 09:00 SGT = 01:00 UTC. Same slot as the existing daily digest. */
const CRON = process.env.FOLLOWUP_CRON || "0 1 * * *";
const ENABLED = process.env.FOLLOWUP_ENABLED !== "false";

let task: ScheduledTask | null = null;

export interface DueContact {
  personId: number;
  fullName: string;
  company: string | null;
  jobTitle: string | null;
  notes: string | null;
  email: string | null;
  phoneMobile: string | null;
  remindAt: string;
}

/** Contacts whose reminder has come due and who are not muted or deleted. */
export async function listDueFollowUps(limit = 20): Promise<DueContact[]> {
  return (await db.execute(sql`
    SELECT cm.person_id AS "personId",
           p.full_name   AS "fullName",
           cm.company_name AS "company",
           cm.job_title  AS "jobTitle",
           cm.notes,
           cm.email,
           cm.phone_mobile AS "phoneMobile",
           cm.remind_at   AS "remindAt"
      FROM contact_meta cm
      JOIN people p ON p.id = cm.person_id
     WHERE cm.remind_at IS NOT NULL
       AND cm.remind_at <= now()
       AND cm.status NOT IN ('deleted', 'muted')
       AND p.merged_into_id IS NULL
     ORDER BY cm.remind_at ASC
     LIMIT ${limit}
  `)).rows as unknown as DueContact[];
}

/** Set or clear a follow-up reminder. `days` of 0 or null clears it. */
export async function setFollowUp(personId: number, days: number | null): Promise<string | null> {
  if (!days || days <= 0) {
    await db.execute(sql`UPDATE contact_meta SET remind_at = NULL, updated_at = now() WHERE person_id = ${personId}`);
    return null;
  }
  const rows = (await db.execute(sql`
    UPDATE contact_meta
       SET remind_at = now() + (${days} || ' days')::interval, updated_at = now()
     WHERE person_id = ${personId}
    RETURNING remind_at AS "remindAt"
  `)).rows as { remindAt: string }[];
  return rows[0]?.remindAt ?? null;
}

export interface FollowUpDraft {
  subject: string;
  message: string;
  channel: "email" | "whatsapp";
}

/**
 * A first draft of the follow-up, written from what the card and the notes
 * actually say. The prompt is deliberately strict about inventing detail: a
 * banker sending a warm note that references a conversation that never
 * happened is worse than sending nothing.
 */
export async function draftFollowUp(
  personId: number,
  channel: "email" | "whatsapp" = "email",
): Promise<FollowUpDraft> {
  const [row] = (await db.execute(sql`
    SELECT p.full_name AS "fullName",
           cm.job_title AS "jobTitle",
           cm.company_name AS "company",
           cm.notes,
           cm.honorific,
           (SELECT string_agg(c.name, ', ') FROM people_companies pc JOIN companies c ON c.id = pc.company_id WHERE pc.person_id = p.id) AS companies
      FROM people p
      LEFT JOIN contact_meta cm ON cm.person_id = p.id
     WHERE p.id = ${personId}
  `)).rows as {
    fullName: string; jobTitle: string | null; company: string | null;
    notes: string | null; honorific: string | null; companies: string | null;
  }[];
  if (!row) throw new Error("person not found");

  const address = [row.honorific, row.fullName].filter(Boolean).join(" ");
  const prompt = `Draft a short follow-up message from a Singapore private banker to someone whose business card he scanned.

Who they are:
- Name: ${address}
- Title: ${row.jobTitle ?? "unknown"}
- Company: ${row.company ?? row.companies ?? "unknown"}
- Where/when they met and any notes: ${row.notes ?? "not recorded"}

Channel: ${channel === "whatsapp" ? "WhatsApp — very short, no subject line, no formal sign-off" : "email — a subject line and a short body"}

Return ONLY JSON: {"subject": "...", "message": "..."}
${channel === "whatsapp" ? 'Use an empty string for "subject".' : ""}

Rules:
- Reference ONLY what the notes actually say. If the notes do not record what was discussed, keep it to having met and a simple next step. NEVER invent a conversation, a shared contact, or a detail about their business.
- Use the honorific if one is given — addressing a Malaysian Tan Sri or a Thai Khun without it is a mistake.
- No flattery, no "I hope this email finds you well", no pitch. One clear, low-pressure next step (a coffee, a call).
- ${channel === "whatsapp" ? "Under 45 words." : "Under 110 words."}
- Sign off as the banker without inventing a name: end the body before any signature.`;

  const out = await callJsonStage<{ subject?: string; message?: string }>({
    model: MODEL,
    prompt,
    maxTokens: 700,
    temperature: 0.4,
    label: "FollowUpDraft",
  });

  return {
    subject: (out.subject ?? "").trim(),
    message: (out.message ?? "").trim(),
    channel,
  };
}

/** Telegram digest of everything due. Clears nothing — a nudge is not a done. */
export async function runFollowUpDigest(reason = "cron"): Promise<{ sent: boolean; due: number }> {
  const due = await listDueFollowUps();
  if (due.length === 0) {
    log(`[follow-ups] nothing due (${reason})`, "followups");
    return { sent: false, due: 0 };
  }

  const base = getAppBaseUrl();
  const lines = [`⏰ <b>${due.length} follow-up${due.length === 1 ? "" : "s"} due</b>`, ""];
  for (const c of due) {
    const who = [c.jobTitle, c.company].filter(Boolean).join(", ");
    const link = base ? `<a href="${base}/people/${c.personId}">${escapeHtml(c.fullName)}</a>` : `<b>${escapeHtml(c.fullName)}</b>`;
    lines.push(`• ${link}${who ? ` — ${escapeHtml(who)}` : ""}`);
    // The "where we met" note is the reason this reminder is worth anything.
    if (c.notes) lines.push(`   <i>${escapeHtml(c.notes.split("\n")[0].slice(0, 140))}</i>`);
  }
  lines.push("", "<i>Open a person to draft the message or push the reminder back.</i>");

  // The chat lives in settings like every other Telegram feature, not in an
  // env var — reading it from the environment silently sent nothing.
  const settings = await storage.getSettings();
  const chatId = settings?.telegramChatId;
  if (!settings?.telegramEnabled || !chatId) {
    log("[follow-ups] Telegram not configured in settings — digest not sent", "followups");
    return { sent: false, due: due.length };
  }
  await sendTelegramMessage(chatId, lines.join("\n"), "HTML", undefined, settings.telegramTopicId ?? undefined);
  log(`[follow-ups] digest sent: ${due.length} due (${reason})`, "followups");
  return { sent: true, due: due.length };
}

export function startFollowUps(): void {
  stopFollowUps();
  if (!ENABLED) {
    console.log("Follow-up reminders disabled (FOLLOWUP_ENABLED=false)");
    return;
  }
  task = cron.schedule(CRON, () => { void runFollowUpDigest("cron"); });
  console.log(`Follow-up reminders started (cron "${CRON}")`);
}

export function stopFollowUps(): void {
  if (task) { task.stop(); task = null; }
}
