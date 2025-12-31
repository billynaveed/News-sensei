# Private Banker Lead Intelligence Tool

## Overview
A web application that helps private bankers identify potential client acquisition opportunities by scanning news articles for wealth-related events in Southeast Asia. The app monitors news sources, extracts company/founder information using AI, deduplicates results, and sends email alerts.

## Tech Stack
- **Frontend:** React 18 + TypeScript + Tailwind CSS + shadcn/ui
- **Backend:** Express.js + TypeScript
- **State Management:** TanStack Query (React Query)
- **Routing:** Wouter
- **AI:** OpenAI via Replit AI Integrations (gpt-4o for extraction)
- **Email:** SendGrid via Replit Connector
- **Storage:** In-memory storage (MemStorage)

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
│   │   ├── dashboard.tsx   # Main lead view
│   │   ├── settings.tsx    # Configuration page
│   │   └── logs.tsx        # Scan history
│   └── App.tsx         # Root component with routing
server/
├── routes.ts           # API endpoints
├── storage.ts          # In-memory data storage
├── scanner.ts          # News scanning & AI extraction
├── sendgrid.ts         # Email alert integration
└── index.ts            # Server entry point
shared/
└── schema.ts           # TypeScript types & Zod schemas
```

## Key Features
1. **Dashboard** - Display article matches in cards sorted by priority score
2. **Lead Cards** - Show headline, source, companies, founders, AI summary, keywords
3. **Filters** - Filter by status, region, source tier, priority level
4. **Settings** - Configure keywords, regions, email alerts, summary length
5. **Scan Logs** - View history of scanning activity

## API Endpoints
- `GET /api/leads` - Get all leads
- `GET /api/leads/stats` - Get lead statistics
- `PATCH /api/leads/:id` - Update lead status
- `GET /api/settings` - Get user settings
- `PUT /api/settings` - Update user settings
- `GET /api/scan-logs` - Get scan history
- `POST /api/scan` - Trigger manual scan
- `POST /api/test-email` - Send test alert email

## Running the Application
```bash
npm run dev
```
Frontend runs on port 5000.

## Recent Changes
- Initial MVP implementation with dashboard, settings, and logs pages
- Integrated OpenAI for AI-powered lead extraction
- Integrated SendGrid for email alerts
- Added dark mode support with theme toggle
