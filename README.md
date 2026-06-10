# News-Sensei

Private-banker lead-intelligence tool. Scans Southeast Asian news and luxury/society
sources for wealth events (IPOs, M&A, funding rounds, exits, UHNW profiles), uses LLMs
to extract company/founder/investor data, scores priority, applies a strict SEA-geography
filter, and sends alerts via Telegram.

> For deep architecture/behaviour notes see **CLAUDE.md**. For the data-model migration
> status see **ROADMAP.md**. This README is the fast onboarding path.

## Stack

- **Frontend:** React 18 + TypeScript + Vite + shadcn/ui (Tailwind)
- **Backend:** Express + TypeScript (ESM dev via `tsx`, prod bundle via esbuild → CJS)
- **DB:** PostgreSQL + Drizzle ORM (push-based schema)
- **LLMs (via an OpenRouter-style gateway, using the OpenAI SDK):**
  - `google/gemini-2.5-flash-lite` — scanning / extraction / lifestyle filtering
  - `anthropic/claude-sonnet-4` — founder enrichment, research, IPO analysis
  - A local Ollama `gemma` path exists for one experimental stage
  - **There is no GPT-4o usage** despite older doc references.

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values below
npm run db:push        # apply schema to PostgreSQL
npm run dev            # client + server on PORT (default 5000)
```

## Environment variables

Required:

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | API key for the LLM gateway |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | **Gateway base URL** (OpenRouter-style). All LLM calls route through this — without it the OpenAI SDK hits api.openai.com and the configured models won't resolve. |

Optional:

| Var | Purpose |
|-----|---------|
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | Claude fallback in tier-1 filtering |
| `TELEGRAM_BOT_TOKEN` | Telegram alerts (preferred over email). **Keep in .env / secrets, never commit.** |
| `TELEGRAM_WEBHOOK_SECRET` | If set, the Telegram webhook is registered with and verifies this secret token |
| `BROWSER_INGEST_SECRET` | If set, `POST /api/browser-ingest` requires header `x-ingest-secret` |
| `SCRAPINGBEE_API_KEY` | Scraping fallback |
| `TAVILY_API_KEY` | Full-text extraction fallback |
| `BRAVE_API_KEY` | Web search for enrichment |
| `SENDGRID_API_KEY` | Email notifications (legacy/deprecated — use Telegram) |
| `PORT` | Server port (default 5000) |

## Commands

```bash
npm run dev     # dev server (frontend + backend)
npm run check   # TypeScript type check (must be green)
npm test        # SEA-geography guard regression test
npm run build   # production build (client → dist/public, server → dist/index.cjs)
npm start       # run the production build
npm run db:push # apply shared/schema.ts to the database
```

## Data model note (v2 cutover)

The live schema is **`shared/schema.ts`**. Its Drizzle objects map to the unified
`*_v2` physical tables — e.g. the `leads` object is `pgTable("leads_v2", ...)` and
`savedLeads` is `saved_leads_v2`. `shared/schema-v2.ts` is a **parked design draft**
that is imported by nothing; do not run `db:push` against it. See ROADMAP.md.
