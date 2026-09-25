import { pgTable, text, varchar, integer, serial, timestamp, boolean, json, jsonb, real, index, uniqueIndex } from "drizzle-orm/pg-core";
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
export type FetchMethod = "rss" | "google_news" | "scrapingbee" | "scrapingbee_premium" | "scraped";

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
  // Present in the live table since the v2 cutover; kept so db:push never drops data.
  eventType: text("event_type"),
  bankerAngle: text("banker_angle"),
  relevanceScore: integer("relevance_score"),
  analyzedByModel: text("analyzed_by_model"),
  sourceId: varchar("source_id"),
  articleId: varchar("article_id"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (t) => ({
  // Index names match scripts/v2-create-tables.sql so a future db:push reconciles
  // rather than duplicating. sourceUrl is the dedup hot path (getLeadByUrl runs
  // once per article per scan) and was previously UNINDEXED.
  sourceUrlIdx: index("idx_leads_v2_source_url").on(t.sourceUrl),
  statusIdx: index("idx_leads_v2_status").on(t.status),
  categoryIdx: index("idx_leads_v2_category").on(t.category),
  priorityScoreIdx: index("idx_leads_v2_priority_score").on(t.priorityScore.desc()),
  publishedAtIdx: index("idx_leads_v2_published_at").on(t.publishedAt.desc()),
}));

export const insertLeadSchema = createInsertSchema(leads).omit({
  id: true,
  createdAt: true,
}).extend({
  // drizzle-zod erases $type<> enums to `string`; restore them so InsertLead
  // matches the table's insert type (keeps storage.createLead type-safe).
  sourceTier: z.enum(["tier1", "tier2", "tier3"]),
  priorityLevel: z.enum(["high", "medium", "low"]),
  status: z.enum(["new", "reviewed", "saved", "contacted", "dismissed"]).optional(),
  fetchMethod: z.enum(["rss", "google_news", "scrapingbee", "scrapingbee_premium", "scraped"]).nullable().optional(),
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
  /**
   * Hide leads whose named people are ALL covered by another banker. Off by
   * default: Billy's 2026-09-02 rule was that blocked leads stay visible with
   * a ⛔ badge until propagation has earned trust.
   */
  hideBlockedLeads: boolean("hide_blocked_leads").notNull().default(false),
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
}).extend({
  tier: z.enum(["tier1", "tier2", "tier3"]),
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
  /** Article URL, so a rejection on the Debug page can be re-run or turned into an example. */
  url?: string;
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
// Reference articles Billy taught from the Debug page (learning loop); see server/pipeline-examples.ts.
export const pipelineExamples = pgTable("pipeline_examples", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  url: text("url").notNull().unique(),
  headline: text("headline").notNull(),
  expected: text("expected").notNull().$type<"pass" | "reject">(),
  note: text("note"),
  lastResult: text("last_result"),
  lastReason: text("last_reason"),
  lastRunAt: timestamp("last_run_at"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});
export type PipelineExample = typeof pipelineExamples.$inferSelect;

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
}, (t) => ({
  // status is filtered repeatedly across the lifestyle pipeline (pending/filtered/extracted).
  statusIdx: index("idx_lifestyle_articles_status").on(t.status),
}));

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
}, (t) => ({
  // upsertPerson looks up by full_name (+ region) once per extracted person.
  // Matches the existing live index name so db:push stays a no-op here.
  fullNameIdx: index("idx_people_name").on(t.fullName),
}));

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

// User feedback on leads — drives the auto-improving filter loop. Recent "bad"
// rows are injected into the scan filter prompts as negative examples. We snapshot
// headline/company/founder so an example survives the lead being deleted/pruned.
// Physical table is ui_lead_feedback (a legacy postgres-owned `lead_feedback`
// table from the parked v2 draft exists and can't be altered by the app role).
export const leadFeedback = pgTable("ui_lead_feedback", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  leadId: varchar("lead_id"),
  rating: text("rating").notNull().$type<"bad" | "good">(),
  reason: text("reason"),
  note: text("note"),
  headline: text("headline"),
  category: text("category"),
  region: text("region"),
  companyNames: text("company_names").array(),
  founderNames: text("founder_names").array(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertLeadFeedbackSchema = createInsertSchema(leadFeedback).omit({
  id: true,
  createdAt: true,
}).extend({
  rating: z.enum(["bad", "good"]),
});
export type InsertLeadFeedback = z.infer<typeof insertLeadFeedbackSchema>;
export type LeadFeedback = typeof leadFeedback.$inferSelect;

// Contact lifecycle layered over the (possibly superuser-owned) people table.
// Kept as a separate app-role-owned table keyed by personId so we never need to
// ALTER people. status: active (default) | saved | deleted; remindAt drives the
// "remind me later" queue; email is the eventual scrape target.
export const contactMeta = pgTable("contact_meta", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  personId: integer("person_id").notNull().unique(),
  email: text("email"),
  status: text("status").notNull().$type<"active" | "saved" | "muted" | "deleted">().default("active"),
  remindAt: timestamp("remind_at"),
  notes: text("notes"),
  // Contact details, mostly filled by the business card scanner. Phones are
  // stored in E.164 so WhatsApp/dialler links work without further cleaning.
  phoneMobile: text("phone_mobile"),
  phoneOffice: text("phone_office"),
  phoneOther: text("phone_other"),
  jobTitle: text("job_title"),
  companyName: text("company_name"),
  linkedinUrl: text("linkedin_url"),
  website: text("website"),
  address: text("address"),
  /** Honorific as printed ("Tan Sri Dato'"), kept out of people.full_name. */
  honorific: text("honorific"),
  /** Name in the card's other script, e.g. 林国泰. */
  nativeName: text("native_name"),
  /** The business_cards row this contact was created from, if any. */
  cardId: varchar("card_id"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});
export type ContactMeta = typeof contactMeta.$inferSelect;
export type ContactStatus = "active" | "saved" | "deleted";

// ---------------------------------------------------------------------------
// Families + blocked persons (coverage conflicts). All four tables are
// app-role-owned (ensure-families-tables.ts) and keyed to people.id so we
// never ALTER the superuser-owned people table. Blocks are ALWAYS applied by
// a human — research agents only propose trees, never block.
// ---------------------------------------------------------------------------

// researchStatus doubles as the research-agent queue:
// pending → researching → done | failed | needs_review. "manual" families
// (created by hand) are skipped by the agent.
export const families = pgTable("families", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  country: text("country"),
  primaryCompanies: text("primary_companies").array(),
  description: text("description"),
  patriarchPersonId: integer("patriarch_person_id"),
  netWorthEstimate: text("net_worth_estimate"),
  researchStatus: text("research_status").notNull().default("manual"),
  researchAttempts: integer("research_attempts").notNull().default(0),
  researchedAt: timestamp("researched_at"),
  confidence: text("confidence"),
  sourceUrls: text("source_urls").array(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});
export type Family = typeof families.$inferSelect;

// A person can belong to two families (marriage), hence a junction.
export const familyMembers = pgTable("family_members", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  familyId: varchar("family_id").notNull(),
  personId: integer("person_id").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (t) => ({
  memberUnique: uniqueIndex("family_members_family_person_uq").on(t.familyId, t.personId),
}));
export type FamilyMember = typeof familyMembers.$inferSelect;

// Canonical directions: parent→child ("parent"), spouse (either direction),
// sibling only when parents are unknown (else derived from shared parents).
export const familyRelationships = pgTable("family_relationships", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  familyId: varchar("family_id").notNull(),
  fromPersonId: integer("from_person_id").notNull(),
  toPersonId: integer("to_person_id").notNull(),
  type: text("type").notNull().$type<"parent" | "spouse" | "sibling">(),
  confidence: text("confidence"),
  sourceUrl: text("source_url"),
  notes: text("notes"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (t) => ({
  relUnique: uniqueIndex("family_rel_uq").on(t.fromPersonId, t.toPersonId, t.type),
}));
export type FamilyRelationship = typeof familyRelationships.$inferSelect;

// origin "direct" = Billy blocked this person; "propagated" = blocked because
// originPersonId was (child blocked ⇒ parents blocked for sure). Unblocking a
// direct block cascade-deletes its propagated rows.
export const personBlocks = pgTable("person_blocks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  personId: integer("person_id").notNull().unique(),
  reason: text("reason"),
  coveredBy: text("covered_by"),
  origin: text("origin").notNull().$type<"direct" | "propagated">().default("direct"),
  originPersonId: integer("origin_person_id"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});
export type PersonBlock = typeof personBlocks.$inferSelect;

// ============================================================================
// Pipeline prompts (editable + versioned from Settings)
// ============================================================================
// Every LLM prompt the pipeline uses has a code default (server/prompts.ts
// DEFAULT_PROMPTS). A row here overrides the default for that key; deleting the
// row reverts to the default. Bodies are templates using {{placeholder}} vars
// rendered by server/prompts.ts `render()`.

export const pipelinePrompts = pgTable("pipeline_prompts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  /** Stable identifier, e.g. "stage1_interest". See PROMPT_KEYS in server/prompts.ts. */
  key: text("key").notNull().unique(),
  body: text("body").notNull(),
  /** Bumped on every save; matches the newest pipeline_prompt_versions row. */
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedBy: text("updated_by"),
});
export type PipelinePrompt = typeof pipelinePrompts.$inferSelect;

/** Append-only history: one row per save, so any version can be reverted to. */
export const pipelinePromptVersions = pgTable("pipeline_prompt_versions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: text("key").notNull(),
  version: integer("version").notNull(),
  body: text("body").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (t) => ({
  keyVersionUnique: uniqueIndex("pipeline_prompt_versions_key_version_uq").on(t.key, t.version),
}));
export type PipelinePromptVersion = typeof pipelinePromptVersions.$inferSelect;

// ---------------------------------------------------------------------------
// Business cards. One row per scanned card: the images, exactly what the
// vision model returned (for audit and re-parse), and the normalised result
// the review screen edits. A card stays in the queue until it is saved, so a
// failed parse is visible rather than silently dropped.
// ---------------------------------------------------------------------------
export const businessCards = pgTable("business_cards", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  /** Set when the card has been saved as a contact. */
  personId: integer("person_id"),
  frontImage: text("front_image"),
  backImage: text("back_image"),
  /** Verbatim model output, so a re-parse never needs the LLM again for audit. */
  rawExtraction: jsonb("raw_extraction"),
  /** The normalised ParsedCard the UI edits. */
  parsed: jsonb("parsed"),
  /** Per-field confidence 0-1 from the model, for the amber highlights. */
  confidence: jsonb("confidence"),
  status: text("status").notNull().$type<"parsed" | "needs_review" | "saved" | "failed">().default("parsed"),
  source: text("source").notNull().default("web"),
  /** "Where we met" — the Telegram caption or the web field. */
  eventNote: text("event_note"),
  /** Groups the cards from one multi-photo upload. */
  batchId: varchar("batch_id"),
  /** Existing people this card might duplicate, as [{id, fullName, reason}]. */
  duplicates: jsonb("duplicates"),
  /** Company website / LinkedIn found after the parse; blank when unverified. */
  enrichment: jsonb("enrichment"),
  model: text("model"),
  error: text("error"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  statusIdx: index("idx_business_cards_status").on(table.status),
}));
export type BusinessCard = typeof businessCards.$inferSelect;
export type InsertBusinessCard = typeof businessCards.$inferInsert;
