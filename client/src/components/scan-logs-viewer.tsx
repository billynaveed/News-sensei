import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";

interface ScanLogEvent {
  timestamp: number;
  type: "info" | "success" | "warning" | "error";
  message: string;
  details?: any;
}

interface ScanProgress {
  status: "scanning" | "processing" | "complete" | "error";
  currentSource?: string;
  articlesFound?: number;
  articlesProcessed?: number;
  totalArticles?: number;
  message?: string;
}

interface ScanLogsViewerProps {
  scanId: string | null;
  onComplete?: () => void;
}

export function ScanLogsViewer({ scanId, onComplete }: ScanLogsViewerProps) {
  const [logs, setLogs] = useState<ScanLogEvent[]>([]);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!scanId) {
      setLogs([]);
      setProgress(null);
      setIsConnected(false);
      return;
    }

    // Connect to SSE endpoint
    const eventSource = new EventSource(`/api/scan-logs/${scanId}/stream`);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setIsConnected(true);
    };

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case "connected":
          setIsConnected(true);
          break;

        case "log":
          setLogs((prev) => [...prev, data.log]);
          // Auto-scroll to bottom
          setTimeout(() => {
            if (scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
          }, 10);
          break;

        case "progress":
          setProgress(data.progress);
          break;

        case "complete":
          setProgress(data.progress);
          setIsConnected(false);
          if (onComplete) {
            onComplete();
          }
          break;
      }
    };

    eventSource.onerror = () => {
      setIsConnected(false);
      eventSource.close();
    };

    // Cleanup on unmount
    return () => {
      eventSource.close();
    };
  }, [scanId, onComplete]);

  if (!scanId) {
    return null;
  }

  const getLogTypeColor = (type: string) => {
    switch (type) {
      case "success":
        return "text-green-600 dark:text-green-400";
      case "error":
        return "text-red-600 dark:text-red-400";
      case "warning":
        return "text-yellow-600 dark:text-yellow-400";
      default:
        return "text-gray-700 dark:text-gray-300";
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "scanning":
        return <Badge variant="default" className="bg-blue-500">Scanning</Badge>;
      case "processing":
        return <Badge variant="default" className="bg-purple-500">Processing</Badge>;
      case "complete":
        return <Badge variant="default" className="bg-green-500">Complete</Badge>;
      case "error":
        return <Badge variant="destructive">Error</Badge>;
      default:
        return null;
    }
  };

  const progressPercent = progress?.totalArticles
    ? Math.round(((progress.articlesProcessed || 0) / progress.totalArticles) * 100)
    : 0;

  return (
    <Card className="p-4 mt-4">
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">Scan Activity Log</h3>
            {progress?.status && getStatusBadge(progress.status)}
            {isConnected && (
              <div className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                </span>
                Live
              </div>
            )}
          </div>
          {progress?.totalArticles && (
            <span className="text-sm text-muted-foreground">
              {progress.articlesProcessed || 0} / {progress.totalArticles} articles
            </span>
          )}
        </div>

        {/* Progress Bar */}
        {progress?.status && ["scanning", "processing"].includes(progress.status) && (
          <div className="space-y-1">
            <Progress value={progressPercent} className="h-2" />
            {progress.message && (
              <p className="text-xs text-muted-foreground">{progress.message}</p>
            )}
          </div>
        )}

        {/* Logs */}
        <ScrollArea className="h-[400px] w-full rounded-md border bg-muted/30 p-3">
          <div ref={scrollRef} className="space-y-1 font-mono text-xs">
            {logs.length === 0 && (
              <p className="text-muted-foreground italic">Waiting for scan to start...</p>
            )}
            {logs.map((log, index) => (
              <div key={index} className={`${getLogTypeColor(log.type)} leading-relaxed`}>
                <span className="text-muted-foreground">
                  [{new Date(log.timestamp).toLocaleTimeString()}]
                </span>{" "}
                {log.message}
                {log.details && (
                  <div className="ml-4 text-muted-foreground/80 mt-0.5">
                    {typeof log.details === "string"
                      ? log.details
                      : JSON.stringify(log.details, null, 2)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>

        {/* Summary */}
        {progress?.status === "complete" && (
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span>✓ Scan completed successfully</span>
          </div>
        )}
        {progress?.status === "error" && (
          <div className="flex items-center gap-4 text-sm text-red-600 dark:text-red-400">
            <span>✗ Scan failed</span>
          </div>
        )}
      </div>
    </Card>
  );
}
