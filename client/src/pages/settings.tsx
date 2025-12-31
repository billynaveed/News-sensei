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
  ExternalLink
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
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
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Settings, SourceTier, Source } from "@shared/schema";

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
  useScrapingBee: z.boolean(),
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

function SourcesSection({ 
  sources, 
  isLoading,
  onToggle,
  isToggling
}: { 
  sources: Source[];
  isLoading: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  isToggling: boolean;
}) {
  const tierLabel = (tier: string) => {
    switch (tier) {
      case "tier1": return "Major";
      case "tier2": return "Regional";
      case "tier3": return "Niche";
      default: return tier;
    }
  };

  const typeLabel = (type: string) => {
    switch (type) {
      case "rss": return "RSS";
      case "api": return "API";
      case "scrape": return "Scrape";
      case "manual": return "Manual";
      default: return type;
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
        <div className="flex items-center gap-2">
          <Newspaper className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">News Sources</CardTitle>
        </div>
        <CardDescription>
          Configure which news sources to scan for wealth-related events. Toggle sources on or off.
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
                  <div 
                    key={source.id} 
                    className="flex items-center justify-between gap-4 p-3 rounded-md border bg-card"
                    data-testid={`source-row-${source.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium truncate">{source.name}</span>
                        <Badge variant="outline" className="text-xs">
                          {source.region}
                        </Badge>
                        <Badge variant="secondary" className="text-xs">
                          {typeLabel(source.type || "manual")}
                        </Badge>
                      </div>
                      {source.description && (
                        <p className="text-sm text-muted-foreground mt-1 truncate">
                          {source.description}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <a 
                        href={source.url} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground"
                        data-testid={`link-source-${source.id}`}
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                      <Switch
                        checked={source.enabled}
                        onCheckedChange={(checked) => onToggle(source.id, checked)}
                        disabled={isToggling}
                        data-testid={`switch-source-${source.id}`}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {sources.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No news sources configured. Sources will be added automatically.
          </p>
        )}
        <div className="pt-2 text-sm text-muted-foreground">
          <span className="font-medium">{sources.filter(s => s.enabled).length}</span> of{" "}
          <span className="font-medium">{sources.length}</span> sources enabled
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

  const toggleSourceMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      await apiRequest("PATCH", `/api/sources/${id}/toggle`, { enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sources"] });
    },
    onError: () => {
      toast({
        title: "Error updating source",
        description: "There was a problem updating the source. Please try again.",
        variant: "destructive",
      });
    },
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
      useScrapingBee: false,
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
        useScrapingBee: settings.useScrapingBee ?? false,
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

          <SourcesSection
            sources={sources}
            isLoading={isLoadingSources}
            onToggle={(id, enabled) => toggleSourceMutation.mutate({ id, enabled })}
            isToggling={toggleSourceMutation.isPending}
          />

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Globe className="h-5 w-5 text-primary" />
                <CardTitle className="text-lg">Data Collection</CardTitle>
              </div>
              <CardDescription>
                Configure how news articles are fetched from sources.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="useScrapingBee"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between">
                    <div className="space-y-0.5">
                      <FormLabel>Use ScrapingBee for enhanced scraping</FormLabel>
                      <FormDescription>
                        When enabled, uses ScrapingBee API as a fallback when RSS feeds return no results. 
                        This incurs additional API costs. When disabled, only free RSS feeds are used.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        data-testid="switch-use-scrapingbee"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <div className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-md">
                <strong>Current mode:</strong>{" "}
                {form.watch("useScrapingBee") 
                  ? "RSS feeds + ScrapingBee fallback (may incur API costs)" 
                  : "RSS feeds only (free)"}
              </div>
            </CardContent>
          </Card>

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
