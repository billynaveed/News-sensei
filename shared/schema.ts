import { pgTable, text, varchar, integer, serial, timestamp, boolean, json, jsonb, real } from "drizzle-orm/pg-core";
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
// v2 cutover: this object now maps to the unified leads_v2 table (news +
// lifestyle + ipo), which is a column superset of v1 leads. The v1 `leads`
// table is left intact (postgres-owned) as a rollback snapshot.
export const leads = pgTable("leads_v2", {
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
  category: text("category"),
  seaConnection: text("sea_connection"),
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

Target Regions: Singapore, Malaysia, Indonesia, Thailand, Vietnam, Philippines, Hong Kong, Taiwan.

GEOGRAPHY RULE (strict, source-backed). Pass on geography ONLY when the article
itself contains evidence of one of:
  (a) the SUBJECT company is headquartered in a Target Region, OR
  (b) a NAMED founder is currently based in a Target Region, OR
  (c) a NAMED founder has credible roots in a Target Region (born / raised /
      educated / family / previously based there), OR
  (d) the SUBJECT company has a strong operational centre in a Target Region
      (regional HQ, primary office with leadership presence), OR
  (e) the article explicitly concerns a wealth liquidity event for a
      SEA / HK / Taiwan founder, family or private company.

The following are NOT enough on their own:
  - SEA publisher or source domain (Tech in Asia, Business Times, Straits Times,
    KrASIA, DealStreetAsia, The Edge, e27, SCMP, CNA, Hubbis)
  - SEA-based investor, backer, fund or LP (GIC, Temasek, Khazanah, EDBI,
    family offices, sovereign funds)
  - Vague "Asia expansion", "APAC growth", APAC customers or distribution
  - Mainland China entities (Beijing / Shanghai / Shenzhen / Guangzhou /
    Hangzhou — e.g. ByteDance, Tencent, Alibaba). Mainland China is NOT a
    Target Region; only HK and Taiwan count.
  - Global companies (Anthropic, OpenAI, SpaceX, Stripe) whose only SEA tie is
    a SEA backer or a SEA-published article.

Return JSON with:
- relevant: true/false
- reason: brief explanation. If relevant, name which of (a)-(e) applies and quote the supporting passage. If not relevant, name the disqualifying signal.
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
// telegramTopicId is NOT a column on `settings` (that table is owned by the
// postgres superuser and can't be altered). It lives in `telegram_routing`
// below and is overlaid onto the settings object by storage.getSettings().
export type Settings = typeof settings.$inferSelect & { telegramTopicId?: number | null };

// Single-row table holding the Telegram forum topic (message_thread_id) that
// alerts are routed into. Separate table because `settings` can't be altered.
// Owned by the app role (newsuser). Captured via the /here bot command.
export const telegramRouting = pgTable("telegram_routing", {
  id: integer("id").primaryKey().default(1),
  topicId: integer("topic_id"),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

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

// Scanned URLs table - tracks URLs already processed to prevent re-scanning
export const scannedUrls = pgTable("scanned_urls", {
  urlHash: text("url_hash").primaryKey(),
  url: text("url").notNull(),
  firstSeen: timestamp("first_seen").default(sql`CURRENT_TIMESTAMP`).notNull(),
  lastSeen: timestamp("last_seen").default(sql`CURRENT_TIMESTAMP`).notNull(),
  sourceName: text("source_name"),
  scanCount: integer("scan_count").notNull().default(1),
});

export const insertScannedUrlSchema = createInsertSchema(scannedUrls).omit({
  firstSeen: true,
  lastSeen: true,
});

export type InsertScannedUrl = z.infer<typeof insertScannedUrlSchema>;
export type ScannedUrl = typeof scannedUrls.$inferSelect;

// Saved leads table - separate from leads table for enhanced metadata
// v2 cutover: maps to saved_leads_v2 (FKs leads_v2). Superset of v1 saved_leads.
export const savedLeads = pgTable("saved_leads_v2", {
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

// Lifestyle publication type
export type LifestylePublicationType = "luxury_magazine" | "business_magazine" | "newspaper" | "blog";
export type LifestyleSourceStatus = "active" | "paused" | "error";
export type LifestyleArticleStatus = "pending" | "filtered" | "filtered_out" | "extracted";

// Lifestyle sources table
export const lifestyleSources = pgTable("lifestyle_sources", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  region: text("region").notNull(),
  publicationType: text("publication_type").notNull().$type<LifestylePublicationType>(),
  baseUrl: text("base_url").notNull(),
  feedUrl: text("feed_url"),
  scrapeConfig: jsonb("scrape_config"),
  checkIntervalMin: integer("check_interval_min").notNull().default(240),
  lastChecked: timestamp("last_checked"),
  status: text("status").notNull().$type<LifestyleSourceStatus>().default("active"),
  errorMessage: text("error_message"),
  errorCount: integer("error_count").notNull().default(0),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export type LifestyleSource = typeof lifestyleSources.$inferSelect;
export type InsertLifestyleSource = typeof lifestyleSources.$inferInsert;

// Lifestyle articles table
export const lifestyleArticles = pgTable("lifestyle_articles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sourceId: integer("source_id").notNull().references(() => lifestyleSources.id),
  url: text("url").notNull().unique(),
  title: text("title").notNull(),
  snippet: text("snippet"),
  imageUrl: text("image_url"),
  publishedAt: timestamp("published_at"),
  fullText: text("full_text"),
  status: text("status").notNull().$type<LifestyleArticleStatus>().default("pending"),
  filterReason: text("filter_reason"),
  filterConfidence: real("filter_confidence"),
  eventType: text("event_type"),
  headline: text("headline"),
  summary: text("summary"),
  bankerAngle: text("banker_angle"),
  relevanceScore: integer("relevance_score"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export type LifestyleArticle = typeof lifestyleArticles.$inferSelect;

// People table (shared across news and lifestyle)
export const people = pgTable("people", {
  id: serial("id").primaryKey(),
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
  fatherStatus: text("father_status"),
  motherName: text("mother_name"),
  motherStatus: text("mother_status"),
  spouseName: text("spouse_name"),
  firstSeenAt: timestamp("first_seen_at").default(sql`CURRENT_TIMESTAMP`),
  lastMentionedAt: timestamp("last_mentioned_at"),
  mentionCount: integer("mention_count").default(1),
  sources: text("sources").array(),
  enriched: boolean("enriched").default(false),
  enrichedAt: timestamp("enriched_at"),
  enrichmentModel: text("enrichment_model"),
  mergedIntoId: integer("merged_into_id"),
  contactId: varchar("contact_id"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export type Person = typeof people.$inferSelect;

// Companies table
export const companies = pgTable("companies", {
  id: serial("id").primaryKey(),
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
  parentCompanyId: integer("parent_company_id"),
  subsidiaries: text("subsidiaries").array(),
  enriched: boolean("enriched").default(false),
  enrichedAt: timestamp("enriched_at"),
  enrichmentModel: text("enrichment_model"),
  sourceUrls: text("source_urls").array(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export type Company = typeof companies.$inferSelect;

// People-companies junction table
export const peopleCompanies = pgTable("people_companies", {
  id: serial("id").primaryKey(),
  personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  role: text("role"),
  roleType: text("role_type"),
  ownershipPct: real("ownership_pct"),
  isCurrent: boolean("is_current").default(true),
  startYear: integer("start_year"),
  endYear: integer("end_year"),
  source: text("source"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export type PeopleCompany = typeof peopleCompanies.$inferSelect;

// Lifestyle lead people junction
export const lifestyleLeadPeople = pgTable("lifestyle_lead_people", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  lifestyleLeadId: varchar("lifestyle_lead_id").notNull().references(() => lifestyleArticles.id, { onDelete: "cascade" }),
  personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  mentionContext: text("mention_context"),
});

export type LifestyleLeadPerson = typeof lifestyleLeadPeople.$inferSelect;

// Lifestyle lead companies junction
export const lifestyleLeadCompanies = pgTable("lifestyle_lead_companies", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  lifestyleLeadId: varchar("lifestyle_lead_id").notNull().references(() => lifestyleArticles.id, { onDelete: "cascade" }),
  companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  mentionContext: text("mention_context"),
});

export type LifestyleLeadCompany = typeof lifestyleLeadCompanies.$inferSelect;

// Lifestyle scrape log
export const lifestyleScrapeLog = pgTable("lifestyle_scrape_log", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  publicationId: integer("publication_id").references(() => lifestyleSources.id),
  startedAt: timestamp("started_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  completedAt: timestamp("completed_at"),
  method: text("method"),
  articlesFound: integer("articles_found").notNull().default(0),
  articlesNew: integer("articles_new").notNull().default(0),
  error: text("error"),
  durationMs: integer("duration_ms"),
});

export type LifestyleScrapeLog = typeof lifestyleScrapeLog.$inferSelect;
