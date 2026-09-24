import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, Send } from "lucide-react";

export type HealthStatus = "ok" | "warn" | "error";

export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  message: string;
  detail?: string;
}

export interface HealthResponse {
  overall: HealthStatus;
  checkedAt: string;
  checks: HealthCheck[];
  monitor: {
    lastOverall: HealthStatus | null;
    lastCheckedAt: string | null;
    lastNotifiedAt: string | null;
    lastNotifiedOverall: HealthStatus | null;
    lastDigestAt: string | null;
    running: boolean;
  };
}

/** Dot colours double as the legend: green healthy, amber degraded, red broken. */
const DOT_CLASS: Record<HealthStatus, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-red-500",
};

const TEXT_CLASS: Record<HealthStatus, string> = {
  ok: "text-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-red-600 dark:text-red-400",
};

const CARD_BORDER: Record<HealthStatus, string> = {
  ok: "",
  warn: "border-amber-500/50",
  error: "border-red-500/50",
};

/**
 * Every dependency the pipeline needs, in one card: database, LLM gateway,
 * scraper credits, web search, scan freshness, family worker and Telegram.
 * Replaces the old scraper/search-only "Integrations" card on /debug.
 */
export function HealthCard() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<HealthResponse>({
    queryKey: ["/api/health"],
    refetchInterval: 60_000,
  });

  const testAlert = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/health/test-alert");
      return (await res.json()) as { sent: boolean; overall: HealthStatus };
    },
    onSuccess: () => {
      toast({ title: "Test alert sent", description: "Check the configured Telegram chat." });
    },
    onError: (error: Error) => {
      toast({ title: "Test alert failed", description: error.message, variant: "destructive" });
    },
  });

  if (isLoading || !data) {
    return (
      <Card data-testid="health-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">System health</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </CardContent>
      </Card>
    );
  }

  const failing = data.checks.filter((c) => c.status !== "ok").length;

  return (
    <Card className={CARD_BORDER[data.overall]} data-testid="health-card">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">System health</CardTitle>
            <CardDescription>
              {failing === 0
                ? "All checks green."
                : `${failing} of ${data.checks.length} checks need attention.`}{" "}
              Checked {new Date(data.checkedAt).toLocaleTimeString()}.
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => testAlert.mutate()}
            disabled={testAlert.isPending}
            data-testid="button-health-test-alert"
          >
            {testAlert.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Send className="h-4 w-4 mr-2" />
            )}
            Send test alert
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {data.checks.map((check) => (
          <div key={check.id} className="flex items-start gap-2" data-testid={`health-check-${check.id}`}>
            <span
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[check.status]}`}
              aria-label={check.status}
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{check.label}</span>
                <span className={`${TEXT_CLASS[check.status]} break-words`}>{check.message}</span>
              </div>
              {check.detail && (
                <div className="text-xs text-muted-foreground break-words">{check.detail}</div>
              )}
            </div>
          </div>
        ))}
        {data.monitor.lastNotifiedAt && (
          <div className="pt-1 text-xs text-muted-foreground">
            Last alert sent {new Date(data.monitor.lastNotifiedAt).toLocaleString()}
            {data.monitor.lastNotifiedOverall ? ` (${data.monitor.lastNotifiedOverall})` : ""}.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default HealthCard;
