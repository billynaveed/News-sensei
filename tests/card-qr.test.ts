/**
 * QR payload parsing. The decoding step needs a browser canvas, so these
 * cover the parsing and classification, which is where the data comes from.
 */
import { check, eq } from "./harness";
import { classifyQr, parseMeCard, parseVCard } from "../client/src/lib/card-qr";
import { foldVCardLine } from "../server/card-normalize";

// --- classification ---------------------------------------------------------

eq("qr: a vCard payload is recognised", classifyQr("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:A B\r\nEND:VCARD").kind, "vcard");
eq("qr: MECARD is recognised", classifyQr("MECARD:N:Tan,Wei;;").kind, "mecard");
eq("qr: a LinkedIn link is recognised", classifyQr("https://www.linkedin.com/in/johntan").kind, "linkedin");
eq("qr: a bare linkedin host still counts", classifyQr("linkedin.com/in/johntan").kind, "linkedin");
eq("qr: another website is just a url", classifyQr("https://acme.com").kind, "url");
eq("qr: a tel payload", classifyQr("tel:+6591234567").kind, "tel");
eq("qr: tel strips its scheme", classifyQr("tel:+6591234567").raw, "+6591234567");
eq("qr: a mailto payload", classifyQr("mailto:a@b.com").raw, "a@b.com");
eq("qr: anything else is text", classifyQr("hello there").kind, "text");

// --- vCard parsing -----------------------------------------------------------

const vcard = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:Chearavanont;Dhanin;;Khun;",
  "FN:Khun Dhanin Chearavanont",
  "ORG:Charoen Pokphand Group;Strategy",
  "TITLE:Senior Chairman",
  "TEL;TYPE=CELL:+66812345678",
  "TEL;TYPE=WORK,VOICE:+6621234567",
  "TEL;TYPE=WORK,FAX:+6621234599",
  "EMAIL;TYPE=WORK:dhanin@cpgroup.co.th",
  "URL:https://www.cpgroup.co.th",
  "ADR;TYPE=WORK:;;313 Silom Road;Bangkok;;10500;Thailand",
  "NOTE:Met at the Bangkok summit",
  "END:VCARD",
].join("\r\n");

const v = parseVCard(vcard);
eq("vcard: display name", v.fullName, "Khun Dhanin Chearavanont");
eq("vcard: surname from the structured name", v.lastName, "Chearavanont");
eq("vcard: given name", v.firstName, "Dhanin");
eq("vcard: honorific from the prefix field", v.honorific, "Khun");
eq("vcard: company drops the department", v.company, "Charoen Pokphand Group");
eq("vcard: job title", v.jobTitle, "Senior Chairman");
eq("vcard: every phone is kept", v.phones?.length, 3);
eq("vcard: a CELL becomes a Mobile label", v.phones?.[0].label, "Mobile");
eq("vcard: a WORK VOICE becomes Work", v.phones?.[1].label, "Work");
eq("vcard: a FAX is labelled as one", v.phones?.[2].label, "Fax");
eq("vcard: email", v.emails, ["dhanin@cpgroup.co.th"]);
eq("vcard: website", v.website, "https://www.cpgroup.co.th");
check("vcard: address is flattened", (v.address ?? "").includes("Bangkok"));
eq("vcard: note", v.note, "Met at the Bangkok summit");

// Folded lines and escaped characters are the two things that break naive
// parsers. Unfolding strips the single leading space of a continuation, per
// RFC 6350, so the fold point itself must carry any real space.
const folded = ["BEGIN:VCARD", "VERSION:3.0", "FN:Somebody With A Very Long ", " Name Indeed", "ORG:Acme\\, Inc.", "END:VCARD"].join("\r\n");
const f = parseVCard(folded);
eq("vcard: a folded line is rejoined", f.fullName, "Somebody With A Very Long Name Indeed");
eq("vcard: an escaped comma is unescaped", f.company, "Acme, Inc.");

// The strongest check: what our own writer folds, our own reader must restore.
// No trailing space: the parser trims values, which is deliberate.
const longNote = ("Met at SFF 2026 — " + "a rather long note about the conversation ".repeat(3)).trim();
const roundTripped = parseVCard(
  ["BEGIN:VCARD", "VERSION:3.0", "FN:Jane Low", foldVCardLine(`NOTE:${longNote}`), "END:VCARD"].join("\r\n"),
);
eq("vcard: fold then parse is lossless", roundTripped.note, longNote);

const unicodeNote = "會面 — Café ☕ " + "x".repeat(80);
const unicodeRound = parseVCard(
  ["BEGIN:VCARD", "VERSION:3.0", "FN:Jane Low", foldVCardLine(`NOTE:${unicodeNote}`), "END:VCARD"].join("\r\n"),
);
eq("vcard: folding never splits a multi-byte character", unicodeRound.note, unicodeNote);

const minimal = parseVCard("BEGIN:VCARD\r\nN:Low;Jane;;;\r\nEND:VCARD");
eq("vcard: a name is built when FN is missing", minimal.fullName, "Jane Low");
eq("vcard: an empty payload does not throw", parseVCard("BEGIN:VCARD\r\nEND:VCARD").emails, []);

// --- MECARD -------------------------------------------------------------------

const m = parseMeCard("MECARD:N:Tan,Wei Ming;ORG:Acme Pte Ltd;TEL:+6591234567;EMAIL:wei@acme.sg;URL:https://acme.sg;;");
eq("mecard: name is reordered from Last,First", m.fullName, "Wei Ming Tan");
eq("mecard: surname", m.lastName, "Tan");
eq("mecard: company", m.company, "Acme Pte Ltd");
eq("mecard: phone", m.phones?.[0].value, "+6591234567");
eq("mecard: email", m.emails, ["wei@acme.sg"]);
eq("mecard: website", m.website, "https://acme.sg");
