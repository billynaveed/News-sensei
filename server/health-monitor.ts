/**
 * Background health monitor.
 *
 * Runs `getHealth()` every 15 minutes and pushes a Telegram alert when the
 * system flips out of "ok" (with a 6-hour re-notify floor so a long outage
 * doesn't spam the chat), plus a "recovered" note when it comes back. A daily
 * 08:00 Asia/Singapore digest reports what the pipeline actually did overnight.
 *
 * The alert path deliberately ignores `settings.telegramEnabled` — that toggle
 * governs *lead* alerts. Operational alerts go out whenever a chat ID exists,
 * because a broken pipeline is exactly when lead alerts have gone quiet.
 */

import cron, { type ScheduledTask } from "node-cron";
import { gte, sql } from "drizzle-orm";
import { leads, scanLogs } from "@shared/schema";
import { db } from "./db";
import { storage } from "./storage";
import { log } from "./log";
import { sendTelegramMessage } from "./telegram";
import { getHealth, type HealthCheck, type HealthReport, type HealthStatus } from "./health";
import { getScraperStatus } from "./scraper";
import { getSearchStatus } from "./web-search";
import { getResearchProgress } from "./family-research";

const CHECK_CRON = process.env.HEALTH_MONITOR_CRON || "*/15 * * * *";
const DIGEST_CRON = process.env.HEALTH_DIGEST_CRON || "0 8 * * *";
const DIGEST_TIMEZONE = "Asia/Singapore";
const RENOTIFY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STATUS_ICON: Record<HealthStatus, string> = { ok: "🟢", warn: "🟡", error: "🔴" };

export interface HealthMonitorState {
  /** Overall status at the last check, or null if the monitor has not run yet. */
  lastOverall: HealthStatus | null;
  lastCheckedAt: string | null;
  /** When the last degradation alert went out. */
  lastNotifiedAt: string | null;
  /** Which status that alert reported (used to detect warn → error escalation). */
  lastNotifiedOverall: HealthStatus | null;
  lastDigestAt: string | null;
  running: boolean;
}

const state: HealthMonitorState = {
  lastOverall: null,
  lastCheckedAt: null,
  lastNotifiedAt: null,
  lastNotifiedOverall: null,
  lastDigestAt: null,
  running: false,
};

let checkTask: ScheduledTask | null = null;
let digestTask: ScheduledTask | null = null;

/** Snapshot for the debug UI. */
export function getHealthMonitorState(): HealthMonitorState {
  return { ...state };
}

const escHtml = (v: unknown) =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Send an operational message to the configured alert chat. Returns false when unconfigured. */
async function notify(message: string): Promise<boolean> {
  const settings = await storage.getSettings();
  const chatId = settings?.telegramChatId;
  if (!chatId || !process.env.TELEGRAM_BOT_TOKEN) return false;
  await sendTelegramMessage(chatId, message, "HTML", undefined, settings?.telegramTopicId ?? null);
  return true;
}

function formatFailing(checks: HealthCheck[]): string {
  return checks
    .map((c) => `${STATUS_ICON[c.status]} <b>${escHtml(c.label)}</b> — ${escHtml(c.message)}${c.detail ? `\n<i>${escHtml(c.detail)}</i>` : ""}`)
    .join("\n");
}

function shouldNotify(report: HealthReport, previous: HealthStatus | null): boolean {
  if (report.overall === "ok") return false;
  // First bad reading, or a transition out of ok.
  if (previous === null || previous === "ok") return true;
  // Escalation warn → error is worth an immediate second message.
  if (state.lastNotifiedOverall === "warn" && report.overall === "error") return true;
  if (!state.lastNotifiedAt) return true;
  return Date.now() - Date.parse(state.lastNotifiedAt) >= RENOTIFY_INTERVAL_MS;
}

async function runCheck(reason: string): Promise<void> {
  let report: HealthReport;
  try {
    report = await getHealth();
  } catch (error) {
    log(`[health] check failed (${reason}): ${(error as Error).message}`, "health");
    return;
  }

  const previous = state.lastOverall;
  state.lastOverall = report.overall;
  state.lastCheckedAt = report.checkedAt;

  try {
    if (report.overall === "ok") {
      if (state.lastNotifiedAt) {
        await notify(`✅ <b>Sensei recovered</b>\n\nAll ${report.checks.length} health checks are green again.`);
        state.lastNotifiedAt = null;
        state.lastNotifiedOverall = null;
      }
      return;
    }

    if (!shouldNotify(report, previous)) return;

    const failing = report.checks.filter((c) => c.status !== "ok");
    const header = report.overall === "error" ? "🔴 <b>Sensei health: ERROR</b>" : "🟡 <b>Sensei health: WARNING</b>";
    const sent = await notify(`${header}\n\n${formatFailing(failing)}`);
    if (sent) {
      state.lastNotifiedAt = new Date().toISOString();
      state.lastNotifiedOverall = report.overall;
    }
  } catch (error) {
    log(`[health] alert delivery failed: ${(error as Error).message}`, "health");
  }
}

interface DigestData {
  leadsByPriority: { level: string; count: number }[];
  totalLeads: number;
  scans: number;
  articlesScanned: number;
  topRejections: { reason: string; count: number }[];
}

/** Gather the last 24h of pipeline activity. All aggregation happens in SQL. */
async function collectDigestData(): Promise<DigestData> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [leadRows, scanRows, rejectionRows] = await Promise.all([
    db
      .select({ level: leads.priorityLevel, count: sql<number>`count(*)::int` })
      .from(leads)
      .where(gte(leads.createdAt, since))
      .groupBy(leads.priorityLevel),
    db
      .select({
        scans: sql<number>`count(*)::int`,
        articlesScanned: sql<number>`coalesce(sum(${scanLogs.articlesScanned}), 0)::int`,
      })
      .from(scanLogs)
      .where(gte(scanLogs.scannedAt, since)),
    // Reasons look like "prefilter: no wealth signal" — group on the prefix so
    // near-identical tails collapse into one bucket.
    db.execute(sql`
      SELECT split_part(elem->>'reason', ':', 1) AS reason, count(*)::int AS count
      FROM scan_logs, json_array_elements(scan_logs.articles_processed) AS elem
      WHERE scan_logs.scanned_at >= ${since}
        AND elem->>'reason' IS NOT NULL
        AND coalesce(elem->>'status', '') <> 'success'
      GROUP BY 1
      ORDER BY count DESC
      LIMIT 3
    `),
  ]);

  const leadsByPriority = leadRows.map((r) => ({ level: r.level ?? "unknown", count: r.count }));
  return {
    leadsByPriority,
    totalLeads: leadsByPriority.reduce((sum, r) => sum + r.count, 0),
    scans: scanRows[0]?.scans ?? 0,
    articlesScanned: scanRows[0]?.articlesScanned ?? 0,
    topRejections: (rejectionRows.rows as { reason: string; count: number }[]).map((r) => ({
      reason: r.reason || "(unlabelled)",
      count: Number(r.count),
    })),
  };
}

function formatDigest(
  data: DigestData,
  scraper: Awaited<ReturnType<typeof getScraperStatus>>,
  search: ReturnType<typeof getSearchStatus>,
  families: Awaited<ReturnType<typeof getResearchProgress>>,
  health: HealthReport,
): string {
  const priorityOrder = ["high", "medium", "low"];
  const byPriority = data.leadsByPriority
    .slice()
    .sort((a, b) => priorityOrder.indexOf(a.level) - priorityOrder.indexOf(b.level))
    .map((r) => `  ${r.level}: ${r.count}`)
    .join("\n") || "  none";

  const rejections = data.topRejections.length
    ? data.topRejections.map((r) => `  ${escHtml(r.reason)} — ${r.count}`).join("\n")
    : "  none recorded";

  const credits =
    typeof scraper.plan?.RemainingMonthlyRequest === "number"
      ? `${scraper.plan.RemainingMonthlyRequest} requests left`
      : "unknown";

  const searchState = search.breakerOpen
    ? search.braveConfigured
      ? "Tavily paused, Brave active"
      : "paused (circuit breaker open)"
    : search.tavilyConfigured
      ? "Tavily"
      : search.braveConfigured
        ? "Brave"
        : "not configured";

  return [
    `${STATUS_ICON[health.overall]} <b>Sensei daily digest</b>`,
    "",
    `<b>Leads (24h): ${data.totalLeads}</b>`,
    byPriority,
    "",
    `<b>Scans (24h):</b> ${data.scans} scans · ${data.articlesScanned} articles`,
    "",
    "<b>Top rejection reasons:</b>",
    rejections,
    "",
    `<b>Scraper:</b> ${escHtml(scraper.provider.replace("_", "."))} — ${escHtml(credits)}`,
    `<b>Search:</b> ${escHtml(searchState)} (${search.today.tavily} Tavily · ${search.today.brave} Brave today)`,
    `<b>Family research:</b> ${families.researched}/${families.total} researched`,
  ].join("\n");
}

async function runDigest(): Promise<void> {
  try {
    const [data, scraper, families, health] = await Promise.all([
      collectDigestData(),
      getScraperStatus(),
      getResearchProgress(),
      getHealth(),
    ]);
    const sent = await notify(formatDigest(data, scraper, getSearchStatus(), families, health));
    state.lastDigestAt = new Date().toISOString();
    if (!sent) log("[health] digest skipped — no Telegram chat configured", "health");
  } catch (error) {
    log(`[health] digest failed: ${(error as Error).message}`, "health");
  }
}

/** Start the 15-minute health check and the daily digest. Idempotent. */
export function startHealthMonitor(): void {
  stopHealthMonitor();
  checkTask = cron.schedule(CHECK_CRON, () => { void runCheck("cron"); });
  digestTask = cron.schedule(DIGEST_CRON, () => { void runDigest(); }, { timezone: DIGEST_TIMEZONE });
  state.running = true;
  log(`Health monitor started (checks "${CHECK_CRON}", digest "${DIGEST_CRON}" ${DIGEST_TIMEZONE})`, "health");
}

export function stopHealthMonitor(): void {
  if (checkTask) { checkTask.stop(); checkTask = null; }
  if (digestTask) { digestTask.stop(); digestTask = null; }
  state.running = false;
}

/** Exposed for the manual "run now" path in routes-health.ts. */
export async function runHealthCheckNow(): Promise<void> {
  await runCheck("manual");
}
