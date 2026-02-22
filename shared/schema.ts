import { pgTable, text, varchar, integer, timestamp, boolean, json, jsonb } from "drizzle-orm/pg-core";
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
export type FetchMethod = "rss" | "google_news" | "scrapingbee" | "scrapingbee_premium";

/** Financial metrics extracted during deep analysis (Stage 6 of the pipeline) */
export interface KeyFinancials {
  fundingAmount?: string | null;
  valuation?: string | null;
  dealValue?: string | null;
}

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
  fetchMethod: text("fetch_method").$type<FetchMethod>(),
  // Intelligent pipeline fields
  isUpdate: boolean("is_update").default(false),
  relatedSavedLeadId: text("related_saved_lead_id"),
  keyFinancials: jsonb("key_financials").$type<KeyFinancials>(),
  wealthAngle: text("wealth_angle"),
  founderLinkedInUrl: text("founder_linkedin_url"),
  founderBio: text("founder_bio"),
  companyDescription: text("company_description"),
  enrichmentData: jsonb("enrichment_data").$type<Record<string, unknown>>(),
  pipelineReasoning: text("pipeline_reasoning"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertLeadSchema = createInsertSchema(leads).omit({
  id: true,
  createdAt: true,
});

export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leads.$inferSelect;

// Default interest filter prompt for the intelligent pipeline (replaces keyword matching)
export const DEFAULT_INTEREST_FILTER_PROMPT = `Analyze if this article indicates a WEALTH LIQUIDITY EVENT where a founder, entrepreneur, or business owner is likely to receive significant liquid wealth (cash/shares) that could be banked by a private banker.

The key question: "Does this event create a newly wealthy individual or significantly increase someone's liquid net worth?"

INCLUDE articles about:
- Private companies raising Series C, D, E+ or late-stage/pre-IPO funding rounds (>$100M). Ignore Series A and B entirely — too early, founders not liquid yet.
- Mergers & acquisitions where founders/shareholders are EXITING (receiving cash or liquid shares)
- Companies preparing for IPO or listing (founders about to get liquid)
- Significant exits or strategic sales of private companies
- Founder liquidity events (secondary sales, founder shares sold)
- Private company valuations reaching unicorn status ($1B+) with identified founders
- PE/VC buyouts where existing shareholders are cashing out

EXCLUDE articles about:
- Companies already publicly listed (trading on exchanges)
- Listed company earnings reports or stock movements
- Government policy or regulatory changes
- General industry trends without specific companies or founders
- Partnerships, commercial deals, or joint ventures (no liquidity created)
- Company operational news (new offices, new hires, product launches, expansions)
- Service centre openings, branch expansions, or geographic expansion
- Award ceremonies, conference appearances, or thought leadership
- Customer wins, contract announcements, or revenue milestones (unless tied to an exit)
- Hiring announcements or executive appointments
- Companies raising debt/loans (no equity liquidity)

BE STRICT: When in doubt, mark as NOT relevant. A private banker cannot act on general business news — they need a specific liquidity event with an identifiable wealthy individual.

Target Regions: Singapore, Malaysia, Indonesia, Thailand, Vietnam, Philippines, Hong Kong, Taiwan

Return JSON with:
- relevant: true/false
- reason: brief explanation of WHY this creates (or doesn't create) a bankable liquidity event
- confidenceScore: 0-100 (how confident you are)`;

// Settings table - stores user preferences
export const settings = pgTable("settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  interestFilterPrompt: text("interest_filter_prompt").notNull().default(DEFAULT_INTEREST_FILTER_PROMPT),
  regions: text("regions").array().notNull(),
  sourceTiers: json("source_tiers").$type<Record<string, SourceTier>>().notNull(),
  summaryLength: text("summary_length").notNull().default("brief"),
  scanFrequency: text("scan_frequency").notNull().default("hourly"), // hourly, daily, weekly, manual
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
  usePremiumScraping: boolean("use_premium_scraping").notNull().default(false),
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
  method: "scrapingbee" | "scrapingbee_premium" | "rss" | "google_news" | "fallback_rss";
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
});

export const insertScanLogSchema = createInsertSchema(scanLogs).omit({
  id: true,
  scannedAt: true,
});

export type InsertScanLog = z.infer<typeof insertScanLogSchema>;
export type ScanLog = typeof scanLogs.$inferSelect;

// Saved leads table - separate from leads table for enhanced metadata
export const savedLeads = pgTable("saved_leads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  leadId: varchar("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  savedAt: timestamp("saved_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  founderLinkedInUrl: text("founder_linkedin_url"),
  founderBio: text("founder_bio"),
  companyDescription: text("company_description"),
  notes: text("notes"),
  researchData: json("research_data").$type<Record<string, any>>(),
  articleSummary: text("article_summary"),
});

export const insertSavedLeadSchema = createInsertSchema(savedLeads).omit({
  id: true,
  savedAt: true,
});

export type InsertSavedLead = z.infer<typeof insertSavedLeadSchema>;
export type SavedLead = typeof savedLeads.$inferSelect;

// IPO exchange type
export type IpoExchange = "hkex_main" | "hkex_gem" | "sgx" | "idx" | "pse";

// IPO Filings table - tracks new IPO listings from HKEX and SGX
export const ipoFilings = pgTable("ipo_filings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  exchange: text("exchange").notNull().$type<IpoExchange>(),
  stockCode: text("stock_code").notNull(),
  companyName: text("company_name").notNull(),
  industry: text("industry"),
  proposedValuation: text("proposed_valuation"),
  revenue: text("revenue"),
  profit: text("profit"),
  founders: text("founders"),
  underwriters: text("underwriters"),
  sponsors: text("sponsors"),
  prospectusUrl: text("prospectus_url"),
  listingDate: text("listing_date"),
  filingDate: text("filing_date"),
  lockupExpiration: text("lockup_expiration"),
  rawData: jsonb("raw_data").$type<Record<string, unknown>>(),
  alertSent: boolean("alert_sent").notNull().default(false),
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

// WebAuthn credentials table - stores passkey/biometric credentials
export const webauthnCredentials = pgTable("webauthn_credentials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  credentialId: text("credential_id").notNull().unique(),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  deviceName: text("device_name"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export type WebAuthnCredential = typeof webauthnCredentials.$inferSelect;

// Auth sessions table
export const authSessions = pgTable("auth_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

export type AuthSession = typeof authSessions.$inferSelect;

// Research cache table - stores research results for 24h deduplication
export const researchCache = pgTable("research_cache", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  query: text("query").notNull(),
  entityType: text("entity_type").notNull(),
  result: jsonb("result").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export type ResearchCacheEntry = typeof researchCache.$inferSelect;
