/**
 * Business card field normalisation — pure functions, no I/O.
 *
 * The vision model's job is to READ the card (find the text, say which field
 * it belongs to). Everything about how a value should be *shaped* lives here,
 * because a deterministic rule beats a probabilistic one for formatting and
 * can be unit-tested against the cases that actually show up in SEA:
 *
 *   - "DID 6225 1234" on a Singapore card  → +6562251234, office
 *   - "HP: 012-345 6789" on a Malaysian card → +60123456789, mobile
 *   - "TAN SRI DATO' LIM KOK THAY"        → honorific "Tan Sri Dato'", name "Lim Kok Thay"
 *   - "MCDONALD PTE LTD"                   → "McDonald Pte Ltd" (not "Mcdonald Pte Ltd")
 *
 * No consumer scanner documents doing this well; it is the wedge of the feature.
 */

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";

/** Fallback when the card gives no country hint at all. */
export const CARD_DEFAULT_COUNTRY = (process.env.CARD_DEFAULT_COUNTRY || "SG") as CountryCode;

// ---------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------

export type PhoneSlot = "mobile" | "office" | "fax" | "other";

export interface NormalizedPhone {
  /** E.164, e.g. "+6591234567". Null when the digits cannot form a valid number. */
  e164: string | null;
  /** Pretty international form for display, e.g. "+65 9123 4567". */
  display: string | null;
  /** Digits after an "ext"/"x"/"#" marker, kept separately. */
  extension: string | null;
  slot: PhoneSlot;
  /** The label exactly as printed on the card ("DID", "HP", "Tel"). */
  label: string | null;
  /** The raw string we were given, for the review screen. */
  raw: string;
  /** libphonenumber's verdict, when it has one. */
  lineType: string | null;
  /** True when the area code was borrowed from another number on the card. */
  inheritedPrefix?: boolean;
}

/**
 * Card label conventions across SEA. "DID" (direct inward dialling) is a desk
 * line; "HP" (hand phone) is Singapore/Malaysia for mobile; 手机/手機 is the
 * Chinese equivalent on bilingual cards.
 */
// `\b` is meaningless next to CJK/Thai characters (they are not \w), so the
// non-Latin forms are matched on their own without a boundary assertion.
const LABEL_SLOTS: [RegExp, PhoneSlot][] = [
  [/^(?:(?:f|fax|facsimile)\b|传真|傳真|โทรสาร)/i, "fax"],
  [/^(?:(?:hp|h\/p|m|mob|mobile|cell|cellular|gsm|handphone|hand phone|di ?dong|di động)\b|手机|手機|มือถือ)/i, "mobile"],
  [/^(?:did|dl|direct|d)\b/i, "office"],
  [/^(?:(?:o|off|office|t|tel|telephone|phone|ph|work|w)\b|电话|電話|โทร)/i, "office"],
];

/** Which typed slot a printed label implies, or null when the label says nothing. */
export function slotFromLabel(label: string | null | undefined): PhoneSlot | null {
  const l = (label ?? "").trim().replace(/^[\s.:•·\-]+/, "");
  if (!l) return null;
  for (const [re, slot] of LABEL_SLOTS) if (re.test(l)) return slot;
  return null;
}

/**
 * Country the number most likely belongs to, in decreasing order of trust:
 * an explicit "+" in the number wins outright (handled by the parser), then
 * the country named in the card's address, then a country another number on
 * the card resolved to, then the configured default.
 */
export function inferCountry(addressCountry?: string | null, siblingCountry?: CountryCode | null): CountryCode {
  const named = countryCodeFromText(addressCountry);
  return named ?? siblingCountry ?? CARD_DEFAULT_COUNTRY;
}

// Latin alternatives are boundary-anchored; CJK/Thai/Hangul ones cannot be
// (those scripts are not `\w`, so `\b` never matches beside them).
const COUNTRY_WORDS: [RegExp, CountryCode][] = [
  [/\b(?:singapore|singapura)\b|新加坡/i, "SG"],
  [/\b(?:malaysia|kuala lumpur|selangor|penang|johor)\b|马来西亚|馬來西亞/i, "MY"],
  [/\b(?:indonesia|jakarta|surabaya)\b|印尼|印度尼西亚/i, "ID"],
  [/\b(?:thailand|bangkok)\b|泰国|泰國|ประเทศไทย|กรุงเทพ/i, "TH"],
  [/\b(?:philippines|manila|makati|taguig)\b|菲律宾|菲律賓/i, "PH"],
  [/\b(?:vietnam|viet nam|hanoi|ho chi minh|việt nam)\b|越南/i, "VN"],
  [/\b(?:hong kong|hongkong)\b|香港/i, "HK"],
  [/\b(?:china|shanghai|beijing|shenzhen)\b|中国|中國/i, "CN"],
  [/\b(?:japan|tokyo|osaka)\b|日本/i, "JP"],
  [/\b(?:india|mumbai|bengaluru|bangalore|delhi)\b/i, "IN"],
  [/\b(?:australia|sydney|melbourne)\b/i, "AU"],
  [/\b(?:united kingdom|england|london|u\.?k\.?)\b/i, "GB"],
  [/\b(?:united states|u\.?s\.?a\.?|new york|california)\b/i, "US"],
  [/\b(?:united arab emirates|dubai|abu dhabi|u\.?a\.?e\.?)\b/i, "AE"],
  [/\b(?:switzerland|zurich|geneva)\b/i, "CH"],
  [/\b(?:taiwan|taipei)\b|台湾|台灣/i, "TW"],
  [/\b(?:south korea|korea|seoul)\b|한국/i, "KR"],
];

/** Two-letter country code named by a free-text address line, if any. */
export function countryCodeFromText(text?: string | null): CountryCode | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  for (const [re, code] of COUNTRY_WORDS) if (re.test(t)) return code;
  // A bare ISO code on its own ("SG", "MY") is worth honouring too.
  const bare = t.toUpperCase().match(/^([A-Z]{2})$/);
  if (bare && COUNTRY_WORDS.some(([, c]) => c === bare[1])) return bare[1] as CountryCode;
  return null;
}

// "ext 205", "extn. 205", "x88" and "#12". `x` needs no trailing boundary
// because "x88" runs the marker straight into the digits.
const EXTENSION_RE = /(?:\b(?:ext|extn|extension)\b\.?|\bx|#)\s*:?\s*(\d{1,6})\s*$/i;

/**
 * Turn a printed phone string into E.164 plus a typed slot.
 *
 * The label decides the slot when it is explicit ("HP" is a mobile even if the
 * number looks like a landline); otherwise libphonenumber's line type decides;
 * otherwise "other". A number that will not validate keeps `e164: null` so the
 * review screen can flag it rather than the app silently saving junk.
 */
export function normalizePhone(
  raw: string,
  label?: string | null,
  ctx?: { country?: CountryCode | null },
): NormalizedPhone {
  const original = (raw ?? "").trim();
  const result: NormalizedPhone = {
    e164: null,
    display: null,
    extension: null,
    slot: "other",
    label: (label ?? "").trim() || null,
    raw: original,
    lineType: null,
  };
  if (!original) return result;

  // Some cards print the label inside the number field ("HP 9123 4567").
  let body = original;
  let effectiveLabel = result.label;
  const inline = body.match(/^\s*([A-Za-z\u4e00-\u9fff\/.]{1,12})\s*[:.\-–]?\s+(?=[+(\d])/);
  if (inline && slotFromLabel(inline[1])) {
    effectiveLabel = effectiveLabel ?? inline[1];
    body = body.slice(inline[0].length);
  }

  const ext = body.match(EXTENSION_RE);
  if (ext) {
    result.extension = ext[1];
    body = body.slice(0, ext.index).trim();
  }

  // "(65) 6225 1234" and "0065 6225 1234" are international forms in disguise.
  body = body.replace(/^\s*\(\s*(\+?\d{1,4})\s*\)/, "+$1").replace(/^\s*00(?=\d)/, "+");

  const country = ctx?.country ?? CARD_DEFAULT_COUNTRY;
  const parsed = parsePhoneNumberFromString(body, country);
  if (parsed?.isValid()) {
    result.e164 = parsed.number;
    result.display = parsed.formatInternational();
    const type = parsed.getType();
    result.lineType = type ?? null;
    const labelSlot = slotFromLabel(effectiveLabel);
    result.slot =
      labelSlot ??
      (type === "MOBILE" || type === "FIXED_LINE_OR_MOBILE"
        ? "mobile"
        : type === "FIXED_LINE"
          ? "office"
          : "other");
  } else {
    result.slot = slotFromLabel(effectiveLabel) ?? "other";
  }
  result.label = effectiveLabel;
  return result;
}

/**
 * Normalise every number on a card together, so a number without a country
 * code can borrow the country another number established. Fax numbers are
 * kept (flagged as fax) rather than dropped — a private bank still faxes.
 */
export function normalizePhones(
  entries: { value: string; label?: string | null }[],
  addressCountry?: string | null,
): NormalizedPhone[] {
  const named = countryCodeFromText(addressCountry);
  // First pass: numbers that carry their own "+" tell us the card's country.
  let sibling: CountryCode | null = null;
  for (const e of entries) {
    if (!/^\s*(\+|00\d|\(\s*\+)/.test(e.value ?? "")) continue;
    const p = normalizePhone(e.value, e.label, { country: named ?? CARD_DEFAULT_COUNTRY });
    if (p.e164) {
      const cc = parsePhoneNumberFromString(p.e164)?.country;
      if (cc) { sibling = cc; break; }
    }
  }
  const country = inferCountry(addressCountry, sibling);
  const phones = entries
    .filter((e) => (e?.value ?? "").trim().length > 0)
    .map((e) => normalizePhone(e.value, e.label, { country }));

  // Cards routinely list two numbers under one area code:
  //   "Tel: (632) 8817-0817 • 8982-3000"
  // The second is not dialable on its own. Rebuild it from the area code of a
  // sibling that DID validate, and accept the result only when it comes out
  // the same length as that sibling — same shape, same exchange, so it is a
  // reconstruction rather than a guess.
  const donor = phones.find((p) => p.e164);
  if (donor?.e164) {
    const donorNational = parsePhoneNumberFromString(donor.e164)?.nationalNumber ?? "";
    for (const phone of phones) {
      if (phone.e164 || !phone.raw) continue;
      const digits = phone.raw.replace(/\D/g, "");
      if (digits.length < 4 || digits.length >= donorNational.length) continue;
      const borrow = donorNational.length - digits.length;
      if (borrow > 4) continue;
      const candidate = parsePhoneNumberFromString(donorNational.slice(0, borrow) + digits, country);
      if (!candidate?.isValid() || candidate.nationalNumber.length !== donorNational.length) continue;
      phone.e164 = candidate.number;
      phone.display = candidate.formatInternational();
      phone.lineType = candidate.getType() ?? null;
      phone.inheritedPrefix = true;
      const type = candidate.getType();
      phone.slot =
        slotFromLabel(phone.label) ??
        (type === "MOBILE" || type === "FIXED_LINE_OR_MOBILE" ? "mobile" : type === "FIXED_LINE" ? "office" : donor.slot);
    }
  }
  return phones;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * SEA honorifics and professional titles that get printed in front of a name.
 * Malaysian federal/state honours are the long ones; order matters, so the
 * longest forms are listed first.
 */
const HONORIFICS = [
  "Yang Berhormat", "Yang Berbahagia", "Tan Sri Dato' Seri", "Tan Sri Dato Seri",
  "Dato' Seri Utama", "Dato Seri Utama", "Datuk Seri Panglima", "Tan Sri Dato'", "Tan Sri Dato",
  "Dato' Sri", "Dato Sri", "Dato' Seri", "Dato Seri", "Datuk Seri", "Datuk Patinggi",
  "Puan Sri", "Toh Puan", "Tan Sri", "Datuk", "Dato'", "Dato", "Datin Paduka", "Datin",
  "Tun", "Tunku", "Tengku", "Raja", "Nik", "Wan",
  "Khunying", "Khun", "Phra", "Mom Luang", "Mom Rajawongse",
  "Haji", "Hajjah", "Hj", "Hjh", "Syed", "Sharifah",
  "Prof Dr", "Professor", "Prof", "Dr", "Dr.", "Ir", "Ar", "Sr",
  "Mr", "Mrs", "Ms", "Miss", "Mdm", "Madam", "Sir", "Lord", "Lady",
];

const SUFFIXES = ["Jr", "Jr.", "Sr", "Sr.", "II", "III", "IV", "PhD", "Ph.D.", "MBA", "CFA", "CPA", "Esq", "JP", "PBM", "BBM"];

export interface SplitName {
  honorific: string | null;
  name: string;
  suffix: string | null;
}

/**
 * Pull leading honorifics and trailing suffixes off a name. Both are kept —
 * addressing a Malaysian Tan Sri without the title is a relationship error,
 * but the title must not end up inside `full_name` where it would break
 * name matching against the rest of Sensei.
 */
export function splitHonorifics(input: string): SplitName {
  let name = (input ?? "").replace(/\s+/g, " ").trim();
  const honorifics: string[] = [];

  let matched = true;
  while (matched && name) {
    matched = false;
    for (const h of HONORIFICS) {
      // Apostrophes vary ("Dato'" vs "Dato’"); compare on a normalised form.
      const re = new RegExp(`^${escapeRegex(h).replace(/'/g, "['’`]?")}\\.?[\\s,]+`, "i");
      if (re.test(name)) {
        honorifics.push(h);
        name = name.replace(re, "").trim();
        matched = true;
        break;
      }
    }
  }

  let suffix: string | null = null;
  for (const s of SUFFIXES) {
    const re = new RegExp(`[\\s,]+${escapeRegex(s)}\\.?$`, "i");
    if (re.test(name)) {
      suffix = s;
      name = name.replace(re, "").trim();
      break;
    }
  }

  return { honorific: honorifics.length ? honorifics.join(" ") : null, name, suffix };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Particles that stay lowercase inside a name unless they lead it. */
const LOWERCASE_PARTICLES = new Set([
  "bin", "binti", "bte", "bt", "ibnu", "al", "el",
  "van", "von", "der", "den", "de", "del", "della", "di", "da", "dos", "das", "du", "la", "le", "ter", "ten",
  "a/l", "a/p", "s/o", "d/o",
]);

/** Always upper: initials and Roman numerals. */
const ROMAN_NUMERAL = /^(?:II|III|IV|VI{0,3}|IX|XI{0,2})$/i;

/**
 * Case one whitespace-delimited token of a name, honouring the prefixes that
 * carry an internal capital. "MCDONALD" → "McDonald", "O'BRIEN" → "O'Brien",
 * "D'SOUZA" → "D'Souza", "JEAN-PIERRE" → "Jean-Pierre".
 */
function caseNameToken(token: string, index: number): string {
  if (!token) return token;
  // Anything non-Latin (Chinese, Thai, Japanese, Korean) has no concept of case.
  if (!/[a-z]/i.test(token)) return token;

  const lower = token.toLowerCase();
  if (LOWERCASE_PARTICLES.has(lower) && index > 0) return lower;
  if (ROMAN_NUMERAL.test(token) && token.length > 1) return token.toUpperCase();
  // "J.P." / "A.B." stay as initials.
  if (/^(?:[a-z]\.){1,4}$/i.test(token)) return token.toUpperCase();

  // Split on hyphens and apostrophes, casing each part, so "jean-pierre" and
  // "o'brien" both come out right.
  const cased = lower.replace(/[a-z\u00c0-\u024f]+/g, (word, offset: number) => {
    const before = lower[offset - 1];
    // A letter after an apostrophe is capitalised ("O'Brien", "D'Souza") unless
    // it is a possessive-style single trailing letter ("Reilly's").
    if (before === "'" || before === "\u2019") {
      return word.length === 1 && offset + 1 >= lower.length ? word : upperFirst(word);
    }
    return upperFirst(word);
  });

  // Scottish/Irish prefixes: Mc + capital, Mac + capital (only for known-ish
  // lengths so "Mackenzie"-style spellings that are genuinely one word and
  // "Macau" are not mangled).
  return cased
    .replace(/^Mc([a-z])/, (_m, c: string) => `Mc${c.toUpperCase()}`)
    .replace(/^Mac([a-z])(?=[a-z]{2,})/, (_m, c: string) => `Mac${c.toUpperCase()}`)
    .replace(/^O'([a-z])/, (_m, c: string) => `O'${c.toUpperCase()}`);
}

function upperFirst(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Fix the casing of a person's name.
 *
 * ALL CAPS (the common case on cards) and all-lowercase are both rewritten.
 * Mixed case is left ALONE: "van der Meer" or "McKinsey" on a card is
 * deliberate, and second-guessing it does more harm than good. Chinese and
 * other non-Latin scripts pass through untouched, and the token ORDER is never
 * changed — "Kwek Leng Beng" is surname-first and must stay that way.
 */
export function titleCaseName(input: string): string {
  const name = (input ?? "").replace(/\s+/g, " ").trim();
  if (!name) return "";
  const letters = name.replace(/[^a-z]/gi, "");
  const isAllCaps = letters.length > 0 && letters === letters.toUpperCase();
  const isAllLower = letters.length > 0 && letters === letters.toLowerCase();
  if (!isAllCaps && !isAllLower) return name;
  return name.split(" ").map((t, i) => caseNameToken(t, i)).join(" ");
}

/**
 * Best-effort first/last split for the phone contact card. Western order is
 * assumed (last token is the family name) EXCEPT when the name looks like a
 * romanised Chinese name in surname-first order, where the FIRST token is the
 * family name. Getting this wrong is cosmetic (full name is authoritative),
 * so the heuristic stays conservative.
 */
const CHINESE_SURNAMES = new Set([
  "kwek", "quek", "lee", "lim", "tan", "ng", "wee", "goh", "teo", "chua", "ong", "low", "sim", "yeo",
  "chan", "cheng", "cheong", "chew", "chia", "chin", "choo", "chong", "chow", "foo", "ho", "hoe", "hong",
  "koh", "kong", "kua", "kuok", "lau", "leong", "liew", "lo", "loh", "mak", "neo", "oei", "pang", "phua",
  "poh", "seah", "seow", "sia", "soh", "tay", "toh", "wong", "woo", "yap", "yee", "yong", "yuen", "zhang",
  "wang", "li", "liu", "chen", "yang", "huang", "zhao", "wu", "zhou", "xu", "sun", "ma", "zhu", "hu", "guo",
]);

const PATRONYMIC = new Set(["bin", "binti", "bte", "bt", "a/l", "a/p", "s/o", "d/o", "ibnu"]);

export function splitFirstLast(fullName: string): { firstName: string | null; lastName: string | null } {
  const parts = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };

  // "Ahmad bin Abdullah": the particle means "son of", so the given name is
  // everything before it and the father's name everything after. The particle
  // itself belongs to neither.
  const p = parts.findIndex((t) => PATRONYMIC.has(t.toLowerCase()));
  if (p > 0 && p < parts.length - 1) {
    return { firstName: parts.slice(0, p).join(" "), lastName: parts.slice(p + 1).join(" ") };
  }

  const first = parts[0].toLowerCase().replace(/[^a-z]/g, "");
  if (CHINESE_SURNAMES.has(first) && parts.length <= 4) {
    return { firstName: parts.slice(1).join(" "), lastName: parts[0] };
  }
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

// ---------------------------------------------------------------------------
// Company, title, email, url, address
// ---------------------------------------------------------------------------

/**
 * Tokens that must keep a fixed shape in a company name: legal suffixes and
 * the acronyms and bank names that litter SEA cards. Key is lowercase.
 */
const COMPANY_FIXED: Record<string, string> = {};
for (const t of [
  "Pte", "Ltd", "Pte Ltd", "Sdn", "Bhd", "Sdn Bhd", "PT", "Tbk", "PLC", "LLC", "LLP", "LP", "Inc", "Corp",
  "Co", "GmbH", "AG", "SA", "NV", "BV", "KK", "Pty", "JSC", "PCL", "PJSC", "FZE", "FZ-LLC", "DMCC",
  "DBS", "UOB", "OCBC", "CIMB", "RHB", "BCA", "BNI", "BRI", "SCB", "HSBC", "UBS", "BNP", "ANZ", "ICBC",
  "AIA", "NTUC", "SIA", "CDL", "CapitaLand", "GIC", "MAS", "SGX", "IPO", "REIT", "F&B", "IT", "HR", "R&D",
  "AI", "APAC", "SEA", "ASEAN", "USA", "UK", "UAE", "M&A", "VC", "PE", "FX", "ESG", "IPO",
]) {
  COMPANY_FIXED[t.toLowerCase()] = t;
}

/**
 * Fix the casing of a company name. Same rule as names — only ALL CAPS or all
 * lowercase are rewritten — but with a dictionary so "DBS BANK LTD" becomes
 * "DBS Bank Ltd" rather than "Dbs Bank Ltd", and "MCDONALD PTE LTD" keeps its
 * internal capital.
 */
export function normalizeCompany(input: string): string {
  const name = (input ?? "").replace(/\s+/g, " ").trim().replace(/[,\s]+$/, "");
  if (!name) return "";
  const letters = name.replace(/[^a-z]/gi, "");
  const isAllCaps = letters.length > 0 && letters === letters.toUpperCase();
  const isAllLower = letters.length > 0 && letters === letters.toLowerCase();
  if (!isAllCaps && !isAllLower) return name;

  return name
    .split(" ")
    .map((token, i) => withPunctuation(token, (bare) => COMPANY_FIXED[bare]) ?? caseNameToken(token, i))
    .join(" ");
}

function stripEdgePunctuation(token: string): string {
  return token.replace(/^[^\p{L}\p{N}&]+|[^\p{L}\p{N}&]+$/gu, "");
}

/**
 * Look a token up in a fixed-spelling dictionary while keeping whatever
 * punctuation surrounded it, so "MD," stays "MD," and not "MD".
 */
function withPunctuation(token: string, lookup: (bare: string) => string | undefined): string | null {
  const bare = stripEdgePunctuation(token);
  if (!bare) return null;
  const fixed = lookup(bare.toLowerCase());
  if (!fixed) return null;
  const start = token.indexOf(bare);
  return token.slice(0, start) + fixed + token.slice(start + bare.length);
}

/** Job titles follow the same casing rule, with the common acronyms preserved. */
const TITLE_FIXED: Record<string, string> = {};
for (const t of ["CEO", "CFO", "COO", "CTO", "CIO", "CMO", "CRO", "CHRO", "MD", "VP", "SVP", "EVP", "AVP", "GM", "RM", "BD", "PA", "EA", "IT", "HR", "APAC", "SEA", "UHNW", "HNW", "CFA", "CPA", "PhD", "MBA"]) {
  TITLE_FIXED[t.toLowerCase()] = t;
}

export function normalizeTitle(input: string): string {
  const title = (input ?? "").replace(/\s+/g, " ").trim().replace(/[,\s]+$/, "");
  if (!title) return "";
  const letters = title.replace(/[^a-z]/gi, "");
  const isAllCaps = letters.length > 0 && letters === letters.toUpperCase();
  const isAllLower = letters.length > 0 && letters === letters.toLowerCase();
  if (!isAllCaps && !isAllLower) return title;
  const SMALL = new Set(["of", "the", "and", "for", "to", "in", "at", "a", "an", "&"]);
  return title
    .split(" ")
    .map((token, i) => {
      const fixed = withPunctuation(token, (bare) => TITLE_FIXED[bare]);
      if (fixed) return fixed;
      const bare = stripEdgePunctuation(token).toLowerCase();
      if (i > 0 && SMALL.has(bare)) return withPunctuation(token, () => bare) ?? bare;
      return caseNameToken(token, i);
    })
    .join(" ");
}

const EMAIL_RE = /^[^\s@,;:"'<>()[\]\\]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Validate and tidy an email. OCR confuses a handful of characters inside the
 * domain, so a couple of high-confidence repairs are applied; anything still
 * invalid returns null rather than a guess (Blinq's "blank beats wrong" rule).
 */
export function normalizeEmail(input: string): string | null {
  let e = (input ?? "").trim().replace(/^mailto:/i, "").replace(/[,;.]+$/, "");
  if (!e) return null;
  e = e.replace(/\s+/g, "");
  // Common OCR slips that only make sense in an address.
  e = e.replace(/\(at\)|\[at\]|\sat\s/gi, "@").replace(/\(dot\)|\[dot\]/gi, ".");
  const at = e.lastIndexOf("@");
  if (at < 1) return null;
  // Lowercased in full: cards routinely print an address in caps purely for
  // styling, and every mail provider in practice treats the local part
  // case-insensitively. "KOKTHAY@MERIDIANCAP.COM.SG" should not become a
  // contact whose email looks shouted.
  const candidate = `${e.slice(0, at).toLowerCase()}@${e.slice(at + 1).toLowerCase().replace(/\.{2,}/g, ".")}`;
  return EMAIL_RE.test(candidate) ? candidate : null;
}

/** Validate a website and give it a scheme. Returns null when it is not a host. */
export function normalizeUrl(input: string): string | null {
  let u = (input ?? "").trim().replace(/[,;]+$/, "").replace(/\s+/g, "");
  if (!u) return null;
  if (/^(mailto|tel):/i.test(u)) return null;
  if (!/^https?:\/\//i.test(u)) u = `https://${u.replace(/^\/+/, "")}`;
  try {
    const parsed = new URL(u);
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(parsed.hostname)) return null;
    parsed.hostname = parsed.hostname.toLowerCase();
    // Trailing-slash-only paths add nothing.
    const out = parsed.toString();
    return out.endsWith("/") && parsed.pathname === "/" ? out.slice(0, -1) : out;
  } catch {
    return null;
  }
}

/** A LinkedIn profile URL, or null. Accepts a bare "linkedin.com/in/x" or a handle. */
export function normalizeLinkedIn(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const handle = raw.match(/^@?([a-z0-9][a-z0-9-]{2,})$/i);
  if (handle) return `https://www.linkedin.com/in/${handle[1].toLowerCase()}`;
  const url = normalizeUrl(raw);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) return null;
    if (!/^\/(in|company|pub)\//i.test(parsed.pathname)) return null;
    return `https://www.linkedin.com${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Collapse a multi-line address into one tidy line. */
export function normalizeAddress(input: string): string | null {
  const a = (input ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim().replace(/[,\s]+$/, ""))
    .filter(Boolean)
    .join(", ")
    .replace(/\s{2,}/g, " ")
    .replace(/,{2,}/g, ",")
    .trim();
  return a || null;
}

// ---------------------------------------------------------------------------
// Whole-card normalisation
// ---------------------------------------------------------------------------

/** What the vision model is asked to return, before any cleaning. */
export interface RawCard {
  fullName?: string | null;
  /** The name in the card's other script (Chinese/Thai/Japanese), if printed. */
  nativeName?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  company?: string | null;
  nativeCompany?: string | null;
  phones?: { value: string; label?: string | null }[];
  emails?: string[];
  websites?: string[];
  linkedin?: string | null;
  address?: string | null;
  addressCountry?: string | null;
  otherText?: string | null;
  confidence?: Record<string, number> | null;
}

/** The cleaned card the UI edits and the saver writes. */
export interface ParsedCard {
  fullName: string;
  nativeName: string | null;
  honorific: string | null;
  suffix: string | null;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  department: string | null;
  company: string | null;
  nativeCompany: string | null;
  phones: NormalizedPhone[];
  /** Convenience views over `phones`, first valid number of each kind. */
  phoneMobile: string | null;
  phoneOffice: string | null;
  emails: string[];
  website: string | null;
  linkedin: string | null;
  address: string | null;
  country: string | null;
  otherText: string | null;
}

/** Apply every rule above to one raw extraction. Never throws. */
export function normalizeCard(raw: RawCard): ParsedCard {
  const split = splitHonorifics(raw.fullName ?? "");
  const fullName = titleCaseName(split.name);
  const { firstName, lastName } = splitFirstLast(fullName);
  const phones = normalizePhones(raw.phones ?? [], raw.addressCountry ?? raw.address ?? null);
  const firstOf = (slot: PhoneSlot) => phones.find((p) => p.slot === slot && p.e164)?.e164 ?? null;
  const country = countryCodeFromText(raw.addressCountry ?? raw.address ?? null);

  const emails = Array.from(
    new Set((raw.emails ?? []).map((e) => normalizeEmail(e)).filter((e): e is string => !!e)),
  );
  const website = (raw.websites ?? []).map((w) => normalizeUrl(w)).find((w): w is string => !!w) ?? null;

  return {
    fullName,
    nativeName: (raw.nativeName ?? "").trim() || null,
    honorific: split.honorific,
    suffix: split.suffix,
    firstName,
    lastName,
    jobTitle: normalizeTitle(raw.jobTitle ?? "") || null,
    department: normalizeTitle(raw.department ?? "") || null,
    company: normalizeCompany(raw.company ?? "") || null,
    nativeCompany: (raw.nativeCompany ?? "").trim() || null,
    phones,
    phoneMobile: firstOf("mobile"),
    phoneOffice: firstOf("office"),
    emails,
    website,
    linkedin: normalizeLinkedIn(raw.linkedin ?? "") ?? null,
    address: normalizeAddress(raw.address ?? ""),
    country,
    otherText: (raw.otherText ?? "").trim() || null,
  };
}

// ---------------------------------------------------------------------------
// vCard
// ---------------------------------------------------------------------------

/**
 * "25 Sep 2026" — the date the card was scanned, for the contact note. Short
 * and unambiguous across locales (never 09/25 vs 25/09), and it answers the
 * question a note in a contact record actually has to answer: when did I meet
 * this person?
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatScanDate(when: Date | string | null | undefined): string | null {
  if (!when) return null;
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return null;
  // Built by hand rather than toLocaleDateString: ICU renders September as
  // "Sept" under en-GB and the abbreviations shift between Node builds, which
  // would quietly change what lands in a saved contact.
  const sgt = new Date(d.getTime() + 8 * 60 * 60 * 1000); // Asia/Singapore, no DST
  return `${sgt.getUTCDate()} ${MONTHS[sgt.getUTCMonth()]} ${sgt.getUTCFullYear()}`;
}

/** The note stored on a contact: where we met, anything extra, and when. */
export function buildCardNote(parts: {
  eventNote?: string | null;
  otherText?: string | null;
  scannedAt?: Date | string | null;
}): string | null {
  const date = formatScanDate(parts.scannedAt);
  const pieces = [parts.eventNote, parts.otherText].map((p) => (p ?? "").trim()).filter(Boolean);
  if (date) pieces.push(`Card scanned ${date}`);
  return pieces.length ? pieces.join(" — ") : null;
}

/**
 * RFC 6350 §3.2 line folding: no line may exceed 75 octets, and a continuation
 * starts with a single space. Folding is done on BYTE boundaries without
 * splitting a multi-byte character, so an em dash or a Chinese name in a NOTE
 * cannot be cut in half and corrupt the import.
 */
export function foldVCardLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Walk back off a continuation byte (10xxxxxx) so a character stays whole.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74; // continuation lines carry a leading space
  }
  return out.join("\r\n ");
}

function vcardEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/**
 * RFC 6350 vCard 3.0 (3.0 rather than 4.0: iOS and Android both import it
 * without complaint, which 4.0 does not reliably do).
 */
export function toVCard(card: ParsedCard, extra?: { note?: string | null; scannedAt?: Date | string | null }): string {
  const lines = ["BEGIN:VCARD", "VERSION:3.0"];
  const display = [card.honorific, card.fullName, card.suffix].filter(Boolean).join(" ");
  lines.push(`N:${vcardEscape(card.lastName ?? "")};${vcardEscape(card.firstName ?? "")};;${vcardEscape(card.honorific ?? "")};${vcardEscape(card.suffix ?? "")}`);
  lines.push(`FN:${vcardEscape(display || card.fullName)}`);
  if (card.nativeName) lines.push(`NICKNAME:${vcardEscape(card.nativeName)}`);
  if (card.company) lines.push(`ORG:${vcardEscape(card.company)}${card.department ? `;${vcardEscape(card.department)}` : ""}`);
  if (card.jobTitle) lines.push(`TITLE:${vcardEscape(card.jobTitle)}`);
  for (const p of card.phones) {
    if (!p.e164) continue;
    const type = p.slot === "mobile" ? "CELL" : p.slot === "office" ? "WORK,VOICE" : p.slot === "fax" ? "WORK,FAX" : "VOICE";
    lines.push(`TEL;TYPE=${type}:${p.e164}${p.extension ? `;ext=${p.extension}` : ""}`);
  }
  for (const e of card.emails) lines.push(`EMAIL;TYPE=WORK:${vcardEscape(e)}`);
  if (card.website) lines.push(`URL:${vcardEscape(card.website)}`);
  if (card.linkedin) lines.push(`X-SOCIALPROFILE;TYPE=linkedin:${vcardEscape(card.linkedin)}`);
  if (card.address) lines.push(`ADR;TYPE=WORK:;;${vcardEscape(card.address)};;;;${vcardEscape(card.country ?? "")}`);
  const note = buildCardNote({ eventNote: extra?.note, otherText: card.otherText, scannedAt: extra?.scannedAt });
  if (note) lines.push(`NOTE:${vcardEscape(note)}`);
  lines.push(`REV:${new Date().toISOString()}`);
  lines.push("END:VCARD");
  return lines.map(foldVCardLine).join("\r\n");
}

/** A safe ASCII filename for the vCard attachment. */
export function vcardFilename(card: ParsedCard): string {
  const base = (card.fullName || "contact").normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return `${base || "contact"}.vcf`;
}
