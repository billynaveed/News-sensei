/**
 * Scanner History: every saved card, most recently saved first, grouped by
 * day. Tapping one opens the contact card to call, email or set a follow-up.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ContactCardDialog } from "@/components/ContactCardDialog";
import type { CardHistoryEntry } from "@/lib/card-types";
import { relativeDay } from "@/lib/follow-ups";
import { ArrowLeft, Bell, History, Loader2, MapPin, Search } from "lucide-react";

function dayHeading(iso: string): string {
  const rel = relativeDay(iso);
  if (rel === "today" || rel === "yesterday") return rel[0].toUpperCase() + rel.slice(1);
  return new Date(iso).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export default function CardHistoryPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const { data, isLoading } = useQuery<{ cards: CardHistoryEntry[] }>({
    queryKey: ["/api/cards/history"],
    // Cards saved from Telegram land here too; refresh on every visit.
    staleTime: 0,
  });

  const cards = data?.cards ?? [];
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter((c) =>
      [c.parsed?.fullName, c.parsed?.company, c.parsed?.jobTitle, c.eventNote]
        .some((v) => v?.toLowerCase().includes(q)),
    );
  }, [cards, filter]);

  // Consecutive rows that share a day sit under one heading. The list is
  // already newest-first, so this keeps that order.
  const groups = useMemo(() => {
    const out: { heading: string; cards: CardHistoryEntry[] }[] = [];
    for (const c of visible) {
      const heading = dayHeading(c.savedAt);
      const last = out[out.length - 1];
      if (last?.heading === heading) last.cards.push(c);
      else out.push({ heading, cards: [c] });
    }
    return out;
  }, [visible]);

  const open = cards.find((c) => c.id === openId);

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/scan" title="Back to the scanner" data-testid="link-history-back">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <History className="h-6 w-6" /> History
        </h1>
        <span className="text-sm text-muted-foreground">
          {cards.length} saved card{cards.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Name, company or where you met"
          className="pl-8"
          data-testid="input-history-filter"
        />
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : groups.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground" data-testid="history-empty">
          {filter ? "No saved card matches that." : "No saved cards yet. Scan one and press Save."}
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.heading} className="space-y-1.5">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{g.heading}</h2>
            <ul className="divide-y rounded-md border">
              {g.cards.map((c) => {
                const name = c.parsed?.fullName || "(no name)";
                const sub = [c.parsed?.jobTitle, c.parsed?.company].filter(Boolean).join(" · ");
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setOpenId(c.id)}
                      className="flex w-full items-center gap-3 p-3 text-left hover-elevate"
                      data-testid={`history-card-${c.id}`}
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
                        {initials(name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{name}</span>
                        {sub && <span className="block truncate text-sm text-muted-foreground">{sub}</span>}
                        {c.eventNote && (
                          <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                            <MapPin className="h-3 w-3 shrink-0" /> {c.eventNote}
                          </span>
                        )}
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground">
                        {new Date(c.savedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                        {c.remindAt && (
                          <Badge
                            variant="outline"
                            className={`gap-1 text-[10px] ${new Date(c.remindAt) <= new Date() ? "border-amber-500/50 text-amber-600 dark:text-amber-400" : ""}`}
                          >
                            <Bell className="h-2.5 w-2.5" /> {relativeDay(c.remindAt)}
                          </Badge>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}

      {open && (
        <ContactCardDialog
          cardId={open.id}
          remindAt={open.remindAt}
          onOpenChange={(o) => !o && setOpenId(null)}
        />
      )}
    </div>
  );
}
