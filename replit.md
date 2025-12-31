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
│   │   ├── settings.tsx    # Configuration page with log retention
│   │   └── logs.tsx        # Scan history with expandable details
│   └── App.tsx         # Root component with routing
server/
├── routes.ts           # API endpoints
├── storage.ts          # PostgreSQL database storage
├── scanner.ts          # News scanning & AI extraction with progress tracking
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
5. **Settings** - Configure keywords, regions, email alerts, summary length, log retention period
6. **Scan Logs** - View history with expandable details (sources searched, articles processed, errors)
7. **Scan Progress** - Real-time tracking of scan status via polling

## API Endpoints
- `GET /api/leads` - Get all leads
- `GET /api/leads/:id` - Get a specific lead
- `GET /api/leads/stats` - Get lead statistics
- `PATCH /api/leads/:id` - Update lead status
- `GET /api/settings` - Get user settings
- `PUT /api/settings` - Update user settings (includes logRetentionDays)
- `GET /api/scan-logs` - Get scan history
- `GET /api/scan-logs/:id` - Get specific scan log details
- `POST /api/scan` - Trigger manual scan (returns scanId)
- `GET /api/scan-progress/:scanId` - Get real-time scan progress
- `POST /api/test-email` - Send test alert email

## Database Schema
- **leads** - News article matches with AI-extracted data
- **settings** - User preferences including logRetentionDays
- **sources** - Configured news sources
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

## Recent Changes
- Added collapsible dashboard insights panel consolidating stats, filters, and scan button
- Implemented colored action buttons (green Save, blue Contact, red Dismiss)
- Added Saved Leads sidebar section with count
- Extended scan logging with detailed tracking: sources searched, articles processed, duration, errors
- Added expandable log rows showing detailed scan information
- Implemented configurable log retention period (1-30 days) with automatic cleanup
- Added scan progress tracking with real-time status updates
- Database storage with PostgreSQL for data persistence across restarts
