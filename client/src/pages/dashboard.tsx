import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useSearch, Link } from "wouter";
import { format } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import {
  ExternalLink,
  Bookmark,
  BookmarkCheck,
  Phone,
  X,
  Filter,
  RefreshCw,
  Building2,
  User,
  Briefcase,
  Calendar,
  TrendingUp,
  AlertCircle,
  Clock,
  ChevronDown,
  ChevronUp,
  DollarSign,
  Lightbulb,
  ChevronRight,
  ThumbsDown,
  Sparkles,
  Loader2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { BellOff } from "lucide-react";
import { Card, CardContent, CardHeader, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { FetchMethodBadge } from "@/components/FetchMethodBadge";
import type { Lead, LeadStatus, PriorityLevel, SourceTier, FetchMethod, KeyFinancials } from "@shared/schema";

type FilterState = {
  publishedDays: string;
  region: string;
  sourceTier: string;
  priority: string;
  status: string;
};

const priorityColors: Record<PriorityLevel, string> = {
  high: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
  medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  low: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
};

const tierColors: Record<SourceTier, string> = {
  tier1: "bg-primary/10 text-primary border-primary/20",
  tier2: "bg-secondary text-secondary-foreground border-secondary-border",
  tier3: "bg-muted text-muted-foreground border-muted-border",
};

const tierLabels: Record<SourceTier, string> = {
  tier1: "Tier 1",
  tier2: "Tier 2",
  tier3: "Tier 3",
};

const statusLabels: Record<LeadStatus, string> = {
  new: "New",
  reviewed: "Reviewed",
  saved: "Saved",
  contacted: "Contacted",
  dismissed: "Dismissed",
};


/** Formats key financials into a readable string for display */
function formatKeyFinancials(financials: KeyFinancials): string {
  const parts: string[] = [];
  if (financials.fundingAmount) parts.push(`Funding: ${financials.fundingAmount}`);
  if (financials.valuation) parts.push(`Valuation: ${financials.valuation}`);
  if (financials.dealValue) parts.push(`Deal: ${financials.dealValue}`);
  return parts.join(" | ");
}

const BAD_REASONS: { value: string; label: string }[] = [
  { value: "not_region", label: "Not in target region" },
  { value: "public_company", label: "Public company" },
  { value: "not_wealth_event", label: "Not a wealth event" },
  { value: "not_uhnw", label: "Not UHNW / notable" },
  { value: "duplicate", label: "Duplicate / old" },
  { value: "other", label: "Other / just bad" },
];

function LeadCard({ lead, isTop, onUpdateStatus, onFeedback, onEnrich, onMute }: {
  lead: Lead;
  isTop?: boolean;
  onUpdateStatus: (id: string, status: LeadStatus) => void;
  onFeedback: (id: string, reason: string) => void;
  onEnrich: (id: string) => Promise<void>;
  onMute: (names: string[]) => void;
}) {
  const [enriching, setEnriching] = useState(false);
  const [muteOpen, setMuteOpen] = useState(false);
  const [muteChecked, setMuteChecked] = useState<Record<string, boolean>>({});
  const handleEnrich = async () => {
    setEnriching(true);
    try { await onEnrich(lead.id); } finally { setEnriching(false); }
  };
  const openMute = (open: boolean) => {
    setMuteOpen(open);
    if (open) setMuteChecked(Object.fromEntries(lead.founderNames.filter(Boolean).map((f) => [f, true])));
  };
  const submitMute = () => {
    const names = lead.founderNames.filter((f) => f && muteChecked[f]);
    if (names.length > 0) onMute(names);
    setMuteOpen(false);
  };
  const priorityClass = priorityColors[lead.priorityLevel];
  const tierClass = tierColors[lead.sourceTier];
  const hasKeyFinancials = lead.keyFinancials &&
    (lead.keyFinancials.fundingAmount || lead.keyFinancials.valuation || lead.keyFinancials.dealValue);

  return (
    <Card className={`group ${isTop ? "ring-2 ring-primary/60 ring-offset-1" : ""}`} data-testid={`lead-card-${lead.id}`}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            {isTop && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary" title="Keyboard shortcuts act on this card">
                ⌨ D·S·B·E·M
              </span>
            )}
            <Badge variant="outline" className={tierClass} size="sm">
              {tierLabels[lead.sourceTier]}
            </Badge>
            <Badge variant="outline" className={priorityClass} size="sm">
              {lead.priorityLevel.charAt(0).toUpperCase() + lead.priorityLevel.slice(1)} Priority
            </Badge>
            {lead.fetchMethod && (
              <FetchMethodBadge method={lead.fetchMethod} />
            )}
            {lead.isUpdate && (
              <Badge
                variant="outline"
                className="bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20"
                size="sm"
              >
                {"\uD83D\uDCF0"} Update for saved company
              </Badge>
            )}
            {lead.status === "new" && (
              <Badge variant="default" size="sm">New</Badge>
            )}
            {lead.status === "saved" && (
              <Badge variant="outline" className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20" size="sm">
                Saved
              </Badge>
            )}
            {lead.status === "contacted" && (
              <Badge variant="outline" className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20" size="sm">
                Contacted
              </Badge>
            )}
          </div>
          <a
            href={lead.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block font-semibold text-base leading-snug hover:text-primary transition-colors line-clamp-2"
            data-testid={`link-headline-${lead.id}`}
          >
            {lead.headline}
            <ExternalLink className="inline-block ml-1.5 h-3.5 w-3.5 opacity-50" />
          </a>
          {lead.relatedSavedLeadId && (
            <Link
              href="/saved-leads"
              className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
              data-testid={`link-related-saved-${lead.id}`}
            >
              <BookmarkCheck className="h-3 w-3" />
              View related saved lead
            </Link>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <div className="flex items-center justify-center w-10 h-10 rounded-md bg-muted font-mono text-sm font-bold">
            {lead.priorityScore}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {lead.companyNames.length > 0 && (
            <div className="flex items-start gap-2">
              <Building2 className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-0.5">Companies</div>
                <div className="text-sm font-medium">{lead.companyNames.join(", ")}</div>
              </div>
            </div>
          )}
          {lead.founderNames.length > 0 && (
            <div className="flex items-start gap-2">
              <User className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-0.5">Founders</div>
                <div className="flex flex-wrap gap-1">
                  {lead.founderNames.filter(Boolean).map((f) => (
                    <Badge key={f} variant="secondary" size="sm">{f}</Badge>
                  ))}
                </div>
              </div>
            </div>
          )}
          {lead.investors && lead.investors.length > 0 && (
            <div className="flex items-start gap-2">
              <Briefcase className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-0.5">Investors</div>
                <div className="text-sm">{lead.investors.join(", ")}</div>
              </div>
            </div>
          )}
          <div className="flex items-start gap-2">
            <Calendar className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-0.5">Published</div>
              <div className="text-sm">{format(new Date(lead.publishedAt), "MMM d, yyyy 'at' h:mm a")}</div>
            </div>
          </div>
        </div>

        {/* Key Financials - displayed when enrichment data is available */}
        {hasKeyFinancials && (
          <div className="flex items-start gap-2 bg-emerald-500/5 border border-emerald-500/20 rounded-md p-3">
            <DollarSign className="h-4 w-4 text-emerald-600 dark:text-emerald-400 mt-0.5 flex-shrink-0" />
            <div>
              <div className="text-xs text-emerald-700 dark:text-emerald-300 uppercase tracking-wide font-medium mb-0.5">
                Key Financials
              </div>
              <div className="text-sm font-medium font-mono tabular-nums text-emerald-800 dark:text-emerald-200">
                {formatKeyFinancials(lead.keyFinancials!)}
              </div>
            </div>
          </div>
        )}

        <div className="bg-muted/50 rounded-md p-3">
          <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1.5">AI Summary</div>
          <p className="text-sm leading-relaxed">{lead.aiSummary}</p>
        </div>

        {/* Wealth Angle - displayed when pipeline enrichment provides it */}
        {lead.wealthAngle && (
          <div className="flex items-start gap-2 bg-amber-500/5 border border-amber-500/20 rounded-md p-3">
            <Lightbulb className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
            <div>
              <div className="text-xs text-amber-700 dark:text-amber-300 uppercase tracking-wide font-medium mb-0.5">
                Wealth Angle
              </div>
              <p className="text-sm leading-relaxed text-amber-900 dark:text-amber-100">
                {lead.wealthAngle}
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Keywords:</span>
          {lead.matchedKeywords.map((keyword) => (
            <Badge key={keyword} variant="secondary" size="sm">
              {keyword}
            </Badge>
          ))}
        </div>

        {/* Pipeline Logic - collapsible for tuning */}
        {lead.pipelineReasoning && (
          <details className="group">
            <summary className="flex items-center gap-1.5 cursor-pointer text-xs text-muted-foreground uppercase tracking-wide font-medium hover:text-foreground transition-colors">
              <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
              Pipeline Logic
            </summary>
            <pre className="mt-2 text-xs leading-relaxed text-muted-foreground bg-muted/30 rounded-md p-2.5 whitespace-pre-wrap font-mono">
              {lead.pipelineReasoning}
            </pre>
          </details>
        )}

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{lead.sourceName}</span>
          <span>{lead.region}</span>
        </div>
      </CardContent>
      <CardFooter className="flex items-center justify-between gap-2 pt-0">
        <div className="flex items-center gap-2">
          {/* Hide save button for update leads (already saved via related lead) */}
          {!lead.isUpdate && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onUpdateStatus(lead.id, "saved")}
                  disabled={lead.status === "saved"}
                  className={lead.status === "saved" ? "text-emerald-600 dark:text-emerald-400" : "text-emerald-600 dark:text-emerald-400"}
                  data-testid={`button-save-${lead.id}`}
                >
                  {lead.status === "saved" ? (
                    <BookmarkCheck className="h-4 w-4 fill-current" />
                  ) : (
                    <Bookmark className="h-4 w-4" />
                  )}
                  {lead.status === "saved" ? "Saved" : "Save"}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{lead.status === "saved" ? "Already saved" : "Bookmark for later"}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onUpdateStatus(lead.id, "contacted")}
                disabled={lead.status === "contacted"}
                className={lead.status === "contacted" ? "text-blue-600 dark:text-blue-400" : "text-blue-600 dark:text-blue-400"}
                data-testid={`button-contacted-${lead.id}`}
              >
                <Phone className={`h-4 w-4 ${lead.status === "contacted" ? "fill-current" : ""}`} />
                {lead.status === "contacted" ? "Contacted" : "Contact"}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{lead.status === "contacted" ? "Already contacted" : "Mark as contacted"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleEnrich}
                disabled={enriching}
                className="text-violet-600 dark:text-violet-400"
                data-testid={`button-enrich-${lead.id}`}
              >
                {enriching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {enriching ? "Enriching..." : "Enrich"}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Find founder bio / company info via web search</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-1">
          {lead.founderNames.length > 0 && (
            <Popover open={muteOpen} onOpenChange={openMute}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="text-zinc-600 dark:text-zinc-300" data-testid={`button-mute-${lead.id}`}>
                  <BellOff className="h-4 w-4" />
                  Mute
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64">
                <div className="text-sm font-medium">Mute founders</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  They'll stop appearing in leads — unless an article also names a founder you haven't muted.
                </p>
                <div className="mt-3 space-y-2">
                  {lead.founderNames.filter(Boolean).map((f) => (
                    <label key={f} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={!!muteChecked[f]} onCheckedChange={(v) => setMuteChecked((s) => ({ ...s, [f]: !!v }))} />
                      <span>{f}</span>
                    </label>
                  ))}
                </div>
                <Button
                  size="sm"
                  className="mt-3 w-full"
                  onClick={submitMute}
                  disabled={!lead.founderNames.some((f) => muteChecked[f])}
                  data-testid={`button-mute-submit-${lead.id}`}
                >
                  Mute selected
                </Button>
              </PopoverContent>
            </Popover>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-amber-600 dark:text-amber-400"
                data-testid={`button-feedback-${lead.id}`}
              >
                <ThumbsDown className="h-4 w-4" />
                Bad lead
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Why is this a bad lead?</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {BAD_REASONS.map((r) => (
                <DropdownMenuItem key={r.value} onClick={() => onFeedback(lead.id, r.value)}>
                  {r.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onUpdateStatus(lead.id, "dismissed")}
                className="text-red-600 dark:text-red-400"
                data-testid={`button-dismiss-${lead.id}`}
              >
                <X className="h-4 w-4" />
                Dismiss
              </Button>
            </TooltipTrigger>
            <TooltipContent>Hide this lead</TooltipContent>
          </Tooltip>
        </div>
      </CardFooter>
    </Card>
  );
}

function LeadCardSkeleton() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-24" />
          </div>
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </div>
        <Skeleton className="h-10 w-10 rounded-md" />
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
        <Skeleton className="h-20 w-full" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-14" />
        </div>
      </CardContent>
      <CardFooter className="flex items-center justify-between gap-2 pt-0">
        <div className="flex gap-2">
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-8 w-20" />
        </div>
        <Skeleton className="h-8 w-16" />
      </CardFooter>
    </Card>
  );
}

function StatsCard({ title, value, icon: Icon, trend }: { title: string; value: number | string; icon: typeof TrendingUp; trend?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1">{title}</div>
            <div className="text-2xl font-bold font-mono tabular-nums">{value}</div>
            {trend && <div className="text-xs text-muted-foreground mt-1">{trend}</div>}
          </div>
          <div className="flex items-center justify-center w-10 h-10 rounded-md bg-primary/10 text-primary">
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const [filters, setFilters] = useState<FilterState>({
    publishedDays: "30",
    region: "all",
    sourceTier: "all",
    priority: "all",
    status: "active",
  });

  const [statsExpanded, setStatsExpanded] = useState(false);

  const { data: leads, isLoading: leadsLoading } = useQuery<Lead[]>({
    queryKey: ["/api/leads"],
  });

  const { data: mutedFounders } = useQuery<{ fullName: string }[]>({
    queryKey: ["/api/founders/muted"],
  });
  const mutedSet = new Set((mutedFounders ?? []).map((m) => (m.fullName || "").toLowerCase().trim()));

  const { data: stats } = useQuery<{ today: number; thisWeek: number; highPriority: number }>({
    queryKey: ["/api/leads/stats"],
  });

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: LeadStatus }) => {
      await apiRequest("PATCH", `/api/leads/${id}`, { status });
    },
    onMutate: async ({ id, status }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["/api/leads"] });

      // Snapshot the previous value
      const previousLeads = queryClient.getQueryData<Lead[]>(["/api/leads"]);

      // Optimistically update to the new value
      queryClient.setQueryData<Lead[]>(["/api/leads"], (old) =>
        old?.map(lead => lead.id === id ? { ...lead, status } : lead) || []
      );

      return { previousLeads };
    },
    onError: (err, variables, context) => {
      // Rollback on error
      if (context?.previousLeads) {
        queryClient.setQueryData(["/api/leads"], context.previousLeads);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leads/stats"] });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (leadId: string) => {
      await apiRequest("POST", "/api/saved-leads", { leadId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/saved-leads"] });
    },
  });

  const triggerScanMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/scan");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leads/stats"] });
    },
  });

  const handleUpdateStatus = (id: string, status: LeadStatus) => {
    if (status === "saved") {
      // Use the new saved leads API
      saveMutation.mutate(id);
    } else {
      updateStatusMutation.mutate({ id, status });
    }
  };

  const handleFeedback = (id: string, reason: string) => {
    // Optimistically drop the card; the server stores feedback + dismisses it,
    // and recent "bad" feedback sharpens the next scan's filter.
    queryClient.setQueryData<Lead[]>(["/api/leads"], (old) =>
      old?.map((l) => (l.id === id ? { ...l, status: "dismissed" as LeadStatus } : l)) || []
    );
    apiRequest("POST", `/api/leads/${id}/feedback`, { rating: "bad", reason })
      .finally(() => queryClient.invalidateQueries({ queryKey: ["/api/leads"] }));
  };

  const handleEnrich = async (id: string) => {
    await apiRequest("POST", `/api/leads/${id}/enrich`, {});
    await queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
  };

  const handleMute = (names: string[]) => {
    apiRequest("POST", "/api/founders/mute", { names }).finally(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/founders/muted"] });
    });
  };

  // Keyboard shortcuts act on the highlighted TOP card (d/s/b/e/m). After an
  // action the card drops out and the next slides up, for fast triage. The
  // top lead is held in a ref so the listener is mounted once.
  const topLeadRef = useRef<Lead | undefined>(undefined);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const top = topLeadRef.current;
      if (!top) return;
      const k = e.key.toLowerCase();
      if (k === "d") { handleUpdateStatus(top.id, "dismissed"); e.preventDefault(); }
      else if (k === "s") { handleUpdateStatus(top.id, "saved"); e.preventDefault(); }
      else if (k === "b") { handleFeedback(top.id, "other"); e.preventDefault(); }
      else if (k === "e") { void handleEnrich(top.id); e.preventDefault(); }
      else if (k === "m") {
        const names = (top.founderNames ?? []).filter(Boolean) as string[];
        if (names.length) handleMute(names);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First filter by basic criteria
  const baseFilteredLeads = leads?.filter((lead) => {
    // Muted founders: hide the lead only if EVERY founder is muted (a lead that
    // also names an un-muted founder still shows).
    if (mutedSet.size > 0) {
      const named = (lead.founderNames ?? []).filter(Boolean);
      if (named.length > 0 && named.every((f) => mutedSet.has(f.toLowerCase().trim()))) {
        return false;
      }
    }
    // Status filter - saved and dismissed articles are excluded from active feed
    if (filters.status === "active" && (lead.status === "dismissed" || lead.status === "saved")) return false;
    if (filters.status === "contacted" && lead.status !== "contacted") return false;
    if (filters.status === "dismissed" && lead.status !== "dismissed") return false;
    
    // Published days filter - use exact time comparison (e.g., 2 days = 48 hours ago)
    if (filters.publishedDays !== "all") {
      const days = parseInt(filters.publishedDays);
      const cutoffTime = Date.now() - days * 24 * 60 * 60 * 1000;
      if (new Date(lead.publishedAt).getTime() < cutoffTime) return false;
    }
    
    if (filters.region !== "all" && lead.region !== filters.region) return false;
    if (filters.sourceTier !== "all" && lead.sourceTier !== filters.sourceTier) return false;
    if (filters.priority !== "all" && lead.priorityLevel !== filters.priority) return false;
    return true;
  }) || [];

  // Collapse duplicates: per company AND per founder, keep only the best lead
  // (highest source tier, then highest priority score). This merges multiple
  // articles about the same person/company into one card.
  const tierPriority: Record<SourceTier, number> = { tier1: 1, tier2: 2, tier3: 3 };
  const entityBestLead = new Map<string, Lead>();

  const isBetter = (candidate: Lead, existing: Lead) => {
    const ct = tierPriority[candidate.sourceTier];
    const et = tierPriority[existing.sourceTier];
    if (ct < et) return true;
    return ct === et && candidate.priorityScore > existing.priorityScore;
  };

  baseFilteredLeads.forEach((lead) => {
    const keys = [
      ...lead.companyNames.filter(Boolean).map((c) => `co:${c.toLowerCase().trim()}`),
      ...lead.founderNames.filter(Boolean).map((f) => `fo:${f.toLowerCase().trim()}`),
    ].filter((k) => k.length > 3); // drop empty-name keys
    keys.forEach((key) => {
      const existing = entityBestLead.get(key);
      if (!existing || isBetter(lead, existing)) entityBestLead.set(key, lead);
    });
  });

  // A lead shows if it's the best for at least one of its entities.
  const bestLeadIds = new Set(Array.from(entityBestLead.values()).map((l) => l.id));

  const filteredLeads = baseFilteredLeads.filter((lead) => {
    // No company AND no founder => can't dedup, always show.
    if (lead.companyNames.length === 0 && lead.founderNames.length === 0) return true;
    return bestLeadIds.has(lead.id);
  }).sort((a, b) => {
    if (a.priorityScore !== b.priorityScore) {
      return b.priorityScore - a.priorityScore;
    }
    return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  });

  // Keep the keyboard-shortcut target in sync with the current top card.
  topLeadRef.current = filteredLeads[0];

  return (
    <div className="flex flex-col h-full">
      <Collapsible open={statsExpanded} onOpenChange={setStatsExpanded}>
        <div className="border-b border-border">
          {statsExpanded ? (
            <CollapsibleContent forceMount>
              <div className="p-6 pb-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                  <StatsCard 
                    title="Generated Today" 
                    value={stats?.today ?? 0} 
                    icon={TrendingUp}
                  />
                  <StatsCard 
                    title="In Newsfeed" 
                    value={filteredLeads.length} 
                    icon={Calendar}
                  />
                </div>
                <div className="flex items-center justify-between gap-4 flex-wrap pt-4 border-t border-border">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Filter className="h-4 w-4 text-muted-foreground" />
                    <Select value={filters.status} onValueChange={(v) => setFilters(f => ({ ...f, status: v }))}>
                      <SelectTrigger className="w-[130px]" data-testid="filter-status">
                        <SelectValue placeholder="Status" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="contacted">Contacted</SelectItem>
                        <SelectItem value="dismissed">Dismissed</SelectItem>
                        <SelectItem value="all">All</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={filters.region} onValueChange={(v) => setFilters(f => ({ ...f, region: v }))}>
                      <SelectTrigger className="w-[140px]" data-testid="filter-region">
                        <SelectValue placeholder="Region" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Regions</SelectItem>
                        <SelectItem value="Singapore">Singapore</SelectItem>
                        <SelectItem value="Hong Kong">Hong Kong</SelectItem>
                        <SelectItem value="Taiwan">Taiwan</SelectItem>
                        <SelectItem value="Indonesia">Indonesia</SelectItem>
                        <SelectItem value="Vietnam">Vietnam</SelectItem>
                        <SelectItem value="Thailand">Thailand</SelectItem>
                        <SelectItem value="Malaysia">Malaysia</SelectItem>
                        <SelectItem value="Philippines">Philippines</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={filters.sourceTier} onValueChange={(v) => setFilters(f => ({ ...f, sourceTier: v }))}>
                      <SelectTrigger className="w-[120px]" data-testid="filter-tier">
                        <SelectValue placeholder="Tier" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Tiers</SelectItem>
                        <SelectItem value="tier1">Tier 1</SelectItem>
                        <SelectItem value="tier2">Tier 2</SelectItem>
                        <SelectItem value="tier3">Tier 3</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={filters.priority} onValueChange={(v) => setFilters(f => ({ ...f, priority: v }))}>
                      <SelectTrigger className="w-[130px]" data-testid="filter-priority">
                        <SelectValue placeholder="Priority" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Priority</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="low">Low</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={filters.publishedDays} onValueChange={(v) => setFilters(f => ({ ...f, publishedDays: v }))}>
                      <SelectTrigger className="w-[140px]" data-testid="filter-published">
                        <SelectValue placeholder="Published" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">Last 1 Day</SelectItem>
                        <SelectItem value="2">Last 2 Days</SelectItem>
                        <SelectItem value="3">Last 3 Days</SelectItem>
                        <SelectItem value="7">Last 7 Days</SelectItem>
                        <SelectItem value="14">Last 14 Days</SelectItem>
                        <SelectItem value="30">Last 30 Days</SelectItem>
                        <SelectItem value="all">All Time</SelectItem>
                      </SelectContent>
                    </Select>
                    {(filters.region !== "all" || filters.sourceTier !== "all" || filters.priority !== "all" || filters.status !== "active" || filters.publishedDays !== "30") && (
                      <Button 
                        variant="ghost" 
                        size="sm"
                        onClick={() => setFilters({ publishedDays: "2", region: "all", sourceTier: "all", priority: "all", status: "active" })}
                        data-testid="button-clear-filters"
                      >
                        Clear filters
                      </Button>
                    )}
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={() => triggerScanMutation.mutate()}
                        disabled={triggerScanMutation.isPending}
                        data-testid="button-scan-now"
                      >
                        <RefreshCw className={`h-4 w-4 ${triggerScanMutation.isPending ? "animate-spin" : ""}`} />
                        {triggerScanMutation.isPending ? "Scanning..." : "Scan Now"}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Scans run automatically every hour. Use this for immediate scanning.</TooltipContent>
                  </Tooltip>
                </div>
              </div>
              <div className="flex justify-center pb-2">
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" data-testid="button-collapse-stats">
                    <ChevronUp className="h-4 w-4 mr-1" />
                    Collapse
                  </Button>
                </CollapsibleTrigger>
              </div>
            </CollapsibleContent>
          ) : (
            <div className="flex items-center justify-between gap-4 px-6 py-3">
              <div className="flex items-center gap-6 text-sm flex-wrap">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  <span className="text-muted-foreground">Generated Today:</span>
                  <span className="font-bold tabular-nums">{stats?.today ?? 0}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-primary" />
                  <span className="text-muted-foreground">In Newsfeed:</span>
                  <span className="font-bold tabular-nums">{filteredLeads.length}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      onClick={() => triggerScanMutation.mutate()}
                      disabled={triggerScanMutation.isPending}
                      data-testid="button-scan-now-collapsed"
                    >
                      <RefreshCw className={`h-4 w-4 ${triggerScanMutation.isPending ? "animate-spin" : ""}`} />
                      {triggerScanMutation.isPending ? "Scanning..." : "Scan"}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Scans run automatically every hour</TooltipContent>
                </Tooltip>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" data-testid="button-expand-stats">
                    <ChevronDown className="h-4 w-4 mr-1" />
                    Expand
                  </Button>
                </CollapsibleTrigger>
              </div>
            </div>
          )}
        </div>
      </Collapsible>

      <div className="flex-1 overflow-auto p-6">
        {leadsLoading ? (
          <div className="grid gap-4">
            {[...Array(3)].map((_, i) => (
              <LeadCardSkeleton key={i} />
            ))}
          </div>
        ) : filteredLeads.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <Clock className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No leads found</h3>
            <p className="text-muted-foreground max-w-md">
              {filters.status !== "active" || filters.region !== "all" || filters.sourceTier !== "all" || filters.priority !== "all" || filters.publishedDays !== "30"
                ? "Try adjusting your filters or click 'Scan Now' to fetch new articles."
                : "Click 'Scan Now' to start scanning for wealth-related news articles."}
            </p>
            <Button 
              className="mt-4" 
              onClick={() => triggerScanMutation.mutate()}
              disabled={triggerScanMutation.isPending}
              data-testid="button-scan-empty"
            >
              <RefreshCw className={`h-4 w-4 ${triggerScanMutation.isPending ? "animate-spin" : ""}`} />
              Scan Now
            </Button>
          </div>
        ) : (
          <div className="grid gap-4">
            <AnimatePresence mode="popLayout">
              {filteredLeads.map((lead, idx) => (
                <motion.div
                  key={lead.id}
                  layout
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -100, transition: { duration: 0.2 } }}
                  transition={{ duration: 0.2 }}
                >
                  <LeadCard
                    lead={lead}
                    isTop={idx === 0}
                    onUpdateStatus={handleUpdateStatus}
                    onFeedback={handleFeedback}
                    onEnrich={handleEnrich}
                    onMute={handleMute}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}
