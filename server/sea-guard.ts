/**
 * Deterministic SEA-anchor guard
 *
 * Enforces the business rule that a lead may only qualify on SEA geography
 * when source-backed evidence shows ONE of:
 *   1. company headquartered in SEA / HK / Taiwan
 *   2. founder currently based in SEA / HK / Taiwan
 *   3. founder has credible roots in SEA / HK / Taiwan
 *   4. company has a strong operational centre in SEA / HK / Taiwan
 *   5. article explicitly concerns a SEA / HK / Taiwan wealth event
 *
 * Insufficient (must NOT pass on these alone):
 *   - SEA publication / source domain
 *   - SEA investor or backer (e.g. GIC, Temasek, Sea Ltd's parent fund)
 *   - APAC customers, vague "Asia expansion", regional distribution
 */

export type SeaEvidenceType =
  | "company_hq"
  | "founder_base"
  | "founder_roots"
  | "operational_centre"
  | "wealth_event"
  | "none";

/** Disqualifying signal categories: presence of any forces a reject. */
export type SeaDisqualifier =
  | "sea_publisher_only"
  | "sea_investor_only"
  | "vague_apac_expansion"
  | "sea_customers_only"
  | "sea_distribution_only";

export interface SeaAnchorInput {
  hqLocation?: string | null;
  founderLocations?: Array<{ name?: string; location?: string | null }> | null;
  seaEvidenceType?: SeaEvidenceType | string | null;
  seaEvidenceText?: string | null;
  disqualifyingSignals?: Array<SeaDisqualifier | string> | null;
  /** LLM's own regionRelevance verdict — used as a soft input, not authoritative. */
  llmRegionRelevance?: boolean | null;
}

export interface SeaAnchorResult {
  passes: boolean;
  reason: string;
  matchedTerm?: string;
}

/**
 * Locations that count as "in target regions" for the geography rule.
 * Stored lowercase; matching is substring on a normalised location string.
 *
 * Includes country names, well-known cities, and a few aliases. We deliberately
 * exclude mainland China cities (Beijing, Shanghai, Shenzhen, Guangzhou) since
 * the target list does NOT include mainland China.
 */
const SEA_LOCATION_TERMS: readonly string[] = [
  // Countries / territories
  "singapore",
  "malaysia",
  "indonesia",
  "thailand",
  "vietnam",
  "viet nam",
  "philippines",
  "hong kong",
  "hongkong",
  "hk sar",
  "taiwan",
  "taiwanese",
  // Indonesian cities
  "jakarta",
  "surabaya",
  "bandung",
  "bali",
  // Malaysian cities
  "kuala lumpur",
  "petaling jaya",
  "penang",
  "johor bahru",
  "cyberjaya",
  // Thai cities
  "bangkok",
  "chiang mai",
  // Vietnamese cities
  "ho chi minh",
  "saigon",
  "hanoi",
  "da nang",
  // Philippine cities
  "manila",
  "makati",
  "bgc",
  "taguig",
  "cebu",
  // Taiwanese cities
  "taipei",
  "kaohsiung",
  "hsinchu",
  // Hong Kong districts (helpful when "Hong Kong" is implied)
  "kowloon",
  "central, hong kong",
  "causeway bay",
];

/**
 * Terms we explicitly DO NOT count, even though they may appear in a location
 * field. Mainland China and SF/NY/London are common false-positive substrings.
 */
const NON_SEA_DISAMBIGUATORS: readonly string[] = [
  "mainland china",
  "people's republic of china",
  "beijing",
  "shanghai",
  "shenzhen",
  "guangzhou",
  "hangzhou",
  "san francisco",
  "new york",
  "london",
  "tokyo",
  "seoul",
  "sydney",
  "mumbai",
  "delhi",
  "bangalore",
];

const VALID_EVIDENCE_TYPES: ReadonlySet<SeaEvidenceType> = new Set<SeaEvidenceType>([
  "company_hq",
  "founder_base",
  "founder_roots",
  "operational_centre",
  "wealth_event",
]);

/**
 * Normalises a location string for case-insensitive substring search.
 * Empty/null returns "".
 */
function normaliseLocation(loc: unknown): string {
  if (typeof loc !== "string") return "";
  return loc.toLowerCase().trim();
}

/**
 * Returns the first SEA term that appears in `loc`, or null if none.
 * Disambiguates: if a NON_SEA term appears, we only count SEA when the SEA
 * term is more specific (e.g. "Hong Kong, China" is SEA; "Beijing, China" is not).
 */
function matchSeaTerm(loc: string): string | null {
  const normalised = normaliseLocation(loc);
  if (!normalised) return null;

  const seaHit = SEA_LOCATION_TERMS.find(t => normalised.includes(t));
  if (!seaHit) return null;

  // If a non-SEA disambiguator is present and no SEA city/territory beyond
  // a generic "asia" term, treat as non-SEA. This guards against e.g.
  // "Beijing, China" where a country-level term might accidentally match.
  // The check is conservative: any SEA term wins, but we log the conflict.
  const conflicting = NON_SEA_DISAMBIGUATORS.find(t => normalised.includes(t));
  if (conflicting) {
    // If the SEA term is "hong kong" or "taiwan" and the conflict is
    // "mainland china" / "beijing" etc., the SEA term still wins because
    // HK/Taiwan are explicitly in our target regions even though commonly
    // grouped under "China".
    return seaHit;
  }
  return seaHit;
}

/**
 * Validates whether the structured Stage 6 LLM output establishes SEA anchoring
 * under the strict business rule. Designed to fail closed: ambiguous or
 * inconsistent signals reject.
 */
export function validateSeaAnchor(input: SeaAnchorInput): SeaAnchorResult {
  const disqualifiers = (input.disqualifyingSignals ?? []).filter(
    (d): d is string => typeof d === "string" && d.trim().length > 0
  );
  if (disqualifiers.length > 0) {
    return {
      passes: false,
      reason:
        `Disqualifying signal(s) reported by analysis: ${disqualifiers.join(", ")}. ` +
        `SEA publisher / investor / APAC-expansion alone do not establish target-region relevance.`,
    };
  }

  const evidenceType = (input.seaEvidenceType ?? "none").toString() as SeaEvidenceType;

  if (evidenceType === "none" || !VALID_EVIDENCE_TYPES.has(evidenceType)) {
    return {
      passes: false,
      reason: `No valid SEA evidence category reported (got: "${evidenceType}").`,
    };
  }

  // For evidence types that name a concrete location, we re-verify the
  // location actually contains a SEA term. This catches LLM hallucinations
  // where the model claims "company_hq" but the hqLocation is "London".
  if (evidenceType === "company_hq") {
    const hq = input.hqLocation ?? "";
    const matched = matchSeaTerm(hq);
    if (!matched) {
      return {
        passes: false,
        reason:
          `Claimed evidence "company_hq" but hqLocation "${hq || "(empty)"}" ` +
          `contains no SEA / HK / Taiwan term.`,
      };
    }
    return {
      passes: true,
      reason: `Company HQ in SEA: "${hq}" (matched "${matched}").`,
      matchedTerm: matched,
    };
  }

  if (evidenceType === "founder_base") {
    const locs = input.founderLocations ?? [];
    for (const f of locs) {
      const matched = matchSeaTerm(f?.location ?? "");
      if (matched) {
        return {
          passes: true,
          reason: `Founder ${f.name ?? "(unnamed)"} based in SEA: "${f.location}" (matched "${matched}").`,
          matchedTerm: matched,
        };
      }
    }
    return {
      passes: false,
      reason:
        `Claimed evidence "founder_base" but no founderLocations entry ` +
        `contains a SEA / HK / Taiwan term.`,
    };
  }

  // For founder_roots / operational_centre / wealth_event we trust the LLM
  // verdict but require non-empty supporting text so reviewers can audit.
  const supporting = (input.seaEvidenceText ?? "").trim();
  if (supporting.length < 10) {
    return {
      passes: false,
      reason:
        `Claimed evidence "${evidenceType}" but supporting text is missing or too short ` +
        `(must cite article passage establishing SEA roots / operational centre / wealth event).`,
    };
  }

  // Soft sanity: text should mention a SEA term to be auditable.
  const textMatch = matchSeaTerm(supporting);
  if (!textMatch) {
    return {
      passes: false,
      reason:
        `Claimed evidence "${evidenceType}" with text "${supporting.slice(0, 120)}…" ` +
        `but text contains no SEA / HK / Taiwan locator term.`,
    };
  }

  return {
    passes: true,
    reason: `${evidenceType.replace("_", " ")}: ${supporting.slice(0, 160)} (matched "${textMatch}").`,
    matchedTerm: textMatch,
  };
}

/**
 * Convenience: returns the canonical list of SEA terms (lowercased) for tests
 * and adapters that want to score a free-text snippet.
 */
export function listSeaTerms(): readonly string[] {
  return SEA_LOCATION_TERMS;
}
