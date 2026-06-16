// Cheap keyword pre-filter (no API call): only send articles to the AI pipeline
// if they contain at least one business-relevant keyword. Prevents sports,
// politics, weather etc. from burning API tokens. Kept dependency-free so it is
// cheap to unit-test and not rebuilt per article.
const PREFILTER_KEYWORDS = [
  'ipo', 'listing', 'funding', 'series a', 'series b', 'series c', 'series d',
  'acquisition', 'merger', 'acquire', 'buyout', 'takeover', 'stake', 'divestiture',
  'valuation', 'unicorn', 'billion', 'million', 'investment', 'investor', 'venture',
  'private equity', 'family office', 'wealth', 'high net worth', 'hnw', 'uhnw',
  'founder', 'entrepreneur', 'startup', 'fintech', 'proptech', 'biotech',
  'exit', 'spac', 'prospectus', 'debut', 'bourse', 'stock exchange',
  'fund', 'capital', 'raise', 'raised', 'backed', 'bankable',
  'sgx', 'hkex', 'idx', 'pse', 'catalist', 'mainboard', 'gem board',
  'real estate', 'property', 'conglomerate', 'tycoon', 'magnate', 'mogul',
  'succession', 'inheritance', 'trust', 'endowment', 'philanthropy',
  'private bank', 'asset management', 'hedge fund',
  'expansion', 'headquarter', 'relocat', 'launch',
  'revenue', 'profit', 'earnings', 'growth', 'deal', 'partnership',
];

/** True if the article's headline+content contains any business-relevant keyword. */
export function matchesBusinessPrefilter(article: { headline: string; content: string }): boolean {
  const articleText = `${article.headline} ${article.content}`.toLowerCase();
  return PREFILTER_KEYWORDS.some(kw => articleText.includes(kw));
}
