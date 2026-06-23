import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { z } from "zod";
import crypto from "crypto";
import { storage } from "./storage";
import { sendTestEmail, sendLeadAlertEmail } from "./sendgrid";
import { sendTestTelegramMessage, getTelegramUpdates, type TelegramUpdate } from "./telegram";
import { handleUpdate as handleTelegramUpdate } from "./telegram-bot";
import { scanForLeads, getScanProgress, enrichLeadWithWebSearch } from "./scanner";
import { ensureLeadFeedbackTable } from "./ensure-lead-feedback-table";
import { ensureContactMetaTable } from "./ensure-contact-meta-table";
import { listContacts, getContactArticles, updateContactMeta, createContactByName, createContactsFromLink, countDueContacts } from "./contacts";
import { migrateSavedLeads } from "./migrate-saved-leads";
import { ensureSavedLeadsTable } from "./ensure-saved-leads-table";
import { enrichSavedLead, formatEnrichmentForSavedLead } from "./founder-enrichment";
import { restartScheduler } from "./scheduler";
import { ensureIpoFilingsTable } from "./ensure-ipo-table";
import { ensureResearchCacheTable } from "./ensure-research-cache-table";
import { scanForIpoFilings, getAllIpoFilings, getIpoFilingById, backfillIpoAnalysis } from "./ipo-scanner";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { LeadStatus, IpoExchange } from "@shared/schema";
import { webauthnCredentials, authSessions, lifestyleSources, lifestyleArticles, lifestyleScrapeLog } from "@shared/schema";
import { db } from "./db";
import { eq, desc, sql } from "drizzle-orm";
import { getRecentLifestyleLeads, scanLifestylePipeline } from "./lifestyle-scanner";

// WebAuthn configuration. Host-specific values come from env so the app is
// deployable anywhere; the defaults preserve the current VPS host.
const RP_NAME = process.env.WEBAUTHN_RP_NAME || "Sensei";
const RP_ID = process.env.WEBAUTHN_RP_ID || "77.42.84.43.nip.io";
const ORIGIN = process.env.WEBAUTHN_ORIGIN || "https://news-sensei.77.42.84.43.nip.io";
const SESSION_COOKIE = "ns_auth";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Simple shared-password gate. Override via APP_PASSWORD. The session cookie set
// on success persists ~1 year, so the password is entered once per device.
const APP_PASSWORD = process.env.APP_PASSWORD || "openup";
const PASSWORD_SESSION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

// In-memory challenge store (challenge -> timestamp)
const challengeStore = new Map<string, number>();

// Clean expired challenges periodically
setInterval(() => {
  const now = Date.now();
  for (const [challenge, ts] of challengeStore) {
    if (now - ts > 5 * 60 * 1000) challengeStore.delete(challenge);
  }
}, 60 * 1000);

async function getCredentialCount(): Promise<number> {
  const creds = await db.select().from(webauthnCredentials);
  return creds.length;
}

async function validateSessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const sessions = await db.select().from(authSessions).where(eq(authSessions.token, token));
  if (sessions.length === 0) return false;
  return new Date(sessions[0].expiresAt) > new Date();
}

async function isAuthenticated(req: Request): Promise<boolean> {
  return validateSessionToken(req.cookies?.[SESSION_COOKIE]);
}

// Passkey registration is open ONLY for first-use setup (zero credentials).
// Once the owner is enrolled, new devices may be registered only by an already
// authenticated session — otherwise any internet visitor could self-enroll and
// gain a full session (auth bypass).
async function registrationAllowed(req: Request): Promise<boolean> {
  const count = await getCredentialCount();
  if (count === 0) return true;
  return isAuthenticated(req);
}

// Auth middleware - protect /api/* except /api/auth/* and /api/telegram-webhook
async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip auth routes, telegram webhook, and browser ingest
  if (req.path.startsWith("/api/auth/") || req.path === "/api/telegram-webhook" || req.path === "/api/browser-ingest") {
    return next();
  }
  // Only protect /api/* routes
  if (!req.path.startsWith("/api/")) {
    return next();
  }
  // Require a valid session for everything else (obtained via password login).
  const token = req.cookies?.[SESSION_COOKIE];
  const valid = await validateSessionToken(token);
  if (!valid) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

const updateLeadStatusSchema = z.object({
  status: z.enum(["new", "reviewed", "saved", "contacted", "dismissed"]),
});

const updateSettingsSchema = z.object({
  interestFilterPrompt: z.string().min(1, "Interest filter prompt cannot be empty").optional(),
  regions: z.array(z.string()).min(1).optional(),
  sourceTiers: z.record(z.enum(["tier1", "tier2", "tier3"])).optional(),
  summaryLength: z.enum(["brief", "detailed", "actionable"]).optional(),
  scanFrequency: z.enum(["hourly", "daily", "weekly", "manual"]).optional(),
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
  usePremiumScraping: z.boolean().optional(),
});

const updateSourceSchema = z.object({
  name: z.string().min(1).optional(),
  domain: z.string().min(1).optional(),
  tier: z.enum(["tier1", "tier2", "tier3"]).optional(),
  active: z.boolean().optional(),
  usePremiumScraping: z.boolean().optional(),
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
  // Liveness/readiness probe. Unauthenticated and not under /api, so it
  // bypasses authMiddleware; pings the DB so monitors can tell "listening but
  // DB down" from healthy. Registered first, before the catch-all/static route.
  app.get("/healthz", async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ status: "ok", db: "ok", uptime: process.uptime() });
    } catch {
      res.status(503).json({ status: "degraded", db: "down", uptime: process.uptime() });
    }
  });

  // Ensure saved_leads table exists
  try {
    const created = await ensureSavedLeadsTable();
    if (created) {
      console.log("saved_leads table was created");
    }
  } catch (error) {
    console.error("Error ensuring saved_leads table:", error);
  }

  // Ensure lead_feedback table exists
  try {
    await ensureLeadFeedbackTable();
  } catch (error) {
    console.error("Error ensuring lead_feedback table:", error);
  }

  // Ensure contact_meta table exists
  try {
    await ensureContactMetaTable();
  } catch (error) {
    console.error("Error ensuring contact_meta table:", error);
  }

  // Ensure ipo_filings table exists
  try {
    const created = await ensureIpoFilingsTable();
    if (created) {
      console.log("ipo_filings table was created");
    }
  } catch (error) {
    console.error("Error ensuring ipo_filings table:", error);
  }

  // Ensure research_cache table exists
  try {
    const created = await ensureResearchCacheTable();
    if (created) {
      console.log("research_cache table was created");
    }
  } catch (error) {
    console.error("Error ensuring research_cache table:", error);
  }

  // Ensure webauthn tables exist
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      device_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`);
    await db.execute(`CREATE TABLE IF NOT EXISTS auth_sessions (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      token TEXT NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
      expires_at TIMESTAMP NOT NULL
    )`);
  } catch (error) {
    console.error("Error ensuring auth tables:", error);
  }

  // Register auth middleware
  app.use(authMiddleware);

  // Auth routes
  app.get("/api/auth/status", async (req, res) => {
    try {
      const count = await getCredentialCount();
      const token = req.cookies?.[SESSION_COOKIE];
      const isAuthenticated = await validateSessionToken(token);
      res.json({ isSetup: count > 0, isAuthenticated });
    } catch (error) {
      console.error("Error checking auth status:", error);
      res.status(500).json({ error: "Failed to check auth status" });
    }
  });

  // Simple password login: on the right password, mint a long-lived session.
  app.post("/api/auth/password-login", async (req, res) => {
    try {
      const { password } = req.body ?? {};
      if (typeof password !== "string" || password !== APP_PASSWORD) {
        return res.status(401).json({ error: "Incorrect password" });
      }
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + PASSWORD_SESSION_MAX_AGE_MS);
      await db.insert(authSessions).values({ token, expiresAt });
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge: PASSWORD_SESSION_MAX_AGE_MS,
        path: "/",
      });
      res.json({ ok: true });
    } catch (error) {
      console.error("Error in password login:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/api/auth/register-options", async (req, res) => {
    try {
      if (!(await registrationAllowed(req))) {
        return res.status(403).json({ error: "Registration is closed: owner already enrolled" });
      }
      const existingCreds = await db.select().from(webauthnCredentials);
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: RP_ID,
        userName: "owner",
        userDisplayName: "Owner",
        attestationType: "none",
        excludeCredentials: existingCreds.map(c => ({
          id: c.credentialId,
          type: "public-key" as const,
        })),
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "preferred",
        },
      });
      challengeStore.set(options.challenge, Date.now());
      res.json(options);
    } catch (error) {
      console.error("Error generating registration options:", error);
      res.status(500).json({ error: "Failed to generate registration options" });
    }
  });

  app.post("/api/auth/register-verify", async (req, res) => {
    try {
      if (!(await registrationAllowed(req))) {
        return res.status(403).json({ error: "Registration is closed: owner already enrolled" });
      }
      const { body: regResponse, deviceName } = req.body;
      // Find matching challenge
      let matchedChallenge: string | undefined;
      for (const [challenge] of challengeStore) {
        matchedChallenge = challenge;
        break;
      }
      if (!matchedChallenge) {
        return res.status(400).json({ error: "No pending challenge" });
      }
      const verification = await verifyRegistrationResponse({
        response: regResponse,
        expectedChallenge: matchedChallenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
      });
      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: "Verification failed" });
      }
      challengeStore.delete(matchedChallenge);
      const { credential } = verification.registrationInfo;
      // Store credential - encode binary fields as base64
      await db.insert(webauthnCredentials).values({
        credentialId: Buffer.from(credential.id).toString("base64url"),
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        deviceName: deviceName || "Unknown Device",
      });
      // Create session
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
      await db.insert(authSessions).values({ token, expiresAt });
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge: SESSION_MAX_AGE_MS,
        path: "/",
      });
      res.json({ verified: true });
    } catch (error) {
      console.error("Error verifying registration:", error);
      res.status(500).json({ error: "Failed to verify registration" });
    }
  });

  app.post("/api/auth/login-options", async (req, res) => {
    try {
      const creds = await db.select().from(webauthnCredentials);
      const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        allowCredentials: creds.map(c => ({
          id: c.credentialId,
          type: "public-key" as const,
        })),
        userVerification: "preferred",
      });
      challengeStore.set(options.challenge, Date.now());
      res.json(options);
    } catch (error) {
      console.error("Error generating login options:", error);
      res.status(500).json({ error: "Failed to generate login options" });
    }
  });

  app.post("/api/auth/login-verify", async (req, res) => {
    try {
      const authResponse = req.body;
      // Find the credential
      const credentialId = authResponse.id;
      const creds = await db.select().from(webauthnCredentials);
      const cred = creds.find(c => c.credentialId === credentialId);
      if (!cred) {
        return res.status(400).json({ error: "Credential not found" });
      }
      // Find matching challenge
      let matchedChallenge: string | undefined;
      for (const [challenge] of challengeStore) {
        matchedChallenge = challenge;
        break;
      }
      if (!matchedChallenge) {
        return res.status(400).json({ error: "No pending challenge" });
      }
      const verification = await verifyAuthenticationResponse({
        response: authResponse,
        expectedChallenge: matchedChallenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: {
          id: cred.credentialId,
          publicKey: Buffer.from(cred.publicKey, "base64url"),
          counter: cred.counter,
        },
      });
      if (!verification.verified) {
        return res.status(400).json({ error: "Verification failed" });
      }
      challengeStore.delete(matchedChallenge);
      // Update counter
      await db.update(webauthnCredentials)
        .set({ counter: verification.authenticationInfo.newCounter })
        .where(eq(webauthnCredentials.credentialId, cred.credentialId));
      // Create session
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
      await db.insert(authSessions).values({ token, expiresAt });
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge: SESSION_MAX_AGE_MS,
        path: "/",
      });
      res.json({ verified: true });
    } catch (error) {
      console.error("Error verifying login:", error);
      res.status(500).json({ error: "Failed to verify login" });
    }
  });

  app.post("/api/auth/logout", async (req, res) => {
    try {
      const token = req.cookies?.[SESSION_COOKIE];
      if (token) {
        await db.delete(authSessions).where(eq(authSessions.token, token));
      }
      res.clearCookie(SESSION_COOKIE, { path: "/" });
      res.json({ success: true });
    } catch (error) {
      console.error("Error logging out:", error);
      res.status(500).json({ error: "Failed to logout" });
    }
  });

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

  // Feedback on a lead. "bad" feedback is stored (with a snapshot for training)
  // and the lead is dismissed so it leaves the feed; recent bad feedback is fed
  // back into the scan filter prompts (see feedback-prompt.ts).
  app.post("/api/leads/:id/feedback", async (req, res) => {
    try {
      const { rating, reason, note } = req.body ?? {};
      if (rating !== "bad" && rating !== "good") {
        return res.status(400).json({ error: "rating must be 'bad' or 'good'" });
      }
      const lead = await storage.getLeadById(req.params.id);
      const fb = await storage.createLeadFeedback({
        leadId: req.params.id,
        rating,
        reason: typeof reason === "string" ? reason.slice(0, 80) : null,
        note: typeof note === "string" ? note.slice(0, 500) : null,
        headline: lead?.headline ?? null,
        category: lead?.category ?? null,
        region: lead?.region ?? null,
        companyNames: lead?.companyNames ?? null,
        founderNames: lead?.founderNames ?? null,
      });
      if (rating === "bad" && lead) {
        await storage.updateLeadStatus(req.params.id, "dismissed");
      }
      res.json({ ok: true, id: fb.id });
    } catch (error) {
      console.error("Error saving lead feedback:", error);
      res.status(500).json({ error: "Failed to save feedback" });
    }
  });

  // Manual on-demand enrichment for a feed lead (founder bio / LinkedIn / company
  // description via web search). Lifestyle leads don't get this during scan.
  app.post("/api/leads/:id/enrich", async (req, res) => {
    try {
      const lead = await storage.getLeadById(req.params.id);
      if (!lead) return res.status(404).json({ error: "Lead not found" });
      const result = await enrichLeadWithWebSearch(
        lead.companyNames || [],
        lead.founderNames || [],
        lead.region || "Singapore",
      );
      const updated = await storage.updateLead(req.params.id, {
        founderLinkedInUrl: result.founderLinkedInUrl,
        founderBio: result.founderBio,
        companyDescription: result.companyDescription,
        enrichmentData: result.enrichmentData,
      });
      res.json(updated);
    } catch (error) {
      console.error("Error enriching lead:", error);
      res.status(500).json({ error: "Enrichment failed" });
    }
  });

  // Feedback insights — what's been flagged and how it's shaping the filter.
  app.get("/api/feedback", async (_req, res) => {
    try {
      res.json(await storage.getFeedbackInsights());
    } catch (error) {
      console.error("Error fetching feedback insights:", error);
      res.status(500).json({ error: "Failed to fetch feedback" });
    }
  });

  // ---- Contacts (person-centric layer over the people table) ----
  app.get("/api/contacts/due-count", async (_req, res) => {
    try { res.json({ count: await countDueContacts() }); }
    catch { res.json({ count: 0 }); }
  });

  app.get("/api/contacts", async (req, res) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : "active";
      const search = typeof req.query.search === "string" ? req.query.search : undefined;
      res.json(await listContacts(status, search));
    } catch (error) {
      console.error("Error listing contacts:", error);
      res.status(500).json({ error: "Failed to list contacts" });
    }
  });

  app.get("/api/contacts/:id/articles", async (req, res) => {
    try {
      const personId = parseInt(req.params.id, 10);
      if (!Number.isFinite(personId)) return res.status(400).json({ error: "Invalid id" });
      res.json(await getContactArticles(personId));
    } catch (error) {
      console.error("Error fetching contact articles:", error);
      res.status(500).json({ error: "Failed to fetch articles" });
    }
  });

  app.patch("/api/contacts/:id", async (req, res) => {
    try {
      const personId = parseInt(req.params.id, 10);
      if (!Number.isFinite(personId)) return res.status(400).json({ error: "Invalid id" });
      const { status, email, remindInDays, remindAt, notes } = req.body ?? {};
      const fields: { status?: string; email?: string | null; remindAt?: Date | null; notes?: string | null } = {};
      if (status === "active" || status === "saved" || status === "deleted") fields.status = status;
      if (typeof email === "string") fields.email = email.trim() || null;
      if (typeof notes === "string") fields.notes = notes;
      if (remindAt === null) fields.remindAt = null;
      else if (typeof remindAt === "string") fields.remindAt = new Date(remindAt);
      else if (typeof remindInDays === "number" && remindInDays > 0) fields.remindAt = new Date(Date.now() + remindInDays * 86400000);
      res.json(await updateContactMeta(personId, fields));
    } catch (error) {
      console.error("Error updating contact:", error);
      res.status(500).json({ error: "Failed to update contact" });
    }
  });

  app.post("/api/contacts", async (req, res) => {
    try {
      const { name } = req.body ?? {};
      if (typeof name !== "string" || name.trim().length < 2) return res.status(400).json({ error: "name required" });
      res.json(await createContactByName(name.trim()));
    } catch (error) {
      console.error("Error creating contact:", error);
      res.status(500).json({ error: "Failed to create contact" });
    }
  });

  app.post("/api/contacts/from-link", async (req, res) => {
    try {
      const { url } = req.body ?? {};
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "valid http(s) url required" });
      res.json(await createContactsFromLink(url.trim()));
    } catch (error) {
      console.error("Error creating contacts from link:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
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

      // Restart scheduler if scan frequency was changed
      if (parsed.data.scanFrequency !== undefined) {
        console.log(`Scan frequency changed to ${parsed.data.scanFrequency}, restarting scheduler...`);
        await restartScheduler();
      }

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
      await sendTestTelegramMessage(settings.telegramChatId, settings.telegramTopicId);
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

  // Telegram webhook endpoint - receives updates pushed by Telegram
  app.post("/api/telegram-webhook", async (req, res) => {
    try {
      // Verify the request came from Telegram (only when a secret is configured;
      // see setWebhook, which registers the same secret_token).
      const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
      if (webhookSecret && req.headers["x-telegram-bot-api-secret-token"] !== webhookSecret) {
        return res.status(401).json({ error: "Invalid webhook secret" });
      }

      const update = req.body as TelegramUpdate;

      if (!update || !update.update_id) {
        console.warn('Telegram webhook received invalid payload:', JSON.stringify(req.body).slice(0, 200));
        return res.status(400).json({ error: "Invalid update payload" });
      }

      console.log(`Telegram webhook received update ${update.update_id}`, {
        hasMessage: !!update.message,
        hasCallback: !!update.callback_query,
        callbackData: update.callback_query?.data,
      });

      // Process the update asynchronously so we respond to Telegram quickly.
      // Telegram requires a 200 response within a few seconds or it will retry.
      handleTelegramUpdate(update).catch((error) => {
        console.error('Error processing Telegram webhook update:', error);
      });

      // Always respond 200 to Telegram to prevent retries
      res.status(200).json({ ok: true });
    } catch (error) {
      console.error('Error in Telegram webhook handler:', error);
      // Still respond 200 to prevent Telegram from retrying
      res.status(200).json({ ok: true });
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

  // IPO Filings endpoints
  app.get("/api/ipo-filings", async (req, res) => {
    try {
      const exchange = req.query.exchange as IpoExchange | undefined;
      const filings = await getAllIpoFilings(exchange);
      res.json(filings);
    } catch (error) {
      console.error("Error fetching IPO filings:", error);
      res.status(500).json({ error: "Failed to fetch IPO filings" });
    }
  });

  app.get("/api/ipo-filings/:id", async (req, res) => {
    try {
      const filing = await getIpoFilingById(req.params.id);
      if (!filing) {
        return res.status(404).json({ error: "IPO filing not found" });
      }
      res.json(filing);
    } catch (error) {
      console.error("Error fetching IPO filing:", error);
      res.status(500).json({ error: "Failed to fetch IPO filing" });
    }
  });

  app.post("/api/ipo-scan", async (req, res) => {
    try {
      const result = await scanForIpoFilings();
      res.json(result);
    } catch (error) {
      console.error("Error triggering IPO scan:", error);
      res.status(500).json({ error: "Failed to trigger IPO scan" });
    }
  });

  app.post("/api/ipo-backfill", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const count = await backfillIpoAnalysis(limit);
      res.json({ enriched: count });
    } catch (error) {
      console.error("Error backfilling IPO analysis:", error);
      res.status(500).json({ error: "Failed to backfill IPO analysis" });
    }
  });

  // Lifestyle leads (read) — surfaces ingested + scored lifestyle articles for /lifestyle-leads page
  app.get("/api/lifestyle-leads", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const leads = await getRecentLifestyleLeads(limit);
      res.json(leads);
    } catch (error) {
      console.error("Error fetching lifestyle leads:", error);
      res.status(500).json({ error: "Failed to fetch lifestyle leads" });
    }
  });

  // Manual lifestyle scan trigger
  app.post("/api/lifestyle-scan", async (_req, res) => {
    try {
      const result = await scanLifestylePipeline();
      res.json(result);
    } catch (error) {
      console.error("Error running lifestyle scan:", error);
      res.status(500).json({ error: "Failed to run lifestyle scan" });
    }
  });

  // Browser ingest endpoint for Mac Mini lifestyle scraper
  app.post("/api/browser-ingest", async (req, res) => {
    try {
      // Shared-secret gate (only enforced when BROWSER_INGEST_SECRET is set).
      // This endpoint is unauthenticated by design (called by the browser
      // extension), so without a secret anyone could inject articles.
      const ingestSecret = process.env.BROWSER_INGEST_SECRET;
      if (ingestSecret && req.headers["x-ingest-secret"] !== ingestSecret) {
        return res.status(401).json({ error: "Invalid ingest secret" });
      }

      const { slug, articles } = req.body;
      if (!slug || !Array.isArray(articles)) {
        return res.status(400).json({ error: "slug and articles array required" });
      }

      const [source] = await db.select().from(lifestyleSources).where(eq(lifestyleSources.slug, slug)).limit(1);
      if (!source) {
        return res.status(404).json({ error: `Source not found: ${slug}` });
      }

      let inserted = 0;
      const now = new Date();

      for (const article of articles) {
        if (!article.url || !article.title) continue;
        try {
          await db.insert(lifestyleArticles).values({
            sourceId: source.id,
            url: article.url,
            title: article.title,
            status: "pending",
            publishedAt: article.publishedAt ? new Date(article.publishedAt) : now,
          }).onConflictDoNothing();
          inserted++;
        } catch {
          // skip duplicates
        }
      }

      await db.insert(lifestyleScrapeLog).values({
        publicationId: source.id,
        method: "browser",
        articlesFound: articles.length,
        articlesNew: inserted,
        completedAt: now,
      });

      res.json({ slug, articlesReceived: articles.length, articlesInserted: inserted });
    } catch (error) {
      console.error("Error in browser ingest:", error);
      res.status(500).json({ error: "Failed to ingest articles" });
    }
  });

  return httpServer;
}
