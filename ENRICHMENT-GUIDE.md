# Founder & Company Enrichment Guide

## Overview

The enrichment system automatically populates saved leads with detailed research about founders and companies using AI-powered analysis. This is the foundation for the automatic research features outlined in the roadmap.

## How It Works

### Architecture

```
Saved Lead → Enrichment API → GPT-4o Analysis → Structured Data → Database
```

1. **Input**: Company names, founder names, region from the lead
2. **Processing**: GPT-4o analyzes available information
3. **Output**: Structured data with confidence scores
4. **Storage**: Saved to `saved_leads` table in `researchData` field

### What Gets Enriched

**Founder Information:**
- LinkedIn profile URL
- Comprehensive biography (2-3 paragraphs)
- Professional background and career history
- Education
- Notable achievements and awards

**Company Information:**
- Business description
- Industry/sector
- Founding year
- Headquarters location
- Business model explanation

### Confidence Scoring

Each enrichment includes a confidence level:
- **High**: Well-documented public figures/companies with verified sources
- **Medium**: Some information available but incomplete or from limited sources
- **Low**: Sparse information or uncertain matches

## Usage

### API Endpoint

```bash
# Enrich a saved lead
POST /api/saved-leads/:id/enrich

# Response
{
  "success": true,
  "savedLead": { /* updated saved lead with enrichment */ },
  "enrichment": {
    "founderConfidence": "high",
    "companyConfidence": "medium"
  }
}
```

### Manual Enrichment (via curl)

```bash
# Get saved lead IDs
curl http://localhost:5000/api/saved-leads | jq '.[].id'

# Enrich a specific lead
curl -X POST http://localhost:5000/api/saved-leads/LEAD_ID/enrich

# View enriched data
curl http://localhost:5000/api/saved-leads/LEAD_ID | jq '.companyDescription, .founderBio, .researchData'
```

### Frontend Integration

The enrichment can be triggered from the saved leads page. Add an "Enrich" button:

```typescript
const enrichMutation = useMutation({
  mutationFn: async (id: string) => {
    await apiRequest("POST", `/api/saved-leads/${id}/enrich`);
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ["/api/saved-leads"] });
  },
});

// In your component:
<Button onClick={() => enrichMutation.mutate(savedLead.id)}>
  {enrichMutation.isPending ? "Enriching..." : "Auto-Research"}
</Button>
```

## Data Structure

### Enrichment Response

```typescript
{
  founderLinkedInUrl: string | null,
  founderBio: string | null,
  companyDescription: string | null,
  researchData: {
    founderProfessionalBackground: string | null,
    founderEducation: string | null,
    founderAchievements: string | null,
    companyIndustry: string | null,
    companyFounded: string | null,
    companyHeadquarters: string | null,
    companyBusinessModel: string | null,
    enrichmentConfidence: {
      founder: "high" | "medium" | "low" | null,
      company: "high" | "medium" | "low" | null
    },
    sources: string[],
    enrichedAt: string  // ISO timestamp
  }
}
```

## Current Limitations & Future Enhancements

### Current Implementation

✅ Uses GPT-4o's knowledge base for research
✅ Works for well-known companies and public figures
✅ Gracefully handles missing information
✅ Honest confidence scoring

### Planned Enhancements

🔄 **Google Search API Integration**
- Real-time web searches for recent information
- Access to latest news and updates
- Better coverage of emerging companies

🔄 **LinkedIn API Integration**
- Verified profile data
- Accurate career history
- Real-time updates

🔄 **Automatic Enrichment on Save**
- Background job queue
- Enrich leads automatically when saved
- Show loading state in UI

🔄 **Web Scraping Fallback**
- Company websites for official information
- News articles for recent updates
- CrunchBase for startup data

### Known Issues

⚠️ **Empty Founder Names**: When leads have no founder names extracted, only company enrichment runs. This is expected behavior.

⚠️ **AI Hallucination Risk**: Always review confidence scores. Low confidence data should be manually verified.

⚠️ **Rate Limits**: OpenAI API has rate limits. Consider implementing:
- Request queuing for bulk enrichments
- Caching of enrichment results
- Progressive enrichment (enrich on-demand vs. automatic)

## Examples

### Example 1: Successful Enrichment

**Lead**: Eastroc Beverage (Temasek-backed IPO)

**Input:**
```json
{
  "companyNames": ["Eastroc Beverage"],
  "founderNames": [],
  "region": "Singapore"
}
```

**Output:**
```json
{
  "companyDescription": "Eastroc Beverage is a leading Chinese energy drink manufacturer known for its Oriental Leaves tea beverages and Eastroc energy drinks. The company has experienced rapid growth in China's beverage market and is backed by Temasek Holdings.",
  "researchData": {
    "companyIndustry": "Beverages / Consumer Goods",
    "companyFounded": "2015",
    "companyHeadquarters": "Shenzhen, China",
    "companyBusinessModel": "Manufacturing and distribution of energy drinks and tea-based beverages primarily in the Chinese market, with expansion plans across Asia",
    "enrichmentConfidence": {
      "company": "high"
    }
  }
}
```

### Example 2: Founder Enrichment

**Lead**: With founder name "Jensen Huang" and company "NVIDIA"

**Output:**
```json
{
  "founderLinkedInUrl": "https://linkedin.com/in/jen-hsun-huang",
  "founderBio": "Jensen Huang is the co-founder, President, and CEO of NVIDIA Corporation. He founded NVIDIA in 1993 and has led the company to become a leader in GPU technology, AI computing, and data center solutions. Under his leadership, NVIDIA's market cap has grown to over $1 trillion.",
  "researchData": {
    "founderProfessionalBackground": "Founded NVIDIA in 1993 after roles at LSI Logic and AMD. Has been CEO since inception, steering the company through multiple technology transitions.",
    "founderEducation": "BSEE from Oregon State University, MSEE from Stanford University",
    "founderAchievements": "Time Magazine's 100 Most Influential People, Fortune Businessperson of the Year",
    "enrichmentConfidence": {
      "founder": "high"
    }
  }
}
```

## Best Practices

1. **Review Before Sharing**: Always review AI-generated content before sharing with clients

2. **Update Regularly**: Re-run enrichment for important leads to get latest information

3. **Manual Augmentation**: Use enrichment as a starting point, add your own research and notes

4. **Confidence Levels**: Pay attention to confidence scores - verify low-confidence data

5. **Privacy**: Don't store sensitive personal information that wasn't publicly available

## Troubleshooting

### Enrichment Returns Null Values

**Cause**: Lead has no founder names, or person/company is not well-known

**Solution**:
- Manually research and fill in the details
- For emerging companies, check their website and press releases

### Low Confidence Scores

**Cause**: Limited public information available

**Solution**:
- Search LinkedIn manually
- Check company website and press releases
- Use industry databases (Crunchbase, PitchBook)

### API Timeout

**Cause**: OpenAI API rate limits or slow response

**Solution**:
- Retry after a few seconds
- Implement exponential backoff
- Consider background job queue for bulk operations

## Integration with Telegram Research

This enrichment system is the foundation for the Telegram research feature (see ROADMAP.md):

```
User: /research John Tan
Bot: → Uses enrichment algorithm
     → Returns structured biography
     → Stores in research cache
```

The same enrichment functions can be reused for interactive research queries.
