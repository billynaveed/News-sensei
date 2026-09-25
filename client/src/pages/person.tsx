/**
 * Person page — everything Sensei knows about one human, stacked over time.
 *
 * Billy opens this before a call: who they are, which family tree they sit in,
 * whether they're covered by another banker, and every mention, deal and note
 * in date order. Notes write through to `contact_meta`, the same store the
 * Contacts page uses.
 */

import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation, useRoute } from "wouter";
import { format } from "date-fns";
import {
  ArrowLeft,
  Ban,
  BellOff,
  Bookmark,
  BookmarkCheck,
  Building2,
  Calendar,
  DollarSign,
  ExternalLink,
  Loader2,
  MapPin,
  PenLine,
  ShieldCheck,
  StickyNote,
  TreePine,
  Users,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BlockPersonDialog } from "@/components/BlockPersonDialog";
import { FamilyTree } from "@/components/FamilyTree";
import type { LayoutEdge, LayoutPerson } from "@/lib/family-layout";
import { FollowUpDraftDialog } from "@/components/FollowUpDraftDialog";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";

type TimelineEntry = {
  kind: "lead" | "note";
  id: string;
  date: string | null;
  headline: string | null;
  url: string | null;
  sourceName: string | null;
  priorityLevel: "high" | "medium" | "low" | null;
  priorityScore: number | null;
  dealValue: string | null;
  status: string | null;
  saved: boolean;
  category: string | null;
  summary: string | null;
  companyNames: string[] | null;
};

type PersonProfile = {
  person: {
    id: number;
    fullName: string;
    aliases: string[];
    bio: string | null;
    nationality: string | null;
    region: string | null;
    city: string | null;
    netWorthEstimate: string | null;
    netWorthSource: string | null;
    wealthSource: string | null;
    familyName: string | null;
    mentionCount: number;
    lastMentionedAt: string | null;
    firstSeenAt: string | null;
  };
  companies: { name: string; role: string | null }[];
  contact: { status: string; email: string | null; notes: string | null } | null;
  families: { familyId: string; familyName: string; country: string | null }[];
  relationships: {
    id: string;
    personId: number;
    fullName: string;
    familyId: string | null;
    relation: string;
    kind?: "parent" | "child" | "spouse" | "sibling" | "other";
    blocked?: boolean;
  }[];
  block: {
    origin: "direct" | "propagated";
    reason: string | null;
    coveredBy: string | null;
    originName: string | null;
  } | null;
  timeline: TimelineEntry[];
};

const priorityColors: Record<string, string> = {
  high: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
  medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  low: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
};

function formatDate(value: string | null): string {
  if (!value) return "Undated";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "Undated" : format(d, "MMM d, yyyy");
}

/** Companies shown per history row before collapsing into "+N more". */
const COMPANIES_PER_ENTRY = 8;

/** One row of the vertical history rail. */
function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const isNote = entry.kind === "note";
  const companies = (entry.companyNames ?? []).filter(Boolean);
  return (
    <li className="relative pl-6" data-testid={`timeline-${entry.id}`}>
      <span
        className={`absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background ${
          isNote ? "bg-primary" : "bg-muted-foreground/50"
        }`}
      />
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono tabular-nums">{formatDate(entry.date)}</span>
        {entry.sourceName && <span className="truncate max-w-[12rem]">{entry.sourceName}</span>}
        {entry.priorityLevel && (
          <Badge variant="outline" size="sm" className={priorityColors[entry.priorityLevel]}>
            {entry.priorityLevel}
            {entry.priorityScore !== null ? ` · ${entry.priorityScore}` : ""}
          </Badge>
        )}
        {entry.dealValue && (
          <Badge
            variant="outline"
            size="sm"
            className="gap-1 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20 font-mono tabular-nums"
          >
            <DollarSign className="h-3 w-3" />
            {entry.dealValue}
          </Badge>
        )}
        {entry.saved && (
          <Badge variant="outline" size="sm" className="gap-1 bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20">
            <BookmarkCheck className="h-3 w-3" /> Saved
          </Badge>
        )}
        {isNote && (
          <Badge variant="outline" size="sm" className="gap-1">
            <StickyNote className="h-3 w-3" /> Note
          </Badge>
        )}
      </div>
      {entry.url ? (
        <a
          href={entry.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-0.5 block break-words font-medium text-sm hover:text-primary transition-colors"
        >
          {entry.headline || entry.url}
          <ExternalLink className="inline-block ml-1.5 h-3 w-3 opacity-50" />
        </a>
      ) : (
        entry.headline && <div className="mt-0.5 break-words font-medium text-sm">{entry.headline}</div>
      )}
      {entry.summary && (
        <p className={`mt-1 text-sm leading-relaxed break-words ${isNote ? "" : "text-muted-foreground line-clamp-3"}`}>
          {entry.summary}
        </p>
      )}
      {companies.length > 0 && (
        // Round-up stories can name 60+ companies; show a readable handful.
        <div className="mt-1 flex flex-wrap gap-1">
          {companies.slice(0, COMPANIES_PER_ENTRY).map((c) => (
            <Badge key={c} variant="secondary" size="sm" className="max-w-[12rem]">
              <span className="truncate">{c}</span>
            </Badge>
          ))}
          {companies.length > COMPANIES_PER_ENTRY && (
            <Badge variant="outline" size="sm" className="text-muted-foreground">
              +{companies.length - COMPANIES_PER_ENTRY} more
            </Badge>
          )}
        </div>
      )}
    </li>
  );
}

/** Private notes editor — writes through to contact_meta.notes. */
function NotesEditor({ personId, initial }: { personId: number; initial: string }) {
  const [draft, setDraft] = useState(initial);
  // Re-seed when the profile (and therefore the person) changes underneath us.
  useEffect(() => setDraft(initial), [initial, personId]);

  const saveNotes = useMutation({
    mutationFn: async (notes: string) => {
      await apiRequest("PATCH", `/api/people/${personId}/notes`, { notes });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/people/${personId}/profile`] });
    },
  });

  const dirty = draft !== initial;
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Private notes</div>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={4}
        placeholder="What you know, who introduced you, what to open with…"
        data-testid="input-person-notes"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!dirty || saveNotes.isPending}
          onClick={() => saveNotes.mutate(draft)}
          data-testid="button-save-notes"
        >
          {saveNotes.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          Save notes
        </Button>
        {dirty && !saveNotes.isPending && (
          <Button size="sm" variant="ghost" onClick={() => setDraft(initial)}>Cancel</Button>
        )}
        {saveNotes.isError && <span className="text-xs text-destructive">Could not save — try again.</span>}
      </div>
    </div>
  );
}

export default function PersonPage() {
  const [, params] = useRoute("/people/:id");
  const personId = Number.parseInt(params?.id ?? "", 10);
  const validId = Number.isFinite(personId) && personId > 0;

  const [, navigate] = useLocation();
  const [blockOpen, setBlockOpen] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);

  const { data, isLoading, isError } = useQuery<PersonProfile>({
    queryKey: [`/api/people/${personId}/profile`],
    enabled: validId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [`/api/people/${personId}/profile`] });
    queryClient.invalidateQueries({ queryKey: ["/api/founders/muted"] });
  };

  const setStatus = useMutation({
    mutationFn: async (status: "saved" | "active") => {
      await apiRequest("PATCH", `/api/contacts/${personId}`, { status });
    },
    onSuccess: invalidate,
  });

  const mute = useMutation({
    mutationFn: async (fullName: string) => {
      await apiRequest("POST", "/api/founders/mute", { names: [fullName] });
    },
    onSuccess: invalidate,
  });

  const unblock = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/persons/${personId}/block`);
    },
    onSuccess: invalidate,
  });

  if (!validId || isError) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-3">
          <Link href="/contacts" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" /> Contacts
          </Link>
          <p className="text-sm text-muted-foreground">This person could not be found.</p>
        </div>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const { person, companies, contact, families, relationships, block, timeline } = data;

  // Immediate family only: this person plus whoever they are directly linked
  // to. Built from the same shape the full tree uses, so the two agree.
  const miniTree: { people: LayoutPerson[]; edges: LayoutEdge[] } = (() => {
    const people: LayoutPerson[] = [
      { id: person.id, fullName: person.fullName, blocked: !!block, blockOrigin: block?.origin ?? null },
      ...relationships.map((r) => ({ id: r.personId, fullName: r.fullName, blocked: !!r.blocked, blockOrigin: null })),
    ];
    const edges: LayoutEdge[] = [];
    for (const r of relationships) {
      if (r.kind === "parent") edges.push({ fromPersonId: r.personId, toPersonId: person.id, type: "parent" });
      else if (r.kind === "child") edges.push({ fromPersonId: person.id, toPersonId: r.personId, type: "parent" });
      else if (r.kind === "spouse") edges.push({ fromPersonId: person.id, toPersonId: r.personId, type: "spouse" });
      else if (r.kind === "sibling") edges.push({ fromPersonId: person.id, toPersonId: r.personId, type: "sibling" });
    }
    return { people, edges };
  })();

  const relativesForBlock = relationships
    .filter((r) => r.kind && r.kind !== "other")
    .map((r) => ({
      personId: r.personId,
      fullName: r.fullName,
      kind: r.kind as "parent" | "child" | "spouse" | "sibling",
      blocked: r.blocked,
    }));
  const isSavedContact = contact?.status === "saved";
  const isMuted = contact?.status === "muted";
  const location = [person.city, person.region, person.nationality].filter(Boolean).join(" · ");
  const primaryFamily = families[0] ?? null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4">
        <Link href="/contacts" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Contacts
        </Link>

        {/* ---- Header ---- */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-xl font-bold tracking-tight break-words" data-testid="text-person-name">
                  {person.fullName}
                </h1>
                {person.aliases.length > 0 && (
                  <div className="text-xs text-muted-foreground break-words">
                    also known as {person.aliases.join(", ")}
                  </div>
                )}
                {location && (
                  <div className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                    <MapPin className="h-3.5 w-3.5 shrink-0" /> <span className="break-words">{location}</span>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={isSavedContact ? "outline" : "default"}
                  disabled={setStatus.isPending}
                  onClick={() => setStatus.mutate(isSavedContact ? "active" : "saved")}
                  data-testid="button-save-contact"
                >
                  {isSavedContact ? <BookmarkCheck className="h-4 w-4 mr-1.5" /> : <Bookmark className="h-4 w-4 mr-1.5" />}
                  {isSavedContact ? "Saved contact" : "Save as contact"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={mute.isPending || setStatus.isPending}
                  onClick={() => (isMuted ? setStatus.mutate("active") : mute.mutate(person.fullName))}
                  data-testid="button-mute-person"
                >
                  <BellOff className="h-4 w-4 mr-1.5" />
                  {isMuted ? "Unmute" : "Mute"}
                </Button>
                {primaryFamily && (
                  <Link href={`/families/${primaryFamily.familyId}`}>
                    <Button size="sm" variant="outline" data-testid="button-open-family">
                      <TreePine className="h-4 w-4 mr-1.5" /> Open family
                    </Button>
                  </Link>
                )}
                {/* Coverage conflicts used to be reachable only from inside a
                    family tree, which is why no block had ever been recorded. */}
                <Button size="sm" variant="outline" onClick={() => setDraftOpen(true)} data-testid="button-draft-followup">
                  <PenLine className="mr-1.5 h-4 w-4" /> Draft follow-up
                </Button>
                {block ? (
                  <Button size="sm" variant="outline" disabled={unblock.isPending} onClick={() => unblock.mutate()} data-testid="button-unblock-person">
                    <ShieldCheck className="mr-1.5 h-4 w-4" /> Unblock
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setBlockOpen(true)} data-testid="button-block-person">
                    <Ban className="mr-1.5 h-4 w-4" /> Mark as covered
                  </Button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {companies.map((c) => (
                <Badge key={c.name} variant="secondary" size="sm" className="gap-1">
                  <Building2 className="h-3 w-3" /> {c.name}
                  {c.role ? ` · ${c.role}` : ""}
                </Badge>
              ))}
              {person.netWorthEstimate && (
                <Badge
                  variant="outline"
                  size="sm"
                  className="gap-1 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20"
                  title={person.netWorthSource ?? undefined}
                >
                  <DollarSign className="h-3 w-3" /> {person.netWorthEstimate}
                </Badge>
              )}
              {person.mentionCount > 1 && (
                <Badge variant="outline" size="sm" className="gap-1">
                  <Calendar className="h-3 w-3" /> seen {person.mentionCount}×
                </Badge>
              )}
              {families.map((f) => (
                <Link key={f.familyId} href={`/families/${f.familyId}`}>
                  <Badge
                    variant="outline"
                    size="sm"
                    className="max-w-[14rem] gap-1 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20 hover:bg-emerald-500/20"
                  >
                    {/* Same 🌳 token the lead feed uses, so the two read as one thing. */}
                    <span aria-hidden>🌳</span>
                    <span className="truncate">{f.familyName}</span>
                  </Badge>
                </Link>
              ))}
            </div>

            {block && (
              <div
                className="flex items-start gap-2 rounded-md border border-red-500/20 bg-red-500/5 p-3"
                data-testid="banner-blocked"
              >
                <Ban className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                <div className="min-w-0 text-sm">
                  <div className="font-medium text-red-700 dark:text-red-300">
                    Blocked — covered{block.coveredBy ? ` by ${block.coveredBy}` : " elsewhere"}
                  </div>
                  <div className="text-xs text-red-700/80 dark:text-red-300/80 break-words">
                    {block.origin === "propagated" && block.originName
                      ? `Propagated from ${block.originName}. `
                      : ""}
                    {block.reason || "No reason recorded."}
                  </div>
                </div>
              </div>
            )}

            {person.bio && <p className="text-sm leading-relaxed text-muted-foreground">{person.bio}</p>}

            {relationships.length > 0 && (
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <Users className="h-3.5 w-3.5" /> Family links
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {relationships.map((r) => (
                    <Link key={r.id} href={`/people/${r.personId}`}>
                      <Badge variant="secondary" size="sm" className="hover:bg-secondary/70">
                        {r.relation} {r.fullName}
                      </Badge>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ---- Immediate family ---- */}
        {relationships.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Users className="h-3.5 w-3.5" /> Immediate family
              </div>
              <FamilyTree
                people={miniTree.people}
                edges={miniTree.edges}
                selectedId={person.id}
                onSelect={(id) => id !== person.id && navigate(`/people/${id}`)}
              />
              {primaryFamily && (
                <Link href={`/families/${primaryFamily.familyId}`} className="mt-2 inline-block text-xs text-muted-foreground hover:text-primary">
                  See the whole {primaryFamily.familyName ?? "family"} tree →
                </Link>
              )}
            </CardContent>
          </Card>
        )}

        {/* ---- Notes ---- */}
        <Card>
          <CardContent className="p-4">
            <NotesEditor personId={person.id} initial={contact?.notes ?? ""} />
          </CardContent>
        </Card>

        {/* ---- Timeline ---- */}
        <Card>
          <CardContent className="p-4">
            <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              History {timeline.length > 0 && <span className="font-mono tabular-nums">({timeline.length})</span>}
            </div>
            {timeline.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing recorded yet — leads naming {person.fullName} will stack up here.
              </p>
            ) : (
              <ol className="space-y-4 border-l border-border pl-2" data-testid="person-timeline">
                {timeline.map((entry) => (
                  <TimelineRow key={entry.id} entry={entry} />
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      {draftOpen && (
        <FollowUpDraftDialog
          personId={personId}
          fullName={person.fullName}
          onOpenChange={(o) => !o && setDraftOpen(false)}
        />
      )}

      {blockOpen && (
        <BlockPersonDialog
          personId={personId}
          fullName={person.fullName}
          relatives={relativesForBlock}
          onOpenChange={(o) => !o && setBlockOpen(false)}
          onBlocked={() => { setBlockOpen(false); invalidate(); }}
        />
      )}
    </div>
  );
}
