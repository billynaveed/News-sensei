/**
 * The follow-up bell in the app header.
 *
 * A reminder set on a contact ("follow up in 3 days") shows here with a count
 * once it comes due. From the list it can be pushed to tomorrow or dismissed,
 * and tapping the name opens the contact card to actually do the follow-up.
 * The Telegram digest still goes out each morning; this is the in-app half.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ContactCardDialog } from "@/components/ContactCardDialog";
import type { FollowUpEntry } from "@/lib/card-types";
import { relativeDay, useSetReminder } from "@/lib/follow-ups";
import { useToast } from "@/hooks/use-toast";
import { Bell, Check, Clock } from "lucide-react";

export function NotificationBell() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [contact, setContact] = useState<FollowUpEntry | null>(null);
  const setReminder = useSetReminder();

  const { data } = useQuery<{ due: FollowUpEntry[]; upcoming: FollowUpEntry[] }>({
    queryKey: ["/api/follow-ups"],
    // A reminder comes due on the clock, not on any action in the app.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  const due = data?.due ?? [];
  const upcoming = data?.upcoming ?? [];

  const act = (c: FollowUpEntry, days: number | null) =>
    setReminder.mutate(
      { personId: c.personId, days },
      {
        onSuccess: () => toast({ title: days ? `${c.fullName}: reminder moved to tomorrow` : `${c.fullName}: reminder dismissed` }),
        onError: (e: Error) => toast({ title: "Could not update the reminder", description: e.message, variant: "destructive" }),
      },
    );

  const openContact = (c: FollowUpEntry) => {
    setOpen(false);
    if (c.cardId) setContact(c);
    else navigate(`/people/${c.personId}`);
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            title={due.length ? `${due.length} follow-up${due.length === 1 ? "" : "s"} due` : "Follow-ups"}
            data-testid="button-notifications"
          >
            <Bell className="h-5 w-5" />
            {due.length > 0 && (
              <span
                className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white"
                data-testid="badge-notifications-count"
              >
                {due.length > 9 ? "9+" : due.length}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[22rem] max-w-[calc(100vw-1.5rem)] p-0">
          <div className="border-b px-3 py-2 text-sm font-medium">Follow-ups</div>
          <div className="max-h-[70vh] overflow-y-auto">
            {due.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground" data-testid="text-notifications-empty">
                Nothing due. Set a reminder after saving a card, or from History.
              </p>
            ) : (
              <ul className="divide-y">
                {due.map((c) => (
                  <li key={c.personId} className="space-y-2 px-3 py-2.5" data-testid={`notification-${c.personId}`}>
                    <button type="button" onClick={() => openContact(c)} className="block w-full text-left">
                      <span className="block text-sm">
                        Follow up with <span className="font-medium">{c.fullName}</span>
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[c.jobTitle, c.company].filter(Boolean).join(", ") || "—"} · due {relativeDay(c.remindAt)}
                      </span>
                      {c.notes && (
                        <span className="block truncate text-xs italic text-muted-foreground">{c.notes.split("\n")[0]}</span>
                      )}
                    </button>
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        disabled={setReminder.isPending}
                        onClick={() => act(c, 1)}
                        data-testid={`button-notification-snooze-${c.personId}`}
                      >
                        <Clock className="mr-1 h-3 w-3" /> Tomorrow
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        disabled={setReminder.isPending}
                        onClick={() => act(c, null)}
                        data-testid={`button-notification-dismiss-${c.personId}`}
                      >
                        <Check className="mr-1 h-3 w-3" /> Dismiss
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {upcoming.length > 0 && (
              <div className="border-t">
                <div className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Coming up</div>
                <ul className="pb-1.5">
                  {upcoming.map((c) => (
                    <li key={c.personId}>
                      <button
                        type="button"
                        onClick={() => openContact(c)}
                        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover-elevate"
                        data-testid={`notification-upcoming-${c.personId}`}
                      >
                        <span className="truncate">{c.fullName}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{relativeDay(c.remindAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {contact?.cardId && (
        <ContactCardDialog
          cardId={contact.cardId}
          // Read live from the bell's own list so pushing it back in the
          // dialog updates the line shown there.
          remindAt={[...due, ...upcoming].find((c) => c.personId === contact.personId)?.remindAt ?? null}
          onOpenChange={(o) => !o && setContact(null)}
        />
      )}
    </>
  );
}
