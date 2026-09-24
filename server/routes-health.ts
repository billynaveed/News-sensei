/**
 * Health endpoints.
 *
 * Registered from inside `registerRoutes()` so these inherit the `/api/*` auth
 * middleware — the unauthenticated liveness probe is `/healthz`, which is
 * deliberately separate and much dumber than this.
 */

import type { Express } from "express";
import { getHealth } from "./health";
import { getHealthMonitorState, runDigest } from "./health-monitor";
import { storage } from "./storage";
import { sendTelegramMessage } from "./telegram";

export function registerHealthRoutes(app: Express): void {
  /** Full health report plus the background monitor's alerting state. */
  app.get("/api/health", async (_req, res) => {
    try {
      const health = await getHealth();
      res.json({ ...health, monitor: getHealthMonitorState() });
    } catch (error) {
      console.error("Error building health report:", error);
      res.status(500).json({ message: "Failed to build health report" });
    }
  });

  /** Proves the alert path end to end: same chat, same topic, same formatting. */
  app.post("/api/health/digest", async (_req, res) => {
    try {
      await runDigest();
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  app.post("/api/health/test-alert", async (_req, res) => {
    try {
      const settings = await storage.getSettings();
      if (!process.env.TELEGRAM_BOT_TOKEN) {
        return res.status(400).json({ message: "TELEGRAM_BOT_TOKEN is not configured" });
      }
      if (!settings?.telegramChatId) {
        return res.status(400).json({ message: "No Telegram chat ID configured in settings" });
      }

      const health = await getHealth();
      const failing = health.checks.filter((c) => c.status !== "ok").length;
      const message = [
        "🧪 <b>Sensei health test alert</b>",
        "",
        `Overall status: <b>${health.overall}</b> (${failing} of ${health.checks.length} checks not green).`,
        "If you can read this, health alerts will reach you.",
      ].join("\n");

      await sendTelegramMessage(
        settings.telegramChatId,
        message,
        "HTML",
        undefined,
        settings.telegramTopicId ?? null,
      );
      return res.json({ sent: true, overall: health.overall });
    } catch (error) {
      console.error("Error sending health test alert:", error);
      return res.status(500).json({
        message: error instanceof Error ? error.message : "Failed to send test alert",
      });
    }
  });
}
