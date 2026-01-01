import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { 
  ChevronDown, 
  ChevronRight, 
  AlertTriangle, 
  CheckCircle2, 
  XCircle,
  AlertCircle,
  Clock, 
  Globe, 
  Rss, 
  RefreshCw,
  Copy,
  Check,
  Filter,
  FileText,
  Search
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ScrapingBeeDebugEntry, ScanLog, ArticleProcessed, SourceSearched } from "@shared/schema";

interface DebugResponse {
  scanLog: ScanLog | null;
  debugEntries: ScrapingBeeDebugEntry[];
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

const statusColors: Record<string, string> = {
  success: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
  skipped: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  error: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
};

function ArticleDecisionRow({ article, index }: { article: ArticleProcessed; index: number }) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const StatusIcon = article.status === "success" ? CheckCircle2 : 
                     article.status === "skipped" ? AlertCircle : XCircle;
  
  return (
    <div className="border rounded-md bg-card">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full text-left p-3 flex items-start gap-3 hover-elevate rounded-md"
        data-testid={`article-decision-${index}`}
      >
        <div className="flex-shrink-0 mt-0.5">
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <StatusIcon className={`h-4 w-4 flex-shrink-0 mt-0.5 ${
          article.status === "success" ? "text-green-600 dark:text-green-400" :
          article.status === "skipped" ? "text-amber-600 dark:text-amber-400" :
          "text-red-600 dark:text-red-400"
        }`} />
        <div className="flex-1 min-w-0 space-y-1">
          <p className="text-sm font-medium leading-snug line-clamp-2">{article.headline}</p>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={statusColors[article.status]}>
              {article.status === "success" ? "Accepted" : article.status === "skipped" ? "Rejected" : "Error"}
            </Badge>
            {article.fetchMethod && (
              <Badge variant="outline" className={fetchMethodColors[article.fetchMethod]}>
                {fetchMethodLabels[article.fetchMethod] || article.fetchMethod}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">{article.source}</span>
          </div>
        </div>
      </button>
      {isExpanded && (
        <div className="px-10 pb-3 space-y-2 border-t pt-3">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-muted-foreground">Source:</span>{" "}
              <span className="font-medium">{article.source}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Region:</span>{" "}
              <span className="font-medium">{article.region}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Status:</span>{" "}
              <span className="font-medium capitalize">{article.status}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Method:</span>{" "}
              <span className="font-medium">{article.fetchMethod ? fetchMethodLabels[article.fetchMethod] : "Unknown"}</span>
            </div>
          </div>
          {article.reason && (
            <div className="mt-2 p-2 rounded bg-muted/50">
              <span className="text-xs font-medium text-muted-foreground">Decision Reason:</span>
              <p className="text-sm mt-1">{article.reason}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SourceSearchedCard({ source }: { source: SourceSearched }) {
  return (
    <div className="flex items-center justify-between p-3 border rounded-md bg-card">
      <div className="flex items-center gap-3">
        <Globe className="h-4 w-4 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">{source.name}</p>
          <Badge variant="outline" className="mt-1">
            {source.tier.replace("tier", "Tier ")}
          </Badge>
        </div>
      </div>
      <div className="text-right">
        <p className="text-2xl font-bold tabular-nums">{source.articlesFound}</p>
        <p className="text-xs text-muted-foreground">articles</p>
      </div>
    </div>
  );
}

function DebugEntryCard({ entry, index }: { entry: ScrapingBeeDebugEntry; index: number }) {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const hasError = !!entry.error;
  const isSuccess = entry.response.matchedCount > 0;
  const isFallback = entry.method === "fallback_rss";
  const isZeroExtracted = entry.response.extractedCount === 0 && !isFallback;

  const getStatusIcon = () => {
    if (hasError && entry.response.status !== 200) {
      return <XCircle className="h-4 w-4 text-red-500" />;
    }
    if (isZeroExtracted) {
      return <AlertTriangle className="h-4 w-4 text-amber-500" />;
    }
    if (isSuccess) {
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
    }
    return <AlertTriangle className="h-4 w-4 text-amber-500" />;
  };

  const getStatusBadge = () => {
    if (entry.response.status >= 400) {
      return <Badge variant="destructive">HTTP {entry.response.status}</Badge>;
    }
    if (isZeroExtracted) {
      return <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 dark:text-amber-400">No Articles</Badge>;
    }
    if (isSuccess) {
      return <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">Success</Badge>;
    }
    return <Badge variant="secondary">No Matches</Badge>;
  };

  const getMethodBadge = () => {
    if (entry.method === "scrapingbee") {
      return <Badge variant="outline" className="gap-1"><Globe className="h-3 w-3" />ScrapingBee</Badge>;
    }
    return <Badge variant="outline" className="gap-1"><Rss className="h-3 w-3" />RSS Fallback</Badge>;
  };

  const copyRequest = async () => {
    const text = JSON.stringify({
      url: entry.request.url,
      render_js: entry.request.renderJs,
      extract_rules: entry.request.extractRules,
    }, null, 2);
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card className={`${hasError && entry.response.status !== 200 ? 'border-red-500/50' : isZeroExtracted ? 'border-amber-500/50' : ''}`}>
        <CollapsibleTrigger className="w-full" data-testid={`debug-entry-toggle-${index}`}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                {getStatusIcon()}
                <span className="font-medium truncate" data-testid={`debug-source-name-${index}`}>{entry.sourceName}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {getMethodBadge()}
                {getStatusBadge()}
              </div>
            </div>
            <div className="flex items-center gap-4 text-xs text-muted-foreground ml-8 flex-wrap">
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {entry.response.latencyMs}ms
              </span>
              <span>Extracted: {entry.response.extractedCount}</span>
              <span>Matched: {entry.response.matchedCount}</span>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 space-y-4">
            {entry.fallbackReason && (
              <div className="text-sm bg-amber-500/10 text-amber-700 dark:text-amber-300 p-2 rounded-md">
                Fallback reason: {entry.fallbackReason}
              </div>
            )}
            
            {entry.error && (
              <div className="text-sm bg-red-500/10 text-red-700 dark:text-red-300 p-2 rounded-md" data-testid={`debug-error-${index}`}>
                Error: {entry.error}
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">Request Parameters</h4>
                <Button variant="ghost" size="sm" onClick={copyRequest} data-testid={`debug-copy-request-${index}`}>
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
                </Button>
              </div>
              <div className="bg-muted p-3 rounded-md text-xs font-mono overflow-x-auto">
                <div><span className="text-muted-foreground">URL:</span> {entry.request.url}</div>
                <div><span className="text-muted-foreground">Render JS:</span> {entry.request.renderJs ? "true" : "false"}</div>
                <div className="mt-1">
                  <span className="text-muted-foreground">Extract Rules:</span>
                  <pre className="mt-1 whitespace-pre-wrap break-all">{entry.request.extractRules}</pre>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-medium">Response</h4>
              <div className="bg-muted p-3 rounded-md text-xs font-mono">
                <div className="flex gap-4 flex-wrap mb-2">
                  <span><span className="text-muted-foreground">Status:</span> {entry.response.status} {entry.response.statusText}</span>
                  <span><span className="text-muted-foreground">Latency:</span> {entry.response.latencyMs}ms</span>
                </div>
                <div className="text-muted-foreground mb-1">Raw Response (first 3KB):</div>
                <ScrollArea className="h-40">
                  <pre className="whitespace-pre-wrap break-all text-xs" data-testid={`debug-response-${index}`}>
                    {entry.response.rawResponseSnippet || "(empty response)"}
                  </pre>
                </ScrollArea>
              </div>
            </div>

            <div className="text-xs text-muted-foreground">
              Timestamp: {new Date(entry.timestamp).toLocaleString()}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function ScanLogCard({ log }: { log: ScanLog }) {
  const [isOpen, setIsOpen] = useState(false);
  const articlesProcessed = log.articlesProcessed || [];
  const sourcesSearched = log.sourcesSearched || [];
  
  const acceptedCount = articlesProcessed.filter(a => a.status === "success").length;
  const rejectedCount = articlesProcessed.filter(a => a.status === "skipped").length;
  const errorCount = articlesProcessed.filter(a => a.status === "error").length;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="border rounded-md bg-card">
      <CollapsibleTrigger asChild>
        <Button 
          variant="ghost" 
          className="w-full justify-start p-4 h-auto hover-elevate"
          data-testid={`button-expand-log-${log.id}`}
        >
          <div className="flex items-center gap-3 w-full flex-wrap">
            {isOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <div className="flex items-center gap-2 min-w-[180px]">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">
                {format(new Date(log.scannedAt), "MMM d, yyyy 'at' h:mm a")}
              </span>
            </div>
            <div className="flex items-center gap-4 flex-wrap flex-1">
              <div className="flex items-center gap-1.5">
                <Search className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-mono tabular-nums">{sourcesSearched.length}</span>
                <span className="text-xs text-muted-foreground">sources</span>
              </div>
              <Badge variant="outline" className={statusColors.success}>
                {acceptedCount} accepted
              </Badge>
              <Badge variant="outline" className={statusColors.skipped}>
                {rejectedCount} rejected
              </Badge>
              {errorCount > 0 && (
                <Badge variant="outline" className={statusColors.error}>
                  {errorCount} errors
                </Badge>
              )}
            </div>
            <span className="text-xs text-muted-foreground font-mono">
              {log.durationMs ? `${(log.durationMs / 1000).toFixed(1)}s` : "--"}
            </span>
          </div>
        </Button>
      </CollapsibleTrigger>
      
      <CollapsibleContent>
        <div className="px-4 pb-4 border-t pt-4">
          <Tabs defaultValue="decisions" className="w-full">
            <TabsList className="mb-4">
              <TabsTrigger value="decisions" data-testid="tab-decisions">
                <Filter className="h-4 w-4 mr-2" />
                Decisions ({articlesProcessed.length})
              </TabsTrigger>
              <TabsTrigger value="sources" data-testid="tab-sources">
                <Globe className="h-4 w-4 mr-2" />
                Sources ({sourcesSearched.length})
              </TabsTrigger>
              {log.errors && log.errors.length > 0 && (
                <TabsTrigger value="errors" data-testid="tab-errors">
                  <XCircle className="h-4 w-4 mr-2" />
                  Errors ({log.errors.length})
                </TabsTrigger>
              )}
            </TabsList>
            
            <TabsContent value="decisions">
              <div className="space-y-4">
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                    <span className="text-sm">Accepted: <strong>{acceptedCount}</strong></span>
                  </div>
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                    <span className="text-sm">Rejected: <strong>{rejectedCount}</strong></span>
                  </div>
                  <div className="flex items-center gap-2">
                    <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                    <span className="text-sm">Errors: <strong>{errorCount}</strong></span>
                  </div>
                </div>
                
                {articlesProcessed.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No articles processed in this scan.</p>
                ) : (
                  <ScrollArea className="h-[400px] pr-4">
                    <div className="space-y-2">
                      {articlesProcessed.map((article, index) => (
                        <ArticleDecisionRow key={index} article={article} index={index} />
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </div>
            </TabsContent>
            
            <TabsContent value="sources">
              {sourcesSearched.length === 0 ? (
                <p className="text-muted-foreground text-sm">No source information available.</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {sourcesSearched.map((source, index) => (
                    <SourceSearchedCard key={index} source={source} />
                  ))}
                </div>
              )}
            </TabsContent>
            
            {log.errors && log.errors.length > 0 && (
              <TabsContent value="errors">
                <div className="space-y-2">
                  {log.errors.map((error, index) => (
                    <div key={index} className="p-3 rounded-md bg-red-500/10 border border-red-500/20">
                      <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                    </div>
                  ))}
                </div>
              </TabsContent>
            )}
          </Tabs>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function DebugPage() {
  const { data, isLoading, refetch, isFetching } = useQuery<DebugResponse>({
    queryKey: ["/api/scan-debug/latest"],
  });

  const { data: allLogs, isLoading: logsLoading } = useQuery<ScanLog[]>({
    queryKey: ["/api/scan-logs"],
  });

  const triggerScan = async () => {
    try {
      await apiRequest("POST", "/api/scan");
      await refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/scan-logs"] });
    } catch (error) {
      console.error("Scan failed:", error);
    }
  };

  const debugEntries = data?.debugEntries || [];
  const scanLog = data?.scanLog;
  const sortedLogs = allLogs?.slice().sort((a, b) => 
    new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime()
  ) || [];

  const errorCount = debugEntries.filter(e => e.error && e.response.status !== 200).length;
  const zeroExtractedCount = debugEntries.filter(e => e.response.extractedCount === 0 && e.method === "scrapingbee").length;
  const successCount = debugEntries.filter(e => e.response.matchedCount > 0).length;
  const fallbackCount = debugEntries.filter(e => e.method === "fallback_rss").length;

  if (isLoading || logsLoading) {
    return (
      <ScrollArea className="h-full">
        <div className="p-6 space-y-6 max-w-5xl mx-auto">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6 max-w-5xl mx-auto">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold" data-testid="debug-page-title">Debug Console</h1>
            <p className="text-muted-foreground text-sm">
              Inspect scan decisions, article filtering, and API calls
            </p>
          </div>
          <Button onClick={triggerScan} disabled={isFetching} data-testid="button-trigger-scan-debug">
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
            Run New Scan
          </Button>
        </div>

        <Tabs defaultValue="decisions" className="w-full">
          <TabsList>
            <TabsTrigger value="decisions">
              <Filter className="h-4 w-4 mr-2" />
              Article Decisions
            </TabsTrigger>
            <TabsTrigger value="api">
              <Globe className="h-4 w-4 mr-2" />
              API Calls
            </TabsTrigger>
          </TabsList>

          <TabsContent value="decisions" className="mt-6 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  Scan History
                </CardTitle>
                <CardDescription>
                  Click on a scan to see which articles were accepted or rejected and why
                </CardDescription>
              </CardHeader>
              <CardContent>
                {sortedLogs.length === 0 ? (
                  <div className="text-center py-12">
                    <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <h3 className="text-lg font-semibold mb-2">No scan data yet</h3>
                    <p className="text-muted-foreground mb-4">
                      Run a scan from the Dashboard to see debug information here.
                    </p>
                    <Button onClick={triggerScan} disabled={isFetching}>
                      <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
                      Run First Scan
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {sortedLogs.map((log) => (
                      <ScanLogCard key={log.id} log={log} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="api" className="mt-6 space-y-4">
            {scanLog && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Last Scan Summary</CardTitle>
                  <CardDescription>
                    {new Date(scanLog.scannedAt).toLocaleString()} - Duration: {scanLog.durationMs}ms
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-4 flex-wrap text-sm">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-emerald-500"></div>
                      <span>Success: {successCount}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-amber-500"></div>
                      <span>Zero Extracted: {zeroExtractedCount}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-blue-500"></div>
                      <span>RSS Fallback: {fallbackCount}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-red-500"></div>
                      <span>Errors: {errorCount}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {debugEntries.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="text-muted-foreground mb-4">
                    No API debug data available yet. Run a scan to see detailed API call information.
                  </p>
                  <Button onClick={triggerScan} disabled={isFetching} data-testid="button-first-scan">
                    <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
                    Run First Scan
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                <h2 className="text-lg font-semibold">Per-Source API Calls ({debugEntries.length})</h2>
                {debugEntries.map((entry, index) => (
                  <DebugEntryCard key={`${entry.sourceId}-${entry.timestamp}`} entry={entry} index={index} />
                ))}
              </div>
            )}

            {zeroExtractedCount > 0 && (
              <Card className="border-amber-500/50">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                    Possible Issues Detected
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm space-y-2">
                  <p>
                    <strong>{zeroExtractedCount}</strong> source(s) returned zero articles from ScrapingBee. This could be due to:
                  </p>
                  <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                    <li><strong>JavaScript rendering required</strong> - Some sites load content via JS. Try enabling render_js=true.</li>
                    <li><strong>CSS selectors don't match</strong> - The generic article selectors may not work for this site's structure.</li>
                    <li><strong>Rate limiting / blocking</strong> - The site may be blocking automated requests.</li>
                    <li><strong>No recent articles</strong> - The site may not have matching content today.</li>
                  </ul>
                  <p className="text-muted-foreground">
                    Click on each entry above to see the raw response and diagnose the issue.
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </ScrollArea>
  );
}
