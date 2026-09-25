/**
 * Business card normalisation: phones, names, companies, emails, vCard.
 * All pure — no DB, no network, no LLM.
 */
import { check, eq } from "./harness";
import {
  countryCodeFromText,
  normalizeAddress,
  normalizeCard,
  normalizeCompany,
  normalizeEmail,
  normalizeLinkedIn,
  normalizePhone,
  normalizePhones,
  normalizeTitle,
  normalizeUrl,
  slotFromLabel,
  splitFirstLast,
  splitHonorifics,
  titleCaseName,
  toVCard,
  buildCardNote,
  formatScanDate,
} from "../server/card-normalize";

// --- phones: E.164 with country inference ------------------------------------

eq("phone: SG mobile, no country code", normalizePhone("9123 4567", "HP", { country: "SG" }).e164, "+6591234567");
eq("phone: SG landline via DID label", normalizePhone("6225 1234", "DID", { country: "SG" }).e164, "+6562251234");
eq("phone: MY mobile with leading zero", normalizePhone("012-345 6789", "HP", { country: "MY" }).e164, "+60123456789");
eq("phone: ID mobile", normalizePhone("0812 3456 789", "HP", { country: "ID" }).e164, "+628123456789");
eq("phone: TH mobile", normalizePhone("081 234 5678", "M", { country: "TH" }).e164, "+66812345678");
eq("phone: PH mobile", normalizePhone("0917 123 4567", "Mobile", { country: "PH" }).e164, "+639171234567");
eq("phone: VN mobile", normalizePhone("090 123 4567", "M", { country: "VN" }).e164, "+84901234567");
eq("phone: explicit + wins over the context country", normalizePhone("+60 3-2averylongjunk", "T", { country: "SG" }).e164, null);
eq("phone: explicit +60 parsed with SG context", normalizePhone("+60 3 2118 1118", "T", { country: "SG" }).e164, "+60321181118");
eq("phone: (65) bracket form treated as country code", normalizePhone("(65) 6225 1234", "Tel", { country: "MY" }).e164, "+6562251234");
eq("phone: 00 prefix treated as +", normalizePhone("0065 6225 1234", "Tel", { country: "MY" }).e164, "+6562251234");
eq("phone: invalid digits give null, not junk", normalizePhone("123", "Tel", { country: "SG" }).e164, null);
eq("phone: empty is null", normalizePhone("", "Tel", { country: "SG" }).e164, null);

// --- phones: labels → typed slots --------------------------------------------

eq("slot: DID is an office line", slotFromLabel("DID"), "office");
eq("slot: HP is a mobile (SG/MY convention)", slotFromLabel("HP"), "mobile");
eq("slot: H/P variant", slotFromLabel("H/P"), "mobile");
eq("slot: Chinese 手机 is a mobile", slotFromLabel("手机"), "mobile");
eq("slot: F is a fax", slotFromLabel("F"), "fax");
eq("slot: Tel is an office line", slotFromLabel("Tel:"), "office");
eq("slot: unknown label says nothing", slotFromLabel("Hotline"), null);
eq("slot: empty label says nothing", slotFromLabel(""), null);
eq(
  "slot: an explicit HP label beats the line type",
  normalizePhone("6225 1234", "HP", { country: "SG" }).slot,
  "mobile",
);
eq(
  "slot: with no label, the line type decides",
  normalizePhone("9123 4567", null, { country: "SG" }).slot,
  "mobile",
);
eq(
  "slot: fax numbers are kept and flagged, not dropped",
  normalizePhone("6225 9999", "Fax", { country: "SG" }).slot,
  "fax",
);

// --- phones: extensions and inline labels ------------------------------------

const ext = normalizePhone("6225 1234 ext 205", "DID", { country: "SG" });
eq("phone: extension split off the number", ext.e164, "+6562251234");
eq("phone: extension captured", ext.extension, "205");
eq("phone: 'x' extension marker", normalizePhone("6225 1234 x88", "T", { country: "SG" }).extension, "88");
eq("phone: '#' extension marker", normalizePhone("6225 1234 #12", "T", { country: "SG" }).extension, "12");
const inline = normalizePhone("HP 9123 4567", null, { country: "SG" });
eq("phone: label printed inside the value is read", inline.slot, "mobile");
eq("phone: inline label stripped before parsing", inline.e164, "+6591234567");

// --- phones: country inferred from the card ----------------------------------

const fromAddress = normalizePhones(
  [{ value: "03-2118 1118", label: "T" }, { value: "012-345 6789", label: "HP" }],
  "Level 10, Menara KL, Kuala Lumpur, Malaysia",
);
eq("card phones: country taken from the address", fromAddress[0].e164, "+60321181118");
eq("card phones: applies to every number on the card", fromAddress[1].e164, "+60123456789");

const fromSibling = normalizePhones(
  [{ value: "+66 2 123 4567", label: "T" }, { value: "081 234 5678", label: "M" }],
  null,
);
eq("card phones: a sibling's country code seeds the rest", fromSibling[1].e164, "+66812345678");

eq(
  "card phones: falls back to the default country",
  normalizePhones([{ value: "9123 4567", label: "HP" }], null)[0].e164,
  "+6591234567",
);
eq("card phones: blanks are dropped", normalizePhones([{ value: "  ", label: "T" }], null).length, 0);

// --- country detection --------------------------------------------------------

eq("country: Singapore from the address", countryCodeFromText("1 Raffles Place, Singapore 048616"), "SG");
eq("country: Malaysia from a city", countryCodeFromText("Jalan Ampang, Kuala Lumpur"), "MY");
eq("country: Thailand in Thai script", countryCodeFromText("กรุงเทพ"), "TH");
eq("country: Vietnam with diacritics", countryCodeFromText("Quận 1, Việt Nam"), "VN");
eq("country: Chinese characters for Hong Kong", countryCodeFromText("香港中環"), "HK");
eq("country: nothing recognisable is null", countryCodeFromText("Level 5, Some Tower"), null);
eq("country: empty is null", countryCodeFromText(""), null);

// --- names: casing -------------------------------------------------------------

eq("name: ALL CAPS becomes Title Case", titleCaseName("KWEK LENG BENG"), "Kwek Leng Beng");
eq("name: all lowercase becomes Title Case", titleCaseName("kwek leng beng"), "Kwek Leng Beng");
eq("name: deliberate mixed case is left alone", titleCaseName("Kwek LENG Beng"), "Kwek LENG Beng");
eq("name: McDonald keeps its internal capital", titleCaseName("JOHN MCDONALD"), "John McDonald");
eq("name: MacLeod keeps its internal capital", titleCaseName("IAN MACLEOD"), "Ian MacLeod");
eq("name: O'Brien keeps its capital", titleCaseName("SEAN O'BRIEN"), "Sean O'Brien");
eq("name: d'Souza keeps its capital", titleCaseName("MARIA D'SOUZA"), "Maria D'Souza");
eq("name: hyphenated names cased on both sides", titleCaseName("JEAN-PIERRE DUBOIS"), "Jean-Pierre Dubois");
eq("name: Malay bin stays lowercase", titleCaseName("AHMAD BIN ABDULLAH"), "Ahmad bin Abdullah");
eq("name: Malay binti stays lowercase", titleCaseName("SITI BINTI RAHMAN"), "Siti binti Rahman");
eq("name: Indian a/l stays lowercase", titleCaseName("RAJU A/L MUNIANDY"), "Raju a/l Muniandy");
eq("name: Dutch particle stays lowercase mid-name", titleCaseName("PIET VAN DER BERG"), "Piet van der Berg");
eq("name: a leading particle is capitalised", titleCaseName("VAN HALEN"), "Van Halen");
eq("name: initials stay upper", titleCaseName("J.P. MORGAN"), "J.P. Morgan");
eq("name: Chinese characters pass through", titleCaseName("郭鹤年"), "郭鹤年");
eq("name: Thai script passes through", titleCaseName("ทักษิณ ชินวัตร"), "ทักษิณ ชินวัตร");
eq("name: token order is never changed", titleCaseName("TAN AH KOW"), "Tan Ah Kow");
eq("name: extra whitespace collapses", titleCaseName("  KWEK   LENG BENG "), "Kwek Leng Beng");
eq("name: empty stays empty", titleCaseName(""), "");

// --- names: honorifics ---------------------------------------------------------

const tanSri = splitHonorifics("Tan Sri Dato' Lim Kok Thay");
eq("honorific: Tan Sri Dato' pulled off", tanSri.honorific, "Tan Sri Dato'");
eq("honorific: the name itself is left", tanSri.name, "Lim Kok Thay");

eq("honorific: Datuk Seri", splitHonorifics("Datuk Seri Anwar Ibrahim").honorific, "Datuk Seri");
eq("honorific: Dr", splitHonorifics("Dr. Tony Tan").honorific, "Dr");
eq("honorific: name after Dr", splitHonorifics("Dr. Tony Tan").name, "Tony Tan");
eq("honorific: Khun (Thailand)", splitHonorifics("Khun Dhanin Chearavanont").honorific, "Khun");
eq("honorific: Haji", splitHonorifics("Haji Mohamed Ali").honorific, "Haji");
eq("honorific: curly apostrophe matches", splitHonorifics("Dato’ Vincent Tan").honorific, "Dato'");
eq("honorific: stacked titles both captured", splitHonorifics("Prof Dr Lim Wee").honorific, "Prof Dr");
eq("honorific: none present", splitHonorifics("Kwek Leng Beng").honorific, null);
eq("honorific: plain name untouched", splitHonorifics("Kwek Leng Beng").name, "Kwek Leng Beng");
eq("suffix: Jr pulled off", splitHonorifics("John Gokongwei Jr.").suffix, "Jr");
eq("suffix: name without it", splitHonorifics("John Gokongwei Jr.").name, "John Gokongwei");
eq("suffix: III", splitHonorifics("Henry Sy III").suffix, "III");

// --- names: first/last ---------------------------------------------------------

eq("split: Western order takes the last token", splitFirstLast("John McDonald").lastName, "McDonald");
eq("split: Western first name", splitFirstLast("John McDonald").firstName, "John");
eq("split: Chinese surname-first is detected", splitFirstLast("Kwek Leng Beng").lastName, "Kwek");
eq("split: Chinese given name is the rest", splitFirstLast("Kwek Leng Beng").firstName, "Leng Beng");
eq("split: Malay bin gives given name then father's name", splitFirstLast("Ahmad bin Abdullah").firstName, "Ahmad");
eq("split: Malay bin last name", splitFirstLast("Ahmad bin Abdullah").lastName, "Abdullah");
eq("split: Malay binti", splitFirstLast("Siti binti Rahman").lastName, "Rahman");
eq("split: Indian a/l", splitFirstLast("Raju a/l Muniandy").lastName, "Muniandy");
eq("split: single token is a first name", splitFirstLast("Madonna").firstName, "Madonna");
eq("split: single token has no last name", splitFirstLast("Madonna").lastName, null);
eq("split: empty", splitFirstLast("").firstName, null);

// --- company + title -----------------------------------------------------------

eq("company: bank acronym preserved", normalizeCompany("DBS BANK LTD"), "DBS Bank Ltd");
eq("company: Pte Ltd suffix", normalizeCompany("ACME HOLDINGS PTE LTD"), "Acme Holdings Pte Ltd");
eq("company: Sdn Bhd suffix", normalizeCompany("BERJAYA CORP SDN BHD"), "Berjaya Corp Sdn Bhd");
eq("company: Indonesian PT prefix", normalizeCompany("PT ASTRA INTERNATIONAL TBK"), "PT Astra International Tbk");
eq("company: internal capital kept", normalizeCompany("MCDONALD PTE LTD"), "McDonald Pte Ltd");
eq("company: mixed case left alone", normalizeCompany("CapitaLand Investment"), "CapitaLand Investment");
eq("company: trailing comma trimmed", normalizeCompany("ACME PTE LTD,"), "Acme Pte Ltd");
eq("company: empty", normalizeCompany(""), "");

eq("title: CEO acronym preserved", normalizeTitle("CHIEF EXECUTIVE OFFICER"), "Chief Executive Officer");
eq("title: standalone acronym", normalizeTitle("CEO"), "CEO");
eq("title: small words stay lowercase", normalizeTitle("HEAD OF PRIVATE BANKING"), "Head of Private Banking");
eq("title: acronym inside a phrase", normalizeTitle("MD, APAC SALES"), "MD, APAC Sales");
eq("title: mixed case left alone", normalizeTitle("Head of Wealth"), "Head of Wealth");

// --- email / url / linkedin / address ------------------------------------------

eq("email: card capitals lowered throughout", normalizeEmail("John.Tan@DBS.COM.SG"), "john.tan@dbs.com.sg");
eq("email: mailto stripped", normalizeEmail("mailto:a@b.com"), "a@b.com");
eq("email: internal spaces removed", normalizeEmail("a @ b.com"), "a@b.com");
eq("email: (at) form repaired", normalizeEmail("john(at)acme.com"), "john@acme.com");
eq("email: trailing punctuation dropped", normalizeEmail("a@b.com."), "a@b.com");
eq("email: no domain is null", normalizeEmail("john@"), null);
eq("email: no @ is null", normalizeEmail("john.acme.com"), null);
eq("email: empty is null", normalizeEmail(""), null);

eq("url: scheme added", normalizeUrl("www.acme.com.sg"), "https://www.acme.com.sg");
eq("url: existing scheme kept", normalizeUrl("http://acme.com"), "http://acme.com");
eq("url: host lowercased", normalizeUrl("WWW.ACME.COM"), "https://www.acme.com");
eq("url: path preserved", normalizeUrl("acme.com/team"), "https://acme.com/team");
eq("url: not a host is null", normalizeUrl("just some text"), null);
eq("url: mailto is not a website", normalizeUrl("mailto:a@b.com"), null);

eq("linkedin: full url normalised", normalizeLinkedIn("https://www.linkedin.com/in/johntan/"), "https://www.linkedin.com/in/johntan");
eq("linkedin: bare host form", normalizeLinkedIn("linkedin.com/in/johntan"), "https://www.linkedin.com/in/johntan");
eq("linkedin: bare handle", normalizeLinkedIn("@johntan"), "https://www.linkedin.com/in/johntan");
eq("linkedin: a non-LinkedIn url is rejected", normalizeLinkedIn("https://twitter.com/johntan"), null);
eq("linkedin: a LinkedIn home page is not a profile", normalizeLinkedIn("https://www.linkedin.com/feed"), null);

eq("address: newlines become one line", normalizeAddress("1 Raffles Place\n#20-01\nSingapore 048616"), "1 Raffles Place, #20-01, Singapore 048616");
eq("address: empty is null", normalizeAddress("   "), null);

// --- whole card ----------------------------------------------------------------

const card = normalizeCard({
  fullName: "TAN SRI DATO' LIM KOK THAY",
  nativeName: "林国泰",
  jobTitle: "CHAIRMAN & CEO",
  company: "GENTING BERHAD",
  phones: [
    { value: "03-2178 2288", label: "DID" },
    { value: "012-345 6789", label: "HP" },
    { value: "03-2161 5304", label: "F" },
  ],
  emails: ["KokThay@GENTING.COM"],
  websites: ["www.genting.com"],
  linkedin: "linkedin.com/in/limkokthay",
  address: "Wisma Genting, Jalan Sultan Ismail, Kuala Lumpur, Malaysia",
});

eq("card: honorific separated from the name", card.honorific, "Tan Sri Dato'");
eq("card: name cased and kept in order", card.fullName, "Lim Kok Thay");
eq("card: native name kept", card.nativeName, "林国泰");
eq("card: surname detected for the phone book", card.lastName, "Lim");
eq("card: title cased with the acronym intact", card.jobTitle, "Chairman & CEO");
eq("card: company cased", card.company, "Genting Berhad");
eq("card: office number from the Malaysian address", card.phoneOffice, "+60321782288");
eq("card: mobile number from the HP label", card.phoneMobile, "+60123456789");
eq("card: fax kept in the list but not promoted", card.phones.filter((p) => p.slot === "fax").length, 1);
eq("card: email normalised", card.emails, ["kokthay@genting.com"]);
eq("card: website normalised", card.website, "https://www.genting.com");
eq("card: linkedin normalised", card.linkedin, "https://www.linkedin.com/in/limkokthay");
eq("card: country detected", card.country, "MY");

const sparse = normalizeCard({ fullName: "JANE LOW" });
eq("card: missing fields are null, never guessed", sparse.company, null);
eq("card: no phones gives an empty list", sparse.phones.length, 0);
eq("card: no mobile is null", sparse.phoneMobile, null);
eq("card: empty raw card does not throw", normalizeCard({}).fullName, "");

// --- vCard ----------------------------------------------------------------------

// --- note with the scan date ----------------------------------------------------

eq("scan date: formatted unambiguously", formatScanDate("2026-09-25T04:30:00Z"), "25 Sep 2026");
eq("scan date: a Date works too", formatScanDate(new Date("2026-01-05T12:00:00Z")), "5 Jan 2026");
eq("scan date: missing is null", formatScanDate(null), null);
eq("scan date: junk is null", formatScanDate("not a date"), null);
eq("scan date: late-evening UTC is already the next day in Singapore", formatScanDate("2026-09-25T17:30:00Z"), "26 Sep 2026");

eq(
  "note: where we met, extra text and the scan date",
  buildCardNote({ eventNote: "SFF 2026", otherText: "introduced by Alan", scannedAt: "2026-09-25T04:30:00Z" }),
  "SFF 2026 — introduced by Alan — Card scanned 25 Sep 2026",
);
eq(
  "note: the date alone when nothing else was captured",
  buildCardNote({ scannedAt: "2026-09-25T04:30:00Z" }),
  "Card scanned 25 Sep 2026",
);
eq("note: nothing at all gives null", buildCardNote({}), null);
eq(
  "note: no date still records where we met",
  buildCardNote({ eventNote: "SFF 2026" }),
  "SFF 2026",
);

const vcf = toVCard(card, { note: "Met at SFF 2026", scannedAt: "2026-09-25T04:30:00Z" });
check("vcard: begins correctly", vcf.startsWith("BEGIN:VCARD\r\nVERSION:3.0"));
check("vcard: ends correctly", vcf.trimEnd().endsWith("END:VCARD"));
check("vcard: display name carries the honorific", vcf.includes("FN:Tan Sri Dato' Lim Kok Thay"));
check("vcard: structured name uses the detected surname", vcf.includes("N:Lim;Kok Thay;;Tan Sri Dato';"));
check("vcard: mobile typed as CELL", vcf.includes("TEL;TYPE=CELL:+60123456789"));
check("vcard: office typed as WORK", vcf.includes("TEL;TYPE=WORK,VOICE:+60321782288"));
check("vcard: fax typed as FAX", vcf.includes("TEL;TYPE=WORK,FAX:"));
check("vcard: organisation present", vcf.includes("ORG:Genting Berhad"));
check("vcard: note carries where we met and the scan date", vcf.includes("NOTE:Met at SFF 2026 — Card scanned 25 Sep 2026"));
check("vcard: uses CRLF line endings", vcf.includes("\r\n"));
check("vcard: a card with no phones still renders", toVCard(sparse).includes("FN:Jane Low"));
