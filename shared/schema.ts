import { pgTable, text, varchar, integer, timestamp, boolean, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

// Users table
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Lead status enum
export type LeadStatus = "new" | "reviewed" | "saved" | "contacted" | "dismissed";
export type PriorityLevel = "high" | "medium" | "low";
export type SourceTier = "tier1" | "tier2" | "tier3";

// Leads table - the main data model for news article matches
export const leads = pgTable("leads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  headline: text("headline").notNull(),
  sourceUrl: text("source_url").notNull(),
  sourceName: text("source_name").notNull(),
  sourceTier: text("source_tier").notNull().$type<SourceTier>(),
  publishedAt: timestamp("published_at").notNull(),
  companyNames: text("company_names").array().notNull(),
  founderNames: text("founder_names").array().notNull(),
  investors: text("investors").array(),
  aiSummary: text("ai_summary").notNull(),
  matchedKeywords: text("matched_keywords").array().notNull(),
  priorityScore: integer("priority_score").notNull(),
  priorityLevel: text("priority_level").notNull().$type<PriorityLevel>(),
  region: text("region").notNull(),
  status: text("status").notNull().$type<LeadStatus>().default("new"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertLeadSchema = createInsertSchema(leads).omit({
  id: true,
  createdAt: true,
});

export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leads.$inferSelect;

// Settings table - stores user preferences
export const settings = pgTable("settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  keywords: text("keywords").array().notNull(),
  regions: text("regions").array().notNull(),
  sourceTiers: json("source_tiers").$type<Record<string, SourceTier>>().notNull(),
  summaryLength: text("summary_length").notNull().default("brief"),
  emailFrequency: text("email_frequency").notNull().default("daily"),
  emailEnabled: boolean("email_enabled").notNull().default(true),
  alertEmail: text("alert_email").notNull(),
  logRetentionDays: integer("log_retention_days").notNull().default(2),
  useScrapingBee: boolean("use_scraping_bee").notNull().default(false),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertSettingsSchema = createInsertSchema(settings).omit({
  id: true,
  updatedAt: true,
});

export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settings.$inferSelect;

// Source type for ingestion method
export type SourceType = "rss" | "api" | "scrape" | "manual";

// News sources configuration
export const sources = pgTable("sources", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  url: text("url").notNull(),
  rssUrl: text("rss_url"),
  tier: text("tier").notNull().$type<SourceTier>(),
  type: text("type").notNull().$type<SourceType>().default("manual"),
  region: text("region").notNull().default("Singapore"),
  description: text("description"),
  enabled: boolean("enabled").notNull().default(true),
});

export const insertSourceSchema = createInsertSchema(sources).omit({
  id: true,
});

export type InsertSource = z.infer<typeof insertSourceSchema>;
export type Source = typeof sources.$inferSelect;

// Debug entry for ScrapingBee API calls
export interface ScrapingBeeDebugEntry {
  sourceName: string;
  sourceId: string;
  timestamp: string;
  method: "scrapingbee" | "rss" | "fallback_rss";
  request: {
    url: string;
    renderJs: boolean;
    extractRules: string;
  };
  response: {
    status: number;
    statusText: string;
    latencyMs: number;
    rawResponseSnippet: string;  // First 3KB of response
    extractedCount: number;
    matchedCount: number;
  };
  error?: string;
  fallbackReason?: string;
}

// Types for detailed scan log information
export interface SourceSearched {
  name: string;
  tier: SourceTier;
  articlesFound: number;
}

export interface ArticleProcessed {
  headline: string;
  source: string;
  region: string;
  status: "success" | "skipped" | "error";
  reason?: string;
}

// Scan logs for tracking scraping activity
export const scanLogs = pgTable("scan_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  scannedAt: timestamp("scanned_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  articlesScanned: integer("articles_scanned").notNull(),
  matchesFound: integer("matches_found").notNull(),
  newLeads: integer("new_leads").notNull(),
  duplicatesSkipped: integer("duplicates_skipped").notNull(),
  durationMs: integer("duration_ms"),
  sourcesSearched: json("sources_searched").$type<SourceSearched[]>(),
  articlesProcessed: json("articles_processed").$type<ArticleProcessed[]>(),
  errors: text("errors").array(),
  scrapingBeeDebug: json("scraping_bee_debug").$type<ScrapingBeeDebugEntry[]>(),
});

export const insertScanLogSchema = createInsertSchema(scanLogs).omit({
  id: true,
  scannedAt: true,
});

export type InsertScanLog = z.infer<typeof insertScanLogSchema>;
export type ScanLog = typeof scanLogs.$inferSelect;
