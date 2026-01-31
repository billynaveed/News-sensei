import { pgTable, text, varchar, integer, real, timestamp, boolean, json } from "drizzle-orm/pg-core";
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
export type FetchMethod = "rss" | "google_news" | "scrapingbee";

// Leads table - the main data model for news article matches
export const leads = pgTable("leads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  headline: text("headline").notNull(),
  sourceUrl: text("source_url").notNull(),
  sourceName: text("source_name").notNull(),
  sourceTier: text("source_tier").notNull().$type<SourceTier>(),
  publishedAt: timestamp("published_at").notNull(),
  companyNames: text("company_names").array().notNull(),
  companyDescription: text("company_description"),
  founderNames: text("founder_names").array().notNull(),
  linkedinProfiles: text("linkedin_profiles").array(),
  investors: text("investors").array(),
  aiSummary: text("ai_summary").notNull(),
  matchedKeywords: text("matched_keywords").array().notNull(),
  priorityScore: integer("priority_score").notNull(),
  priorityLevel: text("priority_level").notNull().$type<PriorityLevel>(),
  region: text("region").notNull(),
  status: text("status").notNull().$type<LeadStatus>().default("new"),
  fetchMethod: text("fetch_method").$type<FetchMethod>(),
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
  telegramEnabled: boolean("telegram_enabled").notNull().default(false),
  telegramChatId: text("telegram_chat_id"),
  logRetentionDays: integer("log_retention_days").notNull().default(2),
  // Global scanning method toggles - apply to ALL active sources
  googleNewsEnabled: boolean("google_news_enabled").notNull().default(false),
  rssEnabled: boolean("rss_enabled").notNull().default(true),
  scrapingBeeEnabled: boolean("scrapingbee_enabled").notNull().default(false),
  dailyCostLimitUsd: real("daily_cost_limit_usd").notNull().default(10.0),
  confidenceThreshold: text("confidence_threshold").notNull().default("balanced").$type<"conservative" | "balanced" | "aggressive">(),
  tier1Model: text("tier1_model").notNull().default("gpt-4o-mini").$type<"gpt-4o-mini" | "claude-haiku">(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertSettingsSchema = createInsertSchema(settings).omit({
  id: true,
  updatedAt: true,
});

export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settings.$inferSelect;

// News sources configuration (simplified - domain-based)
export const sources = pgTable("sources", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  domain: text("domain").notNull().unique(),
  tier: text("tier").notNull().$type<SourceTier>(),
  active: boolean("active").notNull().default(true),
  useScrapingBeeForRss: boolean("use_scrapingbee_for_rss").notNull().default(false),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertSourceSchema = createInsertSchema(sources).omit({
  id: true,
  createdAt: true,
});

export type InsertSource = z.infer<typeof insertSourceSchema>;
export type Source = typeof sources.$inferSelect;

// RSS feeds table (subcategories per source)
export const rssFeeds = pgTable("rss_feeds", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sourceId: varchar("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  url: text("url").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertRssFeedSchema = createInsertSchema(rssFeeds).omit({
  id: true,
  createdAt: true,
});

export type InsertRssFeed = z.infer<typeof insertRssFeedSchema>;
export type RssFeed = typeof rssFeeds.$inferSelect;

// Debug entry for API calls (RSS, Google News, ScrapingBee)
export interface ScrapingBeeDebugEntry {
  sourceName: string;
  sourceId: string;
  timestamp: string;
  method: "scrapingbee" | "rss" | "google_news" | "fallback_rss";
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
  fetchMethod?: FetchMethod;
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
  tier1TokensUsed: json("tier1_tokens_used").$type<Record<string, number>>().default({}),
  tier2TokensUsed: json("tier2_tokens_used").$type<Record<string, number>>().default({}),
  tier1CostUsd: real("tier1_cost_usd").notNull().default(0.0),
  tier2CostUsd: real("tier2_cost_usd").notNull().default(0.0),
  totalCostUsd: real("total_cost_usd").notNull().default(0.0),
  modelsFailed: text("models_failed").array().default([]),
  tier1Filtered: integer("tier1_filtered").notNull().default(0),
});

export const insertScanLogSchema = createInsertSchema(scanLogs).omit({
  id: true,
  scannedAt: true,
});

export type InsertScanLog = z.infer<typeof insertScanLogSchema>;
export type ScanLog = typeof scanLogs.$inferSelect;

// IPO Filing status and exchange enum
export type IpoFilingStatus = "new" | "reviewed" | "dismissed";
export type StockExchange = "HKEX" | "SGX";

// IPO Filings table - tracks IPO announcements from various exchanges
export const ipoFilings = pgTable("ipo_filings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  exchange: text("exchange").notNull().$type<StockExchange>(),
  stockCode: text("stock_code"),
  companyName: text("company_name").notNull(),
  businessDescription: text("business_description"),
  founders: text("founders").array(),
  keyManagement: text("key_management").array(),
  filingDate: timestamp("filing_date").notNull(),
  listingDate: timestamp("listing_date"),
  prospectusUrl: text("prospectus_url").notNull().unique(),
  ipoSize: real("ipo_size"), // In millions USD
  region: text("region").notNull(),
  status: text("status").notNull().$type<IpoFilingStatus>().default("new"),
  aiSummary: text("ai_summary"), // Optional AI-generated summary
  matchedKeywords: text("matched_keywords").array(),
  priorityScore: integer("priority_score"),
  priorityLevel: text("priority_level").$type<PriorityLevel>(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertIpoFilingSchema = createInsertSchema(ipoFilings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertIpoFiling = z.infer<typeof insertIpoFilingSchema>;
export type IpoFiling = typeof ipoFilings.$inferSelect;
