/**
 * Family research page helpers: candidate ranking and family-text extraction.
 * Both are pure, so they run without a database or network.
 */
import { check, eq } from "./harness";
import { extractFamilyText, rankPageCandidates, titleMatchesQuery } from "../server/family-pages";
import { stripHonorifics } from "../server/family-names";

// --- rankPageCandidates ------------------------------------------------------

eq(
  "rank: wikipedia family article outranks person article, profiles, then press",
  rankPageCandidates([
    "https://www.straitstimes.com/business/kwek-leng-beng-steps-down",
    "https://www.forbes.com/profile/kwek-leng-beng/",
    "https://en.wikipedia.org/wiki/Kwek_Leng_Beng",
    "https://en.wikipedia.org/wiki/Kwek_family",
  ], 4),
  [
    "https://en.wikipedia.org/wiki/Kwek_family",
    "https://en.wikipedia.org/wiki/Kwek_Leng_Beng",
    "https://www.forbes.com/profile/kwek-leng-beng/",
    "https://www.straitstimes.com/business/kwek-leng-beng-steps-down",
  ],
);

eq(
  "rank: social and directory hosts are excluded, duplicates collapse, limit applies",
  rankPageCandidates([
    "https://x.com/somebody/status/1",
    "https://www.linkedin.com/in/somebody",
    "https://en.wikipedia.org/wiki/Kwek_family",
    "https://en.wikipedia.org/wiki/Kwek_family",
    "https://www.loopnet.ca/commercial-real-estate-brokers/profile/x",
    "https://www.bloomberg.com/billionaires/profiles/kwek-leng-beng/",
  ], 1),
  ["https://en.wikipedia.org/wiki/Kwek_family"],
);

eq(
  "rank: wikipedia utility pages and non-http values are skipped",
  rankPageCandidates(["ftp://x", "", "https://en.wikipedia.org/wiki/Special:Search?q=kwek", "https://en.wikipedia.org/wiki/Category:Singaporean_families"]),
  [],
);

// --- extractFamilyText -------------------------------------------------------

const wikiHtml = `
<html><head><title>Dhanin Chearavanont - Wikipedia</title></head><body>
<div id="mw-content-text">
<table class="infobox vcard">
  <tr><th>Born</th><td>19 April 1939</td></tr>
  <tr><th>Occupation</th><td>Businessman</td></tr>
  <tr><th>Spouse</th><td>Tewee Chearavanont</td></tr>
  <tr><th>Children</th><td><div class="plainlist"><ul><li>Soopakij Chearavanont</li><li>Suphachai Chearavanont</li></ul></div></td></tr>
  <tr><th>Relatives</th><td>Jaran Chiaravanont (brother)<br>Sumet Jiaravanon (brother)</td></tr>
  <tr><th>Website</th><td>cpgroupglobal.com</td></tr>
</table>
<p>Dhanin Chearavanont is a Thai businessman and the senior chairman of Charoen Pokphand Group.[1]</p>
<h2>Early life</h2>
<p>He was born in Bangkok, the youngest son of Chia Ek Chor, who co-founded the company with his brother.</p>
<h2>Business career</h2>
<p>The group expanded into telecommunications during the 1990s with heavy investment in mobile networks and retail expansion across the region and beyond.</p>
<h2>Personal life</h2>
<p>He is married to Tewee and has five children, including Soopakij, who chairs the group, and Suphachai, who is CEO.</p>
<span class="mw-editsection">[edit]</span>
</div></body></html>`;

const extracted = extractFamilyText(wikiHtml);
check("extract: title comes from the page", extracted.title.startsWith("Dhanin Chearavanont"));
check("extract: infobox spouse row kept", extracted.text.includes("Spouse: Tewee Chearavanont"));
check("extract: infobox children list flattened with separators", /Children: Soopakij Chearavanont; Suphachai Chearavanont/.test(extracted.text));
check("extract: <br>-separated relatives kept as a list", /Relatives: Jaran Chiaravanont \(brother\); Sumet Jiaravanon \(brother\)/.test(extracted.text));
check("extract: irrelevant infobox rows dropped", !extracted.text.includes("cpgroupglobal.com"));
check("extract: family section headings kept", extracted.text.includes("## Personal life") && extracted.text.includes("## Early life"));
check("extract: business-only heading dropped", !extracted.text.includes("## Business career"));
check("extract: paragraph with family words kept", extracted.text.includes("youngest son of Chia Ek Chor"));
check("extract: business-only paragraph dropped", !extracted.text.includes("telecommunications during the 1990s"));
check("extract: citation markers stripped", !extracted.text.includes("[1]"));
check("extract: edit links stripped", !extracted.text.includes("[edit]"));

const capped = extractFamilyText(wikiHtml, 60);
check("extract: cap respected", capped.text.length <= 60, `length ${capped.text.length}`);

check("extract: empty page yields empty text", extractFamilyText("<html><body></body></html>").text === "");

// --- stripHonorifics ---------------------------------------------------------

eq("honorifics: Tan Sri stripped", stripHonorifics("Tan Sri Lim Kok Thay family"), "Lim Kok Thay family");
eq("honorifics: Dato' Sri stripped", stripHonorifics("Dato' Sri Vincent Tan"), "Vincent Tan");
eq("honorifics: Khun stripped", stripHonorifics("Khun Dhanin Chearavanont"), "Dhanin Chearavanont");
eq("honorifics: plain name untouched", stripHonorifics("Kwek Leng Beng"), "Kwek Leng Beng");

// --- titleMatchesQuery -------------------------------------------------------

check("wiki hit: surname in title accepted", titleMatchesQuery("Chearavanont family", "Chearavanont family Thailand"));
check("wiki hit: person article accepted for anchor query", titleMatchesQuery("Dhanin Chearavanont", "Dhanin Chearavanont"));
check("wiki hit: fuzzy unrelated article rejected", !titleMatchesQuery("Thai Chinese", "Tejapaibul family Thailand"));
check("wiki hit: company article rejected for a family query", !titleMatchesQuery("Central Pattana", "Tejapaibul family Thailand"));
check("wiki hit: diacritics ignored", titleMatchesQuery("Phạm Nhật Vượng", "Pham Nhat Vuong"));
