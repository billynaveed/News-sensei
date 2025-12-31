import { eq, desc, gte, and, ne, sql, lt } from "drizzle-orm";
import { db } from "./db";
import { 
  users, leads, settings, sources, scanLogs,
  type User, type InsertUser, 
  type Lead, type InsertLead, type LeadStatus,
  type Settings, type InsertSettings,
  type Source, type InsertSource,
  type ScanLog, type InsertScanLog
} from "@shared/schema";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  getAllLeads(): Promise<Lead[]>;
  getLeadById(id: string): Promise<Lead | undefined>;
  getLeadByUrl(url: string): Promise<Lead | undefined>;
  createLead(lead: InsertLead): Promise<Lead>;
  updateLeadStatus(id: string, status: LeadStatus): Promise<Lead | undefined>;
  getLeadsStats(): Promise<{ today: number; thisWeek: number; highPriority: number }>;

  getSettings(): Promise<Settings | undefined>;
  upsertSettings(settings: Partial<InsertSettings>): Promise<Settings>;

  getAllSources(): Promise<Source[]>;
  getEnabledSources(): Promise<Source[]>;
  createSource(source: InsertSource): Promise<Source>;
  updateSourceEnabled(id: string, enabled: boolean): Promise<Source | undefined>;
  seedDefaultSources(): Promise<void>;

  getAllScanLogs(): Promise<ScanLog[]>;
  getScanLogById(id: string): Promise<ScanLog | undefined>;
  createScanLog(log: InsertScanLog): Promise<ScanLog>;
  cleanupOldScanLogs(retentionDays: number): Promise<number>;
}

const DEFAULT_KEYWORDS = [
  "Liquidity event", "IPO", "Initial Public Offering", "Trade sale",
  "Private equity exit", "PE acquisition", "Merger & acquisition", "M&A deal",
  "Founder exit", "Startup funding Series C", "Startup funding Series D",
  "Unicorn", "SPAC merger", "Secondary sale", "Family office",
  "High net worth", "Asset sale", "Divestiture", "Stake sale",
  "Cashed out", "Sold stake", "Exit deal", "Buyout"
];

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
      keywords: DEFAULT_KEYWORDS,
      regions: DEFAULT_REGIONS,
      sourceTiers: {},
      summaryLength: "brief",
      emailFrequency: "daily",
      emailEnabled: true,
      alertEmail: "billynaveed@gmail.com",
      logRetentionDays: 2,
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
      keywords: update.keywords || DEFAULT_KEYWORDS,
      regions: update.regions || DEFAULT_REGIONS,
      sourceTiers: update.sourceTiers || {},
      summaryLength: update.summaryLength || "brief",
      emailFrequency: update.emailFrequency || "daily",
      emailEnabled: update.emailEnabled ?? true,
      alertEmail: update.alertEmail || "",
      logRetentionDays: update.logRetentionDays ?? 2,
    }).returning();
    return created;
  }

  async getAllSources(): Promise<Source[]> {
    return db.select().from(sources);
  }

  async getEnabledSources(): Promise<Source[]> {
    return db.select().from(sources).where(eq(sources.enabled, true));
  }

  async createSource(insertSource: InsertSource): Promise<Source> {
    const [source] = await db.insert(sources).values(insertSource).returning();
    return source;
  }

  async updateSourceEnabled(id: string, enabled: boolean): Promise<Source | undefined> {
    const [source] = await db.update(sources)
      .set({ enabled })
      .where(eq(sources.id, id))
      .returning();
    return source || undefined;
  }

  async seedDefaultSources(): Promise<void> {
    const existing = await db.select().from(sources);
    if (existing.length > 0) return;

    const defaultSources: InsertSource[] = [
      { name: "The Business Times", url: "https://www.businesstimes.com.sg", rssUrl: "https://www.businesstimes.com.sg/rss/companies", tier: "tier1", type: "rss", region: "Singapore", description: "Singapore's leading business daily" },
      { name: "South China Morning Post", url: "https://www.scmp.com", rssUrl: "https://www.scmp.com/rss/91/feed", tier: "tier1", type: "rss", region: "Hong Kong", description: "Hong Kong's premier English-language news source" },
      { name: "Nikkei Asia", url: "https://asia.nikkei.com", tier: "tier1", type: "scrape", region: "Singapore", description: "Asian business and economic news from Nikkei" },
      { name: "Tech in Asia", url: "https://www.techinasia.com", rssUrl: "https://www.techinasia.com/feed", tier: "tier2", type: "rss", region: "Singapore", description: "Southeast Asia's startup and tech news" },
      { name: "DealStreetAsia", url: "https://www.dealstreetasia.com", tier: "tier2", type: "scrape", region: "Singapore", description: "Private equity and venture capital news in Asia" },
      { name: "The Edge Markets", url: "https://www.theedgemarkets.com", tier: "tier1", type: "scrape", region: "Malaysia", description: "Malaysia's leading financial news portal" },
      { name: "VnExpress International", url: "https://e.vnexpress.net", rssUrl: "https://e.vnexpress.net/rss/business.rss", tier: "tier2", type: "rss", region: "Vietnam", description: "Vietnam's most-read news source in English" },
      { name: "Bangkok Post", url: "https://www.bangkokpost.com", rssUrl: "https://www.bangkokpost.com/rss/data/business.xml", tier: "tier2", type: "rss", region: "Thailand", description: "Thailand's largest English-language newspaper" },
      { name: "Philippine Daily Inquirer", url: "https://business.inquirer.net", tier: "tier2", type: "scrape", region: "Philippines", description: "Philippines' leading business news" },
      { name: "Taiwan News", url: "https://www.taiwannews.com.tw", tier: "tier2", type: "scrape", region: "Taiwan", description: "Taiwan's leading English news source" },
      { name: "The Jakarta Post", url: "https://www.thejakartapost.com", tier: "tier2", type: "scrape", region: "Indonesia", description: "Indonesia's leading English-language daily" },
      { name: "Channel NewsAsia", url: "https://www.channelnewsasia.com", rssUrl: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511", tier: "tier1", type: "rss", region: "Singapore", description: "Singapore's 24-hour news channel" },
    ];

    await db.insert(sources).values(defaultSources);
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
}

export const storage = new DatabaseStorage();
