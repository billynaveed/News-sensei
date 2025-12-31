import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  ChevronDown, 
  ChevronRight, 
  AlertTriangle, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  Globe, 
  Rss, 
  RefreshCw,
  Copy,
  Check
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ScrapingBeeDebugEntry, ScanLog } from "@shared/schema";

interface DebugResponse {
  scanLog: ScanLog | null;
  debugEntries: ScrapingBeeDebugEntry[];
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

export default function DebugPage() {
  const { data, isLoading, refetch, isFetching } = useQuery<DebugResponse>({
    queryKey: ["/api/scan-debug/latest"],
  });

  const triggerScan = async () => {
    try {
      await apiRequest("POST", "/api/scan");
      await refetch();
    } catch (error) {
      console.error("Scan failed:", error);
    }
  };

  const debugEntries = data?.debugEntries || [];
  const scanLog = data?.scanLog;

  const errorCount = debugEntries.filter(e => e.error && e.response.status !== 200).length;
  const zeroExtractedCount = debugEntries.filter(e => e.response.extractedCount === 0 && e.method === "scrapingbee").length;
  const successCount = debugEntries.filter(e => e.response.matchedCount > 0).length;
  const fallbackCount = debugEntries.filter(e => e.method === "fallback_rss").length;

  if (isLoading) {
    return (
      <ScrollArea className="h-full">
        <div className="p-6 space-y-6 max-w-4xl mx-auto">
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
      <div className="p-6 space-y-6 max-w-4xl mx-auto">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold" data-testid="debug-page-title">API Debug</h1>
            <p className="text-muted-foreground text-sm">
              Step-by-step visibility into ScrapingBee API calls
            </p>
          </div>
          <Button onClick={triggerScan} disabled={isFetching} data-testid="button-trigger-scan-debug">
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
            Run New Scan
          </Button>
        </div>

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
                No debug data available yet. Run a scan to see detailed API call information.
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
      </div>
    </ScrollArea>
  );
}
