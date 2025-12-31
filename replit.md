# Private Banker Lead Intelligence Tool

## Overview
A web application that helps private bankers identify potential client acquisition opportunities by scanning news articles for wealth-related events in Southeast Asia. The app monitors news sources, extracts company/founder information using AI, deduplicates results, and sends email alerts.

## Tech Stack
- **Frontend:** React 18 + TypeScript + Tailwind CSS + shadcn/ui
- **Backend:** Express.js + TypeScript
- **Database:** PostgreSQL (via Drizzle ORM)
- **State Management:** TanStack Query (React Query)
- **Routing:** Wouter
- **AI:** OpenAI via Replit AI Integrations (gpt-4o for extraction)
- **Email:** SendGrid via Replit Connector

## Project Structure
```
client/
├── src/
│   ├── components/      # Reusable UI components
│   │   ├── ui/         # shadcn/ui components
│   │   ├── app-sidebar.tsx
│   │   └── theme-toggle.tsx
│   ├── hooks/          # Custom React hooks
│   ├── lib/            # Utility functions
│   ├── pages/          # Page components
│   │   ├── dashboard.tsx   # Main lead view with collapsible insights
│   │   ├── settings.tsx    # Configuration page with source/RSS management
│   │   └── logs.tsx        # Scan history with expandable details
│   └── App.tsx         # Root component with routing
server/
├── routes.ts           # API endpoints
├── storage.ts          # PostgreSQL database storage
├── scanner.ts          # News scanning & AI extraction with progress tracking
├── adapters.ts         # News fetching adapters (RSS, Google News, ScrapingBee)
├── sendgrid.ts         # Email alert integration
├── db.ts               # Database connection
└── index.ts            # Server entry point
shared/
└── schema.ts           # Drizzle ORM schemas and TypeScript types
```

## Key Features
1. **Dashboard** - Display article matches in cards sorted by priority score with collapsible insights panel
2. **Lead Cards** - Show headline, source, companies, founders, AI summary, keywords with colored action buttons
3. **Filters** - Filter by status, region, source tier, priority level
4. **Saved Leads** - Dedicated sidebar section showing saved lead count
5. **Settings** - Configure keywords, regions, email alerts, scanning methods, sources, and RSS feeds
6. **Scan Logs** - View history with expandable details (sources searched, articles processed, errors)
7. **Scan Progress** - Real-time tracking of scan status via polling

## API Endpoints
- `GET /api/leads` - Get all leads
- `GET /api/leads/:id` - Get a specific lead
- `GET /api/leads/stats` - Get lead statistics
- `PATCH /api/leads/:id` - Update lead status
- `GET /api/settings` - Get user settings
- `PUT /api/settings` - Update user settings (includes scanning method toggles)
- `GET /api/sources` - Get all sources
- `POST /api/sources` - Create a new source
- `PATCH /api/sources/:id` - Update a source
- `DELETE /api/sources/:id` - Delete a source
- `GET /api/sources/:sourceId/rss-feeds` - Get RSS feeds for a source
- `GET /api/rss-feeds` - Get all active RSS feeds with source metadata
- `POST /api/rss-feeds` - Create a new RSS feed
- `PATCH /api/rss-feeds/:id` - Update an RSS feed
- `DELETE /api/rss-feeds/:id` - Delete an RSS feed
- `GET /api/scan-logs` - Get scan history
- `GET /api/scan-logs/:id` - Get specific scan log details
- `POST /api/scan` - Trigger manual scan (returns scanId)
- `GET /api/scan-progress/:scanId` - Get real-time scan progress
- `POST /api/test-email` - Send test alert email

## Database Schema
- **leads** - News article matches with AI-extracted data
- **settings** - User preferences including:
  - Global scanning method toggles (googleNewsEnabled, rssEnabled, scrapingBeeEnabled)
  - Keywords, regions, email settings, summary length, log retention
- **sources** - News websites identified by unique domain:
  - name, domain (unique), tier (tier1/tier2/tier3), active
- **rss_feeds** - RSS feed subcategories per source:
  - sourceId (foreign key), name, url, active
- **scan_logs** - Detailed scan history with sourcesSearched, articlesProcessed, errors

## User Preferences
- Default alert email: billynaveed@gmail.com
- Default log retention: 2 days (configurable 1-30 days)
- Automatic cleanup of old scan logs on each scan completion

## Running the Application
```bash
npm run dev
```
Frontend runs on port 5000.

## News Source Architecture

### Domain-Based Source Model
Sources are identified by their unique domain (e.g., "straitstimes.com") rather than full URLs. This simplifies deduplication and allows multiple RSS feeds per source.

### Global Scanning Method Toggles
Three independent toggles that apply to ALL active sources:
1. **Google News** - Searches Google News RSS for articles from each source's domain
2. **RSS Feeds** - Fetches from all active RSS feeds in the rss_feeds table
3. **ScrapingBee** - Fallback web scraping when no articles found from other methods

### RSS Feeds Table
Each source can have multiple RSS feed subcategories (e.g., "Business", "Startups & Tech"). Users can add, enable/disable, or remove individual feeds.

### Fetch Strategy
1. If RSS enabled: Fetch from all active RSS feeds, filter by keywords
2. If Google News enabled: Search Google News for each source's domain
3. If ScrapingBee enabled: Only used as fallback when a source has zero articles from above methods
4. Deduplicate all results by normalized URL

### Adapters
- `fetchFromRssFeed()` - Parses RSS feeds, filters by keywords
- `fetchFromGoogleNews()` - Searches Google News RSS using site:domain
- `fetchFromScrapingBee()` - Web scraping with article extraction rules
- `fetchAllArticles()` - Orchestrates all methods based on global toggles

### Deduplication
URL normalization removes tracking params (utm_*, ref) and standardizes to HTTPS protocol.

## Recent Changes
- Refactored news source management to use domain-based identification
- Added global scanning method toggles (Google News, RSS, ScrapingBee) in settings
- Created separate rss_feeds table for per-source RSS feed subcategories
- Updated Settings UI with collapsible source cards showing RSS feeds
- Fixed circular dependency by making scanner pass data to adapters as parameters
- Maintained ScrapingBee as fallback-only method when other sources return no articles
