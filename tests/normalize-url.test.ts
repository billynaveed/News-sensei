/**
 * Regression tests for normalizeUrl — the dedup key. If this drifts, leads
 * double up (or distinct articles collapse), so it's the contract the scanner's
 * dedup depends on. Pure function, no I/O.
 */
import { normalizeUrl } from "../server/adapters";
import { eq, check } from "./harness";

// protocol is forced to https
eq("forces https", normalizeUrl("http://example.com/a"), "https://example.com/a");

// tracking params stripped, real params kept
eq(
  "strips utm_*/ref, keeps real params",
  normalizeUrl("https://example.com/a?utm_source=tw&utm_medium=email&utm_campaign=x&ref=y&id=42"),
  "https://example.com/a?id=42",
);

// hash fragment cleared
eq("clears hash", normalizeUrl("https://example.com/a#section"), "https://example.com/a");

// two URLs differing only by tracking + protocol + hash dedupe to the same key
check(
  "dedup: tracking/protocol/hash variants collapse",
  normalizeUrl("http://example.com/a?utm_source=x#top") === normalizeUrl("https://example.com/a"),
  "variants did not normalize equal",
);

// distinct paths stay distinct
check(
  "distinct paths stay distinct",
  normalizeUrl("https://example.com/a") !== normalizeUrl("https://example.com/b"),
  "distinct paths collapsed",
);

// non-URL input falls back to lowercased/trimmed string (no throw)
eq("invalid url falls back to lowercase/trim", normalizeUrl("  NOT A URL  "), "not a url");
