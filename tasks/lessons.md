# Lessons Learned

This file captures patterns, mistakes, and rules to prevent repeat errors. Update this after ANY user correction.

## Format
```
### [Date] - [Brief Title]
**Context:** What was the task/situation?
**Mistake:** What went wrong?
**Root Cause:** Why did it happen?
**Rule:** What rule prevents this in the future?
**Applied:** How to apply this lesson going forward?
```

---

## Active Lessons

### 2026-02-01 - Initial Setup
**Context:** Setting up workflow orchestration system
**Rule:** Always verify changes work before marking complete
**Applied:** Run dev server, test features, check logs after any code change

### 2026-02-01 - Self-Improvement Loop
**Context:** Establishing feedback mechanism
**Rule:** Update this file immediately after user corrections
**Applied:** User says "that's wrong" → fix issue → document pattern here

---

## Patterns to Watch For

- **Circular Dependencies:** Scanner passes settings/sources as parameters to adapters (don't import from scanner in adapters)
- **ScrapingBee Usage:** Only fallback when RSS/Google News return zero articles
- **Saved Leads:** Two-table system (saved_leads + leads status flag), not just status
- **URL Normalization:** Always normalize URLs before deduplication checks
- **Plan Mode:** Enter plan mode for 3+ step tasks or architectural decisions

---

## Categories

### Architecture Decisions
- **Test the pipeline with a live, known-good story before declaring it healthy.** "3 leads
  from 836 articles" looked like a quiet week; it was four stacked bugs. Billy's question
  about one specific deal (Circle × Tazapay) exposed all of them in an hour. Keep
  `POST /api/leads/ingest-url` as the regression probe.
- **Every stage that decides on geography or "who is the subject" must reason about the
  acquisition TARGET, not the acquirer.** Headlines lead with the buyer; the seller's
  founders are the lead.
- **Never let a paid API return null silently.** Tavily quota exhaustion and a dead
  ScrapingBee key both degraded the pipeline for weeks without a visible signal. Fallbacks
  (Brave, scrape.do) plus a status endpoint are the minimum; a Debug-page panel is next.

### Bug Fixes
- [Add lessons here as they emerge]

### API Design
- [Add lessons here as they emerge]

### Database Schema
- [Add lessons here as they emerge]

### UI/UX
- [Add lessons here as they emerge]
