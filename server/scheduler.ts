import { sendDailyCostSummary, sendIpoFilingAlert } from "./telegram";
import { scanForLeads } from "./scanner";
import { scanHkexIpos } from "./ipo-scanner";
import type { IStorage } from "./storage";

let dailyReportInterval: NodeJS.Timeout | null = null;
let hourlyScanInterval: NodeJS.Timeout | null = null;
let ipoScanInterval: NodeJS.Timeout | null = null;

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

export function startIpoScanScheduler(storage: IStorage) {
  // Run IPO scan every 6 hours (IPO filings don't happen as frequently)
  ipoScanInterval = setInterval(async () => {
    console.log("Starting automated IPO scan...");
    try {
      const result = await scanHkexIpos({ parsePdfs: true, maxPdfsToProcess: 5 });
      console.log(`IPO scan complete: ${result.newFilings} new filings found`);

      // Send Telegram notifications for new filings
      if (result.newFilings > 0) {
        const settings = await storage.getSettings();
        if (settings?.telegramEnabled && settings.telegramChatId) {
          const filings = await storage.getAllIpoFilings();
          const newFilings = filings
            .filter(f => f.status === "new")
            .slice(0, result.newFilings);

          for (const filing of newFilings) {
            try {
              await sendIpoFilingAlert(settings.telegramChatId, filing);
            } catch (error) {
              console.error(`Failed to send Telegram alert for IPO filing ${filing.id}:`, error);
            }
          }
        }
      }
    } catch (error) {
      console.error("IPO scan failed:", error);
    }
  }, 6 * 3600000); // Run every 6 hours (21600000ms)

  console.log("IPO scan scheduler started (runs every 6 hours)");
}

export function stopIpoScanScheduler() {
  if (ipoScanInterval) {
    clearInterval(ipoScanInterval);
    ipoScanInterval = null;
    console.log("IPO scan scheduler stopped");
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
