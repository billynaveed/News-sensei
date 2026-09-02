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
import { Ban, ChevronRight, Loader2, Network, Plus, Search, Users } from "lucide-react";

export type FamilySummary = {
  id: string;
  name: string;
  country: string | null;
  description: string | null;
  netWorthEstimate: string | null;
  researchStatus: string;
  primaryCompanies: string[] | null;
  memberCount: number;
  blockedCount: number;
};

type ResearchProgress = {
  enabled: boolean;
  running: boolean;
  counts: Record<string, number>;
  total: number;
  researched: number;
  remaining: number;
  searchesLeftToday: number;
  lastRun: { at: string; name: string | null; status: string; error?: string } | null;
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
  const visible = countryFilter === "all" ? filtered : filtered.filter((f) => f.country === countryFilter);

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
              <span className="text-xs text-muted-foreground">
                {progress.counts.pending ?? 0} queued · {progress.counts.needs_review ?? 0} need review · {progress.counts.failed ?? 0} failed
                {progress.lastRun?.name ? ` · last: ${progress.lastRun.name} (${progress.lastRun.status})` : ""}
                {!progress.enabled ? " · worker disabled" : ""}
              </span>
            </div>
            <Progress value={progress.total ? (progress.researched / progress.total) * 100 : 0} className="h-2" />
          </CardContent>
        </Card>
      )}

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

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {familiesData?.length ? "No families match the search." : "No families yet — create one to start mapping."}
          </CardContent>
        </Card>
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
