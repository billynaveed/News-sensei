# Feature Roadmap - News-sensei

## Recently Completed

### 1. Sidebar Navigation Improvements ✅
**Status:** Completed

- ✅ Auto-close sidebar on mobile when clicking navigation links
- ✅ Highlight current active page in navigation
- ✅ Fix saved leads active state detection using proper URL routing

### 2. Saved Leads Refactor (Major Feature) ✅
**Status:** Completed

**Implemented Changes:**

**Database:**
- ✅ Created `saved_leads` table with schema:
  - id, leadId (FK to leads), savedAt timestamp
  - founderLinkedInUrl, founderBio, companyDescription
  - notes (user notes)
  - researchData (JSON field for future expansion)

**API Endpoints:**
- ✅ `POST /api/saved-leads` - Save a lead with optional metadata
- ✅ `GET /api/saved-leads` - Get all saved leads with full lead data
- ✅ `DELETE /api/saved-leads/:id` - Remove from saved
- ✅ `PATCH /api/saved-leads/:id` - Update metadata (notes, LinkedIn, etc.)

**Frontend:**
- ✅ Created `/saved-leads` page with expandable UI:
  - Collapsible Founder Details section (LinkedIn URL, biography)
  - Collapsible Company Details section (description, known investors)
  - Collapsible My Notes section (private user notes)
  - Always-visible AI Summary
  - Edit/Save functionality for all sections
  - Remove button with confirmation dialog
- ✅ Updated sidebar to link to `/saved-leads` route
- ✅ Removed "saved" status filter from dashboard
- ✅ Updated dashboard "Save" button to use new saved_leads API
- ✅ Backward compatibility: still sets `status: "saved"` in leads table

**Migration Strategy:**
- Keeps existing `status: "saved"` in leads table for backward compatibility
- When user saves a lead, creates entry in saved_leads table AND sets status
- When user removes from saved, deletes from saved_leads and sets status back to "reviewed"

### 3. Manual Scan Button Cleanup ✅
**Status:** Completed

- ✅ Removed scan button from saved leads page
- ✅ Kept scan button ONLY on main Dashboard page
- ✅ Added tooltips: "Scans run automatically every hour. Use this for immediate scanning."

## In Progress / Current Sprint

---

## Upcoming Features (Prioritized)

### 4. Telegram Research Command (High Priority)
**Status:** Specification phase

**Goal:** Allow users to research people via Telegram bot by typing their name

**User Flow:**
1. User types: `/research [Person Name]` in Telegram
2. Bot searches saved leads database + LinkedIn/web for matches
   - Default search scope: Singapore
   - Search in: Saved leads, recent leads, LinkedIn API (if available), web search
3. If multiple matches found:
   - Bot replies with numbered list: "Found 3 matches: 1) John Tan (ABC Corp), 2) John Tan (XYZ Ltd), 3) John Tan (Startup Inc)"
   - User replies with number: "1"
4. Once person identified, bot provides detailed background:
   - **Professional Background:**
     - Current role & company
     - Previous roles/companies
     - Education
     - Years of experience
   - **Wealth Indicators:**
     - Company funding history
     - Exit events
     - Investment portfolio
     - Board positions
   - **Recent Activity:**
     - Recent news mentions
     - Deals/transactions
     - Public appearances
   - **Contact Approach:**
     - Recommended talking points
     - Mutual connections (if available)
     - Best contact method

**Technical Implementation:**
- New Telegram command handler: `/research [name]`
- Person resolution logic:
  1. Search saved_leads + leads tables for name match
  2. Search LinkedIn (via API or scraping if API available)
  3. Web search fallback
- AI-powered disambiguation: Use GPT-4o to help resolve ambiguous matches
- AI-powered background generation: Use GPT-4o to synthesize information
- Store research results in `research_cache` table to avoid re-querying

**Open Questions:**
- LinkedIn API access? (May need RapidAPI or scraping)
- Rate limiting strategy?
- How to handle common names?
- Should we cache research results? For how long?

### 5. Founder Enrichment Pipeline (High Priority)
**Status:** Design phase

**Goal:** Automatically enrich founder information when leads are saved

**Features:**
- When user saves a lead, trigger background job to:
  1. Search LinkedIn for founder profile
  2. Extract: Profile URL, headline, bio, experience, education
  3. Search for company description (website, LinkedIn company page)
  4. Store enriched data in saved_leads table

- Show loading state while enrichment happens
- Allow manual "Re-fetch" button if enrichment fails

**Technical Stack:**
- Background job queue (use simple in-memory queue initially, upgrade to Bull/BullMQ later)
- LinkedIn scraping (Puppeteer or API if available)
- Web scraping for company websites

### 6. IPO Filings Scanner Enhancement (Medium Priority)
**Status:** Ideas phase

**Current State:** Basic IPO filing scanner exists (see git history: "enhance IPO filings scanner")

**Improvements Needed:**
- More detailed IPO prospectus parsing
- Extract key metrics: valuation, revenue, profit margins
- Identify underwriters (potential cross-sell opportunities)
- Track IPO timeline (filing → pricing → listing)
- Alert on lock-up expiration dates (wealth event)

### 7. Multi-User Support (Medium Priority)
**Status:** Planning

**Changes:**
- Add authentication (currently no auth)
- User-specific saved leads, settings, alerts
- Team workspaces (multiple users sharing leads)
- Role-based access control

### 8. Lead Scoring Model Improvements (Low Priority)
**Status:** Research

**Ideas:**
- ML-based scoring instead of rule-based
- Historical conversion tracking (which leads converted to clients?)
- Learn from user behavior (which leads get saved/contacted most?)

### 9. Browser Extension (Low Priority)
**Status:** Ideas

**Goal:** Save leads from any website while browsing

**Features:**
- Chrome/Firefox extension
- Right-click any article → "Save to Lead Intel"
- Auto-extract company/founder names
- Send to backend for processing

---

## Completed Features

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

---

## Technical Debt & Maintenance

### Code Quality
- Add TypeScript strict mode to tsconfig
- Add unit tests for scanner logic
- Add integration tests for API endpoints
- Add E2E tests for critical user flows

### Performance
- Add database indexes on leads.publishedAt, leads.status
- Implement pagination for leads list
- Optimize duplicate detection algorithm

### Security
- Add rate limiting to API endpoints
- Add CSRF protection
- Sanitize user input in settings
- Audit environment variable usage

### DevOps
- Set up CI/CD pipeline
- Add database backup strategy
- Add monitoring and alerting (Sentry, DataDog, etc.)
- Add feature flags for gradual rollout

---

## Ideas Backlog (Unscheduled)

- WhatsApp notification integration
- Email digest with weekly summary
- Export leads to CRM (Salesforce, HubSpot)
- Calendar integration (schedule follow-ups)
- Mobile app (React Native)
- Voice assistant integration (Siri, Alexa)
- Competitor analysis dashboard
- Market trend analysis
- Network graph visualization (companies, founders, investors)
- Sentiment analysis on news articles
- Language support beyond English (Chinese, Malay, etc.)
