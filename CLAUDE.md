# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

News-sensei is a private banker lead intelligence tool that scans Southeast Asian news sources for wealth-related events (IPOs, M&A, funding rounds, exits) to identify potential client acquisition opportunities. The system uses AI to extract company/founder information, assigns priority scores, and sends alerts via email or Telegram.

**Tech Stack:** React 18 + TypeScript + Express + PostgreSQL + Drizzle ORM + OpenAI GPT-4o + shadcn/ui

## Development Commands

```bash
# Start development server (frontend + backend on port 5000)
npm run dev

# Type checking
npm run check

# Build for production (compiles client with Vite, server with esbuild)
npm run build

# Start production server
npm start

# Database schema push (applies schema changes to PostgreSQL)
npm run db:push
```

## Environment Setup

Required environment variables (see `.env.example`):
- `DATABASE_URL` - PostgreSQL connection string
- `AI_INTEGRATIONS_OPENAI_API_KEY` - OpenAI API key for lead extraction (gpt-4o model)
- `PORT` - Server port (defaults to 5000)

Optional:
- `SCRAPINGBEE_API_KEY` - For web scraping fallback
- `TELEGRAM_BOT_TOKEN` - For Telegram notifications (preferred over SendGrid)
- `SENDGRID_API_KEY` - For email notifications (deprecated, use Telegram)

## Architecture

### Monorepo Structure

```
client/          React frontend (Vite build)
  src/
    pages/       Page components (dashboard, settings, logs)
    components/  Reusable UI components + shadcn/ui library
    hooks/       Custom React hooks
    lib/         Utility functions

server/          Express backend (esbuild production build)
  routes.ts      API endpoint definitions
  scanner.ts     Core scanning logic + AI extraction
  adapters.ts    News fetching (RSS, Google News, ScrapingBee)
  storage.ts     Database access layer (Drizzle ORM)
  telegram.ts    Telegram notification integration
  sendgrid.ts    Email notification integration (legacy)

shared/          Shared types + database schema
  schema.ts      Drizzle schema definitions + TypeScript types
```

### Key Architectural Patterns

**1. News Source Architecture (Domain-Based Model)**
- Sources identified by unique domain (e.g., "straitstimes.com"), not full URLs
- Each source has tier (tier1/tier2/tier3), name, and active status
- Multiple RSS feed subcategories per source (stored in `rss_feeds` table)
- Three independent global scanning method toggles in settings:
  - `rssEnabled` - Fetch from all active RSS feeds
  - `googleNewsEnabled` - Search Google News for each source domain
  - `scrapingBeeEnabled` - Web scraping fallback (only used when zero articles from other methods)

**2. Scan Flow**
1. Scanner (`scanner.ts`) orchestrates the scan
2. Adapters (`adapters.ts`) fetch articles via RSS/Google News/ScrapingBee
3. Deduplication by normalized URL (removes utm_*, ref params, standardizes to HTTPS)
4. AI extraction (`extractLeadInfo`) uses GPT-4o to analyze each article
5. Results stored in `leads` table with priority scoring
6. Notifications sent via Telegram/email to configured recipients

**3. Database Schema Key Tables**
- `leads` - Main data model: articles with AI-extracted companies, founders, investors, priority scores
- `settings` - User preferences: keywords, regions, email/Telegram config, global scanning toggles
- `sources` - News sources with domain, tier, active status
- `rss_feeds` - RSS feed subcategories linked to sources (foreign key: sourceId)
- `scan_logs` - Detailed scan history with sources searched, articles processed, errors

**4. State Management**
- TanStack Query (React Query) for server state
- Real-time scan progress via polling endpoint (`GET /api/scan-progress/:scanId`)
- Optimistic updates for status changes (lead review/save/dismiss)

**5. Path Aliases**
- `@/` → `client/src/`
- `@shared/` → `shared/`
- `@assets/` → `attached_assets/`

## Important Implementation Details

### Saved Leads System
- **Separate Table Architecture:** Saved leads are stored in a dedicated `saved_leads` table (not just a status flag)
- **Enhanced Metadata:** Each saved lead can have:
  - Founder LinkedIn URL and biography
  - Company description
  - Private user notes
  - Research data (JSON field for future expansion)
- **Backward Compatibility:** Setting a lead to "saved" status:
  1. Creates entry in `saved_leads` table
  2. Sets `status: "saved"` in `leads` table
- **Removal Logic:** Deleting from saved leads:
  1. Removes from `saved_leads` table
  2. Sets `status: "reviewed"` in `leads` table
- **UI Location:** Dedicated `/saved-leads` page with expandable collapsible sections for founder/company details and notes

### Scanner Behavior
- Circular dependency avoided: scanner passes settings/sources data as parameters to adapters
- ScrapingBee is fallback-only (used only when source returns zero articles from RSS/Google News)
- Progress tracking stores per-scan state in memory (not persisted to DB)
- Automatic cleanup of old scan logs based on `logRetentionDays` setting (defaults to 2 days)

### AI Extraction
- Model: gpt-4o via OpenAI API
- Extracts: company names, founder names, investors, keywords, priority score (1-100)
- Priority levels: high (70+), medium (40-69), low (<40)
- Summary length configurable: brief (1-2 sentences), detailed (paragraph), actionable (with recommendations)

### URL Normalization for Deduplication
```typescript
// Removes utm_*, ref tracking params + standardizes protocol
function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = 'https:';
  // Remove tracking params
  ['utm_source', 'utm_medium', 'ref'].forEach(p => parsed.searchParams.delete(p));
  return parsed.toString();
}
```

### Telegram Integration
- Preferred notification method over SendGrid
- HTML formatting with priority icons (🔴 high, 🟡 medium, 🟢 low)
- Handles 4096 character limit by splitting messages
- Bot token configured via `TELEGRAM_BOT_TOKEN` env var

## Design System

Based on Material Design 3 with financial services adaptation (see `design_guidelines.md`):
- Typography: Inter font family, tabular-nums for metrics
- Color: Status-specific badges, minimal use of color for emphasis
- Layout: Sidebar navigation (w-64), responsive with mobile collapse
- Components: shadcn/ui library (Radix UI primitives + Tailwind)
- Icons: Lucide React

Key UI patterns:
- Lead cards with collapsible insights panels
- Real-time scan progress with polling
- Filter bar with multi-select dropdowns
- Expandable scan log details
- Source management with nested RSS feed configuration

## API Patterns

All endpoints return JSON. Common patterns:
- `GET /api/leads?status=new&region=Singapore` - Query params for filtering
- `PATCH /api/leads/:id` - Partial updates (status changes)
- `POST /api/scan` - Returns `{ scanId }` for progress tracking
- `GET /api/scan-progress/:scanId` - Real-time progress polling
- Error responses: `{ message: string }`

**Saved Leads Endpoints:**
- `POST /api/saved-leads` - Body: `{ leadId, founderLinkedInUrl?, founderBio?, companyDescription?, notes?, researchData? }`
- `GET /api/saved-leads` - Returns array of saved leads with full lead data joined
- `PATCH /api/saved-leads/:id` - Update metadata (notes, LinkedIn, bio, description)
- `DELETE /api/saved-leads/:id` - Remove from saved collection

## Database Migrations

This project uses Drizzle ORM with push-based schema updates (no migration files):
1. Edit `shared/schema.ts`
2. Run `npm run db:push` to apply changes
3. Drizzle compares schema to database and generates SQL

## Build System

**Development:** tsx for server, Vite dev server for client
**Production:**
- Client: Vite builds to `dist/public/`
- Server: esbuild bundles to `dist/index.cjs` (CJS format for Node)
- Allowlist of dependencies bundled into server (see `script/build.ts`)
- Most deps externalized to reduce bundle size

## User Preferences

Default alert email: billynaveed@gmail.com
Default log retention: 2 days (configurable 1-30 days)
Automatic cleanup of old scan logs on scan completion
