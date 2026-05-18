/**
 * News-sensei schema v2 — unified design.
 *
 * Replaces the v1 frankenstein (33 DB tables, ~15 declared, two parallel
 * lifestyle pipelines). One way to do each thing. UUID PKs everywhere
 * except settings (singleton) and small lookup tables.
 *
 * Not active yet — Phase 1 of the ROADMAP §P0 migration. The ETL in
 * Phase 2 reads from v1 tables and writes to v2 tables. Phase 3 cuts
 * application code over. Phase 5 drops v1 tables.
 *
 * DO NOT run `npm run db:push` against this file until Phase 1 review
 * is complete and the migration SQL is hand-edited.
 */

import { pgTable, text, varchar, integer, timestamp, boolean, json, jsonb, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { DEFAULT_INTEREST_FILTER_PROMPT } from "./schema";
import { DEFAULT_PRIMARY_MODEL_ID, DEFAULT_FALLBACK_MODEL_ID } from "./llm-models";

// ============================================================================
// Enums & shared types
// ============================================================================

export type LeadCategory = "news" | "lifestyle" | "ipo";
export type LeadStatus = "new" | "reviewed" | "saved" | "contacted" | "dismissed";
export type PriorityLevel = "high" | "medium" | "low";
export type SourceTier = "tier1" | "tier2" | "tier3";
export type SourceCategory = "news" | "lifestyle";
export type SourceStatus = "active" | "paused" | "error";
export type LifestylePublicationType = "luxury_magazine" | "business_magazine" | "newspaper" | "blog";
export type FetchMethod = "rss" | "google_news" | "scrapingbee" | "scrapingbee_premium" | "browser_ingest";
export type ArticlePipelineStatus = "pending" | "filtering" | "filtered_out" | "extracting" | "extracted" | "failed";
export type IpoExchange = "hkex_main" | "hkex_gem" | "sgx" | "idx" | "pse";
export type ScanRunType = "news" | "lifestyle" | "ipo";
export type FeedbackVerdict = "thumbs_up" | "thumbs_down";

export interface KeyFinancials {
  fundingAmount?: string | null;
  valuation?: string | null;
  dealValue?: string | null;
}

// ============================================================================
// Auth (kept from v1, UUID already)
// ============================================================================

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const authSessions = pgTable("auth_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const webauthnCredentials = pgTable("webauthn_credentials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  credentialId: text("credential_id").notNull().unique(),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  deviceName: text("device_name"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ============================================================================
// Settings (singleton)
// ============================================================================

export const settings = pgTable("settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),

  // Pipeline behavior
  interestFilterPrompt: text("interest_filter_prompt").notNull().default(DEFAULT_INTEREST_FILTER_PROMPT),
  regions: text("regions").array().notNull(),
  summaryLength: text("summary_length").notNull().default("brief"),
  scanFrequency: text("scan_frequency").notNull().default("hourly"),

  // LLM config — text fields so users can paste any provider slug.
  // Defaults come from shared/llm-models.ts. Settings UI shows a dropdown
  // populated from KNOWN_MODELS with a free-text override.
  primaryLlmModel: text("primary_llm_model").notNull().default(DEFAULT_PRIMARY_MODEL_ID),
  fallbackLlmModel: text("fallback_llm_model").notNull().default(DEFAULT_FALLBACK_MODEL_ID),

  // Fetch toggles (apply to all news sources)
  rssEnabled: boolean("rss_enabled").notNull().default(true),
  googleNewsEnabled: boolean("google_news_enabled").notNull().default(false),
  scrapingBeeEnabled: boolean("scrapingbee_enabled").notNull().default(false),

  // Notifications
  emailEnabled: boolean("email_enabled").notNull().default(true),
  emailFrequency: text("email_frequency").notNull().default("daily"),
  alertEmail: text("alert_email").notNull(),
  telegramEnabled: boolean("telegram_enabled").notNull().default(false),
  telegramChatId: text("telegram_chat_id"),

  // Housekeeping
  logRetentionDays: integer("log_retention_days").notNull().default(2),

  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ============================================================================
// Sources — unified news + lifestyle. Discriminated by `category`.
// ============================================================================

export const sources = pgTable("sources", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  category: text("category").notNull().$type<SourceCategory>(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  domain: text("domain").notNull(),
  baseUrl: text("base_url").notNull(),
  region: text("region"),

  // News-only fields (nullable for lifestyle)
  tier: text("tier").$type<SourceTier>(),
  useScrapingBeeForRss: boolean("use_scrapingbee_for_rss").notNull().default(false),
  usePremiumScraping: boolean("use_premium_scraping").notNull().default(false),

  // Lifestyle-only fields (nullable for news)
  publicationType: text("publication_type").$type<LifestylePublicationType>(),
  feedUrl: text("feed_url"),
  scrapeConfig: jsonb("scrape_config").$type<Record<string, unknown>>(),
  checkIntervalMin: integer("check_interval_min").default(240),
  lastChecked: timestamp("last_checked"),
  errorMessage: text("error_message"),
  errorCount: integer("error_count").notNull().default(0),

  // Shared
  status: text("status").notNull().$type<SourceStatus>().default("active"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const rssFeeds = pgTable("rss_feeds", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sourceId: varchar("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  url: text("url").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ============================================================================
// Articles — raw scraped, pre-AI. One row per discovered URL.
// ============================================================================

export const articles = pgTable("articles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sourceId: varchar("source_id").references(() => sources.id),
  url: text("url").notNull().unique(),
  urlHash: text("url_hash").notNull(),

  title: text("title").notNull(),
  snippet: text("snippet"),
  imageUrl: text("image_url"),
  publishedAt: timestamp("published_at"),
  fullText: text("full_text"),
  region: text("region"),

  fetchMethod: text("fetch_method").$type<FetchMethod>(),
  pipelineStatus: text("pipeline_status").notNull().$type<ArticlePipelineStatus>().default("pending"),
  filterReason: text("filter_reason"),
  filterConfidence: real("filter_confidence"),

  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ============================================================================
// Leads — AI-analyzed, post-pipeline. `category` discriminates news/lifestyle/ipo.
// ============================================================================

export const leads = pgTable("leads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  category: text("category").notNull().$type<LeadCategory>(),
  articleId: varchar("article_id").references(() => articles.id),
  sourceId: varchar("source_id").references(() => sources.id),

  headline: text("headline").notNull(),
  sourceUrl: text("source_url").notNull(),
  sourceName: text("source_name").notNull(),
  sourceTier: text("source_tier").$type<SourceTier>(),
  publishedAt: timestamp("published_at").notNull(),
  region: text("region").notNull(),

  // Extraction output
  companyNames: text("company_names").array().notNull(),
  founderNames: text("founder_names").array().notNull(),
  investors: text("investors").array(),
  matchedKeywords: text("matched_keywords").array().notNull(),
  aiSummary: text("ai_summary").notNull(),
  wealthAngle: text("wealth_angle"),
  keyFinancials: jsonb("key_financials").$type<KeyFinancials>(),
  pipelineReasoning: text("pipeline_reasoning"),
  seaConnection: text("sea_connection"),

  // Lifestyle-specific
  eventType: text("event_type"),
  bankerAngle: text("banker_angle"),
  relevanceScore: integer("relevance_score"),

  // Scoring
  priorityScore: integer("priority_score").notNull(),
  priorityLevel: text("priority_level").notNull().$type<PriorityLevel>(),

  // User curation
  status: text("status").notNull().$type<LeadStatus>().default("new"),
  fetchMethod: text("fetch_method").$type<FetchMethod>(),

  // Relationships to other leads
  isUpdate: boolean("is_update").default(false),
  relatedSavedLeadId: varchar("related_saved_lead_id"),

  // Provenance — which model produced this analysis, so we can audit fallback events
  analyzedByModel: text("analyzed_by_model"),

  // Enrichment (post-save)
  founderLinkedInUrl: text("founder_linkedin_url"),
  founderBio: text("founder_bio"),
  companyDescription: text("company_description"),
  enrichmentData: jsonb("enrichment_data").$type<Record<string, unknown>>(),

  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ============================================================================
// IPO filings — structured exchange data, FK to leads when matched
// ============================================================================

export const ipoFilings = pgTable("ipo_filings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  leadId: varchar("lead_id").references(() => leads.id),
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

// ============================================================================
// People & companies — entity graph (UUID PKs in v2, migration assigns new IDs)
// ============================================================================

export const people = pgTable("people", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fullName: text("full_name").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  familyName: text("family_name"),
  aliases: text("aliases").array(),
  photoUrl: text("photo_url"),
  bio: text("bio"),
  nationality: text("nationality"),
  region: text("region"),
  city: text("city"),
  netWorthEstimate: text("net_worth_estimate"),
  netWorthSource: text("net_worth_source"),
  wealthGeneration: text("wealth_generation"),
  wealthSource: text("wealth_source"),
  familyNotes: text("family_notes"),
  fatherName: text("father_name"),
  motherName: text("mother_name"),
  spouseName: text("spouse_name"),
  firstSeenAt: timestamp("first_seen_at").default(sql`CURRENT_TIMESTAMP`),
  lastMentionedAt: timestamp("last_mentioned_at"),
  mentionCount: integer("mention_count").default(1),
  enriched: boolean("enriched").default(false),
  enrichedAt: timestamp("enriched_at"),
  enrichmentModel: text("enrichment_model"),
  mergedIntoId: varchar("merged_into_id"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const companies = pgTable("companies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  aliases: text("aliases").array(),
  description: text("description"),
  sector: text("sector"),
  subSector: text("sub_sector"),
  hqCountry: text("hq_country"),
  hqCity: text("hq_city"),
  foundedYear: integer("founded_year"),
  website: text("website"),
  isPublic: boolean("is_public"),
  stockTicker: text("stock_ticker"),
  stockExchange: text("stock_exchange"),
  productsBrands: text("products_brands").array(),
  brandDescription: text("brand_description"),
  fundingStage: text("funding_stage"),
  totalFunding: text("total_funding"),
  revenueEstimate: text("revenue_estimate"),
  fundingHistory: jsonb("funding_history"),
  investors: text("investors").array(),
  parentCompanyId: varchar("parent_company_id"),
  subsidiaries: text("subsidiaries").array(),
  enriched: boolean("enriched").default(false),
  enrichedAt: timestamp("enriched_at"),
  enrichmentModel: text("enrichment_model"),
  sourceUrls: text("source_urls").array(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const peopleCompanies = pgTable("people_companies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  personId: varchar("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  role: text("role"),
  roleType: text("role_type"),
  ownershipPct: real("ownership_pct"),
  isCurrent: boolean("is_current").default(true),
  startYear: integer("start_year"),
  endYear: integer("end_year"),
  source: text("source"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

// Unified junctions — replace lifestyle_lead_people / lifestyle_lead_companies
export const leadPeople = pgTable("lead_people", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  leadId: varchar("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  personId: varchar("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  role: text("role"),
  roleType: text("role_type"),
  mentionContext: text("mention_context"),
});

export const leadCompanies = pgTable("lead_companies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  leadId: varchar("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  mentionContext: text("mention_context"),
});

// ============================================================================
// User curation
// ============================================================================

export const savedLeads = pgTable("saved_leads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  leadId: varchar("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  savedAt: timestamp("saved_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  founderLinkedInUrl: text("founder_linkedin_url"),
  founderBio: text("founder_bio"),
  companyDescription: text("company_description"),
  notes: text("notes"),
  researchData: json("research_data").$type<Record<string, unknown>>(),
  articleSummary: text("article_summary"),
});

export const leadFeedback = pgTable("lead_feedback", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  leadId: varchar("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  verdict: text("verdict").notNull().$type<FeedbackVerdict>(),
  reason: text("reason"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ============================================================================
// Operational — unified scan log + URL dedup + research cache
// ============================================================================

export interface SourceSearched {
  name: string;
  tier?: SourceTier;
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

export const scanRuns = pgTable("scan_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  runType: text("run_type").notNull().$type<ScanRunType>(),
  startedAt: timestamp("started_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  completedAt: timestamp("completed_at"),
  durationMs: integer("duration_ms"),

  articlesScanned: integer("articles_scanned").notNull().default(0),
  matchesFound: integer("matches_found").notNull().default(0),
  newLeads: integer("new_leads").notNull().default(0),
  duplicatesSkipped: integer("duplicates_skipped").notNull().default(0),

  // Per-stage LLM cost & fallback tracking
  primaryModelCalls: integer("primary_model_calls").notNull().default(0),
  fallbackModelCalls: integer("fallback_model_calls").notNull().default(0),

  sourcesSearched: jsonb("sources_searched").$type<SourceSearched[]>(),
  articlesProcessed: jsonb("articles_processed").$type<ArticleProcessed[]>(),
  errors: text("errors").array(),
});

export const scannedUrls = pgTable("scanned_urls", {
  urlHash: text("url_hash").primaryKey(),
  url: text("url").notNull(),
  firstSeen: timestamp("first_seen").default(sql`CURRENT_TIMESTAMP`).notNull(),
  lastSeen: timestamp("last_seen").default(sql`CURRENT_TIMESTAMP`).notNull(),
  sourceName: text("source_name"),
  scanCount: integer("scan_count").notNull().default(1),
});

export const researchCache = pgTable("research_cache", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  query: text("query").notNull(),
  entityType: text("entity_type").notNull(),
  result: jsonb("result").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ============================================================================
// Insert schemas & inferred types
// ============================================================================

export const insertUserSchema = createInsertSchema(users).pick({ username: true, password: true });
export const insertSettingsSchema = createInsertSchema(settings).omit({ id: true, updatedAt: true });
export const insertSourceSchema = createInsertSchema(sources).omit({ id: true, createdAt: true, updatedAt: true });
export const insertRssFeedSchema = createInsertSchema(rssFeeds).omit({ id: true, createdAt: true });
export const insertArticleSchema = createInsertSchema(articles).omit({ id: true, createdAt: true, updatedAt: true });
export const insertLeadSchema = createInsertSchema(leads).omit({ id: true, createdAt: true });
export const insertIpoFilingSchema = createInsertSchema(ipoFilings).omit({ id: true, createdAt: true, updatedAt: true });
export const insertSavedLeadSchema = createInsertSchema(savedLeads).omit({ id: true, savedAt: true });
export const insertLeadFeedbackSchema = createInsertSchema(leadFeedback).omit({ id: true, createdAt: true });
export const insertScanRunSchema = createInsertSchema(scanRuns).omit({ id: true, startedAt: true });

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type Settings = typeof settings.$inferSelect;
export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Source = typeof sources.$inferSelect;
export type InsertSource = z.infer<typeof insertSourceSchema>;
export type RssFeed = typeof rssFeeds.$inferSelect;
export type InsertRssFeed = z.infer<typeof insertRssFeedSchema>;
export type Article = typeof articles.$inferSelect;
export type InsertArticle = z.infer<typeof insertArticleSchema>;
export type Lead = typeof leads.$inferSelect;
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type IpoFiling = typeof ipoFilings.$inferSelect;
export type InsertIpoFiling = z.infer<typeof insertIpoFilingSchema>;
export type Person = typeof people.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type PeopleCompany = typeof peopleCompanies.$inferSelect;
export type LeadPerson = typeof leadPeople.$inferSelect;
export type LeadCompany = typeof leadCompanies.$inferSelect;
export type SavedLead = typeof savedLeads.$inferSelect;
export type InsertSavedLead = z.infer<typeof insertSavedLeadSchema>;
export type LeadFeedback = typeof leadFeedback.$inferSelect;
export type InsertLeadFeedback = z.infer<typeof insertLeadFeedbackSchema>;
export type ScanRun = typeof scanRuns.$inferSelect;
export type InsertScanRun = z.infer<typeof insertScanRunSchema>;
export type ScannedUrl = typeof scannedUrls.$inferSelect;
export type ResearchCacheEntry = typeof researchCache.$inferSelect;
