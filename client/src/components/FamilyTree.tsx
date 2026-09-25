/**
 * Family tree canvas.
 *
 * Geometry comes from `lib/family-layout` (pure, unit-tested). This file only
 * draws it: an SVG layer for the connectors under an HTML layer for the cards,
 * both inside one transformed container so pan and zoom move them together.
 * HTML cards rather than SVG text keeps the typography and truncation native.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ban, ChevronDown, ChevronRight, Maximize2, Minus, Plus, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CARD_WIDTH,
  SPOUSE_GAP,
  descendantCount,
  layoutFamily,
  type LayoutEdge,
  type LayoutPerson,
} from "@/lib/family-layout";

export interface FamilyTreeProps {
  people: LayoutPerson[];
  edges: LayoutEdge[];
  selectedId?: number | null;
  onSelect?: (personId: number) => void;
  /** Person ids to mark as the family head. */
  patriarchId?: number | null;
  className?: string;
}

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 1.8;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Generation labels read the way a banker talks about a family. */
function generationLabel(depth: number, total: number): string {
  if (total <= 1) return "Family";
  if (depth === 0) return "Founder";
  if (depth === total - 1) return `G${depth + 1} · youngest`;
  return `G${depth + 1}`;
}

export function FamilyTree({ people, edges, selectedId, onSelect, patriarchId, className }: FamilyTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const layout = useMemo(
    () => layoutFamily(people, edges, { collapsed }),
    [people, edges, collapsed],
  );

  /** Fit the whole tree in view; also the initial state. */
  const fit = useCallback(() => {
    const el = viewportRef.current;
    if (!el || layout.width === 0 || layout.height === 0) return;
    const scale = Math.min(1, (el.clientWidth - 24) / layout.width, (el.clientHeight - 24) / layout.height);
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
    setZoom(next);
    setPan({
      x: Math.max(0, (el.clientWidth - layout.width * next) / 2),
      y: 8,
    });
  }, [layout.width, layout.height]);

  // Fit once the tree's size is known, and again if it changes shape.
  useEffect(() => { fit(); }, [fit]);

  const onPointerDown = (e: React.PointerEvent) => {
    // Let clicks on a card through; only empty canvas drags.
    if ((e.target as HTMLElement).closest("[data-tree-card]")) return;
    dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.panX + (e.clientX - d.x), y: d.panY + (e.clientY - d.y) });
  };
  const endDrag = (e: React.PointerEvent) => {
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return; // plain scroll still scrolls the page
    e.preventDefault();
    setZoom((z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z - e.deltaY * 0.002)));
  };

  const toggleCollapse = (personId: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId); else next.add(personId);
      return next;
    });
  };

  const childCount = useMemo(() => {
    const counts = new Map<number, number>();
    for (const e of edges) {
      if (e.type !== "parent") continue;
      counts.set(e.fromPersonId, (counts.get(e.fromPersonId) ?? 0) + 1);
    }
    return counts;
  }, [edges]);

  const totalGenerations = layout.generations.length;

  if (layout.units.length === 0 && layout.unlinked.length === 0) {
    return (
      <div className={`py-10 text-center text-sm text-muted-foreground ${className ?? ""}`}>
        No members yet — add the first person.
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Drag to move · ⌘/Ctrl + scroll to zoom · click a person to act on them
        </p>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 0.15))} title="Zoom out" data-testid="button-tree-zoom-out">
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 0.15))} title="Zoom in" data-testid="button-tree-zoom-in">
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={fit} title="Fit to view" data-testid="button-tree-fit">
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div
        ref={viewportRef}
        className="relative touch-none overflow-hidden rounded-md border bg-muted/20"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        style={{
          cursor: dragRef.current ? "grabbing" : "grab",
          // Tall enough to work with, short enough not to leave a dead slab
          // under a two-generation family.
          height: Math.min(560, Math.max(300, layout.height * zoom + 48)),
        }}
        data-testid="family-tree-canvas"
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, width: layout.width, height: layout.height }}
        >
          {/* Generation bands sit behind everything, so a wide tree still reads
              as rows even when the user has panned far to the right. */}
          {layout.generations.map((g) => (
            <div
              key={g.depth}
              className="absolute left-0 right-0 border-y border-dashed border-border/40"
              style={{ top: g.y - 10, height: g.height + 20 }}
            >
              <span className="absolute -top-2 left-1 bg-background px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                {generationLabel(g.depth, totalGenerations)}
              </span>
            </div>
          ))}

          <svg className="pointer-events-none absolute left-0 top-0" width={layout.width} height={layout.height}>
            {layout.connectors.map((c, i) => (
              <path
                key={i}
                d={c.path}
                fill="none"
                className={c.kind === "spouse" ? "stroke-primary/50" : "stroke-muted-foreground/45"}
                strokeWidth={c.kind === "spouse" ? 2 : 1.5}
                strokeDasharray={c.kind === "sibling" ? "5 4" : undefined}
                strokeLinecap="round"
              />
            ))}
          </svg>

          {layout.units.map((unit) =>
            unit.members.map((member, i) => {
              const left = unit.x + i * (CARD_WIDTH + SPOUSE_GAP);
              const kids = childCount.get(member.id) ?? 0;
              const isCollapsed = collapsed.has(member.id);
              const hiddenCount = isCollapsed ? descendantCount(member.id, people, edges) : 0;
              return (
                <div
                  key={member.id}
                  data-tree-card
                  onClick={() => onSelect?.(member.id)}
                  // NB: no `hover-elevate` here — that utility sets
                  // `position: relative` at a higher specificity than
                  // Tailwind's `absolute`, which drops every card into normal
                  // flow and turns the tree into a diagonal staircase.
                  className={`absolute flex cursor-pointer select-none items-center gap-2 rounded-md border bg-card px-2 py-1.5 shadow-sm transition-colors hover:shadow-md ${
                    member.blocked
                      ? member.blockOrigin === "propagated"
                        ? "border-amber-500/60 bg-amber-500/5"
                        : "border-red-500/60 bg-red-500/5"
                      : selectedId === member.id
                        ? "border-primary ring-1 ring-primary"
                        : "border-border"
                  }`}
                  style={{ left, top: unit.y, width: CARD_WIDTH, height: unit.height }}
                  data-testid={`node-person-${member.id}`}
                >
                  {member.photoUrl ? (
                    <img src={member.photoUrl} alt="" className="h-8 w-8 shrink-0 rounded-full border object-cover" />
                  ) : (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                      {initials(member.fullName)}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1">
                      <span className="truncate text-xs font-semibold leading-tight">{member.fullName}</span>
                      {patriarchId === member.id && <span className="shrink-0 text-[10px]" title="Family head">★</span>}
                    </span>
                    {member.companies?.[0] && (
                      <span className="block truncate text-[10px] text-muted-foreground">{member.companies[0]}</span>
                    )}
                    <span className="flex items-center gap-1">
                      {member.netWorthEstimate && (
                        <span className="truncate text-[10px] tabular-nums text-muted-foreground">{member.netWorthEstimate}</span>
                      )}
                      {member.blocked && (
                        <span
                          className={`inline-flex items-center gap-0.5 text-[10px] ${member.blockOrigin === "propagated" ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400"}`}
                          title={member.blockOrigin === "propagated" ? "Blocked because a relative is covered" : "Covered by another banker"}
                        >
                          {member.blockOrigin === "propagated" ? <ShieldAlert className="h-2.5 w-2.5" /> : <Ban className="h-2.5 w-2.5" />}
                          {member.blockOrigin === "propagated" ? "via family" : "blocked"}
                        </span>
                      )}
                    </span>
                  </span>
                  {kids > 0 && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleCollapse(member.id); }}
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
                      title={isCollapsed ? `Show ${hiddenCount} descendant${hiddenCount === 1 ? "" : "s"}` : "Hide this branch"}
                      data-testid={`button-collapse-${member.id}`}
                    >
                      {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </button>
                  )}
                  {isCollapsed && hiddenCount > 0 && (
                    <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full border bg-background px-1.5 text-[10px] text-muted-foreground">
                      +{hiddenCount}
                    </span>
                  )}
                </div>
              );
            }),
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-px w-6 bg-muted-foreground/60" /> parent → child</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0.5 w-6 bg-primary/60" /> married</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-6 border-t border-dashed border-muted-foreground/60" /> sibling</span>
        <span className="inline-flex items-center gap-1.5"><Ban className="h-3 w-3 text-red-500" /> covered by another banker</span>
        <span className="inline-flex items-center gap-1.5"><ShieldAlert className="h-3 w-3 text-amber-500" /> covered via a relative</span>
      </div>
    </div>
  );
}
