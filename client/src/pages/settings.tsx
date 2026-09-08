import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Save,
  Plus,
  X,
  Globe,
  BrainCircuit,
  Bell,
  Loader2,
  Clock,
  Newspaper,
  ExternalLink,
  Rss,
  Search,
  Trash2,
  ChevronDown,
  ChevronRight,
  Send,
  Info,
  RotateCcw,
  FlaskConical,
  History,
  GitCompare
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

const DEFAULT_REGIONS = [
  "Singapore", "Hong Kong", "Taiwan", "Indonesia",
  "Vietnam", "Thailand", "Malaysia", "Philippines"
];

const settingsSchema = z.object({
  regions: z.array(z.string()).min(1, "At least one region is required"),
  summaryLength: z.enum(["brief", "detailed", "actionable"]),
  scanFrequency: z.enum(["hourly", "daily", "weekly", "manual"]),
  logRetentionDays: z.number().min(1).max(30),
  googleNewsEnabled: z.boolean(),
  rssEnabled: z.boolean(),
  scrapingBeeEnabled: z.boolean(),
});

type SettingsFormData = z.infer<typeof settingsSchema>;

// ============================================================================
// Pipeline prompts (editable + versioned)
// ============================================================================

/** One `{{name}}` slot a prompt template may use. */
interface PromptVariable {
  name: string;
  description: string;
}

/** A prompt's live state, as returned by GET /api/prompts. */
interface PromptState {
  key: string;
  label: string;
  description: string;
  /** False while the prompt is stored but not yet read by the module that sends it. */
  wired: boolean;
  variables: PromptVariable[];
  body: string;
  defaultBody: string;
  version: number;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface PromptVersionRow {
  id: string;
  key: string;
  version: number;
  body: string;
  note: string | null;
  createdAt: string;
}

interface ExampleRunResult {
  ran: number;
  passing: number;
  failing: number;
}

/** One aligned row of a two-column diff. */
interface DiffRow {
  left: string | null;
  right: string | null;
  changed: boolean;
}

/**
 * Line-level diff via longest common subsequence.
 *
 * Prompts are small enough that the O(n*m) table is free (a 200-line prompt is
 * 40k cells), and LCS keeps the view honest about inserted and removed lines
 * rather than pretending every edit is line-for-line.
 */
function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ left: a[i], right: b[j], changed: false });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ left: a[i], right: null, changed: true });
      i++;
    } else {
      rows.push({ left: null, right: b[j], changed: true });
      j++;
    }
  }
  while (i < a.length) rows.push({ left: a[i++], right: null, changed: true });
  while (j < b.length) rows.push({ left: null, right: b[j++], changed: true });
  return rows;
}

function PromptDiff({ oldText, newText, oldLabel, newLabel }: {
  oldText: string;
  newText: string;
  oldLabel: string;
  newLabel: string;
}) {
  const rows = diffLines(oldText, newText);
  const changedCount = rows.filter(r => r.changed).length;

  return (
    <div className="rounded-md border overflow-hidden" data-testid="prompt-diff">
      <div className="grid grid-cols-2 text-xs font-medium bg-muted/60">
        <div className="px-3 py-1.5 border-r">{oldLabel}</div>
        <div className="px-3 py-1.5">{newLabel}</div>
      </div>
      {changedCount === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">Identical — no changes.</p>
      ) : (
        <div className="max-h-80 overflow-auto">
          {rows.map((row, index) => (
            <div key={index} className="grid grid-cols-2 font-mono text-xs">
              <div className={`px-3 py-0.5 border-r whitespace-pre-wrap break-words ${
                row.changed && row.left !== null ? "bg-red-500/10" : ""
              }`}>
                {row.left ?? ""}
              </div>
              <div className={`px-3 py-0.5 whitespace-pre-wrap break-words ${
                row.changed && row.right !== null ? "bg-green-500/10" : ""
              }`}>
                {row.right ?? ""}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Editor for one prompt: body, variable chips, save-with-note, reset, and the
 * version history with one-click revert and a side-by-side diff.
 */
function PromptEditor({ prompt, onChanged }: { prompt: PromptState; onChanged: () => void }) {
  const { toast } = useToast();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(prompt.body);
  const [note, setNote] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [diffVersion, setDiffVersion] = useState<number | null>(null);

  // Re-seed the draft whenever a different prompt (or a newer version of the
  // same one) arrives, so a save/revert/reset is reflected in the textarea.
  useEffect(() => {
    setDraft(prompt.body);
    setNote("");
    setDiffVersion(null);
  }, [prompt.key, prompt.version, prompt.body]);

  const { data: history } = useQuery<{ versions: PromptVersionRow[] }>({
    queryKey: ["/api/prompts", prompt.key, "versions"],
    enabled: historyOpen,
  });
  const versions = history?.versions ?? [];

  const isDirty = draft !== prompt.body;
  const unknownVariables = Array.from(
    new Set(Array.from(draft.matchAll(/\{\{\s*(\w+)\s*\}\}/g)).map(m => m[1]))
  ).filter(name => !prompt.variables.some(v => v.name === name));

  const afterMutation = (title: string, description: string) => {
    queryClient.invalidateQueries({ queryKey: ["/api/prompts"] });
    queryClient.invalidateQueries({ queryKey: ["/api/prompts", prompt.key, "versions"] });
    onChanged();
    toast({ title, description });
  };

  const onError = (error: unknown) => {
    toast({
      title: "Could not save prompt",
      description: error instanceof Error ? error.message : "Unknown error",
      variant: "destructive",
    });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PUT", `/api/prompts/${prompt.key}`, { body: draft, note: note || undefined });
    },
    onSuccess: () => afterMutation("Prompt saved", `${prompt.label} is now version ${prompt.version + 1}.`),
    onError,
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/prompts/${prompt.key}/reset`);
    },
    onSuccess: () => afterMutation("Reset to default", `${prompt.label} now uses the built-in prompt.`),
    onError,
  });

  const revertMutation = useMutation({
    mutationFn: async (version: number) => {
      await apiRequest("POST", `/api/prompts/${prompt.key}/revert`, { version });
    },
    onSuccess: () => afterMutation("Reverted", `${prompt.label} restored from history.`),
    onError,
  });

  const insertVariable = (name: string) => {
    const textarea = textareaRef.current;
    const token = `{{${name}}}`;
    if (!textarea) {
      setDraft(current => current + token);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    setDraft(current => current.slice(0, start) + token + current.slice(end));
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const diffSource = diffVersion === null
    ? null
    : diffVersion === 0
      ? { label: "Built-in default", body: prompt.defaultBody }
      : { label: `v${diffVersion}`, body: versions.find(v => v.version === diffVersion)?.body ?? "" };

  return (
    <div className="space-y-4 rounded-md border p-4" data-testid={`prompt-editor-${prompt.key}`}>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{prompt.label}</h3>
          <Badge variant="outline" className="text-xs font-mono">{prompt.key}</Badge>
          {!prompt.wired && (
            <Badge variant="secondary" className="text-xs">Reference only — not yet used</Badge>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{prompt.description}</p>
      </div>

      {prompt.variables.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            Variables (click to insert — these are filled in per article):
          </p>
          <div className="flex flex-wrap gap-1.5">
            {prompt.variables.map(variable => (
              <button
                key={variable.name}
                type="button"
                title={variable.description}
                onClick={() => insertVariable(variable.name)}
                className="rounded border bg-muted px-2 py-0.5 font-mono text-xs hover-elevate"
                data-testid={`button-insert-var-${variable.name}`}
              >
                {`{{${variable.name}}}`}
              </button>
            ))}
          </div>
        </div>
      )}

      <Textarea
        ref={textareaRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        className="min-h-[320px] font-mono text-xs leading-relaxed resize-y"
        spellCheck={false}
        data-testid={`textarea-prompt-${prompt.key}`}
      />

      {unknownVariables.length > 0 && (
        <p className="text-sm text-destructive">
          Unknown variable{unknownVariables.length > 1 ? "s" : ""}:{" "}
          {unknownVariables.map(name => `{{${name}}}`).join(", ")} — saving will be rejected.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="Optional note — what did you change and why?"
          className="h-9 flex-1 min-w-[220px]"
          data-testid={`input-prompt-note-${prompt.key}`}
        />
        <Button
          type="button"
          size="sm"
          disabled={!isDirty || unknownVariables.length > 0 || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
          data-testid={`button-save-prompt-${prompt.key}`}
        >
          {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!isDirty}
          onClick={() => setDraft(prompt.body)}
          data-testid={`button-discard-prompt-${prompt.key}`}
        >
          Discard
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={prompt.isDefault || resetMutation.isPending}
          onClick={() => resetMutation.mutate()}
          data-testid={`button-reset-prompt-${prompt.key}`}
        >
          <RotateCcw className="h-3 w-3" />
          Reset to default
        </Button>
        {!prompt.isDefault && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setDiffVersion(diffVersion === 0 ? null : 0)}
            data-testid={`button-diff-default-${prompt.key}`}
          >
            <GitCompare className="h-3 w-3" />
            Diff vs default
          </Button>
        )}
      </div>

      {diffSource && (
        <PromptDiff
          oldText={diffSource.body}
          newText={draft}
          oldLabel={diffSource.label}
          newLabel={isDirty ? "Your unsaved draft" : `Current (v${prompt.version})`}
        />
      )}

      <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" data-testid={`button-history-${prompt.key}`}>
            {historyOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <History className="h-3 w-3" />
            Version history
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          {versions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No saved versions yet — this prompt is still the built-in default.
            </p>
          ) : (
            <div className="space-y-1.5">
              {versions.map(version => (
                <div
                  key={version.id}
                  className="flex flex-wrap items-center gap-2 rounded border px-3 py-2 text-sm"
                  data-testid={`row-prompt-version-${version.version}`}
                >
                  <Badge variant={version.version === prompt.version ? "default" : "outline"} className="text-xs">
                    v{version.version}
                  </Badge>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {new Date(version.createdAt).toLocaleString()}
                  </span>
                  <span className="flex-1 min-w-[120px] truncate text-muted-foreground">
                    {version.note ?? "No note"}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setDiffVersion(diffVersion === version.version ? null : version.version)}
                    data-testid={`button-diff-version-${version.version}`}
                  >
                    <GitCompare className="h-3 w-3" />
                    Diff
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={version.version === prompt.version || revertMutation.isPending}
                    onClick={() => revertMutation.mutate(version.version)}
                    data-testid={`button-revert-version-${version.version}`}
                  >
                    Revert
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/**
 * "Pipeline prompts" settings section: pick a prompt, edit it, and check the
 * edit against the reference articles Billy has taught Sensei about.
 *
 * Deliberately rendered outside the settings <form> — these mutations save
 * themselves immediately and must not be swept up by the form's submit.
 */
function PipelinePromptsSection() {
  const { toast } = useToast();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ExampleRunResult | null>(null);

  const { data, isLoading } = useQuery<{ prompts: PromptState[] }>({
    queryKey: ["/api/prompts"],
  });
  const prompts = data?.prompts ?? [];
  const selected = prompts.find(p => p.key === selectedKey) ?? null;

  const testMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/pipeline/examples/run");
      return (await response.json()) as ExampleRunResult;
    },
    onSuccess: result => {
      setTestResult(result);
      toast({
        title: "Examples re-run",
        description: `${result.passing}/${result.ran} matched what you taught Sensei.`,
      });
    },
    onError: error => {
      toast({
        title: "Could not run examples",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <BrainCircuit className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Pipeline prompts</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending}
              data-testid="button-test-examples"
            >
              {testMutation.isPending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <FlaskConical className="h-4 w-4" />}
              Test against my examples
            </Button>
            <Link href="/debug">
              <Button type="button" variant="ghost" size="sm" data-testid="link-debug-examples">
                <ExternalLink className="h-3 w-3" />
                Per-example results
              </Button>
            </Link>
          </div>
        </div>
        <CardDescription>
          Every judgement Sensei makes about an article comes from one of these prompts. Edit them
          here instead of in code — each save is versioned, so a change that makes things worse is
          one click from being undone. Then re-run your reference articles to see the effect.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {testResult && (
          <div className="rounded-md bg-muted/50 p-3 text-sm" data-testid="text-example-result">
            Ran <span className="font-medium tabular-nums">{testResult.ran}</span> reference
            article{testResult.ran === 1 ? "" : "s"}:{" "}
            <span className="font-medium text-green-600 tabular-nums">{testResult.passing} as taught</span>,{" "}
            <span className={`font-medium tabular-nums ${testResult.failing > 0 ? "text-destructive" : ""}`}>
              {testResult.failing} off
            </span>
            . <Link href="/debug" className="underline">See which ones on the Debug page.</Link>
          </div>
        )}

        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <div className="space-y-1.5">
            {prompts.map(prompt => {
              const isSelected = prompt.key === selectedKey;
              return (
                <button
                  key={prompt.key}
                  type="button"
                  onClick={() => setSelectedKey(isSelected ? null : prompt.key)}
                  className={`flex w-full flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-left hover-elevate ${
                    isSelected ? "border-primary" : ""
                  }`}
                  data-testid={`button-select-prompt-${prompt.key}`}
                >
                  {isSelected
                    ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  <span className="font-medium text-sm">{prompt.label}</span>
                  {prompt.isDefault ? (
                    <Badge variant="outline" className="text-xs">Default</Badge>
                  ) : (
                    <Badge className="text-xs">Modified · v{prompt.version}</Badge>
                  )}
                  {!prompt.wired && (
                    <Badge variant="secondary" className="text-xs">Reference only</Badge>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {prompt.body.length.toLocaleString()} chars
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {selected && <PromptEditor prompt={selected} onChanged={() => setTestResult(null)} />}
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
                          placeholder="https://www.straitstimes.com/news/business/rss.xml"
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
      regions: DEFAULT_REGIONS,
      summaryLength: "brief",
      scanFrequency: "hourly",
      logRetentionDays: 2,
      googleNewsEnabled: false,
      rssEnabled: true,
      scrapingBeeEnabled: false,
    },
  });

  useEffect(() => {
    if (settings) {
      form.reset({
        regions: settings.regions,
        summaryLength: settings.summaryLength as "brief" | "detailed" | "actionable",
        scanFrequency: (settings.scanFrequency as "hourly" | "daily" | "weekly" | "manual") ?? "hourly",
        logRetentionDays: settings.logRetentionDays ?? 2,
        googleNewsEnabled: settings.googleNewsEnabled ?? false,
        rssEnabled: settings.rssEnabled ?? true,
        scrapingBeeEnabled: settings.scrapingBeeEnabled ?? false,
      });
    }
  }, [settings, form]);

  const saveMutation = useMutation({
    mutationFn: async (data: SettingsFormData) => {
      // Stage 1's prompt moved to the "Pipeline prompts" section (key
      // "stage1_interest"). The legacy settings column is echoed back unchanged
      // so a settings save never silently rewrites it.
      await apiRequest("PUT", "/api/settings", {
        ...data,
        ...(settings ? { interestFilterPrompt: settings.interestFilterPrompt } : {}),
      });
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

  const testTelegramMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/test-telegram");
    },
    onSuccess: () => {
      toast({
        title: "Test message sent",
        description: "Check your Telegram for a test alert.",
      });
    },
    onError: () => {
      toast({
        title: "Error sending Telegram message",
        description: "There was a problem sending the test message.",
        variant: "destructive",
      });
    },
  });

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

      <PipelinePromptsSection />

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
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
                Configure how you receive notifications about new leads.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex flex-row items-center justify-between">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <Send className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium">Telegram Alerts</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Receive instant Telegram notifications for new leads.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => testTelegramMutation.mutate()}
                  disabled={testTelegramMutation.isPending}
                  data-testid="button-test-telegram"
                >
                  {testTelegramMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Test Telegram"
                  )}
                </Button>
              </div>

              <Separator />

              <FormField
                control={form.control}
                name="scanFrequency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Scan Frequency</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-scan-frequency">
                          <SelectValue placeholder="Select frequency" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="hourly">Hourly - Scans every hour</SelectItem>
                        <SelectItem value="daily">Daily - Scans once per day at 9:00 AM</SelectItem>
                        <SelectItem value="weekly">Weekly - Scans every Monday at 9:00 AM</SelectItem>
                        <SelectItem value="manual">Manual - Only scan when triggered</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      How often to automatically scan news sources for new leads and send Telegram notifications.
                    </FormDescription>
                  </FormItem>
                )}
              />

              <Separator />

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
