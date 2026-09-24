import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ChevronDown, ChevronRight, ThumbsUp, ThumbsDown, RefreshCw, Trash2, GraduationCap } from "lucide-react";

type Sample = { headline: string; source: string; url?: string; reason: string; scannedAt: string };
type Funnel = {
  scans: number;
  articles: number;
  stages: Record<string, { count: number; reasons: Record<string, { count: number; samples: Sample[] }> }>;
};
type Example = {
  id: string; url: string; headline: string; expected: "pass" | "reject"; note: string | null;
  lastResult: "pass" | "reject" | "error" | null; lastReason: string | null; lastRunAt: string | null; createdAt: string;
};
type ExamplesResponse = { examples: Example[]; summary: { total: number; passing: number; failing: number; untested: number; lastRunAt: string | null } };

const STAGE_ORDER = ["S0 Pre-filter", "Dedup", "S1", "S1B", "S2", "S3", "S4A", "S4B", "S5", "S6", "S6B", "Lead created", "Error", "Other"];
const STAGE_HELP: Record<string, string> = {
  "S0 Pre-filter": "No business keywords in headline/snippet (free check)",
  Dedup: "URL already scanned, or story already covered",
  S1: "Interest filter — is this a wealth event in a target region? (sees only headline + snippet)",
  S1B: "Geography rescue — HQ verified after an S1 geography reject",
  S2: "No subject company identified",
  S3: "Subject company is publicly listed",
  S4A: "Already have a lead about this company this week",
  S4B: "Duplicate of a saved lead",
  S6: "Deep analysis rejected (SEA guard / not relevant)",
  S6B: "Founder geography check",
};

/**
 * The learning loop's front door: why articles were rejected, and a way to say
 * "this should have passed" (or "should have been rejected") — which turns the
 * article into a reference example that feeds the prompts and the nightly run.
 */
export function RejectionFunnel() {
  const { toast } = useToast();
  const [scans, setScans] = useState(12);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const { data, isLoading, refetch, isFetching } = useQuery<Funnel>({ queryKey: [`/api/pipeline/funnel?scans=${scans}`] });
  const { data: ex } = useQuery<ExamplesResponse>({ queryKey: ["/api/pipeline/examples"] });

  const teach = useMutation({
    mutationFn: async (input: { url: string; headline: string; expected: "pass" | "reject"; note?: string }) => {
      const res = await apiRequest("POST", "/api/pipeline/examples", input);
      return res.json();
    },
    onSuccess: (_d, v) => {
      queryClient.invalidateQueries({ queryKey: ["/api/pipeline/examples"] });
      toast({ title: v.expected === "pass" ? "Taught: this should pass" : "Taught: this should be rejected", description: "Added to the reference examples. It shapes the next scan's prompt and is re-checked nightly." });
    },
    onError: () => toast({ title: "Could not save example", variant: "destructive" }),
  });
  const rerun = useMutation({
    mutationFn: async (url: string) => (await apiRequest("POST", "/api/leads/ingest-url", { url })).json(),
    onSuccess: (r: any) => {
      toast({ title: r?.outcome?.status === "success" ? "Re-run: lead created" : "Re-run: still rejected", description: r?.outcome?.reason?.slice(0, 200) });
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
    },
    onError: (e: any) => toast({ title: "Re-run failed", description: String(e?.message || e).slice(0, 200), variant: "destructive" }),
  });
  const runAll = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/pipeline/examples/run", {})).json(),
    onSuccess: (r: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/pipeline/examples"] });
      toast({ title: `Re-checked ${r.ran} examples`, description: `${r.passing} passing · ${r.failing} failing` });
    },
    onError: (e: any) => toast({ title: "Run failed", description: String(e?.message || e).slice(0, 200), variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => (await apiRequest("DELETE", `/api/pipeline/examples/${id}`)).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/pipeline/examples"] }),
  });

  const stages = useMemo(() => {
    const s = data?.stages ?? {};
    return Object.keys(s).sort((a, b) => {
      const ia = STAGE_ORDER.indexOf(a), ib = STAGE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [data]);
  const total = data?.articles ?? 0;

  return (
    <div className="space-y-4">
      <Card data-testid="rejection-funnel">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base flex items-center gap-2"><GraduationCap className="h-4 w-4" /> Why articles were rejected</CardTitle>
              <CardDescription>
                Last {data?.scans ?? scans} scans · {total} article decisions. Expand a stage, then tell Sensei when it was wrong — each answer becomes a reference example.
              </CardDescription>
            </div>
            <div className="flex items-center gap-1">
              {[6, 12, 24, 48].map((n) => (
                <Badge key={n} variant={scans === n ? "default" : "secondary"} className="cursor-pointer" onClick={() => setScans(n)}>{n} scans</Badge>
              ))}
              <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching}><RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /></Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {stages.map((stage) => {
            const st = data!.stages[stage];
            const pct = total ? Math.round((st.count / total) * 100) : 0;
            const isOpen = !!open[stage];
            return (
              <div key={stage} className="rounded-md border">
                <button className="w-full flex items-center gap-3 p-2 text-left" onClick={() => setOpen((o) => ({ ...o, [stage]: !isOpen }))}>
                  {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                  <span className="font-medium w-28 shrink-0">{stage}</span>
                  <div className="flex-1 h-2 rounded bg-muted overflow-hidden">
                    <div className={`h-full ${stage === "Lead created" ? "bg-emerald-500" : "bg-amber-500"}`} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="tabular-nums text-sm w-20 text-right">{st.count} · {pct}%</span>
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 space-y-3">
                    {STAGE_HELP[stage] && <div className="text-xs text-muted-foreground">{STAGE_HELP[stage]}</div>}
                    {Object.entries(st.reasons).sort((a, b) => b[1].count - a[1].count).map(([reason, bucket]) => (
                      <div key={reason} className="space-y-1">
                        <div className="text-sm font-medium flex items-center gap-2"><Badge variant="outline">{bucket.count}</Badge> {reason}</div>
                        <ul className="space-y-1">
                          {bucket.samples.slice(0, 10).map((s, i) => (
                            <li key={i} className="flex flex-wrap items-center gap-2 text-sm pl-2 border-l">
                              <span className="flex-1 min-w-[200px]">
                                {s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="hover:underline">{s.headline}</a> : s.headline}
                                <span className="text-xs text-muted-foreground"> · {s.source}</span>
                              </span>
                              {s.url && stage !== "Lead created" && (
                                <>
                                  <Button size="sm" variant="outline" className="h-7" title="This should have been a lead" onClick={() => teach.mutate({ url: s.url!, headline: s.headline, expected: "pass", note: `Rejected at ${stage}: ${s.reason.slice(0, 120)}` })}>
                                    <ThumbsUp className="h-3.5 w-3.5 mr-1" /> Should pass
                                  </Button>
                                  <Button size="sm" variant="ghost" className="h-7" title="Run it through the pipeline again now" onClick={() => rerun.mutate(s.url!)} disabled={rerun.isPending}>
                                    <RefreshCw className={`h-3.5 w-3.5 ${rerun.isPending ? "animate-spin" : ""}`} />
                                  </Button>
                                </>
                              )}
                              {s.url && stage === "Lead created" && (
                                <Button size="sm" variant="outline" className="h-7" title="This should not have been a lead" onClick={() => teach.mutate({ url: s.url!, headline: s.headline, expected: "reject" })}>
                                  <ThumbsDown className="h-3.5 w-3.5 mr-1" /> Should reject
                                </Button>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card data-testid="pipeline-examples">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">What Sensei has been taught</CardTitle>
            <Button size="sm" variant="outline" onClick={() => runAll.mutate()} disabled={runAll.isPending || !ex?.examples.length}>
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${runAll.isPending ? "animate-spin" : ""}`} /> Re-check all now
            </Button>
          </div>
          <CardDescription>
            {ex?.summary ? `${ex.summary.total} reference examples · ${ex.summary.passing} passing · ${ex.summary.failing} failing · ${ex.summary.untested} not yet re-checked` : "No examples yet."}
            {ex?.summary?.lastRunAt ? ` · last check ${new Date(ex.summary.lastRunAt).toLocaleString()}` : ""}
          </CardDescription>
        </CardHeader>
        {ex && ex.examples.length > 0 && (
          <CardContent>
            <ul className="space-y-1">
              {ex.examples.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge className={e.expected === "pass" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-red-500/10 text-red-600 dark:text-red-400"}>{e.expected}</Badge>
                  <a href={e.url} target="_blank" rel="noreferrer" className="flex-1 min-w-[200px] hover:underline">{e.headline}</a>
                  {e.lastResult && (
                    <Badge variant="outline" className={e.lastResult === e.expected ? "text-emerald-600" : "text-red-600"}>
                      last: {e.lastResult}
                    </Badge>
                  )}
                  <Button size="sm" variant="ghost" className="h-7" onClick={() => remove.mutate(e.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
