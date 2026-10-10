/** Shapes returned by the card endpoints; mirror server/card-normalize.ts. */

export interface NormalizedPhone {
  e164: string | null;
  display: string | null;
  extension: string | null;
  slot: "mobile" | "office" | "fax" | "other";
  label: string | null;
  raw: string;
  inheritedPrefix?: boolean;
}

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
  phoneMobile: string | null;
  phoneOffice: string | null;
  emails: string[];
  website: string | null;
  linkedin: string | null;
  address: string | null;
  country: string | null;
  otherText: string | null;
  cardBounds: { x: number; y: number; width: number; height: number } | null;
}

export interface BusinessCard {
  id: string;
  personId: number | null;
  frontImage: string | null;
  parsed: ParsedCard | null;
  confidence: Record<string, number> | null;
  duplicates: { personId: number; fullName: string; reason: string }[] | null;
  status: "parsed" | "needs_review" | "saved" | "failed";
  source: string;
  eventNote: string | null;
  model: string | null;
  error: string | null;
  /** Tokenised .vcf link that works without a session — safe to open on a phone. */
  vcardUrl?: string;
  createdAt: string;
}

/** One row of the scanner's History: a saved card, without its photo. */
export interface CardHistoryEntry {
  id: string;
  personId: number | null;
  parsed: ParsedCard | null;
  eventNote: string | null;
  source: string;
  savedAt: string;
  remindAt: string | null;
  vcardUrl?: string;
}

/** A contact with a follow-up reminder, as GET /api/follow-ups returns it. */
export interface FollowUpEntry {
  personId: number;
  fullName: string;
  company: string | null;
  jobTitle: string | null;
  notes: string | null;
  email: string | null;
  phoneMobile: string | null;
  remindAt: string;
  cardId: string | null;
}
