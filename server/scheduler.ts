import { sendDailyCostSummary } from "./telegram";
import { scanForLeads } from "./scanner";
import type { IStorage } from "./storage";

let dailyReportInterval: NodeJS.Timeout | null = null;
let hourlyScanInterval: NodeJS.Timeout | null = null;

export function startDailyCostReportScheduler(storage: IStorage) {
  // Check every minute for 23:50 UTC
  dailyReportInterval = setInterval(async () => {
    const now = new Date();

    // Send daily report at 23:50 UTC
    if (now.getUTCHours() === 23 && now.getUTCMinutes() === 50) {
      await sendDailyReport(storage);
    }
  }, 60000); // Check every minute

  console.log("Daily cost report scheduler started");
}

export function startHourlyScanScheduler() {
  // Run scan every hour
  hourlyScanInterval = setInterval(async () => {
    console.log("Starting hourly automated scan...");
    try {
      const result = await scanForLeads();
      console.log(`Hourly scan complete: ${result.newLeads} new leads found`);
    } catch (error) {
      console.error("Hourly scan failed:", error);
    }
  }, 3600000); // Run every hour (3600000ms = 1 hour)

  console.log("Hourly scan scheduler started");
}

export function stopDailyCostReportScheduler() {
  if (dailyReportInterval) {
    clearInterval(dailyReportInterval);
    dailyReportInterval = null;
    console.log("Daily cost report scheduler stopped");
  }
}

export function stopHourlyScanScheduler() {
  if (hourlyScanInterval) {
    clearInterval(hourlyScanInterval);
    hourlyScanInterval = null;
    console.log("Hourly scan scheduler stopped");
  }
}

async function sendDailyReport(storage: IStorage) {
  try {
    const settings = await storage.getSettings();
    if (!settings || !settings.telegramEnabled || !settings.telegramChatId) {
      return;
    }

    // Get today's scan logs
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const logs = await storage.getAllScanLogs();
    const todayLogs = logs.filter(log =>
      new Date(log.scannedAt) >= todayStart
    );

    const summary = {
      date: todayStart.toISOString().split('T')[0],
      totalScans: todayLogs.length,
      totalCost: todayLogs.reduce((sum, log) => sum + (log.totalCostUsd || 0), 0),
      tier1Cost: todayLogs.reduce((sum, log) => sum + (log.tier1CostUsd || 0), 0),
      tier2Cost: todayLogs.reduce((sum, log) => sum + (log.tier2CostUsd || 0), 0),
      leadsFound: todayLogs.reduce((sum, log) => sum + (log.newLeads || 0), 0),
      limit: settings.dailyCostLimitUsd || 10.0,
    };

    await sendDailyCostSummary(settings.telegramChatId, summary);
  } catch (error) {
    console.error("Failed to send daily cost report:", error);
  }
}
