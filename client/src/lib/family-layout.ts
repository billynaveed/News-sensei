/**
 * Family tree layout.
 *
 * A generic tree layout is the wrong shape for a family: a child hangs from a
 * COUPLE, not from a single parent, and a person can appear as both someone's
 * child and someone's spouse. So this builds "units" (one person, or a married
 * pair) and lays those out with a tidy-tree pass, which is what makes the
 * result read as a family tree rather than a flowchart.
 *
 * Pure and deterministic: no React, no DOM, no side effects, so the geometry
 * can be unit-tested rather than eyeballed in a screenshot.
 */

export interface LayoutPerson {
  id: number;
  fullName: string;
  photoUrl?: string | null;
  companies?: string[] | null;
  netWorthEstimate?: string | null;
  blocked?: boolean;
  blockOrigin?: "direct" | "propagated" | null;
}

export interface LayoutEdge {
  fromPersonId: number;
  toPersonId: number;
  type: "parent" | "spouse" | "sibling";
}

/** One box on the canvas: a single person or a married pair side by side. */
export interface Unit {
  key: string;
  members: LayoutPerson[];
  /** Generation index, 0 = oldest drawn. */
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ConnectorKind = "descent" | "spouse" | "sibling";

export interface Connector {
  kind: ConnectorKind;
  path: string;
}

export interface FamilyLayout {
  units: Unit[];
  connectors: Connector[];
  /** People with no relationship at all — shown separately, never invented into the tree. */
  unlinked: LayoutPerson[];
  width: number;
  height: number;
  /** Generation bands, for the "G1 / G2" rail down the side. */
  generations: { depth: number; y: number; height: number }[];
}

export interface LayoutOptions {
  cardWidth?: number;
  cardHeight?: number;
  /** Gap between the two people of a couple. */
  spouseGap?: number;
  /** Horizontal gap between sibling units. */
  unitGap?: number;
  /** Vertical gap between generations. */
  levelGap?: number;
  padding?: number;
  /** Person ids whose descendants are hidden. */
  collapsed?: Set<number>;
}

/** Exported so the renderer positions cards with the exact same numbers. */
export const CARD_WIDTH = 196;
export const CARD_HEIGHT = 74;
export const SPOUSE_GAP = 14;

const DEFAULTS = {
  cardWidth: CARD_WIDTH,
  cardHeight: CARD_HEIGHT,
  spouseGap: SPOUSE_GAP,
  unitGap: 28,
  levelGap: 74,
  padding: 24,
};

/**
 * Build the tree. Everything is derived from the edges; a person the sources
 * never linked stays in `unlinked` rather than being guessed into a position.
 */
export function layoutFamily(
  people: LayoutPerson[],
  edges: LayoutEdge[],
  options: LayoutOptions = {},
): FamilyLayout {
  const o = { ...DEFAULTS, ...options };
  const collapsed = options.collapsed ?? new Set<number>();
  const byId = new Map(people.map((p) => [p.id, p]));
  const valid = edges.filter((e) => byId.has(e.fromPersonId) && byId.has(e.toPersonId) && e.fromPersonId !== e.toPersonId);

  // --- couples ------------------------------------------------------------
  // A spouse edge fuses two people into one unit. Someone married more than
  // once keeps their FIRST partner in the unit; later partners become their
  // own unit, otherwise the row order becomes unsolvable.
  const partnerOf = new Map<number, number>();
  for (const e of valid) {
    if (e.type !== "spouse") continue;
    if (partnerOf.has(e.fromPersonId) || partnerOf.has(e.toPersonId)) continue;
    partnerOf.set(e.fromPersonId, e.toPersonId);
    partnerOf.set(e.toPersonId, e.fromPersonId);
  }

  const unitKeyOf = new Map<number, string>();
  const units = new Map<string, { key: string; members: LayoutPerson[] }>();
  const linked = new Set<number>();
  for (const e of valid) { linked.add(e.fromPersonId); linked.add(e.toPersonId); }

  for (const person of people) {
    if (!linked.has(person.id) || unitKeyOf.has(person.id)) continue;
    const partnerId = partnerOf.get(person.id);
    if (partnerId !== undefined && byId.has(partnerId) && !unitKeyOf.has(partnerId)) {
      const members = [person, byId.get(partnerId)!];
      const key = `u${Math.min(person.id, partnerId)}-${Math.max(person.id, partnerId)}`;
      units.set(key, { key, members });
      unitKeyOf.set(person.id, key);
      unitKeyOf.set(partnerId, key);
    } else {
      const key = `u${person.id}`;
      units.set(key, { key, members: [person] });
      unitKeyOf.set(person.id, key);
    }
  }

  // --- parent/child between units -----------------------------------------
  const childUnits = new Map<string, Set<string>>();
  const parentUnits = new Map<string, Set<string>>();
  const childPersonToParentUnit = new Map<number, string>();
  for (const e of valid) {
    if (e.type !== "parent") continue;
    const pu = unitKeyOf.get(e.fromPersonId);
    const cu = unitKeyOf.get(e.toPersonId);
    if (!pu || !cu || pu === cu) continue;
    if (!childUnits.has(pu)) childUnits.set(pu, new Set());
    childUnits.get(pu)!.add(cu);
    if (!parentUnits.has(cu)) parentUnits.set(cu, new Set());
    parentUnits.get(cu)!.add(pu);
    childPersonToParentUnit.set(e.toPersonId, pu);
  }

  // Sibling edges only matter when neither person has a known parent; they
  // pin the two units to the same generation without inventing a parent.
  const siblingPairs: [string, string][] = [];
  for (const e of valid) {
    if (e.type !== "sibling") continue;
    const a = unitKeyOf.get(e.fromPersonId);
    const b = unitKeyOf.get(e.toPersonId);
    if (a && b && a !== b) siblingPairs.push([a, b]);
  }

  // --- depth --------------------------------------------------------------
  const depth = new Map<string, number>();
  for (const key of units.keys()) depth.set(key, 0);
  const maxIter = units.size + 10;
  for (let i = 0; i < maxIter; i++) {
    let changed = false;
    for (const [parent, children] of childUnits) {
      for (const child of children) {
        const want = depth.get(parent)! + 1;
        if (depth.get(child)! < want) { depth.set(child, want); changed = true; }
      }
    }
    for (const [a, b] of siblingPairs) {
      const level = Math.max(depth.get(a)!, depth.get(b)!);
      if (depth.get(a)! !== level) { depth.set(a, level); changed = true; }
      if (depth.get(b)! !== level) { depth.set(b, level); changed = true; }
    }
    if (!changed) break; // bad data can cycle; the bound stops it hanging
  }

  // --- collapsing ---------------------------------------------------------
  // Hiding a branch hides every unit reachable only through it.
  const hidden = new Set<string>();
  if (collapsed.size > 0) {
    const roots = Array.from(units.values())
      .filter((u) => u.members.some((m) => collapsed.has(m.id)))
      .map((u) => u.key);
    const stack = [...roots.flatMap((r) => Array.from(childUnits.get(r) ?? []))];
    while (stack.length) {
      const key = stack.pop()!;
      if (hidden.has(key)) continue;
      // Keep a unit that still has a visible parent elsewhere (married in).
      const parents = Array.from(parentUnits.get(key) ?? []);
      if (parents.length > 0 && parents.some((p) => !hidden.has(p) && !roots.includes(p))) continue;
      hidden.add(key);
      for (const c of childUnits.get(key) ?? []) stack.push(c);
    }
  }

  const visibleKeys = Array.from(units.keys()).filter((k) => !hidden.has(k));
  const widthOf = (key: string) => {
    const u = units.get(key)!;
    return u.members.length === 2 ? o.cardWidth * 2 + o.spouseGap : o.cardWidth;
  };

  // --- x positions --------------------------------------------------------
  // Tidy-tree: place children first, then centre each parent over them. A
  // parent whose children are all hidden is placed in row order instead.
  const x = new Map<string, number>();
  const byDepth = new Map<number, string[]>();
  for (const key of visibleKeys) {
    const d = depth.get(key)!;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(key);
  }
  const depths = Array.from(byDepth.keys()).sort((a, b) => a - b);

  // Deterministic order within a row: by first member's name, so the same
  // data always draws the same tree.
  const nameOf = (key: string) => units.get(key)!.members[0].fullName;
  for (const d of depths) byDepth.get(d)!.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));

  // Deepest generation first: pack left to right.
  let cursorByDepth = new Map<number, number>();
  for (const d of [...depths].reverse()) {
    let cursor = o.padding;
    for (const key of byDepth.get(d)!) {
      const kids = Array.from(childUnits.get(key) ?? []).filter((c) => !hidden.has(c) && x.has(c));
      if (kids.length > 0) {
        const left = Math.min(...kids.map((c) => x.get(c)!));
        const right = Math.max(...kids.map((c) => x.get(c)! + widthOf(c)));
        const centred = (left + right) / 2 - widthOf(key) / 2;
        cursor = Math.max(cursor, centred);
      }
      x.set(key, cursor);
      cursor += widthOf(key) + o.unitGap;
    }
    cursorByDepth.set(d, cursor);
  }

  // Second pass downward: a parent that moved right drags its children along,
  // so descent lines stay vertical instead of shearing across the canvas.
  for (const d of depths) {
    const kidsShift = new Map<string, number>();
    for (const key of byDepth.get(d)!) {
      const kids = Array.from(childUnits.get(key) ?? []).filter((c) => !hidden.has(c));
      if (kids.length === 0) continue;
      const left = Math.min(...kids.map((c) => x.get(c)!));
      const right = Math.max(...kids.map((c) => x.get(c)! + widthOf(c)));
      const want = x.get(key)! + widthOf(key) / 2;
      const have = (left + right) / 2;
      const delta = want - have;
      if (Math.abs(delta) < 1) continue;
      for (const c of kids) kidsShift.set(c, Math.max(kidsShift.get(c) ?? -Infinity, delta));
    }
    // Apply, then re-separate that row so nothing overlaps.
    for (const [key, delta] of kidsShift) x.set(key, x.get(key)! + delta);
    const nextRow = byDepth.get(d + 1);
    if (nextRow) {
      const ordered = [...nextRow].sort((a, b) => x.get(a)! - x.get(b)!);
      byDepth.set(d + 1, ordered);
      let cursor = o.padding;
      for (const key of ordered) {
        if (x.get(key)! < cursor) x.set(key, cursor);
        cursor = x.get(key)! + widthOf(key) + o.unitGap;
      }
    }
  }

  // --- assemble -----------------------------------------------------------
  const laidOut: Unit[] = visibleKeys.map((key) => {
    const u = units.get(key)!;
    const d = depth.get(key)!;
    return {
      key,
      members: u.members,
      depth: d,
      x: x.get(key)!,
      y: o.padding + d * (o.cardHeight + o.levelGap),
      width: widthOf(key),
      height: o.cardHeight,
    };
  });
  const unitByKey = new Map(laidOut.map((u) => [u.key, u]));

  const connectors: Connector[] = [];
  // Spouse: a short bar between the two cards of a couple.
  for (const u of laidOut) {
    if (u.members.length !== 2) continue;
    const y = u.y + u.height / 2;
    connectors.push({ kind: "spouse", path: `M ${u.x + o.cardWidth} ${y} L ${u.x + o.cardWidth + o.spouseGap} ${y}` });
  }
  // Descent: down from the couple's midpoint, along a shared bus, then into
  // the top of each child — the orthogonal shape a family tree is read in.
  for (const [parentKey, children] of childUnits) {
    const parent = unitByKey.get(parentKey);
    if (!parent) continue;
    const kids = Array.from(children).map((c) => unitByKey.get(c)).filter((c): c is Unit => !!c);
    if (kids.length === 0) continue;
    const fromX = parent.x + parent.width / 2;
    const fromY = parent.y + parent.height;
    const busY = fromY + o.levelGap / 2;
    connectors.push({ kind: "descent", path: `M ${fromX} ${fromY} L ${fromX} ${busY}` });
    const xs = kids.map((k) => k.x + k.width / 2);
    const left = Math.min(fromX, ...xs);
    const right = Math.max(fromX, ...xs);
    if (right - left > 1) connectors.push({ kind: "descent", path: `M ${left} ${busY} L ${right} ${busY}` });
    for (const kid of kids) {
      const kx = kid.x + kid.width / 2;
      connectors.push({ kind: "descent", path: `M ${kx} ${busY} L ${kx} ${kid.y}` });
    }
  }
  // Sibling: dashed, only for pairs with no shared parent to hang from.
  for (const [a, b] of siblingPairs) {
    const ua = unitByKey.get(a);
    const ub = unitByKey.get(b);
    if (!ua || !ub) continue;
    if (parentUnits.has(a) || parentUnits.has(b)) continue;
    const [l, r] = ua.x <= ub.x ? [ua, ub] : [ub, ua];
    const y = l.y + l.height / 2;
    connectors.push({ kind: "sibling", path: `M ${l.x + l.width} ${y} L ${r.x} ${r.y + r.height / 2}` });
  }

  const unlinked = people.filter((p) => !linked.has(p.id));
  const maxX = laidOut.reduce((m, u) => Math.max(m, u.x + u.width), 0);
  const maxY = laidOut.reduce((m, u) => Math.max(m, u.y + u.height), 0);

  const generations = depths
    .filter((d) => byDepth.get(d)!.length > 0)
    .map((d) => ({ depth: d, y: o.padding + d * (o.cardHeight + o.levelGap), height: o.cardHeight }));

  return {
    units: laidOut,
    connectors,
    unlinked,
    width: maxX + o.padding,
    height: maxY + o.padding,
    generations,
  };
}

/** Units whose descendants are hidden, so the UI can show a "+3" affordance. */
export function descendantCount(personId: number, people: LayoutPerson[], edges: LayoutEdge[]): number {
  const children = new Map<number, number[]>();
  for (const e of edges) {
    if (e.type !== "parent") continue;
    if (!children.has(e.fromPersonId)) children.set(e.fromPersonId, []);
    children.get(e.fromPersonId)!.push(e.toPersonId);
  }
  const seen = new Set<number>();
  const stack = [...(children.get(personId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return seen.size;
}
