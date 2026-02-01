import type { FounderEnrichmentResult, CompanyEnrichmentResult } from './founder-enrichment';

/**
 * Formats founder enrichment results for Telegram display
 */
export function formatFounderEnrichment(result: FounderEnrichmentResult): string {
  const sections: string[] = [];

  sections.push(`👤 <b>Founder Research: ${result.founderName}</b>\n`);

  if (result.biography) {
    sections.push(`<b>📝 Biography:</b>\n${result.biography}\n`);
  }

  if (result.professionalBackground) {
    sections.push(`<b>💼 Professional Background:</b>\n${result.professionalBackground}\n`);
  }

  if (result.education) {
    sections.push(`<b>🎓 Education:</b>\n${result.education}\n`);
  }

  if (result.notableAchievements) {
    sections.push(`<b>🏆 Notable Achievements:</b>\n${result.notableAchievements}\n`);
  }

  if (result.linkedInUrl) {
    sections.push(`<b>🔗 LinkedIn:</b> ${result.linkedInUrl}\n`);
  }

  // Add confidence indicator
  const confidenceIcon = result.confidence === 'high' ? '🟢' :
                        result.confidence === 'medium' ? '🟡' : '🔴';
  sections.push(`<b>Confidence:</b> ${confidenceIcon} ${result.confidence.charAt(0).toUpperCase() + result.confidence.slice(1)}`);

  if (result.sources && result.sources.length > 0) {
    sections.push(`<b>Sources:</b> ${result.sources.join(', ')}`);
  }

  return sections.join('\n');
}

/**
 * Formats company enrichment results for Telegram display
 */
export function formatCompanyEnrichment(result: CompanyEnrichmentResult): string {
  const sections: string[] = [];

  sections.push(`🏢 <b>Company Research: ${result.companyName}</b>\n`);

  if (result.description) {
    sections.push(`<b>📝 Description:</b>\n${result.description}\n`);
  }

  if (result.industry) {
    sections.push(`<b>🏭 Industry:</b> ${result.industry}\n`);
  }

  if (result.headquarters) {
    sections.push(`<b>📍 Headquarters:</b> ${result.headquarters}\n`);
  }

  if (result.founded) {
    sections.push(`<b>📅 Founded:</b> ${result.founded}\n`);
  }

  if (result.businessModel) {
    sections.push(`<b>💼 Business Model:</b> ${result.businessModel}\n`);
  }

  // Add confidence indicator
  const confidenceIcon = result.confidence === 'high' ? '🟢' :
                        result.confidence === 'medium' ? '🟡' : '🔴';
  sections.push(`<b>Confidence:</b> ${confidenceIcon} ${result.confidence.charAt(0).toUpperCase() + result.confidence.slice(1)}`);

  return sections.join('\n');
}

/**
 * Formats saved lead data for Telegram display
 */
export function formatSavedLeadEnrichment(savedLead: any, leadData: any): string {
  const sections: string[] = [];

  sections.push(`📌 <b>Saved Lead Research</b>\n`);
  sections.push(`<b>Article:</b> ${leadData.headline}`);
  sections.push(`<b>Source:</b> ${leadData.sourceName}\n`);

  if (savedLead.founderName || leadData.founderNames?.[0]) {
    const founderName = savedLead.founderName || leadData.founderNames[0];
    sections.push(`👤 <b>${founderName}</b>\n`);

    if (savedLead.founderBio) {
      sections.push(`<b>📝 Biography:</b>\n${savedLead.founderBio}\n`);
    }

    if (savedLead.founderLinkedInUrl) {
      sections.push(`<b>🔗 LinkedIn:</b> ${savedLead.founderLinkedInUrl}\n`);
    }
  }

  if (savedLead.companyName || leadData.companyNames?.[0]) {
    const companyName = savedLead.companyName || leadData.companyNames[0];
    sections.push(`🏢 <b>${companyName}</b>\n`);

    if (savedLead.companyDescription) {
      sections.push(`<b>📝 Description:</b>\n${savedLead.companyDescription}\n`);
    }
  }

  if (savedLead.notes) {
    sections.push(`<b>📋 Notes:</b>\n${savedLead.notes}\n`);
  }

  sections.push(`<b>🔗 Article Link:</b> ${leadData.sourceUrl}`);

  return sections.join('\n');
}

/**
 * Splits long messages to fit Telegram's 4096 character limit
 */
export function splitLongMessage(text: string, maxLength = 4000): string[] {
  if (text.length <= maxLength) return [text];

  const parts: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > maxLength) {
      if (current) parts.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }

  if (current) parts.push(current);
  return parts;
}
