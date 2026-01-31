# Lead Enrichment Feature

## Overview
When you click "Save" on a lead in Telegram, the system automatically enriches it with:
- LinkedIn profiles for all founders (up to 3)
- Company investor information

## How It Works

### 1. LinkedIn Profile Finding
- Uses AI (GPT-4o-mini) to predict the most likely LinkedIn profile URLs
- Follows common LinkedIn URL patterns:
  - `john-doe` (first + last name)
  - `j-doe` (first initial + last name)
  - `john-m-doe` (full name with middle initial)
  - `john-doe-123` (name with numbers)

### 2. Investor Research
- Uses AI to research known investors and backers
- Searches based on:
  - Company name
  - Region
  - Company description (if available)
- Returns comma-separated list of investors
- Handles special cases:
  - Public companies: "Public company (listed on [exchange])"
  - Unknown investors: Returns empty array

### 3. Database Storage
The enriched data is stored in two new fields:
- `linkedinProfiles`: Array of LinkedIn profile URLs
- `investors`: Array of investor names

## Usage

### Via Telegram
1. Receive a lead alert in Telegram
2. Click the "💾 Save" button
3. System automatically:
   - Saves the lead
   - Researches LinkedIn profiles and investors
   - Sends enriched data back to you
   - Stores everything in the database

### Via CLI
View enriched leads:
```bash
npm run cli leads
```

The LinkedIn profiles and investors will be displayed for all saved leads.

## Testing

Run the enrichment test:
```bash
npx tsx scripts/test-enrichment.ts
```

This tests:
- LinkedIn profile finding
- Investor research
- Database storage and retrieval

## Cost Optimization

- LinkedIn finding: Uses GPT-4o-mini (~$0.0002 per founder)
- Investor research: Uses GPT-4o-mini with Claude Haiku fallback (~$0.0003 per lead)
- Total cost: ~$0.001 per lead enrichment (assuming 3 founders)

## Example Output

When you save a lead, you'll receive a Telegram message like:

```
✅ Lead Enriched!

🔗 LinkedIn Profiles:
• https://www.linkedin.com/in/sam-altman
• https://www.linkedin.com/in/greg-brockman

💰 Investors:
• Microsoft
• Reid Hoffman
• Khosla Ventures
• Y Combinator
• Founders Fund
```

## Files Modified

- `shared/schema.ts` - Added linkedinProfiles and investors fields
- `server/lead-enrichment.ts` (NEW) - Core enrichment logic
- `server/storage.ts` - Added enrichLead() method
- `server/telegram-handler.ts` - Integrated enrichment on Save action
- `scripts/test-enrichment.ts` (NEW) - Testing script
