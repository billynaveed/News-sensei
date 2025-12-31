import type { Express } from "express";
import { createServer, type Server } from "http";
import { z } from "zod";
import { storage } from "./storage";
import { sendTestEmail, sendLeadAlertEmail } from "./sendgrid";
import { scanForLeads } from "./scanner";
import type { LeadStatus } from "@shared/schema";

const updateLeadStatusSchema = z.object({
  status: z.enum(["new", "reviewed", "saved", "contacted", "dismissed"]),
});

const updateSettingsSchema = z.object({
  keywords: z.array(z.string()).min(1).optional(),
  regions: z.array(z.string()).min(1).optional(),
  sourceTiers: z.record(z.string()).optional(),
  summaryLength: z.enum(["brief", "detailed", "actionable"]).optional(),
  emailFrequency: z.enum(["hourly", "daily", "weekly"]).optional(),
  emailEnabled: z.boolean().optional(),
  alertEmail: z.string().email().optional(),
});

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Leads endpoints
  app.get("/api/leads", async (req, res) => {
    try {
      const leads = await storage.getAllLeads();
      res.json(leads);
    } catch (error) {
      console.error("Error fetching leads:", error);
      res.status(500).json({ error: "Failed to fetch leads" });
    }
  });

  app.get("/api/leads/stats", async (req, res) => {
    try {
      const stats = await storage.getLeadsStats();
      res.json(stats);
    } catch (error) {
      console.error("Error fetching lead stats:", error);
      res.status(500).json({ error: "Failed to fetch lead stats" });
    }
  });

  app.get("/api/leads/:id", async (req, res) => {
    try {
      const lead = await storage.getLeadById(req.params.id);
      if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
      }
      res.json(lead);
    } catch (error) {
      console.error("Error fetching lead:", error);
      res.status(500).json({ error: "Failed to fetch lead" });
    }
  });

  app.patch("/api/leads/:id", async (req, res) => {
    try {
      const parsed = updateLeadStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid status", details: parsed.error.errors });
      }
      const lead = await storage.updateLeadStatus(req.params.id, parsed.data.status);
      if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
      }
      res.json(lead);
    } catch (error) {
      console.error("Error updating lead:", error);
      res.status(500).json({ error: "Failed to update lead" });
    }
  });

  // Settings endpoints
  app.get("/api/settings", async (req, res) => {
    try {
      const settings = await storage.getSettings();
      res.json(settings);
    } catch (error) {
      console.error("Error fetching settings:", error);
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  app.put("/api/settings", async (req, res) => {
    try {
      const parsed = updateSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid settings", details: parsed.error.errors });
      }
      const settings = await storage.upsertSettings(parsed.data);
      res.json(settings);
    } catch (error) {
      console.error("Error updating settings:", error);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });

  // Scan logs endpoints
  app.get("/api/scan-logs", async (req, res) => {
    try {
      const logs = await storage.getAllScanLogs();
      res.json(logs);
    } catch (error) {
      console.error("Error fetching scan logs:", error);
      res.status(500).json({ error: "Failed to fetch scan logs" });
    }
  });

  // Trigger scan endpoint
  app.post("/api/scan", async (req, res) => {
    try {
      const result = await scanForLeads();
      res.json(result);
    } catch (error) {
      console.error("Error triggering scan:", error);
      res.status(500).json({ error: "Failed to trigger scan" });
    }
  });

  // Test email endpoint
  app.post("/api/test-email", async (req, res) => {
    try {
      const settings = await storage.getSettings();
      if (!settings?.alertEmail) {
        return res.status(400).json({ error: "No alert email configured" });
      }
      await sendTestEmail(settings.alertEmail);
      res.json({ success: true, message: "Test email sent" });
    } catch (error) {
      console.error("Error sending test email:", error);
      res.status(500).json({ error: "Failed to send test email" });
    }
  });

  return httpServer;
}
