import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCheck,
  ChevronRight,
  Link2,
  Loader2,
  Network,
  Plus,
  RotateCw,
  Search,
  Trash2,
  Users,
  XCircle,
} from "lucide-react";

export type FamilySummary = {
  id: string;
  name: string;
  country: string | null;
  description: string | null;
  netWorthEstimate: string | null;
  researchStatus: string;
  researchAttempts: number;
  researchedAt: string | null;
  primaryCompanies: string[] | null;
  /** "high" | "medium" | "low" | "error" — parsed out of families.confidence. */
  confidenceLevel: string | null;
  /** Why the researcher flagged it, e.g. "only 1 member found". */
  reviewNote: string | null;
  sourceCount: number;
  relationshipCount: number;
  memberCount: number;
  blockedCount: number;
};

type ReviewView = "all" | "needs_review" | "failed" | "blocked";

const CONFIDENCE_BADGES: Record<string, string> = {
  high: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  low: "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20",
  error: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
};

/** Billy's bulk rule: enough people, and the model wasn't unsure. */
function isBulkApprovable(f: FamilySummary): boolean {
  return (
    f.researchStatus === "needs_review" &&
    f.memberCount >= 3 &&
    (f.confidenceLevel === "medium" || f.confidenceLevel === "high")
  );
}

type BlockedPerson = {
  personId: number;
  fullName: string;
  origin: "direct" | "propagated";
  reason: string | null;
  coveredBy: string | null;
  originName: string | null;
  familyId: string | null;
};

type ResearchProgress = {
  enabled: boolean;
  running: boolean;
  counts: Record<string, number>;
  total: number;
  researched: number;
  remaining: number;
  searchesLeftToday: number;
  lastRun: { at: string; name: string | null; status: string; detail?: string; error?: string } | null;
};

const RESEARCH_BADGES: Record<string, { label: string; className: string }> = {
  manual: { label: "Manual", className: "bg-muted text-muted-foreground" },
  pending: { label: "Research queued", className: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  researching: { label: "Researching…", className: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  done: { label: "Researched", className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  needs_review: { label: "Needs review", className: "bg-orange-500/10 text-orange-600 dark:text-orange-400" },
  failed: { label: "Research failed", className: "bg-red-500/10 text-red-600 dark:text-red-400" },
};

export default function FamiliesPage() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCountry, setNewCountry] = useState("");
  const [newDescription, setNewDescription] = useState("");

  const { data: familiesData, isLoading } = useQuery<FamilySummary[]>({
    queryKey: ["/api/families"],
  });
  const { data: blocked = [] } = useQuery<BlockedPerson[]>({
    queryKey: ["/api/founders/blocked"],
  });

  const { data: progress } = useQuery<ResearchProgress>({
    queryKey: ["/api/families/research/progress"],
    refetchInterval: 60_000,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/families", {
        name: newName,
        country: newCountry || null,
        description: newDescription || null,
      });
      return (await res.json()) as { id: string };
    },
    onSuccess: (family) => {
      queryClient.invalidateQueries({ queryKey: ["/api/families"] });
      setCreateOpen(false);
      setNewName("");
      setNewCountry("");
      setNewDescription("");
      navigate(`/families/${family.id}`);
    },
  });

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return familiesData ?? [];
    return (familiesData ?? []).filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        (f.country ?? "").toLowerCase().includes(q) ||
        (f.primaryCompanies ?? []).some((c) => c.toLowerCase().includes(q)),
    );
  }, [familiesData, search]);

  const countries = useMemo(() => {
    const set = new Set((familiesData ?? []).map((f) => f.country).filter(Boolean) as string[]);
    return Array.from(set).sort();
  }, [familiesData]);
  const [countryFilter, setCountryFilter] = useState<string>("all");
  const inCountry = countryFilter === "all" ? filtered : filtered.filter((f) => f.country === countryFilter);

  // Review queue: families the researcher could not finish on its own.
  const [view, setView] = useState<ReviewView>("all");
  const reviewCounts = useMemo(
    () => ({
      needs_review: (familiesData ?? []).filter((f) => f.researchStatus === "needs_review").length,
      failed: (familiesData ?? []).filter((f) => f.researchStatus === "failed").length,
    }),
    [familiesData],
  );

  const visible = useMemo(() => {
    if (view !== "all") return inCountry.filter((f) => f.researchStatus === view);
    // Anything awaiting a decision sorts to the top of the full list.
    const rank = (f: FamilySummary) =>
      f.researchStatus === "needs_review" ? 0 : f.researchStatus === "failed" ? 1 : 2;
    return [...inCountry].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [inCountry, view]);

  const bulkApprovable = useMemo(
    () => (familiesData ?? []).filter(isBulkApprovable).length,
    [familiesData],
  );

  const invalidateFamilies = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/families"] });
    queryClient.invalidateQueries({ queryKey: ["/api/families/research/progress"] });
  };

  const approveMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/families/${id}/approve`);
    },
    onSuccess: invalidateFamilies,
  });

  const requeueMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/families/${id}/research`);
    },
    onSuccess: invalidateFamilies,
  });

  const requeueAllMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/families/research/requeue-all");
    },
    onSuccess: invalidateFamilies,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/families/${id}`);
    },
    onSuccess: invalidateFamilies,
  });

  const bulkApproveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/families/review/approve-all", {
        minMembers: 3,
        minConfidence: "medium",
      });
      return (await res.json()) as { approved: number };
    },
    onSuccess: invalidateFamilies,
  });

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Network className="h-5 w-5" /> Families
          </h1>
          <p className="text-sm text-muted-foreground">
            Family trees across Southeast Asia — tag blocked (already-covered) people and their relatives.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-new-family">
              <Plus className="h-4 w-4 mr-1.5" /> New family
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New family</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Family name</label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Low family"
                  data-testid="input-family-name"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Country</label>
                <Input
                  value={newCountry}
                  onChange={(e) => setNewCountry(e.target.value)}
                  placeholder="e.g. Singapore"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Notes</label>
                <Textarea
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="Business, background, anything useful"
                  rows={3}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => createMutation.mutate()}
                disabled={newName.trim().length < 2 || createMutation.isPending}
                data-testid="button-create-family"
              >
                {createMutation.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {progress && progress.total > 0 && (
        <Card data-testid="research-progress">
          <CardContent className="py-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-medium">
                Research agent: {progress.researched}/{progress.total} families researched
                {progress.running && <Loader2 className="inline h-3.5 w-3.5 ml-1.5 animate-spin" />}
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  {progress.counts.pending ?? 0} queued · {progress.counts.needs_review ?? 0} need review · {progress.counts.failed ?? 0} failed
                  {progress.lastRun?.name ? ` · last: ${progress.lastRun.name} (${progress.lastRun.detail ?? progress.lastRun.status})` : ""}
                  {!progress.enabled ? " · worker disabled" : ""}
                </span>
                {/* Visible only once a pass has finished: a new pass re-reads every
                    family with full pages and extends its tree (nothing is cleared). */}
                {(progress.counts.pending ?? 0) === 0 && !progress.running && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    onClick={() => {
                      if (window.confirm(`Re-research all ${progress.total} families? Existing members and relationships are kept; the agent adds what it finds in full source pages, one family per hour.`)) {
                        requeueAllMutation.mutate();
                      }
                    }}
                    disabled={requeueAllMutation.isPending}
                    data-testid="button-requeue-all"
                  >
                    {requeueAllMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RotateCw className="h-3.5 w-3.5 mr-1" />}
                    Re-research all
                  </Button>
                )}
              </span>
            </div>
            <Progress value={progress.total ? (progress.researched / progress.total) * 100 : 0} className="h-2" />
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={view} onValueChange={(v) => setView(v as ReviewView)}>
          <TabsList>
            <TabsTrigger value="all" data-testid="tab-families-all">
              All ({familiesData?.length ?? 0})
            </TabsTrigger>
            <TabsTrigger value="needs_review" data-testid="tab-families-review">
              <AlertTriangle className="h-3.5 w-3.5 mr-1.5 text-orange-500" />
              Needs review ({reviewCounts.needs_review})
            </TabsTrigger>
            <TabsTrigger value="failed" data-testid="tab-families-failed">
              <XCircle className="h-3.5 w-3.5 mr-1.5 text-red-500" />
              Failed ({reviewCounts.failed})
            </TabsTrigger>
            <TabsTrigger value="blocked" data-testid="tab-families-blocked">
              <Ban className="h-3.5 w-3.5 mr-1.5 text-red-500" />
              Blocked ({blocked.length})
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {/* Always visible on the queue so the rule is discoverable, disabled
            while nothing qualifies. */}
        {view === "needs_review" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => bulkApproveMutation.mutate()}
            disabled={bulkApproveMutation.isPending || bulkApprovable === 0}
            title={
              bulkApprovable === 0
                ? "Nothing in the queue has 3+ members and confidence medium or better"
                : undefined
            }
            data-testid="button-approve-all"
          >
            {bulkApproveMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <CheckCheck className="h-3.5 w-3.5 mr-1.5" />
            )}
            Approve all with ≥3 members and confidence ≥ medium ({bulkApprovable})
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search families, countries, companies…"
            className="pl-8"
            data-testid="input-family-search"
          />
        </div>
        {countries.length > 0 && (
          <div className="flex flex-wrap gap-1">
            <Badge
              variant={countryFilter === "all" ? "default" : "secondary"}
              className="cursor-pointer"
              onClick={() => setCountryFilter("all")}
            >
              All
            </Badge>
            {countries.map((c) => (
              <Badge
                key={c}
                variant={countryFilter === c ? "default" : "secondary"}
                className="cursor-pointer"
                onClick={() => setCountryFilter(c)}
              >
                {c}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {view === "blocked" ? (
        <Card>
          <CardContent className="p-4">
            {blocked.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nobody is marked as covered yet. Open a person and use “Mark as covered” when
                another banker already has the relationship — blocking a child marks the
                parents too.
              </p>
            ) : (
              <ul className="divide-y" data-testid="list-blocked">
                {blocked.map((b) => (
                  <li key={b.personId} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                    <Link href={`/people/${b.personId}`} className="font-medium hover:text-primary">
                      {b.fullName}
                    </Link>
                    <Badge
                      variant="outline"
                      className={b.origin === "propagated"
                        ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
                        : "border-red-500/40 text-red-600 dark:text-red-400"}
                    >
                      {b.origin === "propagated" ? `via ${b.originName ?? "a relative"}` : "direct"}
                    </Badge>
                    {b.coveredBy && <span className="text-muted-foreground">covered by {b.coveredBy}</span>}
                    {b.familyId && (
                      <Link href={`/families/${b.familyId}`} className="ml-auto text-xs text-muted-foreground hover:text-primary">
                        open family
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {view === "needs_review"
              ? "Nothing to review — the researcher is happy with every family it has finished."
              : view === "failed"
                ? "No failed families."
                : familiesData?.length
                  ? "No families match the search."
                  : "No families yet — create one to start mapping."}
          </CardContent>
        </Card>
      ) : view !== "all" ? (
        <div className="space-y-2">
          {visible.map((f) => (
            <ReviewRow
              key={f.id}
              family={f}
              onApprove={() => approveMutation.mutate(f.id)}
              onRequeue={() => requeueMutation.mutate(f.id)}
              onDelete={() => {
                if (window.confirm(`Delete "${f.name}"? People and their block status are kept — only the tree is removed.`)) {
                  deleteMutation.mutate(f.id);
                }
              }}
              pending={
                (approveMutation.isPending && approveMutation.variables === f.id) ||
                (requeueMutation.isPending && requeueMutation.variables === f.id) ||
                (deleteMutation.isPending && deleteMutation.variables === f.id)
              }
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {visible.map((f) => {
            const rb = RESEARCH_BADGES[f.researchStatus] ?? RESEARCH_BADGES.manual;
            return (
              <Link key={f.id} href={`/families/${f.id}`}>
                <Card className="cursor-pointer hover:border-primary/40 transition-colors h-full" data-testid={`card-family-${f.id}`}>
                  <CardContent className="p-4 flex flex-col gap-2 h-full">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-semibold truncate">{f.name}</div>
                        {f.country && <div className="text-xs text-muted-foreground">{f.country}</div>}
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
                    </div>
                    {(f.primaryCompanies?.length ?? 0) > 0 && (
                      <div className="text-xs text-muted-foreground truncate">{f.primaryCompanies!.join(", ")}</div>
                    )}
                    <div className="flex flex-wrap items-center gap-1.5 mt-auto pt-1">
                      <Badge variant="secondary" className="gap-1">
                        <Users className="h-3 w-3" /> {f.memberCount}
                      </Badge>
                      {f.blockedCount > 0 && (
                        <Badge className="gap-1 bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20">
                          <Ban className="h-3 w-3" /> {f.blockedCount} blocked
                        </Badge>
                      )}
                      <Badge className={rb.className}>{rb.label}</Badge>
                      {f.netWorthEstimate && <Badge variant="outline">{f.netWorthEstimate}</Badge>}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
/**
 * One row of the review queue: what the researcher found (members, edges,
 * confidence + why it flagged the family, sources) and the three decisions —
 * approve as-is, send it back to the queue, or drop it.
 */
function ReviewRow({
  family,
  onApprove,
  onRequeue,
  onDelete,
  pending,
}: {
  family: FamilySummary;
  onApprove: () => void;
  onRequeue: () => void;
  onDelete: () => void;
  pending: boolean;
}) {
  const confidence = family.confidenceLevel ?? "unknown";
  const failed = family.researchStatus === "failed";
  return (
    <Card data-testid={`row-review-${family.id}`}>
      <CardContent className="p-3 flex flex-col sm:flex-row sm:items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/families/${family.id}`} className="font-semibold hover:underline truncate">
              {family.name}
            </Link>
            {family.country && <span className="text-xs text-muted-foreground">{family.country}</span>}
            <Badge variant="secondary" className="gap-1">
              <Users className="h-3 w-3" /> {family.memberCount}
            </Badge>
            <Badge variant="secondary" className="gap-1">
              <Link2 className="h-3 w-3" /> {family.relationshipCount}
            </Badge>
            <Badge variant="outline" className={CONFIDENCE_BADGES[confidence] ?? ""}>
              {failed ? `failed · attempt ${family.researchAttempts}` : `confidence ${confidence}`}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {family.sourceCount} source{family.sourceCount === 1 ? "" : "s"}
            </span>
          </div>
          {family.reviewNote && (
            <div className={`text-xs mt-1 ${failed ? "text-red-600 dark:text-red-400" : "text-orange-600 dark:text-orange-400"}`}>
              {family.reviewNote}
            </div>
          )}
          {family.description && (
            <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{family.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button size="sm" variant="outline" onClick={onApprove} disabled={pending} data-testid={`button-approve-${family.id}`}>
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}
            Approve
          </Button>
          <Button size="sm" variant="outline" onClick={onRequeue} disabled={pending} data-testid={`button-requeue-${family.id}`}>
            <RotateCw className="h-3.5 w-3.5 mr-1" /> Requeue
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={pending} data-testid={`button-delete-${family.id}`}>
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
