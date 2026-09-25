/**
 * Family tree layout geometry. Pure — no DOM, no React.
 */
import { check, eq } from "./harness";
import { descendantCount, layoutFamily, type LayoutEdge, type LayoutPerson } from "../client/src/lib/family-layout";

const P = (id: number, fullName: string): LayoutPerson => ({ id, fullName });

// Tiang → Samrit → Tos, with Tos married to Sookta and two children.
const people: LayoutPerson[] = [
  P(1, "Tiang"), P(2, "Samrit"), P(3, "Tos"), P(4, "Sookta"), P(5, "Akarn"), P(6, "Rit"), P(7, "Pim"),
];
const edges: LayoutEdge[] = [
  { fromPersonId: 1, toPersonId: 2, type: "parent" },
  { fromPersonId: 2, toPersonId: 3, type: "parent" },
  { fromPersonId: 2, toPersonId: 7, type: "parent" },
  { fromPersonId: 3, toPersonId: 4, type: "spouse" },
  { fromPersonId: 3, toPersonId: 5, type: "parent" },
  { fromPersonId: 3, toPersonId: 6, type: "parent" },
];

const tree = layoutFamily(people, edges);

// --- units and couples ---------------------------------------------------------

eq("layout: every linked person is placed", tree.units.flatMap((u) => u.members).length, 7);
eq("layout: nobody is left unlinked here", tree.unlinked.length, 0);
eq("layout: spouses share one unit", tree.units.filter((u) => u.members.length === 2).length, 1);
check(
  "layout: the couple unit holds Tos and Sookta",
  tree.units.some((u) => u.members.length === 2 && u.members.map((m) => m.fullName).sort().join(",") === "Sookta,Tos"),
);
check("layout: a couple unit is wider than a single", (() => {
  const couple = tree.units.find((u) => u.members.length === 2)!;
  const single = tree.units.find((u) => u.members.length === 1)!;
  return couple.width > single.width;
})());

// --- generations ----------------------------------------------------------------

const depthOf = (name: string) => tree.units.find((u) => u.members.some((m) => m.fullName === name))!.depth;
eq("layout: the founder is the top generation", depthOf("Tiang"), 0);
eq("layout: his son is one below", depthOf("Samrit"), 1);
eq("layout: the grandson is two below", depthOf("Tos"), 2);
eq("layout: a spouse sits on their partner's generation", depthOf("Sookta"), 2);
eq("layout: great-grandchildren are three below", depthOf("Akarn"), 3);
eq("layout: siblings share a generation", depthOf("Pim"), depthOf("Tos"));
eq("layout: one band per generation", tree.generations.length, 4);

const yOf = (name: string) => tree.units.find((u) => u.members.some((m) => m.fullName === name))!.y;
check("layout: each generation sits lower than the one above", yOf("Tiang") < yOf("Samrit") && yOf("Samrit") < yOf("Tos"));
eq("layout: same generation shares a y", yOf("Tos"), yOf("Pim"));

// --- no overlaps ------------------------------------------------------------------

check("layout: no two units in a row overlap", (() => {
  const rows = new Map<number, { x: number; width: number }[]>();
  for (const u of tree.units) {
    if (!rows.has(u.depth)) rows.set(u.depth, []);
    rows.get(u.depth)!.push({ x: u.x, width: u.width });
  }
  for (const row of rows.values()) {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].x < sorted[i - 1].x + sorted[i - 1].width) return false;
    }
  }
  return true;
})());

check("layout: canvas is big enough for every unit", tree.units.every((u) => u.x + u.width <= tree.width && u.y + u.height <= tree.height));

// --- parents sit over their children ----------------------------------------------

check("layout: a parent is centred over its children", (() => {
  const tos = tree.units.find((u) => u.members.some((m) => m.fullName === "Tos"))!;
  const kids = tree.units.filter((u) => u.members.some((m) => ["Akarn", "Rit"].includes(m.fullName)));
  const kidsCentre = (Math.min(...kids.map((k) => k.x)) + Math.max(...kids.map((k) => k.x + k.width))) / 2;
  return Math.abs(tos.x + tos.width / 2 - kidsCentre) < 2;
})());

// --- connectors --------------------------------------------------------------------

check("layout: a spouse bar is drawn", tree.connectors.some((c) => c.kind === "spouse"));
eq("layout: exactly one spouse bar for one couple", tree.connectors.filter((c) => c.kind === "spouse").length, 1);
check("layout: descent lines are drawn", tree.connectors.filter((c) => c.kind === "descent").length >= 6);
check("layout: every connector is a valid SVG path", tree.connectors.every((c) => /^M [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+$/.test(c.path)));

// --- unlinked people ----------------------------------------------------------------

const withOrphan = layoutFamily([...people, P(8, "Nobody")], edges);
eq("layout: an unlinked person is set aside, not invented into the tree", withOrphan.unlinked.map((p) => p.fullName), ["Nobody"]);
eq("layout: unlinked people are not given a unit", withOrphan.units.flatMap((u) => u.members).filter((m) => m.fullName === "Nobody").length, 0);

// --- collapsing ----------------------------------------------------------------------

const collapsed = layoutFamily(people, edges, { collapsed: new Set([3]) });
check("collapse: Tos's children are hidden", !collapsed.units.some((u) => u.members.some((m) => m.fullName === "Akarn")));
check("collapse: Tos himself stays visible", collapsed.units.some((u) => u.members.some((m) => m.fullName === "Tos")));
check("collapse: an unrelated branch is untouched", collapsed.units.some((u) => u.members.some((m) => m.fullName === "Pim")));
eq("collapse: descendant count for the affordance", descendantCount(3, people, edges), 2);
eq("collapse: a leaf has no descendants", descendantCount(5, people, edges), 0);
eq("collapse: the founder's whole line", descendantCount(1, people, edges), 5);

// --- robustness -----------------------------------------------------------------------

eq("layout: an empty family does not throw", layoutFamily([], []).units.length, 0);
eq("layout: one lone person is unlinked", layoutFamily([P(1, "Solo")], []).unlinked.length, 1);
check("layout: a cycle in bad data terminates", (() => {
  const cyclic: LayoutEdge[] = [
    { fromPersonId: 1, toPersonId: 2, type: "parent" },
    { fromPersonId: 2, toPersonId: 1, type: "parent" },
  ];
  const r = layoutFamily([P(1, "A"), P(2, "B")], cyclic);
  return r.units.length === 2;
})());
check("layout: edges naming unknown people are ignored", (() => {
  const r = layoutFamily([P(1, "A")], [{ fromPersonId: 1, toPersonId: 99, type: "parent" }]);
  return r.unlinked.length === 1 && r.units.length === 0;
})());
check("layout: a second marriage does not fuse three people into one unit", (() => {
  const r = layoutFamily([P(1, "A"), P(2, "B"), P(3, "C")], [
    { fromPersonId: 1, toPersonId: 2, type: "spouse" },
    { fromPersonId: 1, toPersonId: 3, type: "spouse" },
  ]);
  return r.units.every((u) => u.members.length <= 2);
})());
check("layout: the same input always gives the same geometry", (() => {
  const a = layoutFamily(people, edges);
  const b = layoutFamily(people, edges);
  return JSON.stringify(a.units) === JSON.stringify(b.units);
})());
