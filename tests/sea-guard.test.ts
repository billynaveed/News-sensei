/**
 * Regression tests for the deterministic SEA-anchor guard.
 *
 * Run with:  npx tsx tests/sea-guard.test.ts
 *
 * These tests do NOT call any external API. They feed simulated Stage 6
 * structured outputs (the JSON returned by the deep-analysis LLM) into the
 * `validateSeaAnchor` guard and assert pass/reject with the right reasoning.
 *
 * Three negative cases come from real production false-positives that motivated
 * the guard:
 *   - Anthropic raise (US AI co, GIC backer, Tech in Asia source)
 *   - Hillhouse $8B fund close (Asia-focused PE, Business Times Singapore)
 *   - ByteDance valuation tops $600B (Beijing, mainland China)
 *
 * Two positive cases ensure the guard does not over-block valid SEA leads.
 */

import { validateSeaAnchor, type SeaAnchorInput } from "../server/sea-guard";
import { check } from "./harness";

interface Case {
  name: string;
  input: SeaAnchorInput;
  expectPass: boolean;
  expectReasonContains?: string;
}

const cases: Case[] = [
  // --- Negative regression: SEA investor only ----------------------------
  {
    name: "Anthropic nears $1T valuation — GIC backer, Tech in Asia source",
    expectPass: false,
    expectReasonContains: "sea_investor_only",
    input: {
      hqLocation: "San Francisco, USA",
      founderLocations: [
        { name: "Dario Amodei", location: "San Francisco, USA" },
        { name: "Daniela Amodei", location: "San Francisco, USA" },
      ],
      // The (correctly-prompted) LLM SHOULD set type=none and flag the
      // disqualifier. We test the strict path where the model still tried
      // to claim wealth_event but disqualifiers force a reject.
      seaEvidenceType: "wealth_event",
      seaEvidenceText: "GIC of Singapore is among the investors in the round",
      disqualifyingSignals: ["sea_investor_only"],
      llmRegionRelevance: true,
    },
  },
  {
    name: "Anthropic — model also (incorrectly) claims none, guard rejects on no evidence",
    expectPass: false,
    expectReasonContains: "No valid SEA evidence",
    input: {
      hqLocation: "San Francisco, USA",
      founderLocations: [{ name: "Dario Amodei", location: "San Francisco, USA" }],
      seaEvidenceType: "none",
      seaEvidenceText: "",
      disqualifyingSignals: [],
      llmRegionRelevance: false,
    },
  },

  // --- Negative regression: SEA publisher / Asia-focused fund ------------
  {
    name: "Hillhouse raises US$8B — Asia-focused fund, Business Times Singapore source",
    expectPass: false,
    expectReasonContains: "sea_publisher_only",
    input: {
      // Hillhouse HQ disputed; for the test we leave it ambiguous. The fund
      // close is not an individual liquidity event for a named founder, and
      // SEA relevance rests only on the publisher.
      hqLocation: "Hong Kong, Singapore",
      founderLocations: [{ name: "Lei Zhang", location: null }],
      seaEvidenceType: "company_hq",
      seaEvidenceText: "Hillhouse, the Asia-focused private equity firm",
      disqualifyingSignals: ["sea_publisher_only", "vague_apac_expansion"],
      llmRegionRelevance: true,
    },
  },

  // --- Negative regression: Mainland China company ----------------------
  {
    name: "ByteDance valuation tops $600B — Beijing-based, Tech in Asia source",
    expectPass: false,
    expectReasonContains: "company_hq",
    input: {
      hqLocation: "Beijing, China",
      founderLocations: [{ name: "Zhang Yiming", location: "Singapore" /* misleading */ }],
      // Even if the LLM (incorrectly) claims company_hq, the guard re-checks
      // the actual hqLocation string and finds no SEA term. Beijing/Shanghai/
      // Shenzhen are explicitly excluded.
      seaEvidenceType: "company_hq",
      seaEvidenceText: "ByteDance, headquartered in Beijing",
      disqualifyingSignals: [],
      llmRegionRelevance: true,
    },
  },
  {
    name: "ByteDance — but with founder_base claim using SEA-relocation rumour",
    // Singapore is in the Target Regions list, so if the model genuinely
    // identifies a founder as based in Singapore the guard should pass.
    // This is the intended behaviour: HQ-only failure does not block a
    // separate, real founder_base anchor.
    expectPass: true,
    expectReasonContains: "Singapore",
    input: {
      hqLocation: "Beijing, China",
      founderLocations: [{ name: "Zhang Yiming", location: "Singapore" }],
      seaEvidenceType: "founder_base",
      seaEvidenceText: "Zhang Yiming has relocated to Singapore",
      disqualifyingSignals: [],
      llmRegionRelevance: true,
    },
  },

  // --- Positive regression: legitimate SEA lead -------------------------
  {
    name: "Singapore fintech IPO — clear company_hq anchor",
    expectPass: true,
    expectReasonContains: "Singapore",
    input: {
      hqLocation: "Singapore",
      founderLocations: [{ name: "Jennifer Lim", location: "Singapore" }],
      seaEvidenceType: "company_hq",
      seaEvidenceText: "TechCorp Singapore announced its IPO on the SGX",
      disqualifyingSignals: [],
      llmRegionRelevance: true,
    },
  },
  {
    name: "Hong Kong M&A — founder based in HK",
    expectPass: true,
    expectReasonContains: "Hong Kong",
    input: {
      hqLocation: "Hong Kong",
      founderLocations: [{ name: "Michael Chen", location: "Hong Kong" }],
      seaEvidenceType: "company_hq",
      seaEvidenceText: "Hong Kong-based DataFlow HK was acquired",
      disqualifyingSignals: [],
      llmRegionRelevance: true,
    },
  },
  {
    name: "Taiwan founder roots — TSMC-spinoff named founder",
    expectPass: true,
    expectReasonContains: "Taipei",
    input: {
      hqLocation: "Cupertino, USA",
      founderLocations: [{ name: "Morris Liu", location: "Taipei, Taiwan" }],
      seaEvidenceType: "founder_roots",
      seaEvidenceText: "Liu was raised in Taipei, Taiwan and educated at NTU",
      disqualifyingSignals: [],
      llmRegionRelevance: true,
    },
  },

  // --- Edge: LLM lies about evidence type --------------------------------
  {
    name: "LLM claims founder_base but no SEA founder location given",
    expectPass: false,
    expectReasonContains: "founder_base",
    input: {
      hqLocation: "Berlin, Germany",
      founderLocations: [{ name: "Jane Doe", location: "Berlin, Germany" }],
      seaEvidenceType: "founder_base",
      seaEvidenceText: "Doe runs the Asia desk",
      disqualifyingSignals: [],
      llmRegionRelevance: true,
    },
  },
  {
    name: "LLM claims wealth_event but text is too short",
    expectPass: false,
    expectReasonContains: "supporting text",
    input: {
      hqLocation: null,
      founderLocations: [],
      seaEvidenceType: "wealth_event",
      seaEvidenceText: "yes",
      disqualifyingSignals: [],
      llmRegionRelevance: true,
    },
  },
  {
    name: "LLM claims operational_centre but text has no SEA term",
    expectPass: false,
    expectReasonContains: "no SEA",
    input: {
      hqLocation: null,
      founderLocations: [],
      seaEvidenceType: "operational_centre",
      seaEvidenceText: "Company runs an APAC sales hub somewhere in the region",
      disqualifyingSignals: [],
      llmRegionRelevance: true,
    },
  },
];

for (const c of cases) {
  const r = validateSeaAnchor(c.input);
  const passOk = r.passes === c.expectPass;
  const reasonOk = c.expectReasonContains
    ? r.reason.toLowerCase().includes(c.expectReasonContains.toLowerCase())
    : true;
  const verdict = r.passes ? "PASS" : "REJECT";
  check(
    `sea-guard: ${c.name}`,
    passOk && reasonOk,
    `expected ${c.expectPass ? "PASS" : "REJECT"} containing "${c.expectReasonContains ?? ""}", got ${verdict} — ${r.reason}`,
  );
}
