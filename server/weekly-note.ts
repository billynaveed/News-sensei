/**
 * Weekly "what I learned" note.
 *
 * Every Sunday evening Sensei writes Billy one message summarising the week it
 * just had: what it found, what he did with it, what he taught it, and what
 * that teaching actually changed about how it judges an article. It is the
 * counterpart to the daily digest — the digest says whether the machine is
 * running, this says whether it is getting better.
 *
 * Deliberately LLM-free. Every number comes from SQL or an in-process counter,
 * so the note costs nothing, cannot hallucinate a statistic, and still reads
 * like prose. Where a number is only available for today rather than the week
 * (the scraper and search counters reset daily), the note says "today" rather
 * than implying a weekly figure.
 *
 * Not wired into index.ts here — {@link startWeeklyNote} is exported for the
 * server bootstrap to call.
 */

import cron, { type ScheduledTask } from "node-cron";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { contactMeta, leads, pipelineExamples, savedLeads } from "@shared/schema";
import { db } from "./db";
import { log } from "./log";
import { storage } from "./storage";
import { sendTelegramMessage } from "./telegram";
import { debugPageLink, escapeHtml, splitLongMessage } from "./telegram-formatter";
import { getExamplesSummary } from "./pipeline-examples";
import { getScraperStatus } from "./scraper";
import { getSearchStatus } from "./web-search";
import { getResearchProgress } from "./family-research";

/** Sunday 18:00, Billy's time. */
const NOTE_CRON = process.env.WEEKLY_NOTE_CRON || "0 18 * * 0";
const NOTE_TIMEZONE = "Asia/Singapore";
const ENABLED = process.env.WEEKLY_NOTE_ENABLED !== "false";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Rejection reasons shown, this week against last. */
const TOP_REJECTIONS = 5;
/** Stage reasons run long ("S4a Already have 1 lead(s) about X from past 7 days"). */
const MAX_REASON_CHARS = 60;
/** "What changed in how I judge" lines — three is a note, ten is a report. */
const MAX_JUDGEMENT_LINES = 3;
/** A pattern needs at least this many examples before it counts as a lesson. */
const MIN_LESSON_SIZE = 2;

let noteTask: ScheduledTask | null = null;
let lastSentAt: string | null = null;

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

interface TaughtExample {
  url: string;
  headline: string;
  expected: string;
  note: string | null;
}

interface RejectionDelta {
  reason: string;
  thisWeek: number;
  lastWeek: number;
}

interface RejectionReport {
  rows: RejectionDelta[];
  /**
   * False when scan_logs no longer reaches back into the previous week (they
   * are pruned on `logRetentionDays`, which defaults to 2). Every reason would
   * otherwise be reported as brand new, which is worse than saying nothing.
   */
  comparable: boolean;
}

interface WeeklyData {
  weekStart: Date;
  leadsByPriority: { level: string; count: number }[];
  totalLeads: number;
  saved: number;
  dismissed: number;
  muted: number;
  taught: TaughtExample[];
  examples: Awaited<ReturnType<typeof getExamplesSummary>> | null;
  rejections: RejectionReport;
  scraper: Awaited<ReturnType<typeof getScraperStatus>> | null;
  search: ReturnType<typeof getSearchStatus> | null;
  families: Awaited<ReturnType<typeof getResearchProgress>> | null;
}

/** Leads created in the window, bucketed by priority band. */
async function collectLeadCounts(weekStart: Date) {
  const rows = await db
    .select({ level: leads.priorityLevel, count: sql<number>`count(*)::int` })
    .from(leads)
    .where(gte(leads.createdAt, weekStart))
    .groupBy(leads.priorityLevel);
  return rows.map((r) => ({ level: r.level ?? "unknown", count: r.count }));
}

/**
 * What Billy did with the week's leads.
 *
 * `saved` is exact (saved_leads_v2 carries its own timestamp). `dismissed`
 * counts leads *created* this week that now sit dismissed — leads_v2 has no
 * status-change timestamp, so a lead dismissed today but found last month is
 * not counted. The note words it accordingly.
 */
async function collectActions(weekStart: Date) {
  const [savedRows, dismissedRows, mutedRows] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(savedLeads).where(gte(savedLeads.savedAt, weekStart)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(leads)
      .where(and(gte(leads.createdAt, weekStart), eq(leads.status, "dismissed"))),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(contactMeta)
      .where(and(gte(contactMeta.updatedAt, weekStart), eq(contactMeta.status, "muted"))),
  ]);

  return {
    saved: savedRows[0]?.count ?? 0,
    dismissed: dismissedRows[0]?.count ?? 0,
    muted: mutedRows[0]?.count ?? 0,
  };
}

/** Reference examples added in the window — the raw material for the lessons. */
async function collectTaught(weekStart: Date): Promise<TaughtExample[]> {
  const rows = await db
    .select({
      url: pipelineExamples.url,
      headline: pipelineExamples.headline,
      expected: pipelineExamples.expected,
      note: pipelineExamples.note,
    })
    .from(pipelineExamples)
    .where(gte(pipelineExamples.createdAt, weekStart))
    .limit(200);
  return rows;
}

/**
 * Top rejection reasons this week with last week's count alongside.
 *
 * Reasons look like "prefilter: no wealth signal", so the prefix before the
 * colon is the bucket — same grouping the daily digest uses, so the two
 * messages never disagree.
 */
async function collectRejections(weekStart: Date, previousStart: Date): Promise<RejectionReport> {
  const [result, coverage] = await Promise.all([
    db.execute(sql`
      SELECT split_part(elem->>'reason', ':', 1) AS reason,
             count(*) FILTER (WHERE scan_logs.scanned_at >= ${weekStart})::int AS this_week,
             count(*) FILTER (WHERE scan_logs.scanned_at < ${weekStart})::int AS last_week
      FROM scan_logs, json_array_elements(scan_logs.articles_processed) AS elem
      WHERE scan_logs.scanned_at >= ${previousStart}
        AND elem->>'reason' IS NOT NULL
        AND coalesce(elem->>'status', '') <> 'success'
        AND elem->>'reason' NOT LIKE 'URL already scanned%'
        AND elem->>'reason' NOT LIKE 'Duplicate - URL%'
      GROUP BY 1
      ORDER BY this_week DESC
      LIMIT ${TOP_REJECTIONS}
    `),
    db.execute(sql`SELECT min(scanned_at) AS oldest FROM scan_logs`),
  ]);

  const oldest = (coverage.rows[0] as { oldest: string | Date | null } | undefined)?.oldest ?? null;
  const oldestAt = oldest ? new Date(oldest) : null;

  return {
    rows: (result.rows as { reason: string; this_week: number; last_week: number }[]).map((r) => ({
      reason: (r.reason || "(unlabelled)").slice(0, MAX_REASON_CHARS),
      thisWeek: Number(r.this_week),
      lastWeek: Number(r.last_week),
    })),
    comparable: oldestAt !== null && oldestAt < weekStart,
  };
}

/**
 * Gathers everything the note needs.
 *
 * Each source is individually fault-tolerant: a missing table or a dead
 * scraper API costs one section, never the whole note.
 */
async function collectWeeklyData(now = new Date()): Promise<WeeklyData> {
  const weekStart = new Date(now.getTime() - WEEK_MS);
  const previousStart = new Date(now.getTime() - 2 * WEEK_MS);

  const [leadsByPriority, actions, taught, examples, rejections, scraper, search, families] = await Promise.all([
    collectLeadCounts(weekStart).catch(() => []),
    collectActions(weekStart).catch(() => ({ saved: 0, dismissed: 0, muted: 0 })),
    collectTaught(weekStart).catch(() => [] as TaughtExample[]),
    getExamplesSummary().catch(() => null),
    collectRejections(weekStart, previousStart).catch(() => ({ rows: [], comparable: false }) as RejectionReport),
    getScraperStatus().catch(() => null),
    Promise.resolve().then(() => getSearchStatus()).catch(() => null),
    getResearchProgress().catch(() => null),
  ]);

  return {
    weekStart,
    leadsByPriority,
    totalLeads: leadsByPriority.reduce((sum, r) => sum + r.count, 0),
    ...actions,
    taught,
    examples,
    rejections,
    scraper,
    search,
    families,
  };
}

// ---------------------------------------------------------------------------
// "What changed in how I judge" — plain English derived from the new examples
// ---------------------------------------------------------------------------

/** Deal shapes we can recognise in a headline, most specific first. */
const DEAL_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bacquisi|\bacquires?\b|\bacquired\b|\bbuys?\b|\bbought\b|\btakeover\b|\bmergers?\b|\bmerges\b/i, label: "acquisitions" },
  { pattern: /\bipo\b|\blistings?\b|\blists\b|\bfloats?\b|\bgoes public\b/i, label: "IPOs and listings" },
  { pattern: /\bseries [a-h]\b|\braise[sd]?\b|\bfunding\b|\bfunding round\b|\bpre-seed\b|\bseed round\b/i, label: "funding rounds" },
  { pattern: /\bexits?\b|\bstake sale\b|\bsells? (?:his|her|its|their)?\s*stake\b|\bdivests?\b|\bsecondary sale\b/i, label: "exits and stake sales" },
  { pattern: /\bfamily office\b|\binherit|\bsuccession\b|\bestate\b|\bwealth transfer\b/i, label: "family-office and succession stories" },
];

/** The SEA markets Billy covers. */
const MARKETS = ["Singapore", "Indonesia", "Malaysia", "Thailand", "Philippines", "Vietnam"];

interface ExampleFacets {
  dealType: string | null;
  markets: string[];
  publisher: string | null;
}

function facetsOf(example: TaughtExample): ExampleFacets {
  const headline = example.headline || "";
  const dealType = DEAL_PATTERNS.find((d) => d.pattern.test(headline))?.label ?? null;
  const markets = MARKETS.filter((m) => new RegExp(`\\b${m}`, "i").test(headline));

  let publisher: string | null = null;
  try {
    publisher = new URL(example.url).hostname.replace(/^www\./, "");
  } catch {
    publisher = null;
  }

  return { dealType, markets, publisher };
}

/** Count occurrences of each key, biggest bucket first. */
function rank<T>(items: T[], key: (item: T) => string | null): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts, ([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

/**
 * Turns the week's new reference examples into two or three plain-English lines
 * about what actually changed in Sensei's judgement.
 *
 * Pattern-based rather than model-based: a lesson is only stated when at least
 * {@link MIN_LESSON_SIZE} examples share it, so the note never generalises from
 * a single article.
 *
 * @param taught - Reference examples added during the window
 * @returns Up to {@link MAX_JUDGEMENT_LINES} sentences, or one honest fallback
 *
 * @example
 * describeJudgementChanges(taught);
 * // ["You taught me 3 acquisitions involving Singapore should pass.", ...]
 */
export function describeJudgementChanges(taught: TaughtExample[]): string[] {
  const passes = taught.filter((t) => t.expected === "pass");
  const rejects = taught.filter((t) => t.expected === "reject");

  if (taught.length === 0) {
    return ["Nothing new taught this week — I'm judging articles the same way I was last Sunday."];
  }

  const facets = passes.map((example) => ({ example, ...facetsOf(example) }));
  const lines: string[] = [];

  const topDeal = rank(facets, (f) => f.dealType)[0];
  if (topDeal && topDeal.count >= MIN_LESSON_SIZE) {
    const inDeal = facets.filter((f) => f.dealType === topDeal.value);
    const topMarket = rank(inDeal, (f) => f.markets[0] ?? null)[0];
    const marketClause = topMarket && topMarket.count >= MIN_LESSON_SIZE ? ` involving ${topMarket.value}` : "";
    lines.push(`You taught me ${topDeal.count} ${topDeal.value}${marketClause} should pass — I'll stop rejecting stories shaped like those.`);
  }

  const topPublisher = rank(facets, (f) => f.publisher)[0];
  if (topPublisher && topPublisher.count >= MIN_LESSON_SIZE) {
    lines.push(`${topPublisher.count} of them came from ${topPublisher.value}, so I'll take that outlet more seriously as a deal source.`);
  }

  if (lines.length === 0 && passes.length > 0) {
    const sample = passes[0];
    lines.push(`You taught me ${passes.length} ${plural(passes.length, "article")} should pass, starting with "${sample.headline}".`);
  }

  if (rejects.length >= 1) {
    lines.push(`You also marked ${rejects.length} ${plural(rejects.length, "article")} as something I should reject — those now count against near-identical stories.`);
  }

  return lines.slice(0, MAX_JUDGEMENT_LINES);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function formatDelta(thisWeek: number, lastWeek: number): string {
  const delta = thisWeek - lastWeek;
  if (lastWeek === 0) return delta > 0 ? " (new)" : "";
  if (delta === 0) return " (flat)";
  return delta > 0 ? ` (▲${delta})` : ` (▼${Math.abs(delta)})`;
}

function formatDateRange(weekStart: Date, now: Date): string {
  const fmt = (d: Date) => d.toLocaleDateString("en-SG", { day: "numeric", month: "short", timeZone: NOTE_TIMEZONE });
  return `${fmt(weekStart)} – ${fmt(now)}`;
}

function formatExamplesLine(summary: WeeklyData["examples"]): string {
  if (!summary || !summary.total) return "none on file yet";
  const tested = summary.passing + summary.failing;
  if (tested === 0) return `${summary.total} on file · none re-run yet`;
  const rate = Math.round((summary.passing / tested) * 100);
  return `${summary.total} on file · ${summary.passing}/${tested} passing (${rate}%)`;
}

/**
 * Renders the weekly note.
 *
 * Exported separately from the send path so it can be previewed (an endpoint, a
 * script, or a test) without messaging anyone.
 *
 * @param now - Treated as the end of the reporting week; defaults to the present
 * @returns HTML for a Telegram message
 */
export async function buildWeeklyNote(now = new Date()): Promise<string> {
  const data = await collectWeeklyData(now);

  const priorityOrder = ["high", "medium", "low"];
  const byPriority =
    data.leadsByPriority
      .slice()
      .sort((a, b) => priorityOrder.indexOf(a.level) - priorityOrder.indexOf(b.level))
      .map((r) => `  ${escapeHtml(r.level)}: ${r.count}`)
      .join("\n") || "  none";

  const { rows: rejectionRows, comparable } = data.rejections;
  const rejections = rejectionRows.length
    ? rejectionRows
        .map((r) => `  ${escapeHtml(r.reason)} — ${r.thisWeek}${comparable ? formatDelta(r.thisWeek, r.lastWeek) : ""}`)
        .join("\n")
    : "  none recorded";
  const rejectionHeading = comparable
    ? "<b>Why I rejected things</b> (this week vs last)"
    : "<b>Why I rejected things</b>\n<i>(no week-on-week comparison — scan logs are pruned before then)</i>";

  const credits =
    data.scraper && typeof data.scraper.plan?.RemainingMonthlyRequest === "number"
      ? `${data.scraper.today.credits} credits used today · ${data.scraper.plan.RemainingMonthlyRequest} left this month`
      : data.scraper
        ? `${data.scraper.today.credits} credits used today`
        : "unavailable";

  const searches = data.search
    ? `${data.search.today.tavily} Tavily · ${data.search.today.brave} Brave (today)`
    : "unavailable";

  const familyLine = data.families
    ? `${data.families.researched}/${data.families.total} families researched · ${data.families.remaining} queued`
    : "unavailable";

  const judgement = describeJudgementChanges(data.taught)
    .map((line) => `• ${escapeHtml(line)}`)
    .join("\n");

  return [
    `🧠 <b>What I learned this week</b>`,
    `<i>${escapeHtml(formatDateRange(data.weekStart, now))}</i>`,
    "",
    `<b>Found ${data.totalLeads} ${plural(data.totalLeads, "lead")}</b>`,
    byPriority,
    "",
    `<b>What you did with them</b>`,
    `  💾 saved ${data.saved}`,
    `  🗑 dismissed ${data.dismissed} (of leads found this week)`,
    `  🔇 muted ${data.muted} ${plural(data.muted, "person", "people")}`,
    "",
    `<b>What you taught me</b>`,
    `  ${data.taught.length} new reference ${plural(data.taught.length, "example")}`,
    `  Regression suite: ${escapeHtml(formatExamplesLine(data.examples))}`,
    "",
    `<b>What changed in how I judge</b>`,
    judgement,
    "",
    rejectionHeading,
    rejections,
    "",
    `<b>Budget</b>`,
    `  Scraper: ${escapeHtml(credits)}`,
    `  Search: ${escapeHtml(searches)}`,
    "",
    `<b>Families</b>`,
    `  ${escapeHtml(familyLine)}`,
    "",
    debugPageLink(),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Delivery + schedule
// ---------------------------------------------------------------------------

/**
 * Builds and sends the weekly note to the configured alert chat.
 *
 * Like the health monitor, this ignores `settings.telegramEnabled` — that
 * toggle governs lead alerts; the weekly note is Sensei reporting on itself.
 *
 * @returns true if a message was sent, false if no chat/bot is configured
 */
export async function sendWeeklyNoteNow(): Promise<boolean> {
  const settings = await storage.getSettings();
  const chatId = settings?.telegramChatId;
  if (!chatId || !process.env.TELEGRAM_BOT_TOKEN) {
    log("[weekly-note] skipped — no Telegram chat configured", "weekly-note");
    return false;
  }

  const note = await buildWeeklyNote();
  for (const part of splitLongMessage(note)) {
    await sendTelegramMessage(chatId, part, "HTML", undefined, settings?.telegramTopicId ?? null);
  }
  lastSentAt = new Date().toISOString();
  return true;
}

/** Snapshot for the debug UI / status endpoints. */
export function getWeeklyNoteState() {
  return { enabled: ENABLED, running: noteTask !== null, cron: NOTE_CRON, timezone: NOTE_TIMEZONE, lastSentAt };
}

/** Start the Sunday 18:00 Asia/Singapore note. Idempotent. */
export function startWeeklyNote(): void {
  stopWeeklyNote();
  if (!ENABLED) {
    log("Weekly note disabled (WEEKLY_NOTE_ENABLED=false)", "weekly-note");
    return;
  }
  noteTask = cron.schedule(
    NOTE_CRON,
    () => {
      void sendWeeklyNoteNow().catch((error) => {
        log(`[weekly-note] send failed: ${(error as Error).message}`, "weekly-note");
      });
    },
    { timezone: NOTE_TIMEZONE },
  );
  log(`Weekly note started ("${NOTE_CRON}" ${NOTE_TIMEZONE})`, "weekly-note");
}

export function stopWeeklyNote(): void {
  if (noteTask) {
    noteTask.stop();
    noteTask = null;
  }
}
