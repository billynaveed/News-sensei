# Sensei CRM — Lifestyle Leads Pipeline
## Product Requirements Document

**Version:** 1.0
**Date:** 2026-02-22
**Author:** Bob (AI Assistant)
**Status:** Draft

---

## 1. Overview & Goals

### Problem
Billy is a UHNW private banker in Singapore serving clients across Southeast Asia. Luxury and society magazines (Tatler, Prestige, Vogue, The Peak, etc.) regularly profile, photograph, and name the exact individuals who are Billy's ideal prospects — at weddings, philanthropy galas, property launches, business features, and society events. Today, Billy manually reads these magazines. This doesn't scale.

### Solution
Build an automated **Lifestyle Leads Pipeline** that:
1. Monitors 17 luxury/society publications across SG, HK, MY, PH, ID, TW, TH
2. Uses AI to identify articles profiling named wealthy individuals
3. Extracts structured data: person, family, company, wealth signals, event type
4. Builds a persistent **People Database** of UHNW individuals and their companies
5. Cross-references with existing news leads for enriched context
6. Surfaces lifestyle leads in the Sensei CRM feed with distinct visual treatment

### Success Metrics
- **Coverage:** ≥15 of 17 publications actively monitored within 30 days of launch
- **Precision:** ≥85% of surfaced lifestyle leads contain genuinely wealthy/notable individuals
- **People DB growth:** 500+ unique UHNW profiles within 90 days
- **Cross-reference hits:** ≥10% of news leads match a person/company in the People DB
- **Billy's time saved:** Replaces ~5 hours/week of manual magazine reading

### Constraints
- Must coexist with existing news pipeline (port 5000, same database)
- Budget: OpenRouter API costs must stay under ~$50/month
- Scraping must respect robots.txt and rate limits (no aggressive crawling)
- No paid publication paywalls to bypass — public content only

---

## 2. Architecture

### Current System
```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  News Pipeline   │────▶│   PostgreSQL     │◀────│  Sensei CRM     │
│  (Express:5000)  │     │  newssensei DB   │     │  (Next.js:3003) │
│  /root/projects/ │     │                  │     │  /workspace/    │
│  News-sensei/    │     │  Tables:         │     │  sensei/app/    │
│                  │     │  - leads         │     │                  │
│  - RSS fetch     │     │  - contacts      │     │  - Feed UI       │
│  - AI scoring    │     │  - contact_notes │     │  - Save/dismiss  │
│  - systemd       │     │  - lead_feedback │     │  - Feedback      │
│                  │     │  - model_ab_log  │     │                  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

### With Lifestyle Pipeline
```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  News Pipeline   │────▶│   PostgreSQL     │◀────│  Sensei CRM     │
│  (Express:5000)  │     │  newssensei DB   │     │  (Next.js:3003) │
└─────────────────┘     │                  │     │                  │
                        │  + people        │     │  + Lifestyle tab │
┌─────────────────┐     │  + companies     │     │  + People cards  │
│ Lifestyle        │────▶│  + people_co...  │     │  + Company cards │
│ Pipeline         │     │  + lifestyle_... │     │  + Cross-ref     │
│ (Express:5001)   │     │  + publications  │     │    badges        │
│ /root/projects/  │     │  + scrape_log    │     │                  │
│ Lifestyle-sensei/│     └──────────────────┘     └─────────────────┘
│                  │
│ Stages:          │
│ 1. Monitor/Scrape│
│ 2. Filter (AI)   │
│ 3. Extract (AI)  │
│ 4. Enrich (AI)   │
│ 5. Cross-ref     │
└─────────────────┘
```

### Key Decisions
- **Separate service** on port 5001 (not bolted onto the news pipeline) — different scraping logic, different schedules, cleaner separation
- **Same database** — enables cross-referencing between news and lifestyle leads
- **Shared API layer** — Sensei CRM talks to both pipelines via REST
- **systemd managed** — like the news pipeline, runs as `lifestyle-sensei.service`
- **OpenRouter for AI** — Llama 4 Maverick (primary), Gemini 2.5 Flash (fallback)

---

## 3. Data Model

### 3.1 `publications` — Source registry
```sql
CREATE TABLE publications (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,                    -- 'Tatler Asia'
  slug          TEXT UNIQUE NOT NULL,             -- 'tatler-asia'
  base_url      TEXT NOT NULL,                    -- 'https://tatlerasia.com'
  tier          SMALLINT NOT NULL DEFAULT 1,      -- 1, 2, or 3
  region        TEXT,                             -- 'SG', 'HK', 'SEA', etc.
  feed_url      TEXT,                             -- RSS/Atom URL if available
  feed_type     TEXT,                             -- 'rss', 'atom', null
  scrape_config JSONB DEFAULT '{}',              -- CSS selectors, pagination config
  scrape_method TEXT DEFAULT 'rss',              -- 'rss', 'scrape', 'both'
  check_interval_min INTEGER DEFAULT 120,        -- how often to check (minutes)
  last_checked  TIMESTAMPTZ,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.2 `lifestyle_leads` — Raw articles
```sql
CREATE TABLE lifestyle_leads (
  id              SERIAL PRIMARY KEY,
  publication_id  INTEGER REFERENCES publications(id),
  url             TEXT UNIQUE NOT NULL,
  title           TEXT,
  snippet         TEXT,                           -- excerpt or meta description
  full_text       TEXT,                           -- fetched article body
  image_url       TEXT,
  published_at    TIMESTAMPTZ,
  discovered_at   TIMESTAMPTZ DEFAULT NOW(),

  -- AI processing
  filter_pass     BOOLEAN,                        -- did it pass the relevance filter?
  filter_reason   TEXT,                            -- why accepted/rejected
  filter_model    TEXT,                            -- which model filtered it
  extraction      JSONB,                           -- structured extraction output
  event_type      TEXT,                            -- 'wedding', 'gala', 'property', 'business', 'rich_list', 'philanthropy', 'society'
  wealth_signals  TEXT[],                          -- array of signal types found

  -- Scoring
  relevance_score REAL,                           -- 0-100, AI-assigned
  status          TEXT DEFAULT 'pending',          -- 'pending', 'filtered_out', 'extracted', 'enriched', 'published', 'dismissed'

  -- Feed display
  headline        TEXT,                            -- AI-generated banker-friendly headline
  summary         TEXT,                            -- AI-generated 2-3 sentence summary
  banker_angle    TEXT,                            -- "why this matters to you"

  -- User interaction (mirrors news leads)
  saved           BOOLEAN DEFAULT false,
  dismissed       BOOLEAN DEFAULT false,
  feedback        TEXT,
  feedback_at     TIMESTAMPTZ,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_lifestyle_leads_status ON lifestyle_leads(status);
CREATE INDEX idx_lifestyle_leads_score ON lifestyle_leads(relevance_score DESC);
CREATE INDEX idx_lifestyle_leads_pub ON lifestyle_leads(publication_id);
```

### 3.3 `people` — UHNW individuals database
```sql
CREATE TABLE people (
  id                SERIAL PRIMARY KEY,
  full_name         TEXT NOT NULL,
  first_name        TEXT,
  last_name         TEXT,
  family_name       TEXT,                         -- dynasty/clan name if applicable
  aliases           TEXT[],                        -- other known names
  photo_url         TEXT,
  bio               TEXT,                          -- AI-generated summary
  nationality       TEXT,
  region            TEXT,                          -- primary region: 'SG', 'HK', 'MY', 'ID', 'PH', 'TH', 'TW'
  city              TEXT,

  -- Wealth signals
  net_worth_estimate TEXT,                        -- '$2.1B', 'undisclosed', etc.
  net_worth_source   TEXT,                        -- 'Forbes 2025', 'estimated from holdings'
  wealth_generation  TEXT,                        -- '1st gen', '2nd gen', '3rd gen'
  wealth_source      TEXT,                        -- 'real estate', 'tech', 'commodities'

  -- Family
  family_notes      TEXT,                         -- parents, siblings, spouse info
  father_name       TEXT,
  father_status     TEXT,                         -- 'alive', 'deceased', 'unknown'
  mother_name       TEXT,
  mother_status     TEXT,
  spouse_name       TEXT,

  -- Metadata
  first_seen_at     TIMESTAMPTZ DEFAULT NOW(),
  last_mentioned_at TIMESTAMPTZ,
  mention_count     INTEGER DEFAULT 1,
  sources           TEXT[],                       -- publication slugs where seen
  enriched          BOOLEAN DEFAULT false,
  enriched_at       TIMESTAMPTZ,
  enrichment_model  TEXT,

  -- Dedup
  contact_id        INTEGER REFERENCES contacts(id), -- link to existing LinkedIn contact if matched
  merged_into_id    INTEGER REFERENCES people(id),    -- dedup: points to canonical record

  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_people_name ON people(full_name);
CREATE INDEX idx_people_last ON people(last_name);
CREATE INDEX idx_people_region ON people(region);
CREATE UNIQUE INDEX idx_people_dedup ON people(full_name, region) WHERE merged_into_id IS NULL;
```

### 3.4 `companies` — Company profiles
```sql
CREATE TABLE companies (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  aliases           TEXT[],                        -- other known names
  description       TEXT,
  sector            TEXT,                          -- 'Real Estate', 'F&B', 'Tech', etc.
  sub_sector        TEXT,
  hq_country        TEXT,
  hq_city           TEXT,
  founded_year      INTEGER,
  website           TEXT,

  -- Classification
  is_public         BOOLEAN,
  stock_ticker      TEXT,                          -- 'SGX:CIT' etc.
  stock_exchange    TEXT,

  -- Products & brands
  products_brands   TEXT[],                        -- ['Banyan Tree', 'Angsana', 'Cassia']
  brand_description TEXT,

  -- Funding & financials
  funding_stage     TEXT,                          -- 'Series C', 'Pre-IPO', 'Public', 'Private (no funding)'
  total_funding     TEXT,                          -- '$150M'
  revenue_estimate  TEXT,
  funding_history   JSONB,                         -- [{round: 'Series A', amount: '$20M', date: '2019', investors: [...]}]
  investors         TEXT[],                        -- major investors

  -- Corporate structure
  parent_company_id INTEGER REFERENCES companies(id),
  subsidiaries      TEXT[],                        -- names (for display; actual links via parent_company_id)

  -- Metadata
  enriched          BOOLEAN DEFAULT false,
  enriched_at       TIMESTAMPTZ,
  enrichment_model  TEXT,
  source_urls       TEXT[],

  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_companies_name ON companies(name);
CREATE INDEX idx_companies_sector ON companies(sector);
```

### 3.5 `people_companies` — Relationships
```sql
CREATE TABLE people_companies (
  id            SERIAL PRIMARY KEY,
  person_id     INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role          TEXT,                              -- 'Founder & CEO', 'Board Member', 'Heir'
  role_type     TEXT,                              -- 'executive', 'board', 'investor', 'heir', 'owner'
  ownership_pct REAL,                              -- 0-100, null if unknown
  is_current    BOOLEAN DEFAULT true,
  start_year    INTEGER,
  end_year      INTEGER,
  source        TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(person_id, company_id, role)
);
```

### 3.6 `lifestyle_lead_people` — Join table
```sql
CREATE TABLE lifestyle_lead_people (
  id               SERIAL PRIMARY KEY,
  lifestyle_lead_id INTEGER NOT NULL REFERENCES lifestyle_leads(id) ON DELETE CASCADE,
  person_id         INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  mention_context   TEXT,                          -- 'featured', 'mentioned', 'photographed'
  UNIQUE(lifestyle_lead_id, person_id)
);
```

### 3.7 `lifestyle_lead_companies` — Join table
```sql
CREATE TABLE lifestyle_lead_companies (
  id               SERIAL PRIMARY KEY,
  lifestyle_lead_id INTEGER NOT NULL REFERENCES lifestyle_leads(id) ON DELETE CASCADE,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  mention_context   TEXT,
  UNIQUE(lifestyle_lead_id, company_id)
);
```

### 3.8 `scrape_log` — Audit trail
```sql
CREATE TABLE scrape_log (
  id              SERIAL PRIMARY KEY,
  publication_id  INTEGER REFERENCES publications(id),
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  method          TEXT,                            -- 'rss', 'scrape'
  articles_found  INTEGER DEFAULT 0,
  articles_new    INTEGER DEFAULT 0,
  error           TEXT,
  duration_ms     INTEGER
);
```

---

## 4. Pipeline Stages (Detailed)

### Stage 1: MONITOR
**Trigger:** Cron job, per-publication intervals (Tier 1 every 2h, Tier 2 every 4h, Tier 3 every 6h)

**Process:**
1. For each active publication, check `last_checked` against `check_interval_min`
2. If RSS available: fetch and parse RSS feed, extract article URLs + titles + dates
3. If scrape-only: HTTP GET the listing page(s), parse with configured CSS selectors
4. Deduplicate against existing `lifestyle_leads.url`
5. Insert new articles as `status: 'pending'` with title, snippet, URL, image_url
6. Log to `scrape_log`

**Rate limiting:** Max 1 request per second per domain. Randomized delay 1-3s between requests.

### Stage 2: FILTER
**Trigger:** Runs after Stage 1, processes all `status: 'pending'` leads
**Batch size:** 10 articles at a time

**Process:**
1. For each pending article, send title + snippet (not full text yet) to AI
2. AI returns: `{ relevant: boolean, reason: string, confidence: 0-100 }`
3. If relevant (confidence ≥ 60): advance to `status: 'filtered'`, fetch full article text
4. If not relevant: set `status: 'filtered_out'`, store reason
5. Fetching full text: HTTP GET article URL, extract body text (readability algorithm)

**Why filter before fetching full text:** Saves bandwidth and API costs. Most articles (~70%) won't be relevant.

### Stage 3: EXTRACT
**Trigger:** Processes all `status: 'filtered'` leads with full_text available

**Process:**
1. Send full article text to AI with extraction prompt
2. AI returns structured data:
   ```json
   {
     "people": [
       {
         "full_name": "Peter Lim",
         "family_name": "Lim",
         "company": "Thomson Medical Group",
         "role": "Founder & Chairman",
         "wealth_signals": ["property purchase", "business feature"],
         "net_worth_hint": "Singapore billionaire",
         "region": "SG"
       }
     ],
     "companies": [
       {
         "name": "Thomson Medical Group",
         "sector": "Healthcare",
         "is_public": true
       }
     ],
     "event_type": "business",
     "headline": "Peter Lim expands healthcare empire with new $200M hospital",
     "summary": "...",
     "banker_angle": "Major liquidity event possible; new hospital may need private banking facilities for senior doctors.",
     "relevance_score": 88
   }
   ```
3. Upsert people into `people` table (match on name + region, update `mention_count`)
4. Upsert companies into `companies` table
5. Create join records in `lifestyle_lead_people` and `lifestyle_lead_companies`
6. Update lifestyle_lead with headline, summary, banker_angle, relevance_score
7. Set `status: 'extracted'`

### Stage 4: ENRICH
**Trigger:** Runs for newly created/updated `people` records where `enriched = false`
**Rate:** Max 20 enrichments per hour (to control API costs)
**Priority:** People with higher mention_count enriched first

**Process:**
1. For each un-enriched person, send name + known context to AI with enrichment prompt
2. AI is instructed to use its training data (not web search) to provide:
   - Bio summary
   - Family information (parents alive/deceased, spouse, children)
   - Net worth estimate and source
   - Wealth generation (1st/2nd/3rd gen)
   - Company associations with roles
3. For each company mentioned, if not in `companies` table, create it
4. For existing companies where `enriched = false`, run company enrichment:
   - Public vs private
   - Products/brands
   - Funding history
   - Investors
   - Subsidiaries
5. Set `enriched = true`, `enriched_at = NOW()`

**Future enhancement:** Web search enrichment (Brave API) for more current data.

### Stage 5: CROSS-REFERENCE
**Trigger:** Runs continuously as a post-processing step

**Process:**
1. **People ↔ Contacts:** Match `people.full_name` against `contacts.name` (fuzzy match). If match found, set `people.contact_id` — this means Billy already knows this person from LinkedIn.
2. **People ↔ News Leads:** When a news lead (from the news pipeline) mentions a company name that exists in our `companies` table, tag it with a cross-reference. Implemented via a materialized view or periodic query.
3. **Company name matching:** Normalize company names (strip "Pte Ltd", "Holdings", "Group" etc.) for fuzzy matching against news lead text.

---

## 5. Publication Monitoring Strategy

| # | Publication | URL | Method | Feed URL / Notes |
|---|-------------|-----|--------|------------------|
| 1 | Tatler Asia | tatlerasia.com | RSS + scrape | Check `/feed`, `/rss`; scrape section pages per edition |
| 2 | Vogue Singapore | vogue.sg | RSS | Standard Condé Nast RSS likely available |
| 3 | The Peak | thepeakmagazine.com.sg | Scrape | No known RSS; scrape `/people`, `/style`, `/watches-jewellery` |
| 4 | Prestige | prestigeonline.com | RSS + scrape | Check per-edition feeds; scrape `/people`, `/style` |
| 5 | Robb Report SG | robbreport.com.sg | RSS | Likely has standard WordPress RSS |
| 6 | Forbes Asia | forbes.com/asia | RSS | forbes.com has RSS feeds per section |
| 7 | A+ Singapore | aplussingapore.com | Scrape | Smaller pub, likely no RSS |
| 8 | Harper's Bazaar SG | harpersbazaar.com.sg | RSS | Hearst properties usually have RSS |
| 9 | Buro Singapore | buro247.sg | Scrape | Check for RSS; likely scrape-based |
| 10 | CNA Luxury | cnaluxury.channelnewsasia.com | RSS | CNA has robust RSS infrastructure |
| 11 | SCMP Lifestyle | scmp.com/lifestyle | RSS | SCMP has RSS feeds per section |
| 12 | Senatus | senatus.net | RSS | WordPress-based, RSS likely |
| 13 | ICON Singapore | iconsingapore.com | Scrape | Check for RSS; likely scrape |
| 14 | Jakarta Globe | jakartaglobe.id | RSS | News site, RSS likely available |
| 15 | Prestige Indonesia | prestigeonline.com/id | RSS + scrape | Same platform as Prestige SG |
| 16 | Tatler Philippines | tatlerasia.com/philippines | RSS + scrape | Sub-edition of Tatler Asia |
| 17 | Tatler Hong Kong | tatlerasia.com/hong-kong | RSS + scrape | Sub-edition of Tatler Asia |

**Implementation approach:**
1. On first setup, probe each URL for RSS/Atom (try `/feed`, `/rss`, `/feed.xml`, `/atom.xml`, common WordPress/CMS paths)
2. Store working feed URL in `publications.feed_url`
3. For non-RSS sites, configure CSS selectors in `publications.scrape_config`:
   ```json
   {
     "listing_urls": ["/people", "/style/fashion"],
     "article_selector": "article a[href]",
     "title_selector": "h2, h3",
     "date_selector": "time",
     "pagination": { "type": "next_button", "selector": "a.next" },
     "max_pages": 3
   }
   ```
4. Use `cheerio` for HTML parsing (lightweight, no headless browser needed)
5. If a site requires JS rendering (SPA), fall back to Puppeteer for that specific publication

---

## 6. AI Prompts Outline

### 6.1 Filter Prompt (Stage 2)
```
You are a relevance filter for a UHNW private banker in Singapore.

Given this article title and snippet from a luxury/society magazine, determine if it profiles or names specific wealthy individuals.

RELEVANT if the article:
- Names specific people (not just brands/products)
- Contains wealth signals: wedding, philanthropy, gala, property purchase, business feature, rich list, society event, luxury lifestyle
- Features people who are likely high-net-worth (business owners, heirs, socialites, philanthropists)

NOT RELEVANT if the article:
- Is a product review with no named people
- Is about celebrities/entertainers (unless with business empires)
- Is generic lifestyle advice
- Names only brands, not individuals

Title: {title}
Snippet: {snippet}
Publication: {publication_name}

Return JSON: { "relevant": boolean, "reason": "brief explanation", "confidence": 0-100 }
```

### 6.2 Extraction Prompt (Stage 3)
```
You are a data extraction assistant for a UHNW private banker in Singapore/SEA.

Extract structured information from this luxury magazine article. Focus on identifying wealthy individuals, their companies, and wealth signals.

Article from {publication_name}:
---
{full_text}
---

Extract and return JSON:
{
  "people": [
    {
      "full_name": "string",
      "first_name": "string",
      "last_name": "string",
      "family_name": "string or null (dynasty/clan name)",
      "companies": ["string"],
      "roles": ["string (e.g. 'CEO of X')"],
      "wealth_signals": ["wedding" | "philanthropy" | "property" | "gala" | "business" | "rich_list" | "society"],
      "net_worth_hint": "string or null",
      "region": "SG|HK|MY|ID|PH|TH|TW|other",
      "context": "brief note on how they appear in the article"
    }
  ],
  "companies": [
    {
      "name": "string",
      "sector": "string",
      "is_public": boolean or null,
      "context": "string"
    }
  ],
  "event_type": "wedding|philanthropy|property|gala|business|rich_list|society|profile",
  "headline": "Concise banker-friendly headline (max 100 chars)",
  "summary": "2-3 sentence summary focused on the people and their wealth/business context",
  "banker_angle": "1-2 sentences: why this matters to a private banker. What opportunity does this suggest?",
  "relevance_score": 0-100
}

Rules:
- Only include people who appear to be wealthy/notable (not journalists, not minor mentions)
- "banker_angle" should suggest actionable opportunity (wealth event, liquidity, new money, etc.)
- If no notable people found, return empty people array and relevance_score < 30
```

### 6.3 Person Enrichment Prompt (Stage 4)
```
You are a research assistant building a UHNW individual profile.

Based on your knowledge, provide comprehensive information about this person:

Name: {full_name}
Known context: {known_context}
Region: {region}
Companies: {companies}

Return JSON:
{
  "bio": "2-3 paragraph biography",
  "nationality": "string",
  "city": "string (primary residence)",
  "net_worth_estimate": "string (e.g. '$2.1 billion', 'estimated $100-500M', 'undisclosed')",
  "net_worth_source": "string (e.g. 'Forbes 2025', 'estimated from company valuation')",
  "wealth_generation": "1st gen|2nd gen|3rd gen|unknown",
  "wealth_source": "string (primary sector/source of wealth)",
  "father_name": "string or null",
  "father_status": "alive|deceased|unknown",
  "mother_name": "string or null",
  "mother_status": "alive|deceased|unknown",
  "spouse_name": "string or null",
  "family_notes": "string (notable family members, dynastic connections)",
  "companies": [
    {
      "name": "string",
      "role": "string",
      "role_type": "executive|board|investor|heir|owner",
      "is_current": boolean,
      "ownership_pct": number or null
    }
  ],
  "confidence": "high|medium|low (how confident are you in this data)"
}

If you don't know this person, return { "confidence": "low", "bio": "Limited public information available." } with null fields.
```

### 6.4 Company Enrichment Prompt (Stage 4)
```
You are a research assistant building a company profile for a private banker's CRM.

Company: {name}
Known context: {context}
Known people: {associated_people}

Return JSON:
{
  "description": "2-3 sentence company description",
  "sector": "string",
  "sub_sector": "string",
  "hq_country": "string",
  "hq_city": "string",
  "founded_year": number or null,
  "website": "string or null",
  "is_public": boolean,
  "stock_ticker": "string or null (e.g. 'SGX:CIT')",
  "products_brands": ["string"],
  "brand_description": "string (what their brands/products are known for)",
  "funding_stage": "string",
  "total_funding": "string or null",
  "revenue_estimate": "string or null",
  "funding_history": [
    { "round": "string", "amount": "string", "date": "string", "investors": ["string"] }
  ],
  "investors": ["string (major known investors)"],
  "subsidiaries": ["string"],
  "confidence": "high|medium|low"
}
```

---

## 7. UI Changes to Sensei CRM

### 7.1 Feed — Lifestyle Lead Cards

Lifestyle leads appear in the existing feed alongside news leads, distinguished by:

- **Purple/magenta accent** (vs blue for news leads)
- **"LIFESTYLE" badge** in top-left corner with event type sub-badge (e.g. "GALA", "WEDDING", "PROPERTY")
- **Publication logo/name** displayed prominently (e.g. Tatler icon)
- **People pills:** Clickable name badges for each person mentioned → opens person profile
- **Company pills:** Clickable company names → opens company profile panel
- **Photo thumbnail** from the article (lifestyle articles are typically photo-heavy)
- **Banker angle** shown as an italicized callout below the summary

**Card layout:**
```
┌──────────────────────────────────────────────────────────┐
│ LIFESTYLE · GALA                          Tatler Asia    │
│                                           2h ago         │
│ ┌──────┐                                                 │
│ │ img  │  Peter Lim and daughter Kim Lim spotted at      │
│ │      │  Singapore Philanthropy Gala 2026               │
│ └──────┘                                                 │
│ 👤 Peter Lim · 👤 Kim Lim                                │
│ 🏢 Thomson Medical · 🏢 Valencia CF                       │
│                                                          │
│ 💡 Major philanthropic event signals active wealth       │
│    management needs. Thomson Medical IPO rumored.        │
│                                                          │
│ [Save] [Dismiss] [👍 👎]                    Score: 88    │
└──────────────────────────────────────────────────────────┘
```

### 7.2 Feed Filters

Add to existing feed filter bar:
- **Lead type toggle:** All | News | Lifestyle
- **Event type filter:** Wedding | Gala | Property | Business | Rich List | Philanthropy | Society
- **Publication filter:** Dropdown with all 17 publications
- **Region filter:** SG | HK | MY | ID | PH | TH | TW

### 7.3 Person Profile Panel

Slide-out panel (right side, 400px wide) when clicking a person pill:

```
┌─────────────────────────────────┐
│ ← Back                          │
│                                  │
│  ┌────────┐                      │
│  │ photo  │  Peter Lim           │
│  └────────┘  Singapore           │
│              Net worth: ~$3.5B   │
│              1st generation      │
│                                  │
│  ─── BIO ───                     │
│  Self-made billionaire known     │
│  for investments in healthcare   │
│  and football...                 │
│                                  │
│  ─── FAMILY ───                  │
│  Father: Lim Chwee Kim (dec.)    │
│  Spouse: n/a (divorced)          │
│  Children: Kim Lim               │
│                                  │
│  ─── COMPANIES ───               │
│  🏢 Thomson Medical (Chairman)   │
│  🏢 Valencia CF (Owner)          │
│  🏢 Hotel Properties Ltd (Dir.)  │
│                                  │
│  ─── SOURCE ARTICLES ───         │
│  📰 Tatler Asia - 2026-02-15    │
│  📰 Forbes Asia - 2025-11-20    │
│                                  │
│  ─── LINKEDIN MATCH ───          │
│  ✅ Matched to contact #1234     │
│                                  │
└─────────────────────────────────┘
```

### 7.4 Company Profile Panel

Slide-out panel when clicking a company pill:

```
┌─────────────────────────────────┐
│ ← Back                          │
│                                  │
│  🏢 Thomson Medical Group        │
│  Healthcare · Singapore          │
│  Founded: 1979 · Public (SGX)    │
│  thomsonmedical.com              │
│                                  │
│  ─── OVERVIEW ───                │
│  Leading private healthcare      │
│  provider in Singapore and       │
│  Southeast Asia...               │
│                                  │
│  ─── BRANDS / PRODUCTS ───       │
│  • Thomson Medical Centre        │
│  • Thomson Women's Clinic        │
│  • TMC Fertility                 │
│                                  │
│  ─── KEY PEOPLE ───              │
│  👤 Peter Lim (Chairman)         │
│  👤 Kiat Lim (CEO)               │
│                                  │
│  ─── FUNDING & FINANCIALS ───    │
│  Public · SGX: Q0F                │
│  Market cap: ~$1.2B              │
│                                  │
│  ─── INVESTORS ───               │
│  • Peter Lim (controlling)       │
│                                  │
│  ─── SUBSIDIARIES ───            │
│  • Thomson Medical Centre        │
│  • TMC Life Sciences             │
│                                  │
│  ─── MENTIONED IN ───            │
│  📰 3 lifestyle leads            │
│  📰 5 news leads                 │
│                                  │
└─────────────────────────────────┘
```

### 7.5 Cross-Reference Badge

On **news leads** (existing feed), when the article mentions a company or person that exists in our People DB:

```
┌──────────────────────────────────────────────────┐
│ NEWS                                             │
│ Thomson Medical to acquire hospital chain...     │
│                                                  │
│ 🔗 KNOWN: Peter Lim (Chairman) — seen at         │
│    Tatler Gala 2026-02-15                         │
│                                                  │
│ [Save] [Dismiss]                                  │
└──────────────────────────────────────────────────┘
```

The cross-reference badge is a small callout that says "We know this person/company from [source]". Clicking it opens the person/company profile.

### 7.6 New Navigation

Add to Sensei CRM sidebar:
- **People** — browse/search the UHNW people database
- **Companies** — browse/search company profiles
- **Publications** — admin view of monitored sources, last check times, article counts

---

## 8. Cross-Reference Logic

### 8.1 People ↔ Contacts (LinkedIn)
```
On person creation/update:
1. Normalize name: lowercase, remove titles (Dr., Dato', Tan Sri, etc.)
2. Search contacts table: fuzzy match on name (pg_trgm similarity > 0.7)
3. If match found with confidence > 0.8: auto-link (set people.contact_id)
4. If match found with confidence 0.6-0.8: flag for manual review
5. If no match: leave unlinked
```

### 8.2 Companies ↔ News Leads
```
On news lead ingestion (hook into existing pipeline):
1. Extract company names from news lead text (simple NER or keyword match)
2. Normalize: strip "Pte Ltd", "Holdings", "Group", "Corp", "Inc", "Ltd"
3. Search companies table: exact or trigram match
4. If match found: store cross-reference metadata on the news lead
5. Also check people table for person names mentioned in news lead
```

### 8.3 Deduplication
```
On person extraction:
1. Check for existing person with same full_name + region
2. If found: increment mention_count, add source, update last_mentioned_at
3. If partial match (same last name + region + same company): flag as potential duplicate
4. Manual merge capability in UI (admin)
```

### 8.4 Implementation
- Create a `cross_references` view or table:
```sql
CREATE TABLE cross_references (
  id          SERIAL PRIMARY KEY,
  source_type TEXT NOT NULL,   -- 'news_lead', 'lifestyle_lead'
  source_id   INTEGER NOT NULL,
  target_type TEXT NOT NULL,   -- 'person', 'company', 'contact'
  target_id   INTEGER NOT NULL,
  match_type  TEXT,            -- 'exact', 'fuzzy', 'manual'
  confidence  REAL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source_type, source_id, target_type, target_id)
);
```

---

## 9. Company Profile Feature

### 9.1 Data Sources (Priority Order)
1. **AI extraction** from lifestyle articles (primary)
2. **AI enrichment** from model knowledge (secondary)
3. **Future: API enrichment** from Crunchbase, PitchBook, or similar (Phase 3+)

### 9.2 Company Card API
```
GET /api/companies/:id
GET /api/companies?search=thomson&sector=healthcare
GET /api/companies/:id/people
GET /api/companies/:id/leads  (both news + lifestyle)
```

### 9.3 Company Freshness
- Companies re-enriched every 30 days if `mention_count` increases
- Manual "refresh" button in UI triggers re-enrichment
- `enriched_at` timestamp shown in UI so Billy knows data freshness

---

## 10. Implementation Phases

### Phase 1: Foundation (Week 1-2)
**Goal:** Pipeline infrastructure + basic monitoring

- [ ] Create all database tables (migrations)
- [ ] Set up Lifestyle-sensei Express service (port 5001, systemd)
- [ ] Implement publication registry + probe RSS feeds for all 17 sources
- [ ] Build Stage 1 (Monitor): RSS fetcher + basic scraper with cheerio
- [ ] Build Stage 2 (Filter): AI relevance filter with OpenRouter
- [ ] Manual verification: check filter quality on 100+ articles
- [ ] Basic API: `GET /api/lifestyle-leads` with pagination

**Deliverable:** Articles flowing in and being filtered. Can inspect via API.

### Phase 2: Extraction + Feed (Week 3-4)
**Goal:** Lifestyle leads visible in Sensei CRM

- [ ] Build Stage 3 (Extract): Full article fetch + AI extraction
- [ ] Create people and companies tables, upsert logic
- [ ] Add lifestyle leads to Sensei feed API (extend existing `/api/leads` or new endpoint)
- [ ] Lifestyle lead cards in CRM UI with purple badge, event type, people pills
- [ ] Feed filters: lead type, event type, publication
- [ ] Save/dismiss/feedback for lifestyle leads

**Deliverable:** Billy can see lifestyle leads in his feed and interact with them.

### Phase 3: People DB + Enrichment (Week 5-6)
**Goal:** Rich people and company profiles

- [ ] Build Stage 4 (Enrich): Person enrichment pipeline
- [ ] Build Stage 4 (Enrich): Company enrichment pipeline
- [ ] Person profile panel in CRM UI
- [ ] Company profile panel in CRM UI
- [ ] People browse/search page
- [ ] Companies browse/search page

**Deliverable:** Clicking a name or company opens a rich profile panel.

### Phase 4: Cross-Reference (Week 7-8)
**Goal:** Connect the dots between news and lifestyle

- [ ] Build Stage 5 (Cross-Reference): People ↔ Contacts matching
- [ ] Build Stage 5 (Cross-Reference): Companies ↔ News leads matching
- [ ] Cross-reference badge on news leads
- [ ] LinkedIn match indicator on person profiles
- [ ] Publications admin page (monitoring status, last check, error log)
- [ ] Deduplication tools (merge people, merge companies)

**Deliverable:** Full cross-referencing working. Billy sees connections across all lead types.

### Phase 5: Polish + Scale (Week 9-10)
**Goal:** Production-ready

- [ ] Error handling, retry logic, dead letter queue for failed enrichments
- [ ] Rate limiting dashboard (API costs tracking)
- [ ] Scraper resilience (handle site layout changes, fallback strategies)
- [ ] Performance optimization (indexes, query tuning, caching)
- [ ] A/B testing on AI models (like existing model_ab_log)
- [ ] Export: people/company data to CSV
- [ ] Mobile-responsive lifestyle cards

---

## Appendix A: Tech Stack

| Component | Technology |
|-----------|-----------|
| Pipeline service | Node.js + Express (matches existing) |
| Scraping | axios + cheerio (+ puppeteer fallback) |
| RSS parsing | rss-parser npm package |
| Database | PostgreSQL (existing instance) |
| AI processing | OpenRouter API (Llama 4 Maverick primary, Gemini 2.5 Flash fallback) |
| Task scheduling | node-cron (in-process) |
| CRM frontend | Next.js 16.1 (existing Sensei app) |
| Full-text extraction | @mozilla/readability + jsdom |

## Appendix B: Cost Estimates

| Item | Monthly Cost |
|------|-------------|
| OpenRouter - Filter stage (~3000 articles × $0.001) | ~$3 |
| OpenRouter - Extract stage (~900 articles × $0.005) | ~$5 |
| OpenRouter - Person enrichment (~200 people × $0.01) | ~$2 |
| OpenRouter - Company enrichment (~100 companies × $0.01) | ~$1 |
| Server resources (existing VPS) | $0 |
| **Total** | **~$11/month** |

*Well under the $50/month budget. Costs scale linearly with article volume.*

## Appendix C: Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Publication blocks our scraper | Respect robots.txt, rotate User-Agent, rate limit, RSS preferred |
| Site redesign breaks scraper | Scrape config is per-publication JSON; easy to update selectors |
| AI extraction hallucinations | Confidence scores + manual review queue for low-confidence extractions |
| People dedup errors | Conservative auto-linking (>0.8 confidence only); manual merge UI |
| API cost spike | Per-hour enrichment caps; model fallback to cheaper Gemini Flash |
| Paywall content | Skip paywalled articles; only process freely available content |
