/**
 * Proves that moving the pipeline's prompts into `DEFAULT_PROMPTS` changed no
 * bytes.
 *
 * Rather than re-typing the old literals (and risking a transcription error
 * that this script would then happily bless), it pulls the *original* template
 * literals straight out of the pre-change source — `git show <baseline>:<file>` for
 * files this workstream edits, the working tree for files it does not — and
 * evaluates them with the same sample variables that are fed to `render()`.
 *
 * Run:  npx tsx scripts/verify-prompt-defaults.ts
 * Exits non-zero on any difference.
 */

import { execFileSync } from "node:child_process";
import { DEFAULT_PROMPTS, render, type PromptKey } from "../server/prompts";

// ============================================================================
// Extracting the original literals
// ============================================================================

/**
 * The last commit before prompts became editable. Pinned rather than "HEAD" so
 * this stays a check against the *original* literals once the change lands.
 */
const BASELINE_COMMIT = "9ad029870e82dacebc2d16187402b8fc6d5fad38";

/** Reads a file as it was before this workstream's edits. */
function atHead(path: string): string {
  return execFileSync("git", ["show", `${BASELINE_COMMIT}:${path}`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

/** Every baseline now comes from BASELINE_COMMIT — all eight prompts have since moved to prompts.ts. */

/**
 * Pulls out the `occurrence`-th ``const prompt = `...` ``  template literal,
 * backticks included, so it can be evaluated verbatim.
 */
function extractPromptLiteral(source: string, occurrence: number): string {
  const lines = source.split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*const prompt = `/.test(lines[i])) continue;
    seen++;
    if (seen !== occurrence) continue;

    const first = lines[i].replace(/^\s*const prompt = /, "");
    if (/`;\s*$/.test(first)) return first.replace(/;\s*$/, "");

    const body = [first];
    for (let j = i + 1; j < lines.length; j++) {
      body.push(lines[j]);
      if (/`;\s*$/.test(lines[j])) return body.join("\n").replace(/;\s*$/, "");
    }
    throw new Error(`Unterminated template literal at line ${i + 1}`);
  }
  throw new Error(`Could not find occurrence ${occurrence} of "const prompt = \`"`);
}

/** Evaluates an extracted literal with the named locals in scope. */
function evaluateLiteral(literal: string, scope: Record<string, unknown>): string {
  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const build = new Function(...names, `return ${literal};`) as (...args: unknown[]) => string;
  return build(...names.map((n) => scope[n]));
}

// ============================================================================
// Sample variables
// ============================================================================
// Deliberately awkward: `$&`, `$1` and a backslash would corrupt the output if
// `render()` used a plain string replacement pattern instead of a callback.

const HEADLINE = 'Circle agrees to buy Tazapay for $400M — "a $& deal", says $1 fund';
const SNIPPET = "Tazapay, the Singapore-based payments firm, agreed to a deal.\\n Backslash \\ and ${braces} included.";
const FULL_CONTENT = `${SNIPPET} `.repeat(40);
const SOURCE = "Tech in Asia";
const REGIONS = ["Singapore", "Hong Kong", "Taiwan"];
const REGIONS_STR = REGIONS.join(", ");

const article = {
  headline: HEADLINE,
  source: SOURCE,
  content: SNIPPET,
};

const FILTER_PROMPT = "SAMPLE STAGE 1 CRITERIA BLOCK\nwith two lines.";
const EXISTING_SUMMARY = "Tazapay raised $16.9M in Series A led by Sequoia.";
const COMPANY_NAME = "Tazapay";

// ============================================================================
// Cases: (old string built the old way) vs (new string built via render())
// ============================================================================

interface Case {
  key: PromptKey;
  old: () => string;
  fresh: () => string;
}

const pipelineStagesHead = atHead("server/pipeline-stages.ts");
const scannerHead = atHead("server/scanner.ts");
const familyResearchNow = atHead("server/family-research.ts");
const founderDiscoveryNow = atHead("server/founder-discovery.ts");

// --- family_research locals, computed exactly as the original does ---
const family = { name: "Wee family", country: "Singapore", primaryCompanies: ["UOB", "UOL Group"] };
const anchor = "Wee Cho Yaw";
const existingMembers = ["Wee Ee Cheong", "Wee Ee Lim"];
const familyContext = "[1] Wee family profile\nURL: https://example.com/wee\nThe Wee family controls UOB.";

// --- founder_discovery locals ---
const founderName = "Tazapay";
const founderHint = "Singapore payments";
const founderSearch = { answer: "Tazapay was founded in 2020 in Singapore." };
const founderContext = "[1] Tazapay founders\nhttps://example.com/tazapay\nRahul Shinghal co-founded Tazapay.";

const cases: Case[] = [
  {
    key: "stage1_interest",
    // Identity by construction: DEFAULT_PROMPTS.stage1_interest *is* the shared
    // constant the settings column defaults to. Assert the reference holds.
    old: () => atHeadExport("shared/schema.ts", "DEFAULT_INTEREST_FILTER_PROMPT"),
    fresh: () => DEFAULT_PROMPTS.stage1_interest,
  },
  {
    key: "stage1_regional_rules",
    old: () =>
      evaluateLiteral(extractPromptLiteral(pipelineStagesHead, 1), {
        filterPrompt: FILTER_PROMPT,
        regionsStr: REGIONS_STR,
        article,
      }),
    fresh: () =>
      `${FILTER_PROMPT}\n\n` +
      render(DEFAULT_PROMPTS.stage1_regional_rules, {
        regions: REGIONS_STR,
        headline: article.headline,
        snippet: article.content.slice(0, 500),
        source: article.source,
      }),
  },
  {
    key: "stage2_company",
    old: () => evaluateLiteral(extractPromptLiteral(pipelineStagesHead, 2), { article }),
    fresh: () =>
      render(DEFAULT_PROMPTS.stage2_company, {
        headline: article.headline,
        content: article.content.slice(0, 500),
      }),
  },
  {
    key: "stage3_public",
    old: () =>
      evaluateLiteral(extractPromptLiteral(pipelineStagesHead, 3), {
        companyName: COMPANY_NAME,
        articleHeadline: HEADLINE,
      }),
    fresh: () =>
      render(DEFAULT_PROMPTS.stage3_public, { companyName: COMPANY_NAME, headline: HEADLINE }),
  },
  {
    key: "stage4_dedup",
    old: () =>
      evaluateLiteral(extractPromptLiteral(pipelineStagesHead, 4), {
        existingSummary: EXISTING_SUMMARY,
        newArticleHeadline: HEADLINE,
        newArticleSnippet: SNIPPET,
      }),
    fresh: () =>
      render(DEFAULT_PROMPTS.stage4_dedup, {
        existingSummary: EXISTING_SUMMARY,
        headline: HEADLINE,
        snippet: SNIPPET.slice(0, 500),
      }),
  },
  {
    key: "stage6_analysis",
    old: () =>
      evaluateLiteral(extractPromptLiteral(scannerHead, 1), {
        article,
        fullContent: FULL_CONTENT,
        targetRegions: REGIONS,
      }),
    fresh: () =>
      render(DEFAULT_PROMPTS.stage6_analysis, {
        headline: article.headline,
        source: article.source,
        content: FULL_CONTENT.slice(0, 6000),
        regions: REGIONS.join(", "),
      }),
  },
  {
    key: "family_research",
    old: () =>
      // Occurrence 2: occurrence 1 is seedFamilies()'s market-seed prompt.
      evaluateLiteral(extractPromptLiteral(familyResearchNow, 2), {
        family,
        anchor,
        existingMembers,
        context: familyContext,
      }),
    fresh: () =>
      render(DEFAULT_PROMPTS.family_research, {
        familyName: family.name,
        country: family.country,
        anchorClause: anchor ? ` The anchor person is "${anchor}".` : "",
        companiesClause: family.primaryCompanies?.length
          ? ` Main companies: ${family.primaryCompanies.join(", ")}.`
          : "",
        knownMembersLine: existingMembers.length
          ? `Already-known members (reuse these exact spellings): ${existingMembers.join("; ")}.`
          : "",
        sources: familyContext,
      }),
  },
  {
    key: "founder_discovery",
    old: () =>
      evaluateLiteral(extractPromptLiteral(founderDiscoveryNow, 1), {
        name: founderName,
        hint: founderHint,
        search: founderSearch,
        context: founderContext,
      }),
    fresh: () =>
      render(DEFAULT_PROMPTS.founder_discovery, {
        companyName: founderName,
        hintSuffix: founderHint ? ` (${founderHint})` : "",
        answerBlock: founderSearch?.answer ? `Search summary: ${founderSearch.answer}\n\n` : "",
        results: founderContext,
      }),
  },
];

/** Pulls an exported string constant's value out of a file at HEAD. */
function atHeadExport(path: string, name: string): string {
  const source = atHead(path);
  const start = source.indexOf(`export const ${name} = \``);
  if (start === -1) throw new Error(`${name} not found in ${path}`);
  const literalStart = source.indexOf("`", start);
  const literal = extractBacktickLiteral(source, literalStart);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${literal};`)() as string;
}

/** Returns the backtick literal starting at `from`, honouring escapes. */
function extractBacktickLiteral(source: string, from: number): string {
  for (let i = from + 1; i < source.length; i++) {
    if (source[i] === "\\") { i++; continue; }
    if (source[i] === "`") return source.slice(from, i + 1);
  }
  throw new Error("Unterminated backtick literal");
}

// ============================================================================
// Report
// ============================================================================

/** First differing line, for a legible failure message. */
function firstDifference(a: string, b: string): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  for (let i = 0; i < Math.max(aLines.length, bLines.length); i++) {
    if (aLines[i] !== bLines[i]) {
      return `line ${i + 1}:\n  old: ${JSON.stringify(aLines[i])}\n  new: ${JSON.stringify(bLines[i])}`;
    }
  }
  return "(identical line-by-line; lengths differ)";
}

let failures = 0;
for (const testCase of cases) {
  let oldText: string;
  let newText: string;
  try {
    oldText = testCase.old();
    newText = testCase.fresh();
  } catch (error) {
    console.log(`FAIL  ${testCase.key} — ${(error as Error).message}`);
    failures++;
    continue;
  }

  if (oldText === newText) {
    console.log(`OK    ${testCase.key} (${newText.length} chars identical)`);
  } else {
    failures++;
    console.log(`FAIL  ${testCase.key} — ${oldText.length} vs ${newText.length} chars`);
    console.log(firstDifference(oldText, newText));
  }
}

console.log(failures === 0 ? "\nAll prompt defaults render byte-identically." : `\n${failures} prompt(s) differ.`);
process.exit(failures === 0 ? 0 : 1);
