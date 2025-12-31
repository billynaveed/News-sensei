import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { 
  Activity, 
  FileText, 
  CheckCircle, 
  AlertTriangle, 
  Clock, 
  ChevronDown, 
  ChevronRight,
  Globe,
  AlertCircle,
  XCircle
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { ScanLog, SourceSearched, ArticleProcessed, ScrapingBeeDebugEntry, FetchMethod } from "@shared/schema";

function LogsTableSkeleton() {
  return (
    <div className="space-y-2">
      {[...Array(5)].map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

function formatDuration(ms: number | null | undefined): string {
  if (!ms) return "--";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const fetchMethodLabels: Record<string, string> = {
  rss: "RSS Feed",
  google_news: "Google News",
  scrapingbee: "ScrapingBee",
  fallback_rss: "RSS (fallback)",
};

const fetchMethodColors: Record<string, string> = {
  rss: "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20",
  google_news: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  scrapingbee: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20",
  fallback_rss: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
};

function LogRow({ log }: { log: ScanLog }) {
  const [isOpen, setIsOpen] = useState(false);
  const hasDetails = (log.sourcesSearched && log.sourcesSearched.length > 0) || 
                     (log.articlesProcessed && log.articlesProcessed.length > 0) ||
                     (log.errors && log.errors.length > 0) ||
                     (log.scrapingBeeDebug && log.scrapingBeeDebug.length > 0);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="border rounded-md bg-card">
        <CollapsibleTrigger asChild>
          <Button 
            variant="ghost" 
            className="w-full justify-start p-4 h-auto hover-elevate"
            data-testid={`button-expand-log-${log.id}`}
          >
            <div className="flex items-center gap-3 w-full flex-wrap">
              {hasDetails ? (
                isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />
              ) : (
                <div className="w-4" />
              )}
              <div className="flex items-center gap-2 min-w-[180px]">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium" data-testid={`text-scan-time-${log.id}`}>
                  {format(new Date(log.scannedAt), "MMM d, yyyy 'at' h:mm a")}
                </span>
              </div>
              <div className="flex items-center gap-4 flex-wrap flex-1">
                <div className="flex items-center gap-1.5">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-mono tabular-nums" data-testid={`text-articles-scanned-${log.id}`}>{log.articlesScanned}</span>
                  <span className="text-xs text-muted-foreground">scanned</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  <span className="text-sm font-mono tabular-nums" data-testid={`text-matches-found-${log.id}`}>{log.matchesFound}</span>
                  <span className="text-xs text-muted-foreground">matches</span>
                </div>
                <Badge variant={log.newLeads > 0 ? "default" : "secondary"} size="sm" data-testid={`badge-new-leads-${log.id}`}>
                  {log.newLeads} new
                </Badge>
                {log.duplicatesSkipped > 0 && (
                  <span className="text-xs text-muted-foreground" data-testid={`text-duplicates-${log.id}`}>
                    {log.duplicatesSkipped} duplicates
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {log.durationMs && (
                  <span className="text-xs text-muted-foreground font-mono" data-testid={`text-duration-${log.id}`}>
                    {formatDuration(log.durationMs)}
                  </span>
                )}
                <Badge 
                  variant="outline" 
                  className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20"
                  size="sm"
                  data-testid={`badge-status-${log.id}`}
                >
                  Complete
                </Badge>
              </div>
            </div>
          </Button>
        </CollapsibleTrigger>
        
        <CollapsibleContent>
          <div className="px-4 pb-4 space-y-4 border-t pt-4" data-testid={`section-log-details-${log.id}`}>
            {log.sourcesSearched && log.sourcesSearched.length > 0 && (
              <div data-testid={`section-sources-searched-${log.id}`}>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <Globe className="h-4 w-4 text-primary" />
                  Sources Searched ({log.sourcesSearched.length})
                </h4>
                <div className="flex flex-wrap gap-2">
                  {(log.sourcesSearched as SourceSearched[]).map((source, idx) => (
                    <Badge key={idx} variant="outline" size="sm" data-testid={`badge-source-${log.id}-${idx}`}>
                      {source.name}
                      <span className="ml-1.5 text-muted-foreground">
                        ({source.articlesFound} articles)
                      </span>
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {log.articlesProcessed && log.articlesProcessed.length > 0 && (
              <div data-testid={`section-articles-processed-${log.id}`}>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <FileText className="h-4 w-4 text-primary" />
                  Articles Processed ({log.articlesProcessed.length})
                </h4>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {(log.articlesProcessed as ArticleProcessed[]).map((article, idx) => (
                    <div 
                      key={idx} 
                      className="flex items-start gap-2 text-sm py-1 border-b last:border-0"
                      data-testid={`row-article-${log.id}-${idx}`}
                    >
                      {article.status === "success" ? (
                        <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
                      ) : article.status === "skipped" ? (
                        <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="truncate font-medium">{article.headline}</div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                          {article.fetchMethod && (
                            <Badge variant="outline" className={fetchMethodColors[article.fetchMethod] || "bg-muted"}>
                              {fetchMethodLabels[article.fetchMethod] || article.fetchMethod}
                            </Badge>
                          )}
                          <span>{article.source}</span>
                          <span>-</span>
                          <span>{article.region}</span>
                          {article.reason && (
                            <>
                              <span>-</span>
                              <span className="italic">{article.reason}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {log.errors && log.errors.length > 0 && (
              <div data-testid={`section-errors-${log.id}`}>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2 text-red-600 dark:text-red-400">
                  <XCircle className="h-4 w-4" />
                  Errors ({log.errors.length})
                </h4>
                <div className="space-y-1">
                  {log.errors.map((error, idx) => (
                    <div key={idx} className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 p-2 rounded" data-testid={`text-error-${log.id}-${idx}`}>
                      {error}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {log.scrapingBeeDebug && log.scrapingBeeDebug.length > 0 && (
              <div data-testid={`section-debug-${log.id}`}>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <Activity className="h-4 w-4 text-primary" />
                  API Debug Log ({log.scrapingBeeDebug.length} calls)
                </h4>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {(log.scrapingBeeDebug as ScrapingBeeDebugEntry[]).map((entry, idx) => (
                    <div 
                      key={idx} 
                      className="text-sm bg-muted/50 rounded-md p-3 space-y-2"
                      data-testid={`debug-entry-${log.id}-${idx}`}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge 
                          variant="outline" 
                          className={fetchMethodColors[entry.method] || "bg-muted"}
                        >
                          {fetchMethodLabels[entry.method] || entry.method}
                        </Badge>
                        <span className="font-medium">{entry.sourceName}</span>
                        <span className="text-xs text-muted-foreground ml-auto">
                          {format(new Date(entry.timestamp), "h:mm:ss a")}
                        </span>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <span className="text-muted-foreground">Request URL:</span>
                          <div className="font-mono truncate">{entry.request.url}</div>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Status:</span>
                          <div className={entry.response.status === 200 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
                            {entry.response.status} {entry.response.statusText}
                          </div>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Latency:</span>
                          <div className="font-mono">{formatDuration(entry.response.latencyMs)}</div>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Results:</span>
                          <div>{entry.response.extractedCount} extracted, {entry.response.matchedCount} matched</div>
                        </div>
                      </div>

                      {entry.fallbackReason && (
                        <div className="text-xs bg-amber-500/10 text-amber-600 dark:text-amber-400 p-2 rounded">
                          Fallback reason: {entry.fallbackReason}
                        </div>
                      )}

                      {entry.error && (
                        <div className="text-xs bg-red-500/10 text-red-600 dark:text-red-400 p-2 rounded">
                          Error: {entry.error}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!hasDetails && (
              <p className="text-sm text-muted-foreground" data-testid={`text-no-details-${log.id}`}>
                No detailed information available for this scan.
              </p>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export default function LogsPage() {
  const { data: logs, isLoading } = useQuery<ScanLog[]>({
    queryKey: ["/api/scan-logs"],
  });

  const totalScanned = logs?.reduce((sum, log) => sum + log.articlesScanned, 0) ?? 0;
  const totalMatches = logs?.reduce((sum, log) => sum + log.matchesFound, 0) ?? 0;
  const totalNewLeads = logs?.reduce((sum, log) => sum + log.newLeads, 0) ?? 0;

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto overflow-auto h-full">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Scan Logs</h1>
        <p className="text-muted-foreground">
          View the history of news article scans and their results.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1">Total Scanned</div>
                <div className="text-2xl font-bold font-mono tabular-nums" data-testid="text-total-scanned">{totalScanned}</div>
              </div>
              <div className="flex items-center justify-center w-10 h-10 rounded-md bg-primary/10 text-primary">
                <FileText className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1">Total Matches</div>
                <div className="text-2xl font-bold font-mono tabular-nums" data-testid="text-total-matches">{totalMatches}</div>
              </div>
              <div className="flex items-center justify-center w-10 h-10 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1">New Leads</div>
                <div className="text-2xl font-bold font-mono tabular-nums" data-testid="text-total-new-leads">{totalNewLeads}</div>
              </div>
              <div className="flex items-center justify-center w-10 h-10 rounded-md bg-green-500/10 text-green-600 dark:text-green-400">
                <CheckCircle className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Scan History</CardTitle>
          </div>
          <CardDescription>
            Click on a scan to see detailed information about sources searched and articles processed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LogsTableSkeleton />
          ) : logs && logs.length > 0 ? (
            <div className="space-y-2">
              {logs.map((log) => (
                <LogRow key={log.id} log={log} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-48 text-center">
              <Activity className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No scan history</h3>
              <p className="text-muted-foreground max-w-md">
                Start scanning for news articles to see your scan history here.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
