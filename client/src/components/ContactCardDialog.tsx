/**
 * A saved business card as a contact you can act on: call, WhatsApp, email,
 * draft the follow-up, set or push back the reminder, put it on the phone.
 *
 * Opened from the scanner's History and from the notification bell, so the
 * card photo and the "where we met" note are always one tap from the nudge.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CroppedCard } from "@/components/CroppedCard";
import { FollowUpDraftDialog } from "@/components/FollowUpDraftDialog";
import type { BusinessCard } from "@/lib/card-types";
import {
  mailtoUrl,
  relativeDay,
  REMINDER_CHOICES,
  useSetReminder,
  whatsappUrl,
} from "@/lib/follow-ups";
import { useToast } from "@/hooks/use-toast";
import {
  Bell,
  BellOff,
  ExternalLink,
  Globe,
  Linkedin,
  Loader2,
  Mail,
  MapPin,
  MessageCircle,
  PenLine,
  Phone,
  Smartphone,
} from "lucide-react";

export function ContactCardDialog({
  cardId,
  remindAt,
  onOpenChange,
}: {
  cardId: string;
  /** Current reminder, from whichever list opened the dialog. */
  remindAt: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [draftOpen, setDraftOpen] = useState(false);
  const setReminder = useSetReminder();

  const { data: card, isLoading, error } = useQuery<BusinessCard>({
    queryKey: [`/api/cards/${cardId}`],
  });

  const p = card?.parsed;
  const email = p?.emails[0] ?? null;
  const phones = (p?.phones ?? []).filter((ph) => ph.e164 && ph.slot !== "fax");
  // WhatsApp lives on the mobile, never on the switchboard.
  const mobile = phones.find((ph) => ph.slot === "mobile")?.e164 ?? p?.phoneMobile ?? null;

  const remind = (days: number | null) => {
    if (!card?.personId) return;
    setReminder.mutate(
      { personId: card.personId, days },
      {
        onSuccess: () =>
          toast({ title: days ? `Reminder set for ${REMINDER_CHOICES.find((c) => c.days === days)?.label ?? `${days} days`}` : "Reminder cleared" }),
        onError: (e: Error) => toast({ title: "Could not set the reminder", description: e.message, variant: "destructive" }),
      },
    );
  };

  return (
    <>
      <Dialog open={!draftOpen} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          {isLoading || !card ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              {error ? (
                "Could not load this card."
              ) : (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </>
              )}
            </div>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="text-xl" data-testid="text-contact-name">
                  {[p?.honorific, p?.fullName].filter(Boolean).join(" ") || "(no name)"}
                </DialogTitle>
                <DialogDescription>
                  {[p?.jobTitle, p?.company].filter(Boolean).join(" · ") || "No title or company on the card"}
                </DialogDescription>
              </DialogHeader>

              {card.frontImage && (
                // Fixed height in a clipping box: inside the dialog's grid an
                // aspect-ratio box let the scaled photo run over the buttons.
                <div className="h-44 overflow-hidden rounded-md border sm:h-52">
                  <CroppedCard src={card.frontImage} bounds={p?.cardBounds} className="h-full w-full" />
                </div>
              )}

              {/* The three ways to reach them, as big targets for a thumb. */}
              <div className="grid grid-cols-3 gap-2">
                <ReachButton href={mobile ?? phones[0]?.e164 ? `tel:${mobile ?? phones[0].e164}` : null} icon={Phone} label="Call" missing="No number" testId="link-contact-call" />
                <ReachButton href={mobile ? whatsappUrl(mobile) : null} icon={MessageCircle} label="WhatsApp" missing="No mobile" testId="link-contact-whatsapp" external />
                <ReachButton href={email ? mailtoUrl(email) : null} icon={Mail} label="Email" missing="No email" testId="link-contact-email" />
              </div>

              <dl className="space-y-1.5 text-sm">
                {phones.map((ph, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Badge variant="outline" className="w-16 shrink-0 justify-center text-xs capitalize">{ph.slot}</Badge>
                    <a href={`tel:${ph.e164}`} className="font-mono tabular-nums hover:underline">{ph.display ?? ph.e164}</a>
                  </div>
                ))}
                {email && (
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <a href={mailtoUrl(email)} className="truncate hover:underline">{email}</a>
                  </div>
                )}
                {p?.linkedin && (
                  <div className="flex items-center gap-2">
                    <Linkedin className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <a href={p.linkedin} target="_blank" rel="noreferrer" className="truncate hover:underline">LinkedIn profile</a>
                  </div>
                )}
                {p?.website && (
                  <div className="flex items-center gap-2">
                    <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <a href={p.website} target="_blank" rel="noreferrer" className="truncate hover:underline">{p.website.replace(/^https?:\/\//, "")}</a>
                  </div>
                )}
                {card.eventNote && (
                  <div className="flex items-start gap-2">
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="text-muted-foreground">{card.eventNote}</span>
                  </div>
                )}
              </dl>

              {card.personId && (
                <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
                  <div className="flex items-center gap-1.5 font-medium">
                    <Bell className="h-4 w-4" />
                    {remindAt ? (
                      <span data-testid="text-contact-reminder">
                        Follow up {relativeDay(remindAt)}
                        <span className="ml-1 font-normal text-muted-foreground">
                          ({new Date(remindAt).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })})
                        </span>
                      </span>
                    ) : (
                      <span>No follow-up reminder</span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-muted-foreground">Remind me</span>
                    {REMINDER_CHOICES.map((c) => (
                      <Button
                        key={c.days}
                        size="sm"
                        variant="outline"
                        disabled={setReminder.isPending}
                        onClick={() => remind(c.days)}
                        data-testid={`button-contact-remind-${c.days}`}
                      >
                        {c.label}
                      </Button>
                    ))}
                    {remindAt && (
                      <Button size="sm" variant="ghost" disabled={setReminder.isPending} onClick={() => remind(null)} data-testid="button-contact-remind-clear">
                        <BellOff className="mr-1 h-3.5 w-3.5" /> Clear
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {card.personId && (
                  <Button onClick={() => setDraftOpen(true)} data-testid="button-contact-draft">
                    <PenLine className="mr-1.5 h-4 w-4" /> Draft follow-up
                  </Button>
                )}
                <Button variant="outline" asChild>
                  <a href={card.vcardUrl ?? `/api/cards/${card.id}/vcard`} data-testid="link-contact-vcard">
                    <Smartphone className="mr-1.5 h-4 w-4" /> Add to phone
                  </a>
                </Button>
                {card.personId && (
                  <Button variant="ghost" asChild>
                    <Link href={`/people/${card.personId}`} onClick={() => onOpenChange(false)} data-testid="link-contact-person">
                      <ExternalLink className="mr-1.5 h-4 w-4" /> Open in Sensei
                    </Link>
                  </Button>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {draftOpen && card?.personId && (
        <FollowUpDraftDialog
          personId={card.personId}
          fullName={p?.fullName ?? ""}
          email={email}
          mobile={mobile}
          onOpenChange={(o) => !o && setDraftOpen(false)}
        />
      )}
    </>
  );
}

/** One of the three big call / WhatsApp / email targets; greyed out when the card had no such detail. */
function ReachButton({
  href,
  icon: Icon,
  label,
  missing,
  testId,
  external,
}: {
  href: string | null;
  icon: typeof Phone;
  label: string;
  missing: string;
  testId: string;
  external?: boolean;
}) {
  const body = (
    <>
      <Icon className="h-4 w-4" />
      <span className="text-xs">{href ? label : missing}</span>
    </>
  );
  if (!href) {
    return (
      <Button variant="outline" className="h-auto flex-col gap-1 py-2" disabled>
        {body}
      </Button>
    );
  }
  return (
    <Button variant="outline" className="h-auto flex-col gap-1 py-2" asChild>
      <a href={href} data-testid={testId} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
        {body}
      </a>
    </Button>
  );
}
