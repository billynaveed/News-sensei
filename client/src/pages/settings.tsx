import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { 
  Save, 
  Plus, 
  X, 
  Mail, 
  Globe, 
  Tag,
  Bell,
  Loader2,
  Clock,
  Newspaper,
  ExternalLink,
  Rss,
  Search,
  Trash2,
  ChevronDown,
  ChevronRight
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Settings, SourceTier, Source, RssFeed } from "@shared/schema";

const DEFAULT_KEYWORDS = [
  "Liquidity event", "IPO", "Initial Public Offering", "Trade sale",
  "Private equity exit", "PE acquisition", "Merger & acquisition", "M&A deal",
  "Founder exit", "Startup funding Series C", "Startup funding Series D",
  "Unicorn", "SPAC merger", "Secondary sale", "Family office",
  "High net worth", "Asset sale", "Divestiture", "Stake sale",
  "Cashed out", "Sold stake", "Exit deal", "Buyout"
];

const DEFAULT_REGIONS = [
  "Singapore", "Hong Kong", "Taiwan", "Indonesia", 
  "Vietnam", "Thailand", "Malaysia", "Philippines"
];

const settingsSchema = z.object({
  keywords: z.array(z.string()).min(1, "At least one keyword is required"),
  regions: z.array(z.string()).min(1, "At least one region is required"),
  summaryLength: z.enum(["brief", "detailed", "actionable"]),
  emailFrequency: z.enum(["hourly", "daily", "weekly"]),
  emailEnabled: z.boolean(),
  alertEmail: z.string().email("Please enter a valid email address"),
  logRetentionDays: z.number().min(1).max(30),
  googleNewsEnabled: z.boolean(),
  rssEnabled: z.boolean(),
  scrapingBeeEnabled: z.boolean(),
});

type SettingsFormData = z.infer<typeof settingsSchema>;

function KeywordsSection({ 
  keywords, 
  onAdd, 
  onRemove 
}: { 
  keywords: string[]; 
  onAdd: (keyword: string) => void; 
  onRemove: (keyword: string) => void;
}) {
  const [newKeyword, setNewKeyword] = useState("");

  const handleAdd = () => {
    if (newKeyword.trim() && !keywords.includes(newKeyword.trim())) {
      onAdd(newKeyword.trim());
      setNewKeyword("");
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Tag className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">Keywords</CardTitle>
        </div>
        <CardDescription>
          Define the keywords to scan for in news articles. These identify wealth-related events.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            placeholder="Add new keyword..."
            value={newKeyword}
            onChange={(e) => setNewKeyword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAdd())}
            data-testid="input-new-keyword"
          />
          <Button onClick={handleAdd} disabled={!newKeyword.trim()} data-testid="button-add-keyword">
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {keywords.map((keyword) => (
            <Badge key={keyword} variant="secondary" className="pr-1">
              {keyword}
              <Button
                variant="ghost"
                size="icon"
                className="h-4 w-4 ml-1 hover:bg-transparent"
                onClick={() => onRemove(keyword)}
                data-testid={`button-remove-keyword-${keyword}`}
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          ))}
        </div>
        {keywords.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No keywords configured. Add keywords to start scanning.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function RegionsSection({ 
  regions, 
  allRegions,
  onToggle 
}: { 
  regions: string[]; 
  allRegions: string[];
  onToggle: (region: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Globe className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">Target Regions</CardTitle>
        </div>
        <CardDescription>
          Select the Southeast Asian regions to monitor for wealth-related news.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {allRegions.map((region) => {
            const isActive = regions.includes(region);
            return (
              <Button
                key={region}
                variant={isActive ? "default" : "outline"}
                className="justify-start"
                onClick={() => onToggle(region)}
                data-testid={`button-region-${region.toLowerCase().replace(" ", "-")}`}
              >
                {region}
              </Button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function GlobalMethodToggles({
  googleNewsEnabled,
  rssEnabled,
  scrapingBeeEnabled,
  onToggle,
}: {
  googleNewsEnabled: boolean;
  rssEnabled: boolean;
  scrapingBeeEnabled: boolean;
  onToggle: (method: 'googleNews' | 'rss' | 'scrapingBee', value: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Search className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">Scanning Methods</CardTitle>
        </div>
        <CardDescription>
          Configure which methods to use for scanning ALL active websites. These toggles apply globally.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-row items-center justify-between p-3 rounded-md border">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Google News Search</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Search Google News for articles from all active websites.
            </p>
          </div>
          <Switch
            checked={googleNewsEnabled}
            onCheckedChange={(checked) => onToggle('googleNews', checked)}
            data-testid="switch-google-news"
          />
        </div>

        <div className="flex flex-row items-center justify-between p-3 rounded-md border">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Rss className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">RSS Feeds</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Fetch articles from all configured RSS feeds.
            </p>
          </div>
          <Switch
            checked={rssEnabled}
            onCheckedChange={(checked) => onToggle('rss', checked)}
            data-testid="switch-rss"
          />
        </div>

        <div className="flex flex-row items-center justify-between p-3 rounded-md border">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">ScrapingBee</span>
              <Badge variant="secondary" className="text-xs">Paid</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Use ScrapingBee API for enhanced web scraping. Incurs API costs.
            </p>
          </div>
          <Switch
            checked={scrapingBeeEnabled}
            onCheckedChange={(checked) => onToggle('scrapingBee', checked)}
            data-testid="switch-scrapingbee"
          />
        </div>

        <div className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-md">
          <strong>Active methods:</strong>{" "}
          {[
            googleNewsEnabled && "Google News",
            rssEnabled && "RSS Feeds",
            scrapingBeeEnabled && "ScrapingBee",
          ].filter(Boolean).join(", ") || "None (scanning disabled)"}
        </div>
      </CardContent>
    </Card>
  );
}

function SourceCard({
  source,
  rssFeeds,
  isLoadingFeeds,
  onToggle,
  onAddFeed,
  onDeleteFeed,
  onToggleFeed,
  onDeleteSource,
}: {
  source: Source;
  rssFeeds: RssFeed[];
  isLoadingFeeds: boolean;
  onToggle: (active: boolean) => void;
  onAddFeed: (feed: { name: string; url: string }) => void;
  onDeleteFeed: (feedId: string) => void;
  onToggleFeed: (feedId: string, active: boolean) => void;
  onDeleteSource: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [newFeedName, setNewFeedName] = useState("");
  const [newFeedUrl, setNewFeedUrl] = useState("");
  const [addFeedOpen, setAddFeedOpen] = useState(false);

  const tierLabel = (tier: string) => {
    switch (tier) {
      case "tier1": return "Major";
      case "tier2": return "Regional";
      case "tier3": return "Niche";
      default: return tier;
    }
  };

  const handleAddFeed = () => {
    if (newFeedName.trim() && newFeedUrl.trim()) {
      onAddFeed({ name: newFeedName.trim(), url: newFeedUrl.trim() });
      setNewFeedName("");
      setNewFeedUrl("");
      setAddFeedOpen(false);
    }
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="border rounded-md bg-card">
        <CollapsibleTrigger asChild>
          <div 
            className="flex items-center justify-between gap-4 p-3 cursor-pointer hover-elevate"
            data-testid={`source-row-${source.id}`}
          >
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
              <span className="font-medium truncate">{source.name}</span>
              <Badge variant="outline" className="text-xs shrink-0">
                {tierLabel(source.tier)}
              </Badge>
              <span className="text-sm text-muted-foreground truncate">
                {source.domain}
              </span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <Badge variant="secondary" className="text-xs">
                {rssFeeds.length} feed{rssFeeds.length !== 1 ? 's' : ''}
              </Badge>
              <Switch
                checked={source.active}
                onCheckedChange={(checked) => {
                  onToggle(checked);
                }}
                onClick={(e) => e.stopPropagation()}
                data-testid={`switch-source-${source.id}`}
              />
            </div>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t px-3 pb-3 space-y-3">
            <div className="flex items-center justify-between pt-3">
              <h4 className="text-sm font-medium text-muted-foreground">RSS Feeds</h4>
              <div className="flex items-center gap-2">
                <Dialog open={addFeedOpen} onOpenChange={setAddFeedOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" variant="outline" data-testid={`button-add-feed-${source.id}`}>
                      <Plus className="h-3 w-3" />
                      Add Feed
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add RSS Feed</DialogTitle>
                      <DialogDescription>
                        Add a new RSS feed for {source.name}
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Feed Name</label>
                        <Input
                          placeholder="e.g., Companies & Markets"
                          value={newFeedName}
                          onChange={(e) => setNewFeedName(e.target.value)}
                          data-testid="input-new-feed-name"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">RSS URL</label>
                        <Input
                          placeholder="https://example.com/rss/feed.xml"
                          value={newFeedUrl}
                          onChange={(e) => setNewFeedUrl(e.target.value)}
                          data-testid="input-new-feed-url"
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setAddFeedOpen(false)}>
                        Cancel
                      </Button>
                      <Button 
                        onClick={handleAddFeed}
                        disabled={!newFeedName.trim() || !newFeedUrl.trim()}
                        data-testid="button-confirm-add-feed"
                      >
                        Add Feed
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                <Button 
                  size="sm" 
                  variant="ghost" 
                  className="text-destructive hover:text-destructive"
                  onClick={onDeleteSource}
                  data-testid={`button-delete-source-${source.id}`}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
            
            {isLoadingFeeds ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : rssFeeds.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                No RSS feeds configured for this source.
              </p>
            ) : (
              <div className="space-y-2">
                {rssFeeds.map((feed) => (
                  <div 
                    key={feed.id}
                    className="flex items-center justify-between gap-3 p-2 rounded-md bg-muted/50"
                    data-testid={`feed-row-${feed.id}`}
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Rss className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="text-sm font-medium truncate">{feed.name}</span>
                      <span className="text-xs text-muted-foreground truncate hidden sm:block">
                        {feed.url}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Switch
                        checked={feed.active}
                        onCheckedChange={(checked) => onToggleFeed(feed.id, checked)}
                        data-testid={`switch-feed-${feed.id}`}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => onDeleteFeed(feed.id)}
                        data-testid={`button-delete-feed-${feed.id}`}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function SourcesSection({ 
  sources, 
  isLoading,
}: { 
  sources: Source[];
  isLoading: boolean;
}) {
  const { toast } = useToast();
  const [newSourceName, setNewSourceName] = useState("");
  const [newSourceDomain, setNewSourceDomain] = useState("");
  const [newSourceTier, setNewSourceTier] = useState<SourceTier>("tier2");
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [rssFeedsBySource, setRssFeedsBySource] = useState<Record<string, RssFeed[]>>({});
  const [loadingFeeds, setLoadingFeeds] = useState<Set<string>>(new Set());

  const fetchFeedsForSource = async (sourceId: string) => {
    if (rssFeedsBySource[sourceId] !== undefined) return;
    setLoadingFeeds(prev => new Set(prev).add(sourceId));
    try {
      const res = await fetch(`/api/sources/${sourceId}/rss-feeds`);
      const feeds = await res.json();
      setRssFeedsBySource(prev => ({ ...prev, [sourceId]: feeds }));
    } catch (error) {
      console.error("Error fetching feeds:", error);
    } finally {
      setLoadingFeeds(prev => {
        const next = new Set(prev);
        next.delete(sourceId);
        return next;
      });
    }
  };

  useEffect(() => {
    sources.forEach(source => {
      fetchFeedsForSource(source.id);
    });
  }, [sources]);

  const toggleSourceMutation = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      await apiRequest("PATCH", `/api/sources/${id}`, { active });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sources"] });
    },
    onError: () => {
      toast({
        title: "Error updating source",
        description: "There was a problem updating the source.",
        variant: "destructive",
      });
    },
  });

  const createSourceMutation = useMutation({
    mutationFn: async (data: { name: string; domain: string; tier: SourceTier }) => {
      await apiRequest("POST", "/api/sources", { ...data, active: true });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sources"] });
      setNewSourceName("");
      setNewSourceDomain("");
      setNewSourceTier("tier2");
      setAddSourceOpen(false);
      toast({ title: "Source added", description: "New source has been added." });
    },
    onError: () => {
      toast({
        title: "Error creating source",
        description: "There was a problem creating the source.",
        variant: "destructive",
      });
    },
  });

  const deleteSourceMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/sources/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sources"] });
      toast({ title: "Source deleted", description: "Source has been removed." });
    },
    onError: () => {
      toast({
        title: "Error deleting source",
        description: "There was a problem deleting the source.",
        variant: "destructive",
      });
    },
  });

  const createFeedMutation = useMutation({
    mutationFn: async (data: { sourceId: string; name: string; url: string }) => {
      await apiRequest("POST", "/api/rss-feeds", { ...data, active: true });
    },
    onSuccess: (_, variables) => {
      setRssFeedsBySource(prev => ({ ...prev, [variables.sourceId]: undefined as any }));
      fetchFeedsForSource(variables.sourceId);
      toast({ title: "Feed added", description: "RSS feed has been added." });
    },
    onError: () => {
      toast({
        title: "Error creating feed",
        description: "There was a problem creating the feed.",
        variant: "destructive",
      });
    },
  });

  const toggleFeedMutation = useMutation({
    mutationFn: async ({ id, active, sourceId }: { id: string; active: boolean; sourceId: string }) => {
      await apiRequest("PATCH", `/api/rss-feeds/${id}`, { active });
      return { sourceId };
    },
    onSuccess: (_, variables) => {
      setRssFeedsBySource(prev => ({ ...prev, [variables.sourceId]: undefined as any }));
      fetchFeedsForSource(variables.sourceId);
    },
  });

  const deleteFeedMutation = useMutation({
    mutationFn: async ({ id, sourceId }: { id: string; sourceId: string }) => {
      await apiRequest("DELETE", `/api/rss-feeds/${id}`);
      return { sourceId };
    },
    onSuccess: (_, variables) => {
      setRssFeedsBySource(prev => ({ ...prev, [variables.sourceId]: undefined as any }));
      fetchFeedsForSource(variables.sourceId);
      toast({ title: "Feed deleted", description: "RSS feed has been removed." });
    },
  });

  const tierLabel = (tier: string) => {
    switch (tier) {
      case "tier1": return "Major";
      case "tier2": return "Regional";
      case "tier3": return "Niche";
      default: return tier;
    }
  };

  const groupedSources = sources.reduce((acc, source) => {
    const tier = source.tier || "tier2";
    if (!acc[tier]) acc[tier] = [];
    acc[tier].push(source);
    return acc;
  }, {} as Record<string, Source[]>);

  const tierOrder = ["tier1", "tier2", "tier3"];

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Newspaper className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">News Sources</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Newspaper className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">News Sources</CardTitle>
          </div>
          <Dialog open={addSourceOpen} onOpenChange={setAddSourceOpen}>
            <DialogTrigger asChild>
              <Button size="sm" data-testid="button-add-source">
                <Plus className="h-4 w-4" />
                Add Source
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add News Source</DialogTitle>
                <DialogDescription>
                  Add a new website to monitor for news articles.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Source Name</label>
                  <Input
                    placeholder="e.g., Business Times Singapore"
                    value={newSourceName}
                    onChange={(e) => setNewSourceName(e.target.value)}
                    data-testid="input-new-source-name"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Domain</label>
                  <Input
                    placeholder="e.g., businesstimes.com.sg"
                    value={newSourceDomain}
                    onChange={(e) => setNewSourceDomain(e.target.value)}
                    data-testid="input-new-source-domain"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Tier</label>
                  <Select value={newSourceTier} onValueChange={(v) => setNewSourceTier(v as SourceTier)}>
                    <SelectTrigger data-testid="select-new-source-tier">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tier1">Major (Tier 1)</SelectItem>
                      <SelectItem value="tier2">Regional (Tier 2)</SelectItem>
                      <SelectItem value="tier3">Niche (Tier 3)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAddSourceOpen(false)}>
                  Cancel
                </Button>
                <Button 
                  onClick={() => createSourceMutation.mutate({
                    name: newSourceName,
                    domain: newSourceDomain,
                    tier: newSourceTier,
                  })}
                  disabled={!newSourceName.trim() || !newSourceDomain.trim() || createSourceMutation.isPending}
                  data-testid="button-confirm-add-source"
                >
                  {createSourceMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add Source"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        <CardDescription>
          Configure which news sources to scan. Each source can have multiple RSS feeds.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {tierOrder.map((tier) => {
          const tierSources = groupedSources[tier];
          if (!tierSources || tierSources.length === 0) return null;
          
          return (
            <div key={tier} className="space-y-3">
              <h3 className="text-sm font-medium text-muted-foreground">
                {tierLabel(tier)} Sources
              </h3>
              <div className="space-y-2">
                {tierSources.map((source) => (
                  <SourceCard
                    key={source.id}
                    source={source}
                    rssFeeds={rssFeedsBySource[source.id] || []}
                    isLoadingFeeds={loadingFeeds.has(source.id)}
                    onToggle={(active) => toggleSourceMutation.mutate({ id: source.id, active })}
                    onAddFeed={(feed) => createFeedMutation.mutate({ sourceId: source.id, ...feed })}
                    onDeleteFeed={(feedId) => deleteFeedMutation.mutate({ id: feedId, sourceId: source.id })}
                    onToggleFeed={(feedId, active) => toggleFeedMutation.mutate({ id: feedId, active, sourceId: source.id })}
                    onDeleteSource={() => deleteSourceMutation.mutate(source.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
        {sources.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No news sources configured. Add sources to start scanning.
          </p>
        )}
        <div className="pt-2 text-sm text-muted-foreground">
          <span className="font-medium">{sources.filter(s => s.active).length}</span> of{" "}
          <span className="font-medium">{sources.length}</span> sources active
        </div>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { toast } = useToast();

  const { data: settings, isLoading } = useQuery<Settings>({
    queryKey: ["/api/settings"],
  });

  const { data: sources = [], isLoading: isLoadingSources } = useQuery<Source[]>({
    queryKey: ["/api/sources"],
  });

  const form = useForm<SettingsFormData>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      keywords: DEFAULT_KEYWORDS,
      regions: DEFAULT_REGIONS,
      summaryLength: "brief",
      emailFrequency: "daily",
      emailEnabled: true,
      alertEmail: "",
      logRetentionDays: 2,
      googleNewsEnabled: false,
      rssEnabled: true,
      scrapingBeeEnabled: false,
    },
  });

  useEffect(() => {
    if (settings) {
      form.reset({
        keywords: settings.keywords,
        regions: settings.regions,
        summaryLength: settings.summaryLength as "brief" | "detailed" | "actionable",
        emailFrequency: settings.emailFrequency as "hourly" | "daily" | "weekly",
        emailEnabled: settings.emailEnabled,
        alertEmail: settings.alertEmail,
        logRetentionDays: settings.logRetentionDays ?? 2,
        googleNewsEnabled: settings.googleNewsEnabled ?? false,
        rssEnabled: settings.rssEnabled ?? true,
        scrapingBeeEnabled: settings.scrapingBeeEnabled ?? false,
      });
    }
  }, [settings, form]);

  const saveMutation = useMutation({
    mutationFn: async (data: SettingsFormData) => {
      await apiRequest("PUT", "/api/settings", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({
        title: "Settings saved",
        description: "Your preferences have been updated successfully.",
      });
    },
    onError: () => {
      toast({
        title: "Error saving settings",
        description: "There was a problem saving your settings. Please try again.",
        variant: "destructive",
      });
    },
  });

  const testEmailMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/test-email");
    },
    onSuccess: () => {
      toast({
        title: "Test email sent",
        description: "Check your inbox for a test alert email.",
      });
    },
    onError: () => {
      toast({
        title: "Error sending test email",
        description: "There was a problem sending the test email. Please check your settings.",
        variant: "destructive",
      });
    },
  });

  const handleAddKeyword = (keyword: string) => {
    const current = form.getValues("keywords");
    form.setValue("keywords", [...current, keyword], { shouldDirty: true });
  };

  const handleRemoveKeyword = (keyword: string) => {
    const current = form.getValues("keywords");
    form.setValue("keywords", current.filter(k => k !== keyword), { shouldDirty: true });
  };

  const handleToggleRegion = (region: string) => {
    const current = form.getValues("regions");
    if (current.includes(region)) {
      form.setValue("regions", current.filter(r => r !== region), { shouldDirty: true });
    } else {
      form.setValue("regions", [...current, region], { shouldDirty: true });
    }
  };

  const handleToggleMethod = (method: 'googleNews' | 'rss' | 'scrapingBee', value: boolean) => {
    if (method === 'googleNews') {
      form.setValue("googleNewsEnabled", value, { shouldDirty: true });
    } else if (method === 'rss') {
      form.setValue("rssEnabled", value, { shouldDirty: true });
    } else if (method === 'scrapingBee') {
      form.setValue("scrapingBeeEnabled", value, { shouldDirty: true });
    }
  };

  const onSubmit = (data: SettingsFormData) => {
    saveMutation.mutate(data);
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-6 max-w-4xl mx-auto">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto overflow-auto h-full">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Configure your lead intelligence preferences and alert settings.
        </p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <KeywordsSection
            keywords={form.watch("keywords")}
            onAdd={handleAddKeyword}
            onRemove={handleRemoveKeyword}
          />

          <RegionsSection
            regions={form.watch("regions")}
            allRegions={DEFAULT_REGIONS}
            onToggle={handleToggleRegion}
          />

          <GlobalMethodToggles
            googleNewsEnabled={form.watch("googleNewsEnabled")}
            rssEnabled={form.watch("rssEnabled")}
            scrapingBeeEnabled={form.watch("scrapingBeeEnabled")}
            onToggle={handleToggleMethod}
          />

          <SourcesSection
            sources={sources}
            isLoading={isLoadingSources}
          />

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Bell className="h-5 w-5 text-primary" />
                <CardTitle className="text-lg">Alert Preferences</CardTitle>
              </div>
              <CardDescription>
                Configure how and when you receive email alerts about new leads.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <FormField
                control={form.control}
                name="emailEnabled"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between">
                    <div className="space-y-0.5">
                      <FormLabel>Email Alerts</FormLabel>
                      <FormDescription>
                        Receive email notifications when new high-priority leads are found.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        data-testid="switch-email-enabled"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <Separator />

              <FormField
                control={form.control}
                name="alertEmail"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Alert Email Address</FormLabel>
                    <FormControl>
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                          <Input 
                            placeholder="your@email.com" 
                            className="pl-10" 
                            {...field} 
                            data-testid="input-alert-email"
                          />
                        </div>
                        <Button 
                          type="button"
                          variant="outline"
                          onClick={() => testEmailMutation.mutate()}
                          disabled={testEmailMutation.isPending || !field.value}
                          data-testid="button-test-email"
                        >
                          {testEmailMutation.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            "Test"
                          )}
                        </Button>
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="emailFrequency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Alert Frequency</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-email-frequency">
                            <SelectValue placeholder="Select frequency" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="hourly">Hourly</SelectItem>
                          <SelectItem value="daily">Daily Digest</SelectItem>
                          <SelectItem value="weekly">Weekly Summary</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        How often to send alert emails.
                      </FormDescription>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="summaryLength"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>AI Summary Length</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-summary-length">
                            <SelectValue placeholder="Select length" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="brief">Brief (1-2 sentences)</SelectItem>
                          <SelectItem value="detailed">Detailed (1 paragraph)</SelectItem>
                          <SelectItem value="actionable">Actionable (with recommendations)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Length of AI-generated summaries.
                      </FormDescription>
                    </FormItem>
                  )}
                />
              </div>

              <Separator />

              <FormField
                control={form.control}
                name="logRetentionDays"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between gap-4">
                    <div className="space-y-0.5 flex-1">
                      <FormLabel className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        Log Retention Period
                      </FormLabel>
                      <FormDescription>
                        How long to keep scan history logs before automatic cleanup.
                      </FormDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      <FormControl>
                        <Input 
                          type="number" 
                          min={1} 
                          max={30}
                          className="w-20 text-center"
                          {...field}
                          onChange={(e) => field.onChange(parseInt(e.target.value) || 1)}
                          data-testid="input-log-retention-days"
                        />
                      </FormControl>
                      <span className="text-sm text-muted-foreground">days</span>
                    </div>
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => form.reset()}
              disabled={!form.formState.isDirty}
              data-testid="button-reset-settings"
            >
              Reset
            </Button>
            <Button 
              type="submit" 
              disabled={saveMutation.isPending || !form.formState.isDirty}
              data-testid="button-save-settings"
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save Settings
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
