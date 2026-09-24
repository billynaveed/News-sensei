/**
 * System health checks.
 *
 * One cheap probe per moving part the pipeline depends on: the database, the
 * LLM gateway, the scraping provider, web search, the scan scheduler, the
 * family-research worker and Telegram delivery. Everything here must stay
 * effectively free to run — the monitor calls it every 15 minutes and the UI
 * polls it every minute. No LLM calls, no paid API calls beyond the scrape.do
 * `/info` lookup that `getScraperStatus()` already performs.
 */

import { desc } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { scanLogs, type Settings } from "@shared/schema";
import { db } from "./db";
import { storage } from "./storage";
import { getLlmStatus } from "./openai-client";
import { getScraperStatus } from "./scraper";
import { getSearchStatus } from "./web-search";
import { getResearchProgress } from "./family-research";

export type HealthStatus = "ok" | "warn" | "error";

export interface HealthCheck {
  /** Stable machine id, e.g. "db" — safe to key UI off. */
  id: string;
  /** Human label for the debug page. */
  label: string;
  status: HealthStatus;
  /** One-line summary shown next to the label. */
  message: string;
  /** Optional extra context (last error text, timestamps). */
  detail?: string;
}

export interface HealthReport {
  overall: HealthStatus;
  checkedAt: string;
  checks: HealthCheck[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const LLM_ERROR_WINDOW_MS = 10 * MINUTE;
const LLM_CONSECUTIVE_FAILURES = 5;
const SCRAPER_CREDITS_ERROR = 20;
const SCRAPER_CREDITS_WARN = 100;
const SEARCH_QUOTA_WINDOW_MS = 24 * HOUR;
const HOURLY_SCAN_MAX_AGE_MS = 3 * HOUR;
const FAMILY_WORKER_FAILURE_STREAK = 3;

const STATUS_RANK: Record<HealthStatus, number> = { ok: 0, warn: 1, error: 2 };

function worst(statuses: HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>((acc, s) => (STATUS_RANK[s] > STATUS_RANK[acc] ? s : acc), "ok");
}

function ageMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Date.now() - t;
}

function humanAge(ms: number): string {
  if (ms < MINUTE) return `${Math.round(ms / 1000)}s ago`;
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}m ago`;
  return `${(ms / HOUR).toFixed(1)}h ago`;
}

/** Run one check, converting an unexpected throw into an error row instead of failing the report. */
async function safeCheck(
  id: string,
  label: string,
  run: () => Promise<HealthCheck> | HealthCheck,
): Promise<HealthCheck> {
  try {
    return await run();
  } catch (error) {
    return {
      id,
      label,
      status: "error",
      message: "Check failed to run",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkDb(): Promise<HealthCheck> {
  const start = Date.now();
  await db.execute(sql`select 1`);
  return { id: "db", label: "Database", status: "ok", message: `Reachable (${Date.now() - start}ms)` };
}

function checkLlm(): HealthCheck {
  const s = getLlmStatus();
  const base = { id: "llm", label: "LLM gateway" } as const;

  if (!s.lastSuccessAt && !s.lastErrorAt) {
    return { ...base, status: "ok", message: "No calls yet since boot" };
  }

  const recent = s.recentOutcomes.slice(-LLM_CONSECUTIVE_FAILURES);
  const allRecentFailed = recent.length >= LLM_CONSECUTIVE_FAILURES && recent.every((o) => o === "error");
  const errorAge = ageMs(s.lastErrorAt);
  const noSuccessSinceError =
    !!s.lastErrorAt &&
    (!s.lastSuccessAt || Date.parse(s.lastSuccessAt) < Date.parse(s.lastErrorAt));
  const freshFailure = errorAge !== null && errorAge < LLM_ERROR_WINDOW_MS && noSuccessSinceError;

  const detail = s.lastError
    ? `Last error${s.lastErrorAt ? ` ${humanAge(ageMs(s.lastErrorAt) ?? 0)}` : ""}: ${s.lastError}`
    : undefined;

  if (allRecentFailed || freshFailure) {
    return {
      ...base,
      status: "error",
      message: allRecentFailed
        ? `Last ${LLM_CONSECUTIVE_FAILURES} calls all failed`
        : "Failing with no successful call since",
      detail,
    };
  }
  if (s.errorsToday > 0) {
    return {
      ...base,
      status: "warn",
      message: `${s.errorsToday} of ${s.callsToday} calls failed today`,
      detail,
    };
  }
  return {
    ...base,
    status: "ok",
    message: `${s.callsToday} calls today, no errors`,
    detail: s.lastSuccessAt ? `Last success ${humanAge(ageMs(s.lastSuccessAt) ?? 0)}` : undefined,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function checkScraper(): Promise<HealthCheck> {
  const s = await getScraperStatus();
  const base = { id: "scraper", label: "Scraper" } as const;
  const providerLabel = s.provider.replace("_", ".");

  if (s.provider === "none") {
    return { ...base, status: "error", message: "No scraping provider configured" };
  }

  const remaining = numberOrNull(s.plan?.RemainingMonthlyRequest);
  const max = numberOrNull(s.plan?.MaxMonthlyRequest);
  const planActive = s.plan?.IsActive;
  const quota = remaining !== null ? `${remaining}${max !== null ? `/${max}` : ""} requests left` : "quota unknown";
  const todayLine = `Today: ${s.today.requests} requests · ${s.today.credits} credits · ${s.today.failures} failed`;
  const detail = s.today.lastError ? `${todayLine}. Last error: ${s.today.lastError}` : todayLine;

  if (planActive === false) {
    return { ...base, status: "error", message: `${providerLabel} plan is inactive`, detail };
  }
  if (remaining !== null && remaining < SCRAPER_CREDITS_ERROR) {
    return { ...base, status: "error", message: `${providerLabel} out of credits (${quota})`, detail };
  }
  if (remaining !== null && remaining < SCRAPER_CREDITS_WARN) {
    return { ...base, status: "warn", message: `${providerLabel} credits low (${quota})`, detail };
  }
  if (s.today.requests > 0 && s.today.failures > s.today.requests / 2) {
    return {
      ...base,
      status: "warn",
      message: `${providerLabel} failing more than half of requests today`,
      detail,
    };
  }
  return { ...base, status: "ok", message: `${providerLabel} — ${quota}`, detail };
}

function checkSearch(): HealthCheck {
  const s = getSearchStatus();
  const base = { id: "search", label: "Web search" } as const;
  const todayLine = `Today: ${s.today.tavily} Tavily · ${s.today.brave} Brave · ${s.today.failures} failed`;

  if (!s.tavilyConfigured && !s.braveConfigured) {
    return { ...base, status: "error", message: "No search provider configured (Tavily or Brave)" };
  }

  const quotaAge = ageMs(s.lastQuotaError?.at ?? null);
  const recentQuotaError = quotaAge !== null && quotaAge < SEARCH_QUOTA_WINDOW_MS;

  if (s.breakerOpen) {
    return {
      ...base,
      status: "warn",
      message: s.braveConfigured ? "Tavily paused — using Brave" : "Search circuit breaker open",
      detail: s.breakerResetsAt ? `Resets at ${s.breakerResetsAt}. ${todayLine}` : todayLine,
    };
  }
  if (recentQuotaError) {
    return {
      ...base,
      status: "warn",
      message: "Quota error in the last 24h",
      detail: `${s.lastQuotaError?.message ?? ""} (${humanAge(quotaAge!)}). ${todayLine}`,
    };
  }
  const provider = s.tavilyConfigured ? "Tavily" : "Brave";
  return { ...base, status: "ok", message: `${provider} healthy`, detail: todayLine };
}

async function checkLastScan(settings: Settings | undefined): Promise<HealthCheck> {
  const base = { id: "lastScan", label: "Last scan" } as const;
  // Narrow projection: scan_logs rows carry megabytes of per-article JSON we
  // must not pull just to read a timestamp.
  const [latest] = await db
    .select({
      scannedAt: scanLogs.scannedAt,
      articlesScanned: scanLogs.articlesScanned,
      newLeads: scanLogs.newLeads,
      errors: scanLogs.errors,
    })
    .from(scanLogs)
    .orderBy(desc(scanLogs.scannedAt))
    .limit(1);

  if (!latest) {
    return { ...base, status: "warn", message: "No scans recorded yet" };
  }

  const age = Date.now() - latest.scannedAt.getTime();
  const summary = `${latest.articlesScanned} articles · ${latest.newLeads} new leads · ${humanAge(age)}`;
  const frequency = settings?.scanFrequency ?? "manual";

  if (frequency === "hourly" && age > HOURLY_SCAN_MAX_AGE_MS) {
    return {
      ...base,
      status: "error",
      message: `No scan for ${humanAge(age)} (hourly schedule)`,
      detail: summary,
    };
  }
  const errors = latest.errors ?? [];
  if (errors.length > 0) {
    return {
      ...base,
      status: "warn",
      message: `Last scan reported ${errors.length} error${errors.length > 1 ? "s" : ""}`,
      detail: `${summary}. ${errors.slice(0, 3).join(" | ")}`,
    };
  }
  return { ...base, status: "ok", message: summary };
}

// Consecutive-failure streak for the family research worker. `lastRun` only
// exposes the most recent tick, so we accumulate the streak here by noticing
// each new tick timestamp.
const familyWorkerStreak = { lastSeenRunAt: null as string | null, consecutiveFailures: 0 };
const FAMILY_FAILURE_STATUSES = new Set(["failed", "budget-exhausted"]);

async function checkFamilyWorker(): Promise<HealthCheck> {
  const progress = await getResearchProgress();
  const base = { id: "familyWorker", label: "Family research worker" } as const;

  if (!progress.enabled) {
    return { ...base, status: "ok", message: "Disabled (FAMILY_RESEARCH_ENABLED=false)" };
  }

  const lastRun = progress.lastRun;
  if (lastRun && lastRun.at !== familyWorkerStreak.lastSeenRunAt) {
    familyWorkerStreak.lastSeenRunAt = lastRun.at;
    familyWorkerStreak.consecutiveFailures = FAMILY_FAILURE_STATUSES.has(lastRun.status)
      ? familyWorkerStreak.consecutiveFailures + 1
      : 0;
  }

  const summary = `${progress.researched}/${progress.total} families researched · ${progress.searchesLeftToday} searches left today`;
  if (!lastRun) {
    return { ...base, status: "ok", message: `${summary} · no tick yet` };
  }

  const runLine = `Last tick ${humanAge(ageMs(lastRun.at) ?? 0)}: ${lastRun.status}${lastRun.name ? ` (${lastRun.name})` : ""}${lastRun.error ? ` — ${lastRun.error}` : ""}`;

  if (familyWorkerStreak.consecutiveFailures >= FAMILY_WORKER_FAILURE_STREAK) {
    return {
      ...base,
      status: "error",
      message: `${familyWorkerStreak.consecutiveFailures} consecutive failed ticks`,
      detail: `${summary}. ${runLine}`,
    };
  }
  if (FAMILY_FAILURE_STATUSES.has(lastRun.status)) {
    return {
      ...base,
      status: "warn",
      message: lastRun.status === "budget-exhausted" ? "Daily search budget exhausted" : "Last tick failed",
      detail: `${summary}. ${runLine}`,
    };
  }
  return { ...base, status: "ok", message: summary, detail: runLine };
}

function checkTelegram(settings: Settings | undefined): HealthCheck {
  const base = { id: "telegram", label: "Telegram alerts" } as const;
  const missing: string[] = [];
  if (!process.env.TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!settings?.telegramChatId) missing.push("chat ID in settings");

  if (missing.length > 0) {
    return { ...base, status: "warn", message: `Not configured: ${missing.join(", ")}` };
  }
  return {
    ...base,
    status: "ok",
    message: `Configured (chat ${settings!.telegramChatId})`,
    detail: settings?.telegramTopicId != null ? `Topic ${settings.telegramTopicId}` : undefined,
  };
}

/**
 * Run every health check and roll them up.
 *
 * @returns the overall status (worst of the individual checks), the time of the
 * probe, and one row per check.
 *
 * @example
 * const health = await getHealth();
 * if (health.overall !== "ok") console.warn(health.checks.filter(c => c.status !== "ok"));
 */
export async function getHealth(): Promise<HealthReport> {
  const settings = await storage.getSettings().catch(() => undefined);

  const checks = await Promise.all([
    safeCheck("db", "Database", checkDb),
    safeCheck("llm", "LLM gateway", checkLlm),
    safeCheck("scraper", "Scraper", checkScraper),
    safeCheck("search", "Web search", checkSearch),
    safeCheck("lastScan", "Last scan", () => checkLastScan(settings)),
    safeCheck("familyWorker", "Family research worker", checkFamilyWorker),
    safeCheck("telegram", "Telegram alerts", () => checkTelegram(settings)),
  ]);

  return {
    overall: worst(checks.map((c) => c.status)),
    checkedAt: new Date().toISOString(),
    checks,
  };
}
