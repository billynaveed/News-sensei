import axios from "axios";
import OpenAI from "openai";
import { PDFExtract, PDFExtractOptions } from "pdf.js-extract";

const openai = process.env.AI_INTEGRATIONS_OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    })
  : null;

export interface ProspectusExtractedInfo {
  companyName: string;
  businessDescription: string;
  founders: string[];
  keyManagement: string[];
  filingDate?: Date;
  listingDate?: Date;
  ipoSize?: number; // In millions USD
}

/**
 * Downloads a PDF from a URL and returns the buffer
 */
async function downloadPdf(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    timeout: 60000, // 60 second timeout for large PDFs
  });

  return Buffer.from(response.data);
}

/**
 * Extracts text from a PDF buffer using pdf.js-extract
 */
async function extractTextFromPdf(pdfBuffer: Buffer): Promise<string> {
  const pdfExtract = new PDFExtract();
  const options: PDFExtractOptions = {};

  const data = await pdfExtract.extractBuffer(pdfBuffer, options);

  // Combine all text from all pages
  let fullText = "";
  for (const page of data.pages) {
    for (const item of page.content) {
      if (item.str) {
        fullText += item.str + " ";
      }
    }
    fullText += "\n";
  }

  return fullText.trim();
}

/**
 * Uses AI to extract structured information from prospectus text
 * Focuses on first 15,000 characters to stay within token limits
 */
async function extractInfoWithAI(prospectusText: string): Promise<ProspectusExtractedInfo> {
  if (!openai) {
    throw new Error("OpenAI API key not configured");
  }

  // Take first ~15,000 characters (roughly 3,750 tokens)
  // Focus on early sections which typically contain company overview and management info
  const textSample = prospectusText.slice(0, 15000);

  const prompt = `Extract structured information from this IPO prospectus excerpt.

Prospectus text:
${textSample}

Extract and return a JSON object with:
1. "companyName": The full legal company name
2. "businessDescription": A concise 1-2 sentence description of what the company does and its industry
3. "founders": Array of founder names (if mentioned)
4. "keyManagement": Array of key executive names (CEO, CFO, Chairman, etc.) with their titles
5. "filingDate": Filing date if mentioned (format: YYYY-MM-DD)
6. "listingDate": Expected listing date if mentioned (format: YYYY-MM-DD)
7. "ipoSize": IPO size in millions USD if mentioned (just the number)

Return only valid JSON, no markdown.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 1024,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No response from AI");
    }

    const extracted = JSON.parse(content);

    return {
      companyName: extracted.companyName || "Unknown",
      businessDescription: extracted.businessDescription || "No description available",
      founders: Array.isArray(extracted.founders) ? extracted.founders : [],
      keyManagement: Array.isArray(extracted.keyManagement) ? extracted.keyManagement : [],
      filingDate: extracted.filingDate ? new Date(extracted.filingDate) : undefined,
      listingDate: extracted.listingDate ? new Date(extracted.listingDate) : undefined,
      ipoSize: typeof extracted.ipoSize === "number" ? extracted.ipoSize : undefined,
    };
  } catch (error) {
    console.error("Error extracting info with AI:", error);
    throw new Error(`AI extraction failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

/**
 * Basic regex-based extraction as fallback if AI fails
 */
function extractInfoBasic(prospectusText: string): ProspectusExtractedInfo {
  // Extract first 5000 characters for basic parsing
  const textSample = prospectusText.slice(0, 5000);

  // Try to find company name (usually in first few lines)
  const companyNameMatch = textSample.match(/(?:Company|Issuer):\s*([^\n]+)/i);
  const companyName = companyNameMatch ? companyNameMatch[1].trim() : "Unknown";

  // Try to find business description
  const businessMatch = textSample.match(/(?:Business|Industry|Principal Activities?):\s*([^\n]+)/i);
  const businessDescription = businessMatch
    ? businessMatch[1].trim()
    : "No description available";

  return {
    companyName,
    businessDescription,
    founders: [],
    keyManagement: [],
  };
}

/**
 * Main function to parse a prospectus PDF and extract information
 * @param prospectusUrl URL to the prospectus PDF
 * @param useAI Whether to use AI for extraction (default: true)
 */
export async function parseProspectusPdf(
  prospectusUrl: string,
  useAI: boolean = true
): Promise<ProspectusExtractedInfo> {
  console.log(`Downloading prospectus from: ${prospectusUrl}`);

  try {
    // Download PDF
    const pdfBuffer = await downloadPdf(prospectusUrl);
    console.log(`PDF downloaded, size: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB`);

    // Extract text
    console.log("Extracting text from PDF...");
    const prospectusText = await extractTextFromPdf(pdfBuffer);
    console.log(`Extracted ${prospectusText.length} characters of text`);

    // Use AI extraction if enabled and available
    if (useAI && openai) {
      console.log("Using AI to extract structured information...");
      try {
        const extractedInfo = await extractInfoWithAI(prospectusText);
        console.log("AI extraction successful");
        return extractedInfo;
      } catch (aiError) {
        console.error("AI extraction failed, falling back to basic extraction:", aiError);
        return extractInfoBasic(prospectusText);
      }
    } else {
      console.log("Using basic extraction (AI disabled or not configured)");
      return extractInfoBasic(prospectusText);
    }
  } catch (error) {
    console.error("Error parsing prospectus PDF:", error);
    throw new Error(`Failed to parse prospectus: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

/**
 * Batch process multiple prospectus PDFs with rate limiting
 */
export async function batchParseProspectuses(
  prospectusUrls: string[],
  useAI: boolean = true,
  delayMs: number = 2000
): Promise<Map<string, ProspectusExtractedInfo | Error>> {
  const results = new Map<string, ProspectusExtractedInfo | Error>();

  for (const url of prospectusUrls) {
    try {
      const info = await parseProspectusPdf(url, useAI);
      results.set(url, info);
    } catch (error) {
      results.set(url, error as Error);
    }

    // Add delay between requests to avoid rate limiting
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return results;
}
