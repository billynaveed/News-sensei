import type { Express } from "express";
import { createServer, type Server } from "http";
import { z } from "zod";
import { storage } from "./storage";
import { sendTestEmail, sendLeadAlertEmail } from "./sendgrid";
import { sendTestTelegramMessage, getTelegramUpdates } from "./telegram";
import { scanForLeads, getScanProgress } from "./scanner";
import { migrateSavedLeads } from "./migrate-saved-leads";
import { ensureSavedLeadsTable } from "./ensure-saved-leads-table";
import { enrichSavedLead, formatEnrichmentForSavedLead } from "./founder-enrichment";
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
  telegramEnabled: z.boolean().optional(),
  telegramChatId: z.string().optional(),
  logRetentionDays: z.number().min(1).max(30).optional(),
  googleNewsEnabled: z.boolean().optional(),
  rssEnabled: z.boolean().optional(),
  scrapingBeeEnabled: z.boolean().optional(),
});

const createSourceSchema = z.object({
  name: z.string().min(1),
  domain: z.string().min(1),
  tier: z.enum(["tier1", "tier2", "tier3"]),
  active: z.boolean().optional(),
});

const updateSourceSchema = z.object({
  name: z.string().min(1).optional(),
  domain: z.string().min(1).optional(),
  tier: z.enum(["tier1", "tier2", "tier3"]).optional(),
  active: z.boolean().optional(),
});

const createRssFeedSchema = z.object({
  sourceId: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
  active: z.boolean().optional(),
});

const updateRssFeedSchema = z.object({
  name: z.string().min(1).optional(),
  url: z.string().url().optional(),
  active: z.boolean().optional(),
});

const createSavedLeadSchema = z.object({
  leadId: z.string().min(1),
  founderLinkedInUrl: z.string().url().optional().or(z.literal("")),
  founderBio: z.string().optional(),
  companyDescription: z.string().optional(),
  notes: z.string().optional(),
  researchData: z.record(z.any()).optional(),
});

const updateSavedLeadSchema = z.object({
  founderLinkedInUrl: z.string().url().optional().or(z.literal("")),
  founderBio: z.string().optional(),
  companyDescription: z.string().optional(),
  notes: z.string().optional(),
  researchData: z.record(z.any()).optional(),
});

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Ensure saved_leads table exists
  try {
    const created = await ensureSavedLeadsTable();
    if (created) {
      console.log("saved_leads table was created");
    }
  } catch (error) {
    console.error("Error ensuring saved_leads table:", error);
  }

  // Seed default sources and run log cleanup on startup
  try {
    await storage.seedDefaultSources();
    console.log("Default sources seeded");
  } catch (error) {
    console.error("Error seeding default sources:", error);
  }

  try {
    const settings = await storage.getSettings();
    if (settings) {
      const deletedCount = await storage.cleanupOldScanLogs(settings.logRetentionDays ?? 2);
      if (deletedCount > 0) {
        console.log(`Cleaned up ${deletedCount} old scan logs on startup`);
      }
    }
  } catch (error) {
    console.error("Error cleaning up scan logs on startup:", error);
  }

  // Migrate existing saved leads to new table on startup
  try {
    const migrationResult = await migrateSavedLeads();
    if (migrationResult.migrated > 0) {
      console.log(`Migrated ${migrationResult.migrated} saved leads to new table`);
    }
  } catch (error) {
    console.error("Error migrating saved leads on startup:", error);
  }

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

  app.get("/api/scan-logs/:id", async (req, res) => {
    try {
      const log = await storage.getScanLogById(req.params.id);
      if (!log) {
        return res.status(404).json({ error: "Scan log not found" });
      }
      res.json(log);
    } catch (error) {
      console.error("Error fetching scan log:", error);
      res.status(500).json({ error: "Failed to fetch scan log" });
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

  // Scan progress endpoint
  app.get("/api/scan-progress/:scanId", async (req, res) => {
    try {
      const progress = getScanProgress(req.params.scanId);
      if (!progress) {
        return res.json({ status: "not_found" });
      }
      res.json(progress);
    } catch (error) {
      console.error("Error fetching scan progress:", error);
      res.status(500).json({ error: "Failed to fetch scan progress" });
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

  // Test Telegram endpoint
  app.post("/api/test-telegram", async (req, res) => {
    try {
      const settings = await storage.getSettings();
      if (!settings?.telegramChatId) {
        return res.status(400).json({ error: "No Telegram chat ID configured" });
      }
      await sendTestTelegramMessage(settings.telegramChatId);
      res.json({ success: true, message: "Test Telegram message sent" });
    } catch (error: any) {
      console.error("Error sending test Telegram message:", error);
      res.status(500).json({ error: error.message || "Failed to send Telegram message" });
    }
  });

  // Get Telegram chat ID from recent messages
  app.get("/api/telegram-chat-id", async (req, res) => {
    try {
      const updates = await getTelegramUpdates();
      if (updates.length === 0) {
        return res.json({ chatId: null, message: "No messages found. Please send a message to the bot first." });
      }
      // Get the most recent chat ID
      const latestUpdate = updates[updates.length - 1];
      const chatId = latestUpdate.message?.chat?.id?.toString() || 
                     latestUpdate.channel_post?.chat?.id?.toString();
      res.json({ chatId, updates: updates.slice(-3) });
    } catch (error: any) {
      console.error("Error getting Telegram updates:", error);
      res.status(500).json({ error: error.message || "Failed to get Telegram updates" });
    }
  });

  // Sources endpoints
  app.get("/api/sources", async (req, res) => {
    try {
      const sources = await storage.getAllSources();
      res.json(sources);
    } catch (error) {
      console.error("Error fetching sources:", error);
      res.status(500).json({ error: "Failed to fetch sources" });
    }
  });

  app.get("/api/sources/:id", async (req, res) => {
    try {
      const source = await storage.getSourceById(req.params.id);
      if (!source) {
        return res.status(404).json({ error: "Source not found" });
      }
      res.json(source);
    } catch (error) {
      console.error("Error fetching source:", error);
      res.status(500).json({ error: "Failed to fetch source" });
    }
  });

  app.post("/api/sources", async (req, res) => {
    try {
      const parsed = createSourceSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid source data", details: parsed.error.errors });
      }
      const source = await storage.createSource(parsed.data);
      res.status(201).json(source);
    } catch (error) {
      console.error("Error creating source:", error);
      res.status(500).json({ error: "Failed to create source" });
    }
  });

  app.patch("/api/sources/:id", async (req, res) => {
    try {
      const parsed = updateSourceSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid source data", details: parsed.error.errors });
      }
      const source = await storage.updateSource(req.params.id, parsed.data);
      if (!source) {
        return res.status(404).json({ error: "Source not found" });
      }
      res.json(source);
    } catch (error) {
      console.error("Error updating source:", error);
      res.status(500).json({ error: "Failed to update source" });
    }
  });

  app.delete("/api/sources/:id", async (req, res) => {
    try {
      const deleted = await storage.deleteSource(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: "Source not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting source:", error);
      res.status(500).json({ error: "Failed to delete source" });
    }
  });

  // RSS Feeds endpoints
  app.get("/api/sources/:sourceId/rss-feeds", async (req, res) => {
    try {
      const feeds = await storage.getRssFeedsBySourceId(req.params.sourceId);
      res.json(feeds);
    } catch (error) {
      console.error("Error fetching RSS feeds:", error);
      res.status(500).json({ error: "Failed to fetch RSS feeds" });
    }
  });

  app.get("/api/rss-feeds", async (req, res) => {
    try {
      const feeds = await storage.getAllActiveRssFeeds();
      res.json(feeds);
    } catch (error) {
      console.error("Error fetching all RSS feeds:", error);
      res.status(500).json({ error: "Failed to fetch RSS feeds" });
    }
  });

  app.post("/api/rss-feeds", async (req, res) => {
    try {
      const parsed = createRssFeedSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid RSS feed data", details: parsed.error.errors });
      }
      const feed = await storage.createRssFeed(parsed.data);
      res.status(201).json(feed);
    } catch (error) {
      console.error("Error creating RSS feed:", error);
      res.status(500).json({ error: "Failed to create RSS feed" });
    }
  });

  app.patch("/api/rss-feeds/:id", async (req, res) => {
    try {
      const parsed = updateRssFeedSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid RSS feed data", details: parsed.error.errors });
      }
      const feed = await storage.updateRssFeed(req.params.id, parsed.data);
      if (!feed) {
        return res.status(404).json({ error: "RSS feed not found" });
      }
      res.json(feed);
    } catch (error) {
      console.error("Error updating RSS feed:", error);
      res.status(500).json({ error: "Failed to update RSS feed" });
    }
  });

  app.delete("/api/rss-feeds/:id", async (req, res) => {
    try {
      const deleted = await storage.deleteRssFeed(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: "RSS feed not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting RSS feed:", error);
      res.status(500).json({ error: "Failed to delete RSS feed" });
    }
  });

  // Saved Leads endpoints
  app.get("/api/saved-leads", async (req, res) => {
    try {
      const savedLeads = await storage.getAllSavedLeads();
      res.json(savedLeads);
    } catch (error) {
      console.error("Error fetching saved leads:", error);
      res.status(500).json({ error: "Failed to fetch saved leads" });
    }
  });

  app.get("/api/saved-leads/:id", async (req, res) => {
    try {
      const savedLead = await storage.getSavedLeadById(req.params.id);
      if (!savedLead) {
        return res.status(404).json({ error: "Saved lead not found" });
      }
      res.json(savedLead);
    } catch (error) {
      console.error("Error fetching saved lead:", error);
      res.status(500).json({ error: "Failed to fetch saved lead" });
    }
  });

  app.post("/api/saved-leads", async (req, res) => {
    try {
      const parsed = createSavedLeadSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid saved lead data", details: parsed.error.errors });
      }

      // Check if this lead is already saved
      const existing = await storage.getSavedLeadByLeadId(parsed.data.leadId);
      if (existing) {
        return res.status(409).json({ error: "Lead is already saved" });
      }

      const savedLead = await storage.createSavedLead(parsed.data);
      res.status(201).json(savedLead);
    } catch (error) {
      console.error("Error creating saved lead:", error);
      res.status(500).json({ error: "Failed to save lead" });
    }
  });

  app.patch("/api/saved-leads/:id", async (req, res) => {
    try {
      const parsed = updateSavedLeadSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid saved lead data", details: parsed.error.errors });
      }
      const savedLead = await storage.updateSavedLead(req.params.id, parsed.data);
      if (!savedLead) {
        return res.status(404).json({ error: "Saved lead not found" });
      }
      res.json(savedLead);
    } catch (error) {
      console.error("Error updating saved lead:", error);
      res.status(500).json({ error: "Failed to update saved lead" });
    }
  });

  app.delete("/api/saved-leads/:id", async (req, res) => {
    try {
      const deleted = await storage.deleteSavedLead(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: "Saved lead not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting saved lead:", error);
      res.status(500).json({ error: "Failed to delete saved lead" });
    }
  });

  // Enrich saved lead with founder and company information
  app.post("/api/saved-leads/:id/enrich", async (req, res) => {
    try {
      const savedLead = await storage.getSavedLeadById(req.params.id);
      if (!savedLead) {
        return res.status(404).json({ error: "Saved lead not found" });
      }

      const lead = savedLead.lead;

      // Run enrichment
      const enrichment = await enrichSavedLead({
        companyNames: lead.companyNames,
        founderNames: lead.founderNames,
        region: lead.region,
      });

      // Format and update saved lead
      const enrichedData = formatEnrichmentForSavedLead(enrichment);
      const updated = await storage.updateSavedLead(req.params.id, enrichedData);

      res.json({
        success: true,
        savedLead: updated,
        enrichment: {
          founderConfidence: enrichment.founders[0]?.confidence || "low",
          companyConfidence: enrichment.companies[0]?.confidence || "low",
        },
      });
    } catch (error) {
      console.error("Error enriching saved lead:", error);
      res.status(500).json({ error: "Failed to enrich saved lead" });
    }
  });

  // Migration endpoint (manual trigger if needed)
  app.post("/api/migrate-saved-leads", async (req, res) => {
    try {
      const result = await migrateSavedLeads();
      res.json(result);
    } catch (error) {
      console.error("Error running migration:", error);
      res.status(500).json({ error: "Failed to run migration" });
    }
  });

  // Debug endpoints for ScrapingBee API visibility
  app.get("/api/scan-debug/latest", async (req, res) => {
    try {
      const logs = await storage.getAllScanLogs();
      if (logs.length === 0) {
        return res.json({ scanLog: null, debugEntries: [] });
      }
      const latestLog = logs[0];
      res.json({
        scanLog: latestLog,
        debugEntries: latestLog.scrapingBeeDebug || [],
      });
    } catch (error) {
      console.error("Error fetching latest debug data:", error);
      res.status(500).json({ error: "Failed to fetch debug data" });
    }
  });

  app.get("/api/scan-debug/:scanId", async (req, res) => {
    try {
      const log = await storage.getScanLogById(req.params.scanId);
      if (!log) {
        return res.status(404).json({ error: "Scan log not found" });
      }
      res.json({
        scanLog: log,
        debugEntries: log.scrapingBeeDebug || [],
      });
    } catch (error) {
      console.error("Error fetching debug data:", error);
      res.status(500).json({ error: "Failed to fetch debug data" });
    }
  });

  return httpServer;
}
