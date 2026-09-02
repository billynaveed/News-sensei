import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation, useRoute } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  Ban,
  Building2,
  DollarSign,
  Loader2,
  MapPin,
  Plus,
  ShieldCheck,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";

type Member = {
  id: number;
  fullName: string;
  aliases: string[] | null;
  bio: string | null;
  photoUrl: string | null;
  nationality: string | null;
  city: string | null;
  netWorthEstimate: string | null;
  wealthSource: string | null;
  companies: string[] | null;
  blocked: boolean;
  blockOrigin: "direct" | "propagated" | null;
  blockReason: string | null;
  blockCoveredBy: string | null;
  blockOriginName: string | null;
};

type Relationship = {
  id: string;
  fromPersonId: number;
  toPersonId: number;
  type: "parent" | "spouse" | "sibling";
  confidence: string | null;
  sourceUrl: string | null;
};

type FamilyDetail = {
  family: {
    id: string;
    name: string;
    country: string | null;
    description: string | null;
    netWorthEstimate: string | null;
    researchStatus: string;
    sourceUrls: string[] | null;
  };
  members: Member[];
  relationships: Relationship[];
};

type RelationKind = "none" | "child_of" | "parent_of" | "spouse_of" | "sibling_of";

// ---------------------------------------------------------------------------
// Tree layout: assign a generation to every member from parent/spouse/sibling
// edges (parents above children, spouses + siblings level), then order each
// row so spouses sit adjacent and children sit under their parents.
// ---------------------------------------------------------------------------
function computeGenerations(members: Member[], relationships: Relationship[]) {
  const ids = new Set(members.map((m) => m.id));
  const edges = relationships.filter((r) => ids.has(r.fromPersonId) && ids.has(r.toPersonId));
  const linked = new Set<number>();
  edges.forEach((e) => {
    linked.add(e.fromPersonId);
    linked.add(e.toPersonId);
  });

  const gen = new Map<number, number>();
  linked.forEach((id) => gen.set(id, 0));

  // Relaxation: child below parent, spouse/sibling level with each other.
  // Bounded iterations keep accidental cycles (bad data) from hanging the UI.
  const maxIter = linked.size + 10;
  for (let i = 0; i < maxIter; i++) {
    let changed = false;
    for (const e of edges) {
      const a = gen.get(e.fromPersonId)!;
      const b = gen.get(e.toPersonId)!;
      if (e.type === "parent") {
        if (b < a + 1) {
          gen.set(e.toPersonId, a + 1);
          changed = true;
        }
      } else {
        const level = Math.max(a, b);
        if (a !== level) { gen.set(e.fromPersonId, level); changed = true; }
        if (b !== level) { gen.set(e.toPersonId, level); changed = true; }
      }
    }
    if (!changed) break;
  }

  const memberById = new Map(members.map((m) => [m.id, m]));
  const rows = new Map<number, Member[]>();
  linked.forEach((id) => {
    const g = gen.get(id)!;
    if (!rows.has(g)) rows.set(g, []);
    rows.get(g)!.push(memberById.get(id)!);
  });

  const sortedGens = Array.from(rows.keys()).sort((a, b) => a - b);
  const parentsOf = new Map<number, number[]>();
  const spouseOf = new Map<number, number[]>();
  edges.forEach((e) => {
    if (e.type === "parent") {
      if (!parentsOf.has(e.toPersonId)) parentsOf.set(e.toPersonId, []);
      parentsOf.get(e.toPersonId)!.push(e.fromPersonId);
    } else if (e.type === "spouse") {
      if (!spouseOf.has(e.fromPersonId)) spouseOf.set(e.fromPersonId, []);
      if (!spouseOf.has(e.toPersonId)) spouseOf.set(e.toPersonId, []);
      spouseOf.get(e.fromPersonId)!.push(e.toPersonId);
      spouseOf.get(e.toPersonId)!.push(e.fromPersonId);
    }
  });

  // Order rows top-down: sort children by their parents' average position in
  // the row above, then pull spouse pairs adjacent.
  const posInRow = new Map<number, number>();
  const orderedRows: Member[][] = [];
  sortedGens.forEach((g, rowIdx) => {
    let row = rows.get(g)!;
    if (rowIdx === 0) {
      row = [...row].sort((a, b) => a.fullName.localeCompare(b.fullName));
    } else {
      row = [...row].sort((a, b) => {
        const pa = (parentsOf.get(a.id) ?? []).map((p) => posInRow.get(p) ?? 0);
        const pb = (parentsOf.get(b.id) ?? []).map((p) => posInRow.get(p) ?? 0);
        const avgA = pa.length ? pa.reduce((s, v) => s + v, 0) / pa.length : 999;
        const avgB = pb.length ? pb.reduce((s, v) => s + v, 0) / pb.length : 999;
        return avgA - avgB || a.fullName.localeCompare(b.fullName);
      });
    }
    // Pull each spouse next to their partner (first pass, greedy).
    for (let i = 0; i < row.length; i++) {
      const partners = spouseOf.get(row[i].id) ?? [];
      for (const partnerId of partners) {
        const j = row.findIndex((m) => m.id === partnerId);
        if (j > i + 1) {
          const [sp] = row.splice(j, 1);
          row.splice(i + 1, 0, sp);
        }
      }
    }
    row.forEach((m, i) => posInRow.set(m.id, i));
    orderedRows.push(row);
  });

  const unlinked = members.filter((m) => !linked.has(m.id));
  return { rows: orderedRows, unlinked, edges };
}

/** Relatives of one person, for the block-propagation dialog. */
function computeRelatives(personId: number, relationships: Relationship[]) {
  const parents: number[] = [];
  const children: number[] = [];
  const spouses: number[] = [];
  const siblings = new Set<number>();
  relationships.forEach((r) => {
    if (r.type === "parent") {
      if (r.toPersonId === personId) parents.push(r.fromPersonId);
      if (r.fromPersonId === personId) children.push(r.toPersonId);
    } else if (r.type === "spouse") {
      if (r.fromPersonId === personId) spouses.push(r.toPersonId);
      if (r.toPersonId === personId) spouses.push(r.fromPersonId);
    } else if (r.type === "sibling") {
      if (r.fromPersonId === personId) siblings.add(r.toPersonId);
      if (r.toPersonId === personId) siblings.add(r.fromPersonId);
    }
  });
  // Shared-parent siblings.
  relationships.forEach((r) => {
    if (r.type === "parent" && parents.includes(r.fromPersonId) && r.toPersonId !== personId) {
      siblings.add(r.toPersonId);
    }
  });
  return { parents, children, spouses, siblings: Array.from(siblings) };
}

function PersonNode({
  member,
  selected,
  onClick,
  nodeRef,
}: {
  member: Member;
  selected: boolean;
  onClick: () => void;
  nodeRef: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={nodeRef}
      onClick={onClick}
      data-testid={`node-person-${member.id}`}
      className={`cursor-pointer select-none rounded-md border px-3 py-2 w-40 bg-card shadow-sm transition-colors hover:border-primary/50 ${
        member.blocked
          ? "border-red-500/50 bg-red-500/5"
          : selected
            ? "border-primary"
            : "border-border"
      }`}
    >
      <div className="text-sm font-semibold leading-tight break-words">{member.fullName}</div>
      {(member.companies?.length ?? 0) > 0 && (
        <div className="text-xs text-muted-foreground truncate mt-0.5">{member.companies![0]}</div>
      )}
      <div className="flex flex-wrap gap-1 mt-1">
        {member.netWorthEstimate && (
          <Badge variant="outline" className="text-[10px] px-1 py-0">{member.netWorthEstimate}</Badge>
        )}
        {member.blocked && (
          <Badge className="text-[10px] px-1 py-0 gap-0.5 bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20">
            <Ban className="h-2.5 w-2.5" /> Blocked
          </Badge>
        )}
      </div>
    </div>
  );
}

export default function FamilyDetailPage() {
  const [, params] = useRoute("/families/:id");
  const [, navigate] = useLocation();
  const familyId = params?.id ?? "";

  const { data: detail, isLoading } = useQuery<FamilyDetail>({
    queryKey: [`/api/families/${familyId}`],
    enabled: !!familyId,
  });

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [blockTargetId, setBlockTargetId] = useState<number | null>(null);

  const layout = useMemo(
    () => (detail ? computeGenerations(detail.members, detail.relationships) : null),
    [detail],
  );

  // ------- SVG connector measurement -------
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef(new Map<number, HTMLDivElement>());
  const [lines, setLines] = useState<{ path: string; kind: "parent" | "spouse" | "sibling" }[]>([]);
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const measure = () => {
      const container = containerRef.current;
      if (!container || !layout) return setLines([]);
      const cRect = container.getBoundingClientRect();
      const next: { path: string; kind: "parent" | "spouse" | "sibling" }[] = [];
      const rectOf = (id: number) => {
        const el = nodeRefs.current.get(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          cx: r.left - cRect.left + container.scrollLeft + r.width / 2,
          top: r.top - cRect.top + container.scrollTop,
          bottom: r.bottom - cRect.top + container.scrollTop,
          left: r.left - cRect.left + container.scrollLeft,
          right: r.right - cRect.left + container.scrollLeft,
          my: r.top - cRect.top + container.scrollTop + r.height / 2,
        };
      };
      for (const e of layout.edges) {
        const a = rectOf(e.fromPersonId);
        const b = rectOf(e.toPersonId);
        if (!a || !b) continue;
        if (e.type === "parent") {
          const midY = (a.bottom + b.top) / 2;
          next.push({
            kind: "parent",
            path: `M ${a.cx} ${a.bottom} C ${a.cx} ${midY}, ${b.cx} ${midY}, ${b.cx} ${b.top}`,
          });
        } else {
          const [l, r] = a.cx <= b.cx ? [a, b] : [b, a];
          if (Math.abs(a.my - b.my) < 8) {
            next.push({ kind: e.type, path: `M ${l.right} ${l.my} L ${r.left} ${r.my}` });
          } else {
            next.push({ kind: e.type, path: `M ${l.right} ${l.my} C ${(l.right + r.left) / 2} ${l.my}, ${(l.right + r.left) / 2} ${r.my}, ${r.left} ${r.my}` });
          }
        }
      }
      setLines(next);
      setSvgSize({ w: container.scrollWidth, h: container.scrollHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [layout]);

  // ------- mutations -------
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [`/api/families/${familyId}`] });
    queryClient.invalidateQueries({ queryKey: ["/api/families"] });
    queryClient.invalidateQueries({ queryKey: ["/api/founders/blocked"] });
  };

  const removeMemberMutation = useMutation({
    mutationFn: async (personId: number) => {
      await apiRequest("DELETE", `/api/families/${familyId}/members/${personId}`);
    },
    onSuccess: () => {
      setSelectedId(null);
      invalidate();
    },
  });

  const unblockMutation = useMutation({
    mutationFn: async (personId: number) => {
      await apiRequest("DELETE", `/api/persons/${personId}/block`);
    },
    onSuccess: invalidate,
  });

  const deleteFamilyMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/families/${familyId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/families"] });
      navigate("/families");
    },
  });

  const selected = detail?.members.find((m) => m.id === selectedId) ?? null;
  const blockTarget = detail?.members.find((m) => m.id === blockTargetId) ?? null;

  if (isLoading || !detail) {
    return (
      <div className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/families" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" /> Families
          </Link>
          <h1 className="text-xl font-bold tracking-tight mt-1">{detail.family.name}</h1>
          <div className="text-sm text-muted-foreground">
            {[detail.family.country, detail.family.netWorthEstimate].filter(Boolean).join(" · ")}
          </div>
          {detail.family.description && (
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">{detail.family.description}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setAddOpen(true)} data-testid="button-add-member">
            <UserPlus className="h-4 w-4 mr-1.5" /> Add member
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              if (window.confirm(`Delete "${detail.family.name}"? People and their block status are kept — only the tree is removed.`)) {
                deleteFamilyMutation.mutate();
              }
            }}
            data-testid="button-delete-family"
          >
            <Trash2 className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>
      </div>

      {/* Tree */}
      <Card>
        <CardContent className="p-4">
          {layout && layout.rows.length === 0 && layout.unlinked.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No members yet — add the first person.
            </div>
          ) : (
            <div ref={containerRef} className="relative overflow-x-auto pb-2">
              <svg
                className="absolute inset-0 pointer-events-none"
                width={svgSize.w}
                height={svgSize.h}
                style={{ minWidth: "100%" }}
              >
                {lines.map((l, i) => (
                  <path
                    key={i}
                    d={l.path}
                    fill="none"
                    className={l.kind === "parent" ? "stroke-muted-foreground/50" : "stroke-muted-foreground/40"}
                    strokeWidth={1.5}
                    strokeDasharray={l.kind === "sibling" ? "4 3" : l.kind === "spouse" ? "1 3" : undefined}
                  />
                ))}
              </svg>
              <div className="relative flex flex-col gap-10 items-center min-w-max px-2 py-2 mx-auto">
                {layout!.rows.map((row, i) => (
                  <div key={i} className="flex gap-6 items-start justify-center">
                    {row.map((m) => (
                      <PersonNode
                        key={m.id}
                        member={m}
                        selected={selectedId === m.id}
                        onClick={() => setSelectedId(m.id)}
                        nodeRef={(el) => {
                          if (el) nodeRefs.current.set(m.id, el);
                          else nodeRefs.current.delete(m.id);
                        }}
                      />
                    ))}
                  </div>
                ))}
              </div>
              {layout!.unlinked.length > 0 && (
                <div className="mt-8 border-t border-dashed border-border pt-4">
                  <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-2">
                    Not linked yet — select a person to add relationships
                  </div>
                  <div className="flex flex-wrap gap-4">
                    {layout!.unlinked.map((m) => (
                      <PersonNode
                        key={m.id}
                        member={m}
                        selected={selectedId === m.id}
                        onClick={() => setSelectedId(m.id)}
                        nodeRef={(el) => {
                          if (el) nodeRefs.current.set(m.id, el);
                          else nodeRefs.current.delete(m.id);
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {detail.members.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><span className="inline-block w-6 border-t-[1.5px] border-muted-foreground/60" /> parent → child</span>
              <span className="inline-flex items-center gap-1.5"><span className="inline-block w-6 border-t-[1.5px] border-dotted border-muted-foreground/60" /> spouse</span>
              <span className="inline-flex items-center gap-1.5"><span className="inline-block w-6 border-t-[1.5px] border-dashed border-muted-foreground/60" /> sibling</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Person panel */}
      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelectedId(null)}>
        <DialogContent className="max-w-lg">
          {selected && (
            <PersonPanel
              member={selected}
              detail={detail}
              familyId={familyId}
              onBlock={() => setBlockTargetId(selected.id)}
              onUnblock={() => unblockMutation.mutate(selected.id)}
              unblockPending={unblockMutation.isPending}
              onRemove={() => {
                if (window.confirm(`Remove ${selected.fullName} from this family? Their block status is kept.`)) {
                  removeMemberMutation.mutate(selected.id);
                }
              }}
              onChanged={invalidate}
            />
          )}
        </DialogContent>
      </Dialog>

      <AddMemberDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        familyId={familyId}
        members={detail.members}
        onAdded={invalidate}
      />

      {blockTarget && (
        <BlockDialog
          member={blockTarget}
          detail={detail}
          onOpenChange={(o) => !o && setBlockTargetId(null)}
          onBlocked={() => {
            setBlockTargetId(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function PersonPanel({
  member,
  detail,
  familyId,
  onBlock,
  onUnblock,
  unblockPending,
  onRemove,
  onChanged,
}: {
  member: Member;
  detail: FamilyDetail;
  familyId: string;
  onBlock: () => void;
  onUnblock: () => void;
  unblockPending: boolean;
  onRemove: () => void;
  onChanged: () => void;
}) {
  const byId = new Map(detail.members.map((m) => [m.id, m]));
  const rels = detail.relationships
    .filter((r) => r.fromPersonId === member.id || r.toPersonId === member.id)
    .map((r) => {
      const otherId = r.fromPersonId === member.id ? r.toPersonId : r.fromPersonId;
      const other = byId.get(otherId);
      let label: string;
      if (r.type === "parent") label = r.fromPersonId === member.id ? "Parent of" : "Child of";
      else if (r.type === "spouse") label = "Spouse of";
      else label = "Sibling of";
      return { rel: r, other, label };
    })
    .filter((x) => x.other);

  const deleteRelMutation = useMutation({
    mutationFn: async (relId: string) => {
      await apiRequest("DELETE", `/api/relationships/${relId}`);
    },
    onSuccess: onChanged,
  });

  const [addingRel, setAddingRel] = useState(false);
  const [relKind, setRelKind] = useState<"parent" | "child" | "spouse" | "sibling">("child");
  const [relOtherId, setRelOtherId] = useState<string>("");
  const addRelMutation = useMutation({
    mutationFn: async () => {
      const otherId = parseInt(relOtherId, 10);
      const body =
        relKind === "parent"
          ? { fromPersonId: otherId, toPersonId: member.id, type: "parent" } // other is member's parent
          : relKind === "child"
            ? { fromPersonId: member.id, toPersonId: otherId, type: "parent" }
            : { fromPersonId: member.id, toPersonId: otherId, type: relKind };
      await apiRequest("POST", `/api/families/${familyId}/relationships`, body);
    },
    onSuccess: () => {
      setAddingRel(false);
      setRelOtherId("");
      onChanged();
    },
  });

  const others = detail.members.filter((m) => m.id !== member.id);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 flex-wrap">
          {member.fullName}
          {member.blocked && (
            <Badge className="gap-1 bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20">
              <Ban className="h-3 w-3" /> Blocked
            </Badge>
          )}
        </DialogTitle>
        {member.blocked && (
          <DialogDescription className="text-red-600 dark:text-red-400">
            {member.blockOrigin === "propagated" && member.blockOriginName
              ? `Blocked because ${member.blockOriginName} is blocked.`
              : member.blockReason || "Blocked — covered elsewhere."}
            {member.blockCoveredBy ? ` Covered by ${member.blockCoveredBy}.` : ""}
          </DialogDescription>
        )}
      </DialogHeader>

      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
          {(member.companies?.length ?? 0) > 0 && (
            <span className="inline-flex items-center gap-1"><Building2 className="h-3.5 w-3.5" />{member.companies!.join(", ")}</span>
          )}
          {(member.city || member.nationality) && (
            <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{member.city || member.nationality}</span>
          )}
          {member.netWorthEstimate && (
            <span className="inline-flex items-center gap-1"><DollarSign className="h-3.5 w-3.5" />{member.netWorthEstimate}</span>
          )}
        </div>
        {member.bio && <p className="text-muted-foreground line-clamp-4">{member.bio}</p>}

        <div>
          <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1.5">Relationships</div>
          {rels.length === 0 && !addingRel && (
            <div className="text-muted-foreground text-xs">None yet.</div>
          )}
          <div className="space-y-1">
            {rels.map(({ rel, other, label }) => (
              <div key={rel.id} className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1">
                <span>
                  <span className="text-muted-foreground">{label}</span> <span className="font-medium">{other!.fullName}</span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => deleteRelMutation.mutate(rel.id)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
          {addingRel ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Select value={relKind} onValueChange={(v) => setRelKind(v as any)}>
                <SelectTrigger className="w-28 h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="child">Parent of</SelectItem>
                  <SelectItem value="parent">Child of</SelectItem>
                  <SelectItem value="spouse">Spouse of</SelectItem>
                  <SelectItem value="sibling">Sibling of</SelectItem>
                </SelectContent>
              </Select>
              <Select value={relOtherId} onValueChange={setRelOtherId}>
                <SelectTrigger className="w-44 h-8"><SelectValue placeholder="Person…" /></SelectTrigger>
                <SelectContent>
                  {others.map((m) => (
                    <SelectItem key={m.id} value={String(m.id)}>{m.fullName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="h-8"
                disabled={!relOtherId || addRelMutation.isPending}
                onClick={() => addRelMutation.mutate()}
              >
                {addRelMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
              </Button>
              <Button size="sm" variant="ghost" className="h-8" onClick={() => setAddingRel(false)}>Cancel</Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="mt-2 h-8" onClick={() => setAddingRel(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Add relationship
            </Button>
          )}
        </div>
      </div>

      <DialogFooter className="flex-row justify-between sm:justify-between gap-2">
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5 mr-1" /> Remove from family
        </Button>
        {member.blocked ? (
          <Button variant="outline" size="sm" onClick={onUnblock} disabled={unblockPending} data-testid="button-unblock">
            {unblockPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5 mr-1" />}
            Unblock
          </Button>
        ) : (
          <Button variant="destructive" size="sm" onClick={onBlock} data-testid="button-block">
            <Ban className="h-3.5 w-3.5 mr-1" /> Block…
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
function AddMemberDialog({
  open,
  onOpenChange,
  familyId,
  members,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  familyId: string;
  members: Member[];
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [relKind, setRelKind] = useState<RelationKind>("none");
  const [relToId, setRelToId] = useState<string>("");

  const addMutation = useMutation({
    mutationFn: async () => {
      const relation =
        relKind !== "none" && relToId
          ? { toPersonId: parseInt(relToId, 10), type: relKind }
          : undefined;
      await apiRequest("POST", `/api/families/${familyId}/members`, { name, relation });
    },
    onSuccess: () => {
      setName("");
      setRelKind("none");
      setRelToId("");
      onOpenChange(false);
      onAdded();
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add family member</DialogTitle>
          <DialogDescription>
            If the person already exists in Sensei (e.g. from a lead), they're linked rather than duplicated.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Full name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Lane Low"
              data-testid="input-member-name"
            />
          </div>
          {members.length > 0 && (
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Relationship (optional)</label>
              <div className="flex flex-wrap gap-2 mt-1">
                <Select value={relKind} onValueChange={(v) => setRelKind(v as RelationKind)}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No link yet</SelectItem>
                    <SelectItem value="child_of">Child of</SelectItem>
                    <SelectItem value="parent_of">Parent of</SelectItem>
                    <SelectItem value="spouse_of">Spouse of</SelectItem>
                    <SelectItem value="sibling_of">Sibling of</SelectItem>
                  </SelectContent>
                </Select>
                {relKind !== "none" && (
                  <Select value={relToId} onValueChange={setRelToId}>
                    <SelectTrigger className="w-48"><SelectValue placeholder="Existing member…" /></SelectTrigger>
                    <SelectContent>
                      {members.map((m) => (
                        <SelectItem key={m.id} value={String(m.id)}>{m.fullName}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            onClick={() => addMutation.mutate()}
            disabled={name.trim().length < 2 || (relKind !== "none" && !relToId) || addMutation.isPending}
            data-testid="button-add-member-submit"
          >
            {addMutation.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
function BlockDialog({
  member,
  detail,
  onOpenChange,
  onBlocked,
}: {
  member: Member;
  detail: FamilyDetail;
  onOpenChange: (o: boolean) => void;
  onBlocked: () => void;
}) {
  const byId = new Map(detail.members.map((m) => [m.id, m]));
  const relatives = useMemo(() => computeRelatives(member.id, detail.relationships), [member.id, detail.relationships]);

  // Billy's rule: a blocked child means the parents are blocked for sure —
  // parents come pre-checked. Siblings/spouse/children are opt-in.
  const [checked, setChecked] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(relatives.parents.map((id) => [id, true])),
  );
  const [coveredBy, setCoveredBy] = useState("");
  const [reason, setReason] = useState("Covered by another banker");

  const blockMutation = useMutation({
    mutationFn: async () => {
      const alsoBlock = Object.entries(checked)
        .filter(([, v]) => v)
        .map(([id]) => parseInt(id, 10));
      await apiRequest("POST", `/api/persons/${member.id}/block`, {
        alsoBlock,
        reason: reason || null,
        coveredBy: coveredBy || null,
      });
    },
    onSuccess: onBlocked,
  });

  const groups: { label: string; ids: number[] }[] = [
    { label: "Parents", ids: relatives.parents },
    { label: "Spouse", ids: relatives.spouses },
    { label: "Siblings", ids: relatives.siblings },
    { label: "Children", ids: relatives.children },
  ];
  const anyRelatives = groups.some((g) => g.ids.length > 0);
  const selectedCount = Object.values(checked).filter(Boolean).length;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ban className="h-4 w-4 text-red-500" /> Block {member.fullName}
          </DialogTitle>
          <DialogDescription>
            Blocked people are flagged with ⛔ on leads — they're covered elsewhere and can't be approached.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {anyRelatives && (
            <div>
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                Also block relatives?
              </div>
              <div className="space-y-2">
                {groups.map((g) =>
                  g.ids
                    .map((id) => byId.get(id))
                    .filter((p): p is Member => !!p && !p.blocked)
                    .map((p) => (
                      <label key={p.id} className="flex items-center gap-2 text-sm cursor-pointer">
                        <Checkbox
                          checked={!!checked[p.id]}
                          onCheckedChange={(v) => setChecked((s) => ({ ...s, [p.id]: !!v }))}
                          data-testid={`checkbox-block-${p.id}`}
                        />
                        <span className="font-medium">{p.fullName}</span>
                        <span className="text-xs text-muted-foreground">({g.label.toLowerCase()})</span>
                      </label>
                    )),
                )}
              </div>
              {relatives.parents.length > 0 && (
                <p className="text-xs text-muted-foreground mt-1.5">
                  Parents are pre-checked — a blocked child means the parents are covered too.
                </p>
              )}
            </div>
          )}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Covered by (optional)</label>
            <Input value={coveredBy} onChange={(e) => setCoveredBy(e.target.value)} placeholder="Bank / banker name" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Reason</label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            onClick={() => blockMutation.mutate()}
            disabled={blockMutation.isPending}
            data-testid="button-block-confirm"
          >
            {blockMutation.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Block {1 + selectedCount} {1 + selectedCount === 1 ? "person" : "people"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
