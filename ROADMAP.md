# Feature Roadmap - News-sensei

_Updated: 2026-02-15_

---

## 🔴 High Priority (Next 2 Weeks)

### 1. IPO Filings Scanner — HKEX & SGX (HIGH)
**Status:** Research complete, ready to build

**Goal:** Automatically detect new IPO filings on Hong Kong and Singapore stock exchanges and alert Billy via Telegram with key details.

**Data Sources:**
- **HKEX Main Board**: `https://www2.hkexnews.hk/New-Listings/New-Listing-Information/Main-Board?sc_lang=en` (plain HTML — no browser needed!)
- **HKEX GEM Board**: `https://www2.hkexnews.hk/New-Listings/New-Listing-Information/GEM?sc_lang=en`
- **HKEX Application Proofs** (pre-IPO): `https://www1.hkexnews.hk/app/appindex.html`
- **SGX IPO Prospectus**: `https://www.sgx.com/securities/ipo-prospectus` (JS-rendered — needs Playwright)
- **SGX IPO Performance**: `https://www.sgx.com/securities/ipo-performance`

**Technical Approach:**
- HKEX: HTTP fetch + HTML parsing (cheerio) on cron (every 2 hours)
- SGX: Playwright headless browser scraping on cron (every 2 hours)
- New filing detection: compare against DB of previously seen filings
- GPT-4o prospectus analysis: extract valuation, revenue, founders, underwriters, industry
- Telegram alert with summary + prospectus PDF link
- Store in `ipo_filings` table with all extracted metadata

**Key Metrics to Extract:**
- Company name, stock code, exchange
- Industry / sector
- Proposed valuation / market cap
- Revenue & profit (last FY)
- Founders / key shareholders (wealth event!)
- Underwriters / sponsors
- Expected listing date
- Lock-up expiration date

**Why High Priority:** IPO founders = new UHNW clients. First-mover advantage on relationship building.

---

### 2. Telegram `/research` Command (HIGH)
**Status:** Specification complete

**Goal:** Research any person from Telegram by typing their name.

**User Flow:**
1. Billy types: `/research John Tan` in Telegram
2. Bot searches: saved leads → news-sensei DB → web search → Clay (if integrated)
3. If multiple matches: numbered list for disambiguation
4. Returns: professional background, wealth indicators, recent news, contact approach

**Enrichment Sources (priority order):**
1. News-sensei saved leads DB
2. Clay API (if Billy provides access) — gets LinkedIn, funding, email, etc.
3. Google search + web scraping fallback
4. Brave Search API

**Data Returned:**
- Current role & company
- Previous roles, education
- Wealth indicators (funding, exits, board seats)
- Recent news mentions
- Recommended talking points

---

### 3. Clay Integration (HIGH — pending Billy's API key)
**Status:** Waiting on Clay API access

**Goal:** Use Clay as the enrichment backbone for lead data.

**Integration Points:**
- Auto-enrich when a lead is saved (LinkedIn, email, funding, tech stack)
- Power the `/research` command
- Waterfall enrichment (Clay tries 100+ providers automatically)
- Webhook: Clay pushes enriched data back to news-sensei

**What's Needed:** Billy's Clay API key + plan details (credit limits)

---

## 🟡 Medium Priority (Month 2)

### 4. Founder Enrichment Pipeline
**Status:** Design phase

**Goal:** Auto-enrich founder info when leads are saved.
- Trigger background job on lead save
- Pull: LinkedIn profile, headline, bio, experience, education
- Pull: company description, funding, investors
- Show loading state in UI, allow manual re-fetch
- Uses Clay if available, falls back to Google dorking

### 5. Lead Scoring Improvements
**Status:** Research

**Ideas:**
- ML-based scoring instead of rule-based
- Historical conversion tracking
- Learn from Billy's save/dismiss patterns
- Weight by: funding stage, geography (SG focus), industry

### 6. Authentication & Multi-User
**Status:** Planning

- Add login (currently open)
- User-specific saved leads & settings
- Team workspaces
- Role-based access

### 7. HTTPS for Dashboard
**Status:** Ready to implement

- Let's Encrypt cert for news-sensei dashboard
- Currently HTTP only

---

## 🟢 Future (Month 3+)

### 8. Browser Extension
- Chrome extension: right-click any article → "Save to News-sensei"
- Auto-extract company/founder names
- Send to backend for processing

### 9. CRM Export
- Export leads to Salesforce, HubSpot
- Sync saved leads bidirectionally

### 10. Network Graph Visualization
- Map relationships: companies ↔ founders ↔ investors
- Visual network of connections
- Identify warm intro paths

### 11. WhatsApp Notifications
- Alternative to Telegram for alerts
- Same alert format, different delivery

### 12. Email Weekly Digest
- Curated weekly summary of top leads
- IPO pipeline overview
- Wealth events calendar

---

## ✅ Completed

- ✅ Domain-based news source management
- ✅ RSS feed subcategories per source
- ✅ Global scanning method toggles (RSS, Google News, ScrapingBee)
- ✅ AI-powered lead extraction with GPT-4o
- ✅ Priority scoring system
- ✅ Telegram notifications
- ✅ Scan logs with detailed tracking
- ✅ URL deduplication
- ✅ Multi-tier filtering
- ✅ Hourly automated scans
- ✅ Saved leads with expandable detail UI
- ✅ Manual scan button (dashboard only)
- ✅ Sidebar navigation improvements

---

## Technical Debt

- [ ] TypeScript strict mode
- [ ] Unit tests for scanner logic
- [ ] Integration tests for API endpoints
- [ ] Database indexes (leads.publishedAt, leads.status)
- [ ] Pagination for leads list
- [ ] Rate limiting on API endpoints
- [ ] CSRF protection
- [ ] CI/CD pipeline
- [ ] Feature flags

---

## Ideas Backlog

- Sentiment analysis on articles
- Language support (Chinese, Malay, Japanese)
- Mobile app (React Native)
- Competitor analysis dashboard
- Market trend analysis
- Calendar integration for follow-up scheduling
- Voice assistant integration
