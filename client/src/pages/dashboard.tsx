import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { 
  ExternalLink, 
  Bookmark, 
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
  Clock
} from "lucide-react";
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
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Lead, LeadStatus, PriorityLevel, SourceTier } from "@shared/schema";

type FilterState = {
  dateRange: string;
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

function LeadCard({ lead, onUpdateStatus }: { lead: Lead; onUpdateStatus: (id: string, status: LeadStatus) => void }) {
  const priorityClass = priorityColors[lead.priorityLevel];
  const tierClass = tierColors[lead.sourceTier];

  return (
    <Card className="group" data-testid={`lead-card-${lead.id}`}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={tierClass} size="sm">
              {tierLabels[lead.sourceTier]}
            </Badge>
            <Badge variant="outline" className={priorityClass} size="sm">
              {lead.priorityLevel.charAt(0).toUpperCase() + lead.priorityLevel.slice(1)} Priority
            </Badge>
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
                <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-0.5">Key People</div>
                <div className="text-sm font-medium">{lead.founderNames.join(", ")}</div>
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

        <div className="bg-muted/50 rounded-md p-3">
          <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1.5">AI Summary</div>
          <p className="text-sm leading-relaxed">{lead.aiSummary}</p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Keywords:</span>
          {lead.matchedKeywords.map((keyword) => (
            <Badge key={keyword} variant="secondary" size="sm">
              {keyword}
            </Badge>
          ))}
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{lead.sourceName}</span>
          <span>{lead.region}</span>
        </div>
      </CardContent>
      <CardFooter className="flex items-center justify-between gap-2 pt-0">
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onUpdateStatus(lead.id, "saved")}
                disabled={lead.status === "saved"}
                data-testid={`button-save-${lead.id}`}
              >
                <Bookmark className="h-4 w-4" />
                Save
              </Button>
            </TooltipTrigger>
            <TooltipContent>Bookmark for later</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onUpdateStatus(lead.id, "contacted")}
                disabled={lead.status === "contacted"}
                data-testid={`button-contacted-${lead.id}`}
              >
                <Phone className="h-4 w-4" />
                Contacted
              </Button>
            </TooltipTrigger>
            <TooltipContent>Mark as contacted</TooltipContent>
          </Tooltip>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onUpdateStatus(lead.id, "dismissed")}
              data-testid={`button-dismiss-${lead.id}`}
            >
              <X className="h-4 w-4" />
              Dismiss
            </Button>
          </TooltipTrigger>
          <TooltipContent>Hide this lead</TooltipContent>
        </Tooltip>
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
    dateRange: "all",
    region: "all",
    sourceTier: "all",
    priority: "all",
    status: "active",
  });

  const { data: leads, isLoading: leadsLoading } = useQuery<Lead[]>({
    queryKey: ["/api/leads"],
  });

  const { data: stats } = useQuery<{ today: number; thisWeek: number; highPriority: number }>({
    queryKey: ["/api/leads/stats"],
  });

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: LeadStatus }) => {
      await apiRequest("PATCH", `/api/leads/${id}`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leads/stats"] });
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
    updateStatusMutation.mutate({ id, status });
  };

  const filteredLeads = leads?.filter((lead) => {
    if (filters.status === "active" && lead.status === "dismissed") return false;
    if (filters.status === "saved" && lead.status !== "saved") return false;
    if (filters.status === "contacted" && lead.status !== "contacted") return false;
    if (filters.region !== "all" && lead.region !== filters.region) return false;
    if (filters.sourceTier !== "all" && lead.sourceTier !== filters.sourceTier) return false;
    if (filters.priority !== "all" && lead.priorityLevel !== filters.priority) return false;
    return true;
  }).sort((a, b) => {
    if (a.priorityScore !== b.priorityScore) {
      return b.priorityScore - a.priorityScore;
    }
    return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  }) || [];

  return (
    <div className="flex flex-col h-full">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-6 border-b border-border">
        <StatsCard 
          title="Today's Leads" 
          value={stats?.today ?? 0} 
          icon={TrendingUp}
        />
        <StatsCard 
          title="This Week" 
          value={stats?.thisWeek ?? 0} 
          icon={Calendar}
        />
        <StatsCard 
          title="High Priority" 
          value={stats?.highPriority ?? 0} 
          icon={AlertCircle}
        />
      </div>

      <div className="sticky top-0 z-50 bg-background border-b border-border p-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <Select value={filters.status} onValueChange={(v) => setFilters(f => ({ ...f, status: v }))}>
              <SelectTrigger className="w-[130px]" data-testid="filter-status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="saved">Saved</SelectItem>
                <SelectItem value="contacted">Contacted</SelectItem>
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
            {(filters.region !== "all" || filters.sourceTier !== "all" || filters.priority !== "all" || filters.status !== "active") && (
              <Button 
                variant="ghost" 
                size="sm"
                onClick={() => setFilters({ dateRange: "all", region: "all", sourceTier: "all", priority: "all", status: "active" })}
                data-testid="button-clear-filters"
              >
                Clear filters
              </Button>
            )}
          </div>
          <Button
            onClick={() => triggerScanMutation.mutate()}
            disabled={triggerScanMutation.isPending}
            data-testid="button-scan-now"
          >
            <RefreshCw className={`h-4 w-4 ${triggerScanMutation.isPending ? "animate-spin" : ""}`} />
            {triggerScanMutation.isPending ? "Scanning..." : "Scan Now"}
          </Button>
        </div>
      </div>

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
              {filters.status !== "active" || filters.region !== "all" || filters.sourceTier !== "all" || filters.priority !== "all"
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
            {filteredLeads.map((lead) => (
              <LeadCard 
                key={lead.id} 
                lead={lead} 
                onUpdateStatus={handleUpdateStatus}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
