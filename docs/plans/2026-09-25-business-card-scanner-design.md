# Business card scanner — design

**Date:** 2026-09-25
**Status:** approved, building v1

## Why

Billy meets prospects at events and collects cards. Typing them in loses the context and
the numbers end up unusable (no country code, so WhatsApp fails). A scanner that turns a
photo into a correct, enriched Sensei contact closes the gap between "met someone" and
"they are in the pipeline".

## What the market does, and the gap

Research across CamCard, ABBYY, Covve, HiHello, Haystack, Sansan/Eight, ScanBizCards,
Wantedly People, Blinq, Popl, Habsy, Card2Gold (Sept 2026) shows a converged feature set:
batch capture, both sides into one record, bilingual cards, web enrichment, duplicate
merge, one-tap save to phone, "where we met" notes, follow-up reminders.

Two things **no vendor documents doing well**:

1. **Phone normalisation to E.164 with the country inferred from the card** and the SEA
   label conventions (DID, HP, M, O, F, ext) mapped to typed slots. Covve claims only
   "international phone numbers supported". This is the top cause of dead WhatsApp numbers.
2. **SEA name handling** — honorifics (Tan Sri, Dato', Datuk, Dr), Chinese surname-first
   order, and ALL-CAPS to Title Case without breaking McDonald, d'Souza, DBS, Pte Ltd.
   Sansan only achieves this with human operators.

An LLM vision model plus a deterministic normaliser beats every consumer app on SG/MY cards.
That is the wedge this feature takes.

## Architecture

```
photo(s) ──► card-scanner.ts ──► vision LLM (gemini-2.5-flash) ──► raw JSON
                   │                                                 │
                   │                                    card-normalize.ts (pure)
                   │                                    phones → E.164 + typed slots
                   │                                    names → honorifics + case
                   │                                    company/email/url/address
                   │                                                 │
                   ├──► dedupe vs people/contact_meta ◄──────────────┘
                   ├──► enrichment (company site/HQ, LinkedIn) — blanks if unverified
                   └──► business_cards row (images + raw + cleaned + status)
                                     │
                    ┌────────────────┴────────────────┐
              Telegram reply                    /scan web page
            (parsed + vCard file)          (queue, review, re-parse, save)
```

### Separation of concerns

`card-normalize.ts` is **pure and unit-tested**: no I/O, no DB, no LLM. Everything the
model should not be trusted with lives here, because a deterministic rule beats a
probabilistic one for formatting. The LLM's job is only to *read the card* — find the
text and say which field it belongs to. Formatting, validating and typing is code.

## Components

### 1. `shared/schema.ts`

New `business_cards` table (app-role-owned, `db:push`):

| column | purpose |
|---|---|
| `id` uuid | pk |
| `personId` int | set once saved; null while in the review queue |
| `frontImage` / `backImage` text | data URLs or file paths |
| `rawExtraction` jsonb | exactly what the model returned (audit + re-parse) |
| `parsed` jsonb | the normalised `ParsedCard` |
| `confidence` jsonb | per-field confidence from the model |
| `status` text | `parsed` \| `needs_review` \| `saved` \| `failed` |
| `source` text | `telegram` \| `web` |
| `eventNote` text | "where we met" — the Telegram caption or the web field |
| `batchId` uuid | groups a multi-card upload |
| `error` text | failure reason for the Failed tab |
| `createdAt` / `updatedAt` | |

`contact_meta` gains `phoneMobile`, `phoneOffice`, `phoneOther` (all E.164), `jobTitle`,
`company`, `linkedinUrl`, `website`, `address`, `cardId`. Phone and title belong on the
contact layer, not `people` (which the rest of the pipeline treats as facts about a
person, not contact details).

### 2. `server/card-normalize.ts` (pure)

- `normalizePhone(raw, label, ctx)` → `{ e164, national, type, label }`. Country order:
  explicit `+`, then the card's address country, then other numbers on the card, then
  `CARD_DEFAULT_COUNTRY` (SG). Handles `ext`/`x`/`#` extensions. Uses
  `libphonenumber-js/max` so mobile vs fixed-line is real, not guessed from the label.
- `phoneSlotFor(label, type)` — DID/O/T/Tel → office, HP/M/Mobile/手机 → mobile, F/Fax → drop.
- `titleCaseName(name)` — preserves McDonald/MacLeod, d'Souza, O'Brien, bin/binti/a/l,
  van/von/de/del, Roman numerals, initials. ALL CAPS and all lower both fixed; mixed case
  left alone (the card may be deliberate).
- `splitHonorifics(name)` → `{ honorific, name }` with a SEA dictionary (Tan Sri, Puan Sri,
  Dato' Seri, Datuk, Dato', Tun, Toh Puan, Khun, Haji, Dr, Prof, Ir, Ar).
- `normalizeCompany(name)` — same casing rules plus a suffix/acronym dictionary
  (Pte Ltd, Sdn Bhd, Bhd, PT, Tbk, Co Ltd, LLP, DBS, UOB, OCBC, CIMB, BCA, SCB).
- `normalizeEmail`, `normalizeUrl`, `normalizeAddress` — validate, lowercase the domain,
  add `https://`, return null rather than guess.

### 3. `server/card-scanner.ts`

`extractCard(images, opts)` → vision call with a strict JSON schema; `gemini-2.5-flash`
primary (vision-capable, cheap), `claude-sonnet-4` on a `reparse` request or when the
first pass returns nothing usable. Prompt asks for **both scripts** (Latin + local),
every phone with its **printed label verbatim**, and a per-field confidence.

Then: normalise → dedupe (`resolvePersonByName`, plus email and E.164 phone match against
`contact_meta`) → optional enrichment (`searchCompanyHeadquarters`, LinkedIn via the
existing founder enrichment) → persist a `business_cards` row.

`saveCard(cardId, edits)` → `resolvePersonByName` + `linkCompany` + `updateContactMeta`,
status `saved`. `toVCard(parsed)` → RFC 6350 text.

### 4. Telegram (`telegram-bot.ts`, `telegram.ts`)

- Extend `TelegramUpdate` with `photo`, `document`, `caption`, `media_group_id`.
- `getFile` + download helper (missing today).
- A photo message routes to the scanner; the caption becomes `eventNote`. An album
  (`media_group_id`) is collected on a short debounce and processed as a batch.
- Reply: formatted contact + inline row `✅ Save · ✏️ Fix · 🔄 Re-parse · 🗑 Discard`,
  followed by a `.vcf` document to tap-save to the phone. "Fix" links to the web page.

### 5. Web (`client/src/pages/scan.tsx`)

Camera/file input (`capture="environment"`), drag-drop, multi-file. A queue card per
image with status; a review panel showing the card image beside the parsed fields, with
low-confidence fields highlighted amber and a duplicate banner when one is found.
Buttons: Save, Re-parse with AI, Discard, Download vCard.

### 6. Uploads

`express.json` limit raised to 12 mb and images posted as data URLs — simpler than
multipart, and the images go to the LLM as data URLs anyway. Client downscales to
max 1600 px before upload.

## Error handling

- Vision failure or unparseable JSON → card row `status=failed` with the reason, visible
  in a Failed tab, re-parse button available. Never a silent drop.
- Unverifiable email/LinkedIn → left blank (Blinq's rule). Better an empty field than a
  wrong one in front of a client.
- Enrichment runs after the parse is already saved, so a search outage never loses a card.
- Telegram download failure → reply with the error, keep the card row.

## Testing

`tests/card-normalize.test.ts` under the existing zero-dep harness, covering: SG/MY/ID/TH/
PH/VN numbers with and without `+`, country inference from address, DID/HP/F labels,
extensions, ALL CAPS names, McDonald/d'Souza/bin/binti, Chinese order left alone,
honorific splitting, company suffixes and bank acronyms, email/url validation, vCard shape.

## Out of scope for v1

Drafted WhatsApp/email follow-up, reminders, Google Contacts OAuth sync, QR/vCard decode,
job-change alerts, offline capture. All are logged in `tasks/todo.md`.
