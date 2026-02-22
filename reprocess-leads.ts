/**
 * Reprocess all leads through the updated filter and analysis prompts.
 * This re-evaluates each lead's interest filter result and priority score
 * using the new, stricter prompts.
 */
import OpenAI from "openai";

const openai = new OpenAI();
const API_BASE = "http://localhost:5000";

interface Lead {
  id: string;
  headline: string;
  sourceUrl: string;
  sourceName: string;
  aiSummary: string;
  priorityScore: number;
  priorityLevel: string;
  status: string;
  companyNames: string[];
  founderNames: string[];
}

async function getSettings() {
  const res = await fetch(`${API_BASE}/api/settings`);
  return res.json();
}

async function getAllLeads(): Promise<Lead[]> {
  const res = await fetch(`${API_BASE}/api/leads?limit=1000`);
  return res.json();
}

async function reprocessLead(lead: Lead, filterPrompt: string, regions: string[]): Promise<{
  passesFilter: boolean;
  filterReason: string;
  newPriorityScore: number;
  newPriorityLevel: string;
  wealthAngle: string;
}> {
  const regionsStr = regions.join(", ");
  
  // Combined filter + scoring in one call to save tokens
  const prompt = `${filterPrompt}

ALSO score this article's priority for a UHNW private banker:
- 80-100 (HIGH): Clear liquidity event with named founder(s). IPO filing, acquisition with disclosed price, Series D+ or large late-stage raise >$100M, confirmed exit.
- 50-79 (MEDIUM): Likely liquidity event but details missing. IPO rumors, M&A talks, Series C raise, unicorn milestone with named founders.
- 20-49 (LOW): Tangential. Series C without details, strategic investment, no imminent event. Ignore Series A/B entirely.
- 1-19 (REJECT): No liquidity event. General market news, industry commentary, opinion, company operations, policy analysis.

CRITICAL: If the article is general commentary, investment advice, or opinion without a SPECIFIC company undergoing a SPECIFIC liquidity event — score it 1-19.

Article headline: ${lead.headline}
Source: ${lead.sourceName}
Summary: ${lead.aiSummary}
Companies: ${(lead.companyNames || []).join(", ") || "None mentioned"}
Founders: ${(lead.founderNames || []).join(", ") || "None mentioned"}

Target Regions: ${regionsStr}

Return JSON:
{
  "relevant": true/false,
  "reason": "brief explanation",
  "confidenceScore": 0-100,
  "priorityScore": 1-100,
  "priorityLevel": "high/medium/low",
  "wealthAngle": "WHO is getting wealthy and HOW, or 'No identifiable individual'"
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 500,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("No response");
    
    const result = JSON.parse(content);
    return {
      passesFilter: result.relevant === true && (result.confidenceScore ?? 0) > 60,
      filterReason: result.reason || "",
      newPriorityScore: result.priorityScore ?? 10,
      newPriorityLevel: result.priorityLevel || "low",
      wealthAngle: result.wealthAngle || "No identifiable individual",
    };
  } catch (e: any) {
    console.error(`  Error: ${e.message}`);
    return {
      passesFilter: false,
      filterReason: `Error: ${e.message}`,
      newPriorityScore: 0,
      newPriorityLevel: "low",
      wealthAngle: "Error",
    };
  }
}

async function updateLead(id: string, patch: any) {
  await fetch(`${API_BASE}/api/leads/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

async function main() {
  const settings = await getSettings();
  const leads = await getAllLeads();
  
  // Only reprocess non-saved, non-dismissed leads (status = "new")
  // But also include dismissed since those might have been wrongly scored
  const toProcess = leads.filter(l => l.status !== "saved"); // keep saved ones as-is
  
  console.log(`\n📊 Current state: ${leads.length} total leads`);
  console.log(`   Processing ${toProcess.length} leads (skipping ${leads.length - toProcess.length} saved)\n`);

  let kept = 0, removed = 0, errors = 0;
  const results: { headline: string; oldScore: number; newScore: number; passes: boolean; reason: string }[] = [];

  for (let i = 0; i < toProcess.length; i++) {
    const lead = toProcess[i];
    process.stdout.write(`[${i + 1}/${toProcess.length}] ${lead.headline.slice(0, 60)}... `);
    
    const result = await reprocessLead(lead, settings.interestFilterPrompt, settings.regions);
    
    results.push({
      headline: lead.headline,
      oldScore: lead.priorityScore,
      newScore: result.newPriorityScore,
      passes: result.passesFilter,
      reason: result.filterReason,
    });

    if (result.passesFilter) {
      // Update with new scores
      await updateLead(lead.id, {
        priorityScore: result.newPriorityScore,
        priorityLevel: result.newPriorityLevel,
        wealthAngle: result.wealthAngle,
      });
      console.log(`✅ KEEP (${result.newPriorityScore} ${result.newPriorityLevel})`);
      kept++;
    } else {
      // Mark as dismissed
      await updateLead(lead.id, {
        priorityScore: result.newPriorityScore,
        priorityLevel: result.newPriorityLevel,
        status: "dismissed",
        wealthAngle: result.wealthAngle,
      });
      console.log(`❌ DISMISS (${result.filterReason.slice(0, 50)})`);
      removed++;
    }

    // Rate limit: small delay between calls
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`📊 REPROCESSING COMPLETE`);
  console.log(`   ✅ Kept: ${kept}`);
  console.log(`   ❌ Dismissed: ${removed}`);
  console.log(`   ⚠️  Errors: ${errors}`);
  console.log(`   📌 Saved (untouched): ${leads.length - toProcess.length}`);
  console.log(`${"=".repeat(60)}\n`);
}

main().catch(console.error);
