import type { FetchMethod } from "@shared/schema";

interface FetchMethodConfig {
  icon: string;
  label: string;
  color: string;
}

const FETCH_METHOD_CONFIG: Record<FetchMethod, FetchMethodConfig> = {
  rss: {
    icon: "\u{1F4E1}",
    label: "RSS",
    color: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 border-blue-200 dark:border-blue-800",
  },
  google_news: {
    icon: "\u{1F50D}",
    label: "Google News",
    color: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300 border-green-200 dark:border-green-800",
  },
  scrapingbee: {
    icon: "\u{1F41D}",
    label: "ScrapingBee",
    color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800",
  },
  scrapingbee_premium: {
    icon: "\u2B50",
    label: "Premium",
    color: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300 border-purple-200 dark:border-purple-800",
  },
};

interface FetchMethodBadgeProps {
  method: FetchMethod;
  className?: string;
}

/**
 * Displays the fetch method used to discover an article.
 * Shows an icon and label with color-coded background matching the method type.
 *
 * @example
 * <FetchMethodBadge method="rss" />
 * <FetchMethodBadge method="scrapingbee_premium" className="ml-2" />
 */
export function FetchMethodBadge({ method, className = "" }: FetchMethodBadgeProps) {
  const config = FETCH_METHOD_CONFIG[method];

  if (!config) {
    return null;
  }

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-md border whitespace-nowrap ${config.color} ${className}`}
    >
      <span aria-hidden="true">{config.icon}</span>
      <span>{config.label}</span>
    </span>
  );
}
