/**
 * Reprocess all leads using Gemini Flash (free tier, 1000 req/day)
 */

const API_BASE = "http://localhost:5000";
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;

async function geminiCall(prompt: string): Promise<any> {
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 500,
      },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No response");
  return JSON.parse(text);
}

async function main() {
  const settingsRes = await fetch(`${API_BASE}/api/settings`);
  const settings = await settingsRes.json();
  
  const leadsRes = await fetch(`${API_BASE}/api/leads?limit=1000`);
  const leads = await leadsRes.json();
  
  const toProcess = leads.filter((l: any) => l.status !== "saved");
  
  console.log(`\n📊 Processing ${toProcess.length} leads (skipping ${leads.length - toProcess.length} saved)\n`);

  let kept = 0, removed = 0, errors = 0;
  const regionsStr = settings.regions.join(", ");

  for (let i = 0; i < toProcess.length; i++) {
    const lead = toProcess[i];
    const shortHeadline = lead.headline.slice(0, 60);
    process.stdout.write(`[${i + 1}/${toProcess.length}] ${shortHeadline}... `);

    const prompt = `${settings.interestFilterPrompt}

ALSO score priority for a UHNW private banker:
- 80-100 (HIGH): Clear liquidity event with named founder(s). IPO filing, acquisition with disclosed price, Series D+ raise >$100M, confirmed exit.
- 50-79 (MEDIUM): Likely liquidity event but details missing. IPO rumors, M&A talks, Series C raise, unicorn milestone.
- 20-49 (LOW): Tangential. No imminent event. Ignore Series A/B.
- 1-19 (REJECT): No liquidity event. General news, commentary, ops news.

Article: ${lead.headline}
Source: ${lead.sourceName}
Summary: ${(lead.aiSummary || "").slice(0, 300)}
Companies: ${(lead.companyNames || []).join(", ") || "None"}
Founders: ${(lead.founderNames || []).join(", ") || "None"}

Return JSON: {"relevant":true/false,"reason":"brief","confidenceScore":0-100,"priorityScore":1-100,"priorityLevel":"high/medium/low","wealthAngle":"WHO gets wealthy or No identifiable individual"}`;

    try {
      const result = await geminiCall(prompt);
      const passes = result.relevant === true && (result.confidenceScore ?? 0) > 60;
      const score = result.priorityScore ?? 10;
      const level = result.priorityLevel || "low";
      
      const patch: any = {
        priorityScore: score,
        priorityLevel: level,
        wealthAngle: result.wealthAngle || null,
      };
      
      if (!passes) {
        patch.status = "dismissed";
        console.log(`❌ ${score} - ${(result.reason || "").slice(0, 50)}`);
        removed++;
      } else {
        console.log(`✅ ${score} ${level} - ${(result.wealthAngle || "").slice(0, 50)}`);
        kept++;
      }

      await fetch(`${API_BASE}/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch (e: any) {
      console.log(`⚠️ Error: ${e.message.slice(0, 50)}`);
      errors++;
    }

    // Rate limit: 1 req/sec for free tier
    await new Promise(r => setTimeout(r, 1100));
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`📊 DONE: ✅ Kept ${kept} | ❌ Dismissed ${removed} | ⚠️ Errors ${errors}`);
  console.log(`${"=".repeat(60)}\n`);
}

main().catch(console.error);
