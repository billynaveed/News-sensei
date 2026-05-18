import { eq, desc, gte, and, ne, sql, lt } from "drizzle-orm";
import { db } from "./db";
import {
  users, leads, settings, sources, scanLogs, rssFeeds, savedLeads, scannedUrls,
  DEFAULT_INTEREST_FILTER_PROMPT,
  type User, type InsertUser,
  type Lead, type InsertLead, type LeadStatus,
  type Settings, type InsertSettings,
  type Source, type InsertSource,
  type RssFeed, type InsertRssFeed,
  type ScanLog, type InsertScanLog,
  type SavedLead, type InsertSavedLead,
  type ScannedUrl
} from "@shared/schema";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  getAllLeads(): Promise<Lead[]>;
  getLeadById(id: string): Promise<Lead | undefined>;
  getLeadByUrl(url: string): Promise<Lead | undefined>;
  getRecentLeadsByCompany(companyName: string, days: number): Promise<Lead[]>;
  createLead(lead: InsertLead): Promise<Lead>;
  updateLeadStatus(id: string, status: LeadStatus): Promise<Lead | undefined>;
  getLeadsStats(): Promise<{ today: number; thisWeek: number; highPriority: number }>;

  getSettings(): Promise<Settings | undefined>;
  upsertSettings(settings: Partial<InsertSettings>): Promise<Settings>;

  // Sources (simplified - domain-based)
  getAllSources(): Promise<Source[]>;
  getActiveSources(): Promise<Source[]>;
  getSourceById(id: string): Promise<Source | undefined>;
  createSource(source: InsertSource): Promise<Source>;
  updateSource(id: string, updates: Partial<InsertSource>): Promise<Source | undefined>;
  deleteSource(id: string): Promise<boolean>;
  seedDefaultSources(): Promise<void>;

  // RSS Feeds (subcategories per source)
  getRssFeedsBySourceId(sourceId: string): Promise<RssFeed[]>;
  getAllActiveRssFeeds(): Promise<(RssFeed & { sourceName: string; sourceTier: string; useScrapingBeeForRss: boolean })[]>;
  createRssFeed(feed: InsertRssFeed): Promise<RssFeed>;
  updateRssFeed(id: string, updates: Partial<InsertRssFeed>): Promise<RssFeed | undefined>;
  deleteRssFeed(id: string): Promise<boolean>;

  getAllScanLogs(): Promise<ScanLog[]>;
  getScanLogById(id: string): Promise<ScanLog | undefined>;
  createScanLog(log: InsertScanLog): Promise<ScanLog>;
  cleanupOldScanLogs(retentionDays: number): Promise<number>;

  // Scanned URLs (deduplication)
  hasScannedUrl(urlHash: string): Promise<boolean>;
  recordScannedUrl(url: string, sourceName: string): Promise<void>;
  cleanupOldScannedUrls(retentionDays: number): Promise<number>;

  // Saved Leads
  getAllSavedLeads(): Promise<(SavedLead & { lead: Lead })[]>;
  getSavedLeadById(id: string): Promise<(SavedLead & { lead: Lead }) | undefined>;
  getSavedLeadByLeadId(leadId: string): Promise<SavedLead | undefined>;
  getSavedLeadByCompanyName(companyName: string): Promise<(SavedLead & { lead: Lead }) | undefined>;
  createSavedLead(savedLead: InsertSavedLead): Promise<SavedLead>;
  updateSavedLead(id: string, updates: Partial<InsertSavedLead>): Promise<SavedLead | undefined>;
  deleteSavedLead(id: string): Promise<boolean>;
}

const DEFAULT_REGIONS = [
  "Singapore", "Hong Kong", "Taiwan", "Indonesia", 
  "Vietnam", "Thailand", "Malaysia", "Philippines"
];

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async getAllLeads(): Promise<Lead[]> {
    return db.select().from(leads).orderBy(desc(leads.priorityScore), desc(leads.publishedAt));
  }

  async getLeadById(id: string): Promise<Lead | undefined> {
    const [lead] = await db.select().from(leads).where(eq(leads.id, id));
    return lead || undefined;
  }

  async getLeadByUrl(url: string): Promise<Lead | undefined> {
    const [lead] = await db.select().from(leads).where(eq(leads.sourceUrl, url));
    return lead || undefined;
  }

  async getRecentLeadsByCompany(companyName: string, days: number): Promise<Lead[]> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    // Case-insensitive search using ILIKE on company names array
    const results = await db.select().from(leads).where(
      and(
        gte(leads.createdAt, cutoff),
        sql`EXISTS (SELECT 1 FROM unnest(${leads.companyNames}) AS c WHERE c ILIKE ${`%${companyName}%`})`
      )
    );
    return results;
  }

  async createLead(insertLead: InsertLead): Promise<Lead> {
    const [lead] = await db.insert(leads).values(insertLead).returning();
    return lead;
  }

  async updateLeadStatus(id: string, status: LeadStatus): Promise<Lead | undefined> {
    const [lead] = await db.update(leads)
      .set({ status })
      .where(eq(leads.id, id))
      .returning();
    return lead || undefined;
  }

  async getLeadsStats(): Promise<{ today: number; thisWeek: number; highPriority: number }> {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);

    const allLeads = await db.select().from(leads).where(ne(leads.status, "dismissed"));
    
    return {
      today: allLeads.filter(l => new Date(l.createdAt) >= todayStart).length,
      thisWeek: allLeads.filter(l => new Date(l.createdAt) >= weekStart).length,
      highPriority: allLeads.filter(l => l.priorityLevel === "high").length,
    };
  }

  async getSettings(): Promise<Settings | undefined> {
    const [existingSettings] = await db.select().from(settings).limit(1);
    if (existingSettings) return existingSettings;

    const [newSettings] = await db.insert(settings).values({
      interestFilterPrompt: DEFAULT_INTEREST_FILTER_PROMPT,
      regions: DEFAULT_REGIONS,
      sourceTiers: {},
      summaryLength: "brief",
      emailFrequency: "daily",
      emailEnabled: true,
      alertEmail: "billynaveed@gmail.com",
      logRetentionDays: 2,
      googleNewsEnabled: false,
      rssEnabled: true,
      scrapingBeeEnabled: false,
    }).returning();
    return newSettings;
  }

  async upsertSettings(update: Partial<InsertSettings>): Promise<Settings> {
    const existing = await this.getSettings();
    if (existing) {
      const [updated] = await db.update(settings)
        .set({ ...update, updatedAt: new Date() })
        .where(eq(settings.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await db.insert(settings).values({
      interestFilterPrompt: update.interestFilterPrompt || DEFAULT_INTEREST_FILTER_PROMPT,
      regions: update.regions || DEFAULT_REGIONS,
      sourceTiers: update.sourceTiers || {},
      summaryLength: update.summaryLength || "brief",
      scanFrequency: update.scanFrequency || "hourly",
      emailFrequency: update.emailFrequency || "daily",
      emailEnabled: update.emailEnabled ?? true,
      alertEmail: update.alertEmail || "",
      logRetentionDays: update.logRetentionDays ?? 2,
      googleNewsEnabled: update.googleNewsEnabled ?? false,
      rssEnabled: update.rssEnabled ?? true,
      scrapingBeeEnabled: update.scrapingBeeEnabled ?? false,
    }).returning();
    return created;
  }

  async getAllSources(): Promise<Source[]> {
    return db.select().from(sources);
  }

  async getActiveSources(): Promise<Source[]> {
    return db.select().from(sources).where(eq(sources.active, true));
  }

  async getSourceById(id: string): Promise<Source | undefined> {
    const [source] = await db.select().from(sources).where(eq(sources.id, id));
    return source || undefined;
  }

  async createSource(insertSource: InsertSource): Promise<Source> {
    const [source] = await db.insert(sources).values(insertSource).returning();
    return source;
  }

  async updateSource(id: string, updates: Partial<InsertSource>): Promise<Source | undefined> {
    const [source] = await db.update(sources)
      .set(updates)
      .where(eq(sources.id, id))
      .returning();
    return source || undefined;
  }

  async deleteSource(id: string): Promise<boolean> {
    const result = await db.delete(sources).where(eq(sources.id, id));
    return true;
  }

  async seedDefaultSources(): Promise<void> {
    const existing = await db.select().from(sources);
    if (existing.length > 0) return;

    // Seed default sources - cast tier values to SourceTier
    const defaultSourcesData = [
      { name: "Straits Times", domain: "straitstimes.com", tier: "tier1" as const, active: true },
      { name: "Channel NewsAsia", domain: "channelnewsasia.com", tier: "tier1" as const, active: true },
      { name: "Business Times Singapore", domain: "businesstimes.com.sg", tier: "tier1" as const, active: true },
      { name: "Reuters", domain: "reuters.com", tier: "tier2" as const, active: true },
      { name: "Tech in Asia", domain: "techinasia.com", tier: "tier3" as const, active: true },
      { name: "DealStreetAsia", domain: "dealstreetasia.com", tier: "tier3" as const, active: true },
      { name: "e27", domain: "e27.co", tier: "tier3" as const, active: true },
    ];

    const insertedSources = await db.insert(sources).values(defaultSourcesData).returning();

    // Seed default RSS feeds for each source
    const defaultFeeds: InsertRssFeed[] = [];
    
    for (const source of insertedSources) {
      if (source.domain === "straitstimes.com") {
        defaultFeeds.push(
          { sourceId: source.id, name: "Business", url: "https://www.straitstimes.com/news/business/rss.xml", active: true }
        );
      } else if (source.domain === "channelnewsasia.com") {
        defaultFeeds.push(
          { sourceId: source.id, name: "Business", url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511", active: true }
        );
      } else if (source.domain === "businesstimes.com.sg") {
        defaultFeeds.push(
          { sourceId: source.id, name: "Companies & Markets", url: "https://www.businesstimes.com.sg/rss/companies-markets", active: true },
          { sourceId: source.id, name: "Startups & Tech", url: "https://www.businesstimes.com.sg/rss/startups-tech", active: true }
        );
      } else if (source.domain === "reuters.com") {
        defaultFeeds.push(
          { sourceId: source.id, name: "Business", url: "https://www.reutersagency.com/feed/?best-topics=business-finance", active: true }
        );
      } else if (source.domain === "techinasia.com") {
        defaultFeeds.push(
          { sourceId: source.id, name: "Main Feed", url: "https://www.techinasia.com/feed", active: true }
        );
      } else if (source.domain === "dealstreetasia.com") {
        defaultFeeds.push(
          { sourceId: source.id, name: "Main Feed", url: "https://www.dealstreetasia.com/feed", active: true }
        );
      } else if (source.domain === "e27.co") {
        defaultFeeds.push(
          { sourceId: source.id, name: "Main Feed", url: "https://e27.co/feed/", active: true }
        );
      }
    }

    if (defaultFeeds.length > 0) {
      await db.insert(rssFeeds).values(defaultFeeds);
    }
  }

  // RSS Feeds methods
  async getRssFeedsBySourceId(sourceId: string): Promise<RssFeed[]> {
    return db.select().from(rssFeeds).where(eq(rssFeeds.sourceId, sourceId));
  }

  async getAllActiveRssFeeds(): Promise<(RssFeed & { sourceName: string; sourceTier: string; useScrapingBeeForRss: boolean })[]> {
    const activeSources = await this.getActiveSources();
    const activeSourceIds = activeSources.map(s => s.id);
    
    if (activeSourceIds.length === 0) return [];

    const feeds = await db.select().from(rssFeeds).where(eq(rssFeeds.active, true));
    
    return feeds
      .filter(feed => activeSourceIds.includes(feed.sourceId))
      .map(feed => {
        const source = activeSources.find(s => s.id === feed.sourceId);
        return {
          ...feed,
          sourceName: source?.name || "Unknown",
          sourceTier: source?.tier || "tier3",
          useScrapingBeeForRss: source?.useScrapingBeeForRss || false,
        };
      });
  }

  async createRssFeed(insertFeed: InsertRssFeed): Promise<RssFeed> {
    const [feed] = await db.insert(rssFeeds).values(insertFeed).returning();
    return feed;
  }

  async updateRssFeed(id: string, updates: Partial<InsertRssFeed>): Promise<RssFeed | undefined> {
    const [feed] = await db.update(rssFeeds)
      .set(updates)
      .where(eq(rssFeeds.id, id))
      .returning();
    return feed || undefined;
  }

  async deleteRssFeed(id: string): Promise<boolean> {
    await db.delete(rssFeeds).where(eq(rssFeeds.id, id));
    return true;
  }

  async getAllScanLogs(): Promise<ScanLog[]> {
    return db.select().from(scanLogs).orderBy(desc(scanLogs.scannedAt));
  }

  async getScanLogById(id: string): Promise<ScanLog | undefined> {
    const [log] = await db.select().from(scanLogs).where(eq(scanLogs.id, id));
    return log || undefined;
  }

  async createScanLog(insertLog: InsertScanLog): Promise<ScanLog> {
    const [log] = await db.insert(scanLogs).values(insertLog).returning();
    return log;
  }

  async cleanupOldScanLogs(retentionDays: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const oldLogs = await db.select({ id: scanLogs.id })
      .from(scanLogs)
      .where(lt(scanLogs.scannedAt, cutoffDate));

    if (oldLogs.length > 0) {
      await db.delete(scanLogs).where(lt(scanLogs.scannedAt, cutoffDate));
    }

    return oldLogs.length;
  }

  async hasScannedUrl(urlHash: string): Promise<boolean> {
    const [existing] = await db.select().from(scannedUrls).where(eq(scannedUrls.urlHash, urlHash));
    return !!existing;
  }

  async recordScannedUrl(url: string, sourceName: string): Promise<void> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url))
      .then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''));

    const existing = await this.hasScannedUrl(hash);
    if (existing) {
      await db.update(scannedUrls)
        .set({ lastSeen: new Date(), scanCount: sql`${scannedUrls.scanCount} + 1` })
        .where(eq(scannedUrls.urlHash, hash));
    } else {
      await db.insert(scannedUrls).values({
        urlHash: hash,
        url,
        sourceName,
        scanCount: 1,
      });
    }
  }

  async cleanupOldScannedUrls(retentionDays: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const oldUrls = await db.select({ urlHash: scannedUrls.urlHash })
      .from(scannedUrls)
      .where(lt(scannedUrls.lastSeen, cutoffDate));

    if (oldUrls.length > 0) {
      await db.delete(scannedUrls).where(lt(scannedUrls.lastSeen, cutoffDate));
    }

    return oldUrls.length;
  }

  // Saved Leads methods
  async getAllSavedLeads(): Promise<(SavedLead & { lead: Lead })[]> {
    const savedLeadsData = await db.select().from(savedLeads).orderBy(desc(savedLeads.savedAt));

    const result = [];
    for (const saved of savedLeadsData) {
      const lead = await this.getLeadById(saved.leadId);
      if (lead) {
        result.push({ ...saved, lead });
      }
    }

    return result;
  }

  async getSavedLeadById(id: string): Promise<(SavedLead & { lead: Lead }) | undefined> {
    const [saved] = await db.select().from(savedLeads).where(eq(savedLeads.id, id));
    if (!saved) return undefined;

    const lead = await this.getLeadById(saved.leadId);
    if (!lead) return undefined;

    return { ...saved, lead };
  }

  async getSavedLeadByLeadId(leadId: string): Promise<SavedLead | undefined> {
    const [saved] = await db.select().from(savedLeads).where(eq(savedLeads.leadId, leadId));
    return saved || undefined;
  }

  async getSavedLeadByCompanyName(companyName: string): Promise<(SavedLead & { lead: Lead }) | undefined> {
    const normalizedName = companyName.toLowerCase().trim();
    const allSaved = await this.getAllSavedLeads();

    return allSaved.find(saved =>
      saved.lead.companyNames.some(name =>
        name.toLowerCase().trim() === normalizedName
      )
    );
  }

  async createSavedLead(insertSavedLead: InsertSavedLead): Promise<SavedLead> {
    // Also update the lead status to "saved" for backward compatibility
    await this.updateLeadStatus(insertSavedLead.leadId, "saved");

    const [saved] = await db.insert(savedLeads).values(insertSavedLead).returning();
    return saved;
  }

  async updateSavedLead(id: string, updates: Partial<InsertSavedLead>): Promise<SavedLead | undefined> {
    const [saved] = await db.update(savedLeads)
      .set(updates)
      .where(eq(savedLeads.id, id))
      .returning();
    return saved || undefined;
  }

  async deleteSavedLead(id: string): Promise<boolean> {
    const saved = await db.select().from(savedLeads).where(eq(savedLeads.id, id));
    if (saved.length === 0) return false;

    // Update the lead status back to "new" or "reviewed"
    await this.updateLeadStatus(saved[0].leadId, "reviewed");

    await db.delete(savedLeads).where(eq(savedLeads.id, id));
    return true;
  }
}

export const storage = new DatabaseStorage();
