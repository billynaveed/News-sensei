# Intelligent Lead Pipeline & Telegram Integration Design

**Date:** 2026-02-12
**Status:** Ready for Implementation
**Priority:** High - Core System Redesign

## Executive Summary

This design transforms News-sensei from a simple keyword-matching system into an intelligent, multi-stage lead qualification pipeline with interactive Telegram integration. Key improvements:

- **7-stage intelligent pipeline** replacing simple keyword matching
- **Interactive Telegram buttons** with webhook-based status updates
- **Semantic filtering** using editable LLM prompts instead of keyword lists
- **Smart deduplication** that detects substantial changes in follow-up articles
- **Premium content extraction** for Tier 1 sources using ScrapingBee
- **Automatic enrichment** with web search during initial scan
- **Test mode** for validating pipeline decisions

---

## Part 1: Telegram Interactive Buttons

### Current Problem
- Telegram messages include buttons (Save, Mark Reviewed, Dismiss)
- Buttons flash when clicked but nothing happens
- No webhook or polling to handle callback queries
- User has no feedback on actions

### Solution Architecture

**Webhook Endpoint:**
```typescript
POST /api/telegram-webhook
- Receives callback_query events from Telegram
- Parses callback_data: "lead_save_{leadId}", "lead_reviewed_{leadId}", "lead_dismiss_{leadId}"
- Updates lead status in database
- Edits message to replace buttons with status indicator
- Uses answerCallbackQuery to acknowledge click
```

**Webhook Setup (server startup):**
```typescript
// In server/index.ts
if (process.env.TELEGRAM_BOT_TOKEN && process.env.SERVER_URL) {
  await setWebhook(`${SERVER_URL}/api/telegram-webhook`);
}
```

**Status Indicators:**
| Action | Status Display |
|--------|---------------|
| Save | ✅ Saved |
| Mark Reviewed | ✅ Reviewed |
| Dismiss | 🗑️ Dismissed |

**Button Actions:**

1. **Save Button:**
   - Update `leads` table: `status = "saved"`
   - Create entry in `saved_leads` table with enriched data
   - Edit message: replace buttons with "✅ Saved"

2. **Mark Reviewed Button:**
   - Update `leads` table: `status = "reviewed"`
   - Edit message: replace buttons with "✅ Reviewed"

3. **Dismiss Button:**
   - Update `leads` table: `status = "dismissed"`
   - Edit message: replace buttons with "🗑️ Dismissed"

**Error Handling:**
- Lead already saved → respond "✅ Already saved"
- Lead not found → respond "❌ Lead no longer available"
- Database error → respond "⚠️ Error, please try again"
- Log all webhook events for debugging

**Implementation Files:**
- `server/routes.ts` - Add webhook endpoint
- `server/telegram.ts` - Add webhook setup and message editing functions
- `.env.example` - Add `SERVER_URL` variable

---

## Part 2: Multi-Stage Intelligent Lead Pipeline

### Current System (Simple)
```
RSS/Google News → Keyword Match → AI Extract → Save to DB
```

### New System (Intelligent)
```
RSS/Google News → Stage 1: Interest Filter (LLM)
                → Stage 2: Company Extraction
                → Stage 3: Public Company Filter
                → Stage 4: Deduplication Check
                → Stage 5: Full Article Fetch
                → Stage 6: Deep Analysis
                → Stage 7: Enrichment
                → Save to DB with full metadata
```

---

### Stage 1: Semantic Interest Filter

**Purpose:** Replace simple keyword matching with intelligent semantic analysis.

**Current Settings UI:**
```
Keywords: [IPO, M&A, funding, exit, acquisition]
```

**New Settings UI:**
```
Lead Interest Filter Prompt:
┌─────────────────────────────────────────────────┐
│ Analyze if this article indicates a wealth     │
│ liquidity event relevant to private banking:   │
│                                                 │
│ INCLUDE if article discusses:                  │
│ - Private companies raising funding rounds     │
│ - M&A exits or acquisitions                    │
│ - Companies preparing for IPO/listing          │
│ - Founder liquidity events                     │
│ - Private company sales or strategic exits     │
│                                                 │
│ EXCLUDE if:                                     │
│ - Company is already publicly listed           │
│ - Article is about listed company earnings     │
│ - No founder/wealth angle mentioned            │
│                                                 │
│ [User can edit and refine this prompt]         │
└─────────────────────────────────────────────────┘
```

**Implementation:**
```typescript
// New function in scanner.ts
async function passesInterestFilter(
  article: RawArticle,
  filterPrompt: string,
  targetRegions: string[]
): Promise<{ passes: boolean; reason: string }> {
  const prompt = `${filterPrompt}

Article Headline: ${article.headline}
Article Snippet: ${article.content.slice(0, 500)}
Source: ${article.source}
Target Regions: ${targetRegions.join(", ")}

Return JSON:
{
  "relevant": true/false,
  "reason": "Brief explanation of decision",
  "confidenceScore": 0-100
}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(response.choices[0].message.content);
  return {
    passes: result.relevant && result.confidenceScore > 60,
    reason: result.reason,
  };
}
```

**Database Changes:**
- Remove `keywords` field from `settings` table
- Add `interestFilterPrompt` TEXT field to `settings` table
- Include default prompt in seed data

---

### Stage 2: Company Extraction

**Purpose:** Extract primary company name from headline/snippet before full analysis.

**Implementation:**
```typescript
async function extractPrimaryCompany(
  article: RawArticle
): Promise<string | null> {
  const prompt = `Extract the PRIMARY company name from this article headline:

Headline: ${article.headline}
Content: ${article.content.slice(0, 300)}

Return ONLY the company name, or null if no clear company is mentioned.
Return JSON: { "companyName": "string or null" }`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(response.choices[0].message.content);
  return result.companyName;
}
```

---

### Stage 3: Public Company Filter

**Purpose:** Automatically skip articles about publicly-listed companies.

**Implementation:**
```typescript
async function isPublicCompany(
  companyName: string,
  articleHeadline: string
): Promise<{ isPublic: boolean; reason: string }> {
  const prompt = `Determine if this company is publicly listed/traded:

Company: ${companyName}
Article Headline: ${articleHeadline}

A company is PUBLIC if:
- It trades on a stock exchange (SGX, NASDAQ, NYSE, etc)
- Article mentions stock ticker symbols
- Described as "publicly traded" or "listed company"

A company is PRIVATE if:
- Not yet listed
- Article discusses FUTURE IPO (company is still private)
- No mention of trading or stock tickers

Return JSON:
{
  "isPublic": true/false,
  "reason": "Brief explanation",
  "confidence": 0-100
}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(response.choices[0].message.content);
  return {
    isPublic: result.isPublic && result.confidence > 70,
    reason: result.reason,
  };
}
```

---

### Stage 4: Smart Deduplication

**Purpose:** Detect if article is about a company already in database, and if so, whether it contains substantially new information.

**Database Schema Change:**
```sql
ALTER TABLE saved_leads ADD COLUMN article_summary TEXT;
```

**Implementation:**
```typescript
async function checkDuplication(
  companyName: string,
  newArticleHeadline: string,
  newArticleSnippet: string
): Promise<{
  isDuplicate: boolean;
  isUpdate: boolean;
  existingSavedLeadId: string | null;
  reason: string;
}> {
  // 1. Check if company exists in saved_leads
  const existingLead = await storage.getSavedLeadByCompanyName(companyName);

  if (!existingLead) {
    return {
      isDuplicate: false,
      isUpdate: false,
      existingSavedLeadId: null,
      reason: "New company, not in database",
    };
  }

  // 2. Compare new article to saved article summary
  const prompt = `Compare these two articles about the same company:

SAVED ARTICLE SUMMARY:
${existingLead.articleSummary}

NEW ARTICLE:
Headline: ${newArticleHeadline}
Snippet: ${newArticleSnippet}

Determine if the new article contains SUBSTANTIALLY NEW information.

Substantially new means:
- Different funding round or amount
- New acquisition or exit event
- Significant business development
- Different time period or stage

NOT substantially new:
- Same event, different wording
- Minor updates to same story
- Similar information already covered

Return JSON:
{
  "substantiallyNew": true/false,
  "percentNew": 0-100,
  "reason": "Explanation of what's new or why it's duplicate"
}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(response.choices[0].message.content);

  if (result.substantiallyNew && result.percentNew > 40) {
    return {
      isDuplicate: false,
      isUpdate: true,
      existingSavedLeadId: existingLead.id,
      reason: result.reason,
    };
  } else {
    return {
      isDuplicate: true,
      isUpdate: false,
      existingSavedLeadId: existingLead.id,
      reason: result.reason,
    };
  }
}
```

**UI Implications:**
- New leads: Show "💾 Save" button
- Updates to saved companies: Show "📰 Update for saved company" badge (no Save button)
- Display link to original saved lead

**Database Schema Addition:**
```sql
ALTER TABLE leads ADD COLUMN is_update BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN related_saved_lead_id TEXT;
```

---

### Stage 5: Full Article Content Fetch

**Purpose:** For Tier 1 sources and articles that passed all filters, fetch complete article content for deep analysis.

**Tier 1 Sources Strategy:**
- Run ScrapingBee in PARALLEL with RSS/Google News (not as fallback)
- If article matches filters → use premium ScrapingBee to get full content
- Premium features: `render_js=true`, `premium_proxy=true`, `block_resources=false`

**Implementation:**
```typescript
async function fetchFullArticleContent(
  article: RawArticle,
  sourceTier: SourceTier
): Promise<{ fullContent: string; fetchMethod: string }> {
  // For Tier 1 sources, use premium ScrapingBee
  if (sourceTier === "tier1" && SCRAPINGBEE_API_KEY) {
    const params = new URLSearchParams({
      api_key: SCRAPINGBEE_API_KEY,
      url: article.url,
      render_js: "true",
      premium_proxy: "true",
      block_resources: "false",
      extract_rules: JSON.stringify({
        article_text: {
          selector: "article, .article-body, .story-body, main",
          type: "item",
          output: "text"
        }
      })
    });

    const response = await fetch(`https://app.scrapingbee.com/api/v1?${params}`);
    const data = await response.json();

    return {
      fullContent: data.article_text || article.content,
      fetchMethod: "scrapingbee_premium"
    };
  }

  // For other tiers, use existing content
  return {
    fullContent: article.content,
    fetchMethod: article.fetchMethod
  };
}
```

**Cost Implications:**
- Premium ScrapingBee: ~5-10 credits per request
- Only used for Tier 1 sources that pass all filters
- Estimated: 5-10 premium requests per scan (if 2-3 Tier 1 leads pass filters)

---

### Stage 6: Deep Analysis with Full Content

**Purpose:** With full article content, perform comprehensive analysis to extract all relevant information.

**Implementation:**
```typescript
async function deepAnalyzeArticle(
  article: RawArticle,
  fullContent: string,
  targetRegions: string[]
): Promise<Partial<InsertLead> | null> {
  const prompt = `Perform deep analysis of this news article for private banking lead intelligence.

FULL ARTICLE:
Headline: ${article.headline}
Source: ${article.source}
Content: ${fullContent}

Extract and return JSON:
{
  "companyNames": ["array of all companies mentioned"],
  "primaryCompany": "the main company this article is about",
  "founderNames": ["array of founders/key people"],
  "investors": ["array of investors mentioned"],
  "summary": "Comprehensive 2-3 paragraph summary covering: what happened, deal size/valuation if mentioned, strategic significance, and why this matters for private banking",
  "keyFinancials": {
    "fundingAmount": "e.g. $50M",
    "valuation": "e.g. $500M",
    "dealValue": "for M&A"
  },
  "priorityScore": 1-100,
  "priorityLevel": "high/medium/low",
  "matchedIndicators": ["IPO", "Series B", "Exit", etc],
  "wealthAngle": "Explanation of the wealth/liquidity opportunity for private banking"
}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: 2000,
    response_format: { type: "json_object" },
  });

  const extracted = JSON.parse(response.choices[0].message.content);

  return {
    headline: article.headline,
    sourceUrl: article.url,
    sourceName: article.source,
    sourceTier: article.sourceTier,
    publishedAt: article.publishedAt,
    companyNames: extracted.companyNames || [],
    founderNames: extracted.founderNames || [],
    investors: extracted.investors || [],
    aiSummary: extracted.summary || "",
    matchedKeywords: extracted.matchedIndicators || [],
    priorityScore: extracted.priorityScore || 50,
    priorityLevel: extracted.priorityLevel || "medium",
    region: article.region,
    status: "new",
    fetchMethod: article.fetchMethod,
    keyFinancials: extracted.keyFinancials,
    wealthAngle: extracted.wealthAngle,
  };
}
```

**Database Schema Additions:**
```sql
ALTER TABLE leads ADD COLUMN key_financials JSONB;
ALTER TABLE leads ADD COLUMN wealth_angle TEXT;
```

---

### Stage 7: Web Search Enrichment

**Purpose:** Automatically enrich leads with founder and company research during scan.

**Implementation:**
```typescript
// In scanner.ts, after deepAnalyzeArticle and before storage.createLead
if (leadInfo.companyNames.length > 0) {
  try {
    const enrichment = await enrichSavedLead({
      companyNames: leadInfo.companyNames,
      founderNames: leadInfo.founderNames,
      region: leadInfo.region,
    });

    const enrichedData = formatEnrichmentForSavedLead(enrichment);

    // Merge enrichment data into leadInfo
    leadInfo.founderLinkedInUrl = enrichedData.founderLinkedInUrl;
    leadInfo.founderBio = enrichedData.founderBio;
    leadInfo.companyDescription = enrichedData.companyDescription;
    leadInfo.enrichmentData = enrichedData.researchData;
  } catch (error) {
    console.error("Enrichment failed, saving without enrichment:", error);
    // Continue without enrichment data
  }
}
```

**Database Schema Additions:**
```sql
ALTER TABLE leads ADD COLUMN founder_linkedin_url TEXT;
ALTER TABLE leads ADD COLUMN founder_bio TEXT;
ALTER TABLE leads ADD COLUMN company_description TEXT;
ALTER TABLE leads ADD COLUMN enrichment_data JSONB;
```

**Performance:**
- Each enrichment: 2 web searches + 2 GPT-4o calls = ~3-5 seconds
- Scan with 10 qualified leads: +30-50 seconds total
- Progress updates: "Enriching lead 3/10: Researching [Company Name]..."

---

## Part 3: ScrapingBee Tier 1 Strategy

### Current Behavior
- ScrapingBee used as fallback only
- Only activated when RSS + Google News return 0 articles

### New Tier 1 Behavior

**Parallel Fetching:**
For sources marked as Tier 1 (Bloomberg, Financial Times, etc):
1. Run RSS feeds (if configured)
2. Run Google News search
3. **Run ScrapingBee in PARALLEL** (not fallback)
4. Combine all results, deduplicate by URL

**Premium Upgrade:**
When an article from Tier 1 source passes Stage 1-4 filters:
1. Use premium ScrapingBee to fetch full article text
2. Pass full content to Stage 6 (Deep Analysis)

**Database Schema:**
```sql
ALTER TABLE sources ADD COLUMN use_premium_scraping BOOLEAN DEFAULT false;
```

**Settings UI:**
For each source, add checkbox:
```
☑ Use premium scraping for this source
  (Higher cost, better content extraction for paywalled articles)
```

**Implementation in adapters.ts:**
```typescript
export async function fetchAllArticles(
  activeSources: Source[],
  activeFeeds: RssFeedWithMeta[],
  keywords: string[],
  options: ScanningOptions
): Promise<FetchAllArticlesResult> {
  const allArticles: RawArticle[] = [];
  const tier1Sources = activeSources.filter(s => s.tier === "tier1");
  const otherSources = activeSources.filter(s => s.tier !== "tier1");

  // For Tier 1: Run all methods in parallel
  if (tier1Sources.length > 0) {
    const tier1Results = await Promise.all(
      tier1Sources.map(async (source) => {
        const methods = [];

        if (options.rssEnabled) {
          methods.push(fetchFromRssFeed(...));
        }
        if (options.googleNewsEnabled) {
          methods.push(fetchFromGoogleNews(source, ...));
        }
        if (options.scrapingBeeEnabled) {
          methods.push(fetchFromScrapingBee(source, ...));
        }

        const results = await Promise.all(methods);
        return results.flat();
      })
    );
    allArticles.push(...tier1Results.flat());
  }

  // For other tiers: Use existing fallback logic
  // ... existing code ...

  return deduplicateAndReturn(allArticles);
}
```

---

## Part 4: Source Badge Display

### Current State
- `fetchMethod` field exists in database
- Not displayed in UI

### New UI Component

**Lead Card Badge:**
```typescript
// In client/src/components/LeadCard.tsx
function FetchMethodBadge({ method }: { method: FetchMethod }) {
  const config = {
    rss: { icon: "📡", label: "RSS", color: "bg-blue-100 text-blue-800" },
    google_news: { icon: "🔍", label: "Google News", color: "bg-green-100 text-green-800" },
    scrapingbee: { icon: "🐝", label: "ScrapingBee", color: "bg-yellow-100 text-yellow-800" },
    scrapingbee_premium: { icon: "⭐", label: "Premium", color: "bg-purple-100 text-purple-800" },
  };

  const { icon, label, color } = config[method];

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded ${color}`}>
      <span>{icon}</span>
      <span>{label}</span>
    </span>
  );
}
```

**Placement:**
Show badge in lead card header, next to source name:
```
[Lead Card]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Bloomberg | 📡 RSS | 🔴 High Priority
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Part 5: Testing & Validation

### Test Mode

**New Settings Toggle:**
```
☑ Test Mode
  Run pipeline on sample articles without saving to database.
  Shows decision at each stage for debugging.
```

**Implementation:**
```typescript
// POST /api/test-pipeline
app.post("/api/test-pipeline", async (req, res) => {
  const settings = await storage.getSettings();
  const activeSources = await storage.getActiveSources();

  // Fetch 5 articles from each active source
  const sampleArticles = await fetchSampleArticles(activeSources, 5);

  const testResults = [];

  for (const article of sampleArticles) {
    const result = {
      article: {
        headline: article.headline,
        source: article.source,
        url: article.url,
      },
      stages: {},
    };

    // Stage 1: Interest Filter
    const stage1 = await passesInterestFilter(article, settings.interestFilterPrompt, settings.regions);
    result.stages.stage1 = {
      name: "Interest Filter",
      passed: stage1.passes,
      reason: stage1.reason,
    };
    if (!stage1.passes) {
      testResults.push(result);
      continue;
    }

    // Stage 2: Company Extraction
    const stage2 = await extractPrimaryCompany(article);
    result.stages.stage2 = {
      name: "Company Extraction",
      passed: !!stage2,
      companyName: stage2,
    };
    if (!stage2) {
      testResults.push(result);
      continue;
    }

    // Stage 3: Public Company Filter
    const stage3 = await isPublicCompany(stage2, article.headline);
    result.stages.stage3 = {
      name: "Public Company Filter",
      passed: !stage3.isPublic,
      reason: stage3.reason,
    };
    if (stage3.isPublic) {
      testResults.push(result);
      continue;
    }

    // Stage 4: Deduplication
    const stage4 = await checkDuplication(stage2, article.headline, article.content);
    result.stages.stage4 = {
      name: "Deduplication",
      passed: !stage4.isDuplicate,
      isUpdate: stage4.isUpdate,
      reason: stage4.reason,
    };

    // Stages 5-7 would continue if not testing
    result.stages.stage5 = { name: "Full Article Fetch", passed: true, note: "Would fetch in production" };
    result.stages.stage6 = { name: "Deep Analysis", passed: true, note: "Would analyze in production" };
    result.stages.stage7 = { name: "Enrichment", passed: true, note: "Would enrich in production" };

    testResults.push(result);
  }

  res.json({
    totalArticles: sampleArticles.length,
    results: testResults,
    summary: {
      stage1Passed: testResults.filter(r => r.stages.stage1?.passed).length,
      stage2Passed: testResults.filter(r => r.stages.stage2?.passed).length,
      stage3Passed: testResults.filter(r => r.stages.stage3?.passed).length,
      stage4Passed: testResults.filter(r => r.stages.stage4?.passed).length,
    }
  });
});
```

**UI Component:**
Add "Test Pipeline" button to Settings page that:
1. Triggers test endpoint
2. Shows results in expandable table
3. Displays decision reason at each stage
4. Highlights articles that would be saved

---

## Part 6: Scan Progress Enhancements

### Enhanced Progress Messages

Update `scanProgress` messages to reflect new stages:

```typescript
// Stage 1
scanProgress.set(scanId, {
  status: "processing",
  message: "Stage 1/7: Filtering articles by interest...",
  articlesProcessed: i,
  totalArticles: articles.length
});

// Stage 2
scanProgress.set(scanId, {
  status: "processing",
  message: "Stage 2/7: Extracting company names...",
  articlesProcessed: i,
  totalArticles: articles.length
});

// Stage 3
scanProgress.set(scanId, {
  status: "processing",
  message: "Stage 3/7: Checking if companies are public...",
  articlesProcessed: i,
  totalArticles: articles.length
});

// Stage 4
scanProgress.set(scanId, {
  status: "processing",
  message: "Stage 4/7: Checking for duplicates...",
  articlesProcessed: i,
  totalArticles: articles.length
});

// Stage 5
scanProgress.set(scanId, {
  status: "processing",
  message: "Stage 5/7: Fetching full article content...",
  articlesProcessed: i,
  totalArticles: articles.length
});

// Stage 6
scanProgress.set(scanId, {
  status: "processing",
  message: `Stage 6/7: Deep analysis of ${article.headline.slice(0, 40)}...`,
  articlesProcessed: i,
  totalArticles: articles.length
});

// Stage 7
scanProgress.set(scanId, {
  status: "processing",
  message: `Stage 7/7: Enriching ${companyName} with web research...`,
  articlesProcessed: i,
  totalArticles: articles.length
});
```

---

## Part 7: Database Schema Changes Summary

**New Tables:**
None (saved_leads already exists)

**Modified Tables:**

```sql
-- settings table
ALTER TABLE settings DROP COLUMN keywords;
ALTER TABLE settings ADD COLUMN interest_filter_prompt TEXT;

-- leads table
ALTER TABLE leads ADD COLUMN is_update BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN related_saved_lead_id TEXT;
ALTER TABLE leads ADD COLUMN key_financials JSONB;
ALTER TABLE leads ADD COLUMN wealth_angle TEXT;
ALTER TABLE leads ADD COLUMN founder_linkedin_url TEXT;
ALTER TABLE leads ADD COLUMN founder_bio TEXT;
ALTER TABLE leads ADD COLUMN company_description TEXT;
ALTER TABLE leads ADD COLUMN enrichment_data JSONB;

-- saved_leads table
ALTER TABLE saved_leads ADD COLUMN article_summary TEXT;

-- sources table
ALTER TABLE sources ADD COLUMN use_premium_scraping BOOLEAN DEFAULT false;

-- Add new fetch method to enum
ALTER TYPE fetch_method ADD VALUE 'scrapingbee_premium';
```

**Migration Script:**
Create `server/migrations/2026-02-12-intelligent-pipeline.ts` to handle:
1. Convert existing keywords to default interest filter prompt
2. Add new columns with default values
3. Backfill article_summary for existing saved leads

---

## Part 8: Implementation Plan

### Phase 1: Foundation (Week 1)
- [ ] Database schema changes and migration
- [ ] Update settings UI to show interest filter prompt
- [ ] Implement Stage 1: Interest Filter function
- [ ] Test with sample articles

### Phase 2: Pipeline Stages (Week 2)
- [ ] Implement Stage 2: Company Extraction
- [ ] Implement Stage 3: Public Company Filter
- [ ] Implement Stage 4: Smart Deduplication
- [ ] Update scan progress messages
- [ ] Test each stage independently

### Phase 3: Content & Analysis (Week 3)
- [ ] Implement Stage 5: Full Article Fetch (premium ScrapingBee)
- [ ] Implement Stage 6: Deep Analysis with full content
- [ ] Update Tier 1 sources to use parallel fetching
- [ ] Test with Bloomberg/FT articles

### Phase 4: Enrichment & Display (Week 4)
- [ ] Implement Stage 7: Automatic enrichment during scan
- [ ] Add source badges to UI (FetchMethodBadge component)
- [ ] Update lead cards to show enriched data
- [ ] Test end-to-end pipeline

### Phase 5: Telegram Integration (Week 5)
- [ ] Implement webhook endpoint
- [ ] Set up webhook on server startup
- [ ] Handle button callbacks (save/review/dismiss)
- [ ] Edit messages to show status indicators
- [ ] Test with real Telegram bot

### Phase 6: Testing & Validation (Week 6)
- [ ] Implement test mode endpoint
- [ ] Create test mode UI component
- [ ] Run test mode on all active sources
- [ ] Refine prompts based on test results
- [ ] Performance optimization

---

## Part 9: Cost & Performance Estimates

### API Costs Per Lead (Qualified)

**Current System:**
- 1x GPT-4o call (extraction): ~$0.01
- **Total: $0.01/lead**

**New System:**
- Stage 1: 1x GPT-4o (interest filter): ~$0.005
- Stage 2: 1x GPT-4o (company extraction): ~$0.005
- Stage 3: 1x GPT-4o (public check): ~$0.005
- Stage 4: 1x GPT-4o (dedup comparison): ~$0.01
- Stage 5: 1x ScrapingBee premium (Tier 1 only): ~$0.05
- Stage 6: 1x GPT-4o (deep analysis): ~$0.02
- Stage 7: 2x Tavily searches: ~$0.02
- Stage 7: 2x GPT-4o (enrichment): ~$0.02
- **Total: ~$0.14/lead (Tier 1) or ~$0.09/lead (other tiers)**

**Monthly Estimate:**
- Assume 50 qualified leads/month
- 20% from Tier 1 sources: 10 leads × $0.14 = $1.40
- 80% from other sources: 40 leads × $0.09 = $3.60
- **Total: ~$5/month** (vs current $0.50/month)
- **10x cost increase, but exponentially better lead quality**

### Performance

**Current Scan Time:**
- 10 articles → ~30 seconds (3s per article)

**New Pipeline:**
- Stage 1-4: ~5s per article (4x GPT-4o calls)
- 50% filtered out → 5 articles continue
- Stage 5-7: ~10s per article (full fetch + enrichment)
- **Total: ~100 seconds for 10 articles**
- **3x slower, but produces fully enriched, high-quality leads**

---

## Part 10: Success Metrics

### Quantitative Metrics
- **Precision:** % of leads that are actually relevant (target: >90%)
- **Recall:** % of relevant articles captured (target: >80%)
- **Deduplication accuracy:** % of true duplicates caught (target: >95%)
- **Enrichment coverage:** % of leads with founder bio and company description (target: >70%)
- **Public company filter accuracy:** % of public companies correctly filtered (target: >95%)

### Qualitative Metrics
- User feedback on lead quality
- Time saved in manual research
- Number of leads that convert to client meetings
- User satisfaction with Telegram interaction

### Monitoring & Dashboards
Add to Settings page:
```
Pipeline Health Dashboard
━━━━━━━━━━━━━━━━━━━━━━━
Stage 1 (Interest Filter):     87% pass rate
Stage 2 (Company Extraction):   92% success rate
Stage 3 (Public Filter):        15% filtered (correct)
Stage 4 (Deduplication):        8% duplicates caught
Stage 5-7 (Full Pipeline):      23% completion rate

API Cost (30 days): $4.82
Avg Lead Quality Score: 87/100
```

---

## Part 11: Risk Mitigation

### Risk: High API Costs
**Mitigation:**
- Implement cost caps in settings (e.g., "Max $10/month")
- Alert when 80% of budget consumed
- Fallback to simpler pipeline if cost cap reached

### Risk: Slow Scan Times
**Mitigation:**
- Run stages in parallel where possible (Stage 1-2 can be combined)
- Implement timeout per stage (10s max)
- Skip enrichment if taking too long, log for manual follow-up

### Risk: LLM Hallucinations
**Mitigation:**
- Always include confidence scores in responses
- Log all LLM decisions for audit
- Human review of high-value leads before contact
- Test mode to validate prompts before production

### Risk: Webhook Failures
**Mitigation:**
- Implement webhook retry logic (3 attempts)
- Fallback to polling if webhook setup fails
- Log all webhook events for debugging
- Graceful degradation: if webhook down, show warning in Telegram

---

## Appendix A: Example Prompts

### Default Interest Filter Prompt
```
Analyze if this article indicates a wealth liquidity event relevant to private banking clients in Southeast Asia.

INCLUDE articles about:
- Private companies raising Series A, B, C+ funding rounds
- Mergers & acquisitions where founders are exiting
- Companies preparing for IPO or listing (still private)
- Significant exits or strategic sales
- Founder liquidity events (secondary sales, founder shares)
- Private company valuations reaching unicorn status ($1B+)

EXCLUDE articles about:
- Companies already publicly listed (trading on exchanges)
- Listed company earnings reports or stock movements
- Government policy or regulatory changes only
- General industry trends without specific companies
- Partnerships or commercial deals (unless involving equity/acquisition)

Target Regions: Singapore, Malaysia, Indonesia, Thailand, Vietnam, Philippines, Hong Kong

Return JSON with:
- relevant: true/false
- reason: brief explanation of decision
- confidenceScore: 0-100 (how confident you are)
```

---

## Appendix B: File Structure

```
server/
├── routes.ts                   # Add webhook endpoint
├── telegram.ts                 # Add webhook setup, message editing
├── scanner.ts                  # Implement 7-stage pipeline
├── adapters.ts                 # Update Tier 1 parallel fetching
├── founder-enrichment.ts       # (already exists, use in Stage 7)
├── web-search.ts              # (already exists, use in Stage 7)
├── storage.ts                  # Add new database methods
└── migrations/
    └── 2026-02-12-intelligent-pipeline.ts

client/src/
├── components/
│   ├── FetchMethodBadge.tsx   # New component for source badges
│   ├── LeadCard.tsx           # Update to show badges, update indicators
│   └── TestPipelineResults.tsx # New component for test mode UI
├── pages/
│   ├── SettingsPage.tsx       # Update to show interest filter prompt
│   └── DashboardPage.tsx      # Update lead cards with badges

shared/
└── schema.ts                   # Update database schema types

docs/plans/
└── 2026-02-12-intelligent-lead-pipeline-design.md  # This file
```

---

## Appendix C: Open Questions

1. **Prompt Versioning:** Should we version interest filter prompts and allow rollback?
2. **Multi-language:** Should prompts detect and handle non-English articles?
3. **Learning Loop:** Should system learn from user feedback (saved vs dismissed) to improve prompts?
4. **Batch Processing:** For large scans (100+ articles), should we implement batch/queue system?
5. **Webhook Security:** Should we validate Telegram webhook signature?

---

## Next Steps

1. **Review this design document with stakeholders**
2. **Create detailed implementation tasks in project management tool**
3. **Set up development branch: `feature/intelligent-pipeline`**
4. **Begin Phase 1 implementation**
5. **Schedule weekly review meetings to track progress**

---

**Design Status:** ✅ Complete and Ready for Implementation
**Estimated Implementation Time:** 6 weeks
**Estimated Monthly Operating Cost:** $5-10 (10x current, but exponentially better quality)
**Expected Lead Quality Improvement:** 5-10x reduction in false positives

---

*This design document should be treated as a living document and updated as implementation progresses and new insights are gained.*
