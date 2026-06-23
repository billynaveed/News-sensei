import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageSquareWarning, ThumbsDown, Sparkles } from "lucide-react";

type Feedback = {
  id: string;
  reason: string | null;
  note: string | null;
  headline: string | null;
  category: string | null;
  region: string | null;
  founderNames: string[] | null;
  companyNames: string[] | null;
  createdAt: string;
};

type Insights = {
  total: number;
  byReason: { reason: string; count: number }[];
  recent: Feedback[];
};

const REASON_LABELS: Record<string, string> = {
  not_region: "Not in target region",
  public_company: "Public company",
  not_wealth_event: "Not a wealth event",
  not_uhnw: "Not UHNW / notable",
  duplicate: "Duplicate / old",
  other: "Other / just bad",
  unspecified: "Unspecified",
};

export default function FeedbackPage() {
  const { data, isLoading } = useQuery<Insights>({ queryKey: ["/api/feedback"] });
  const max = Math.max(1, ...(data?.byReason.map((r) => r.count) ?? [1]));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
        <div className="flex items-center gap-2">
          <MessageSquareWarning className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Feedback &amp; filter tuning</h1>
        </div>
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" />
          <span>
            Every <strong>👎 Bad lead</strong> you flag is recorded here and fed into the scanner's filter as a
            “reject things like this” example, so each scan gets sharper. The most recent {""}
            <strong>~15 per type</strong> are sent to the model.
          </span>
        </div>

        {isLoading ? (
          <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
        ) : !data || data.total === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No feedback yet. Hit <strong className="mx-1">👎 Bad lead</strong> on any card and it'll show here.
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <ThumbsDown className="h-4 w-4" />
              <span><strong className="text-foreground">{data.total}</strong> leads flagged as bad</span>
            </div>

            {/* reason breakdown */}
            <Card>
              <CardContent className="space-y-2 p-4">
                <div className="mb-1 text-sm font-medium">By reason</div>
                {data.byReason.map((r) => (
                  <div key={r.reason} className="flex items-center gap-3 text-sm">
                    <div className="w-44 shrink-0 truncate text-muted-foreground">{REASON_LABELS[r.reason] || r.reason}</div>
                    <div className="h-2 flex-1 rounded-full bg-muted">
                      <div className="h-2 rounded-full bg-amber-500" style={{ width: `${(r.count / max) * 100}%` }} />
                    </div>
                    <div className="w-8 text-right tabular-nums">{r.count}</div>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* recent */}
            <div className="text-sm font-medium">Recently flagged</div>
            <div className="space-y-2">
              {data.recent.map((f) => {
                const who = [...(f.founderNames ?? []), ...(f.companyNames ?? [])].filter(Boolean).join(", ");
                return (
                  <Card key={f.id}>
                    <CardContent className="flex items-start justify-between gap-3 p-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{f.headline || who || "(no headline)"}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="outline" size="sm" className="text-amber-600 dark:text-amber-400">
                            {REASON_LABELS[f.reason ?? "unspecified"] || f.reason}
                          </Badge>
                          {f.category && <span>{f.category}</span>}
                          {f.region && <span>· {f.region}</span>}
                          {f.note && <span className="italic">· “{f.note}”</span>}
                        </div>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {new Date(f.createdAt).toLocaleDateString()}
                      </span>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
