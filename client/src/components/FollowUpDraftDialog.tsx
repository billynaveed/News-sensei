/**
 * A first draft of the follow-up message, and the reminder that goes with it.
 *
 * The draft is written from the notes only. The prompt refuses to invent a
 * conversation, so a sparse note gives a short, honest message rather than a
 * fluent one about a meeting that never happened.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Check, Copy, Loader2, Mail, MessageCircle, PenLine } from "lucide-react";

interface Draft {
  subject: string;
  message: string;
  channel: "email" | "whatsapp";
}

export function FollowUpDraftDialog({
  personId,
  fullName,
  onOpenChange,
}: {
  personId: number;
  fullName: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [channel, setChannel] = useState<"email" | "whatsapp">("email");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [copied, setCopied] = useState(false);

  const generate = useMutation({
    mutationFn: async (which: "email" | "whatsapp") => {
      const res = await apiRequest("POST", `/api/people/${personId}/follow-up-draft`, { channel: which });
      return (await res.json()) as Draft;
    },
    onSuccess: (d) => setDraft(d),
    onError: (e: Error) => toast({ title: "Could not draft the message", description: e.message, variant: "destructive" }),
  });

  const remind = useMutation({
    mutationFn: async (days: number) => {
      await apiRequest("POST", `/api/people/${personId}/follow-up`, { days });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/people/${personId}/profile`] });
      toast({ title: "Reminder set" });
    },
  });

  const copy = async () => {
    if (!draft) return;
    const text = draft.subject ? `${draft.subject}\n\n${draft.message}` : draft.message;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast({ title: "Could not copy", description: "Select the text and copy it manually.", variant: "destructive" });
    }
  };

  const pick = (which: "email" | "whatsapp") => {
    setChannel(which);
    setDraft(null);
    generate.mutate(which);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PenLine className="h-4 w-4" /> Follow up with {fullName}
          </DialogTitle>
          <DialogDescription>
            Written from your notes only — it will not invent a conversation you did not have.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={channel === "email" && draft ? "default" : "outline"}
              onClick={() => pick("email")}
              disabled={generate.isPending}
              data-testid="button-draft-email"
            >
              <Mail className="mr-1.5 h-4 w-4" /> Email
            </Button>
            <Button
              size="sm"
              variant={channel === "whatsapp" && draft ? "default" : "outline"}
              onClick={() => pick("whatsapp")}
              disabled={generate.isPending}
              data-testid="button-draft-whatsapp"
            >
              <MessageCircle className="mr-1.5 h-4 w-4" /> WhatsApp
            </Button>
          </div>

          {generate.isPending && (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Writing a draft…
            </div>
          )}

          {draft && !generate.isPending && (
            <div className="space-y-2">
              {draft.channel === "email" && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Subject</Label>
                  <Input
                    value={draft.subject}
                    onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                    data-testid="input-draft-subject"
                  />
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Message</Label>
                <Textarea
                  value={draft.message}
                  onChange={(e) => setDraft({ ...draft, message: e.target.value })}
                  rows={draft.channel === "whatsapp" ? 4 : 8}
                  data-testid="input-draft-message"
                />
              </div>
              <p className="text-xs text-muted-foreground">Edit it before you send — it is a starting point, not a send button.</p>
            </div>
          )}

          {!draft && !generate.isPending && (
            <p className="py-4 text-sm text-muted-foreground">Pick a channel and a draft appears here.</p>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
            <span className="text-muted-foreground">Remind me again in</span>
            {[3, 7, 30].map((d) => (
              <Button key={d} size="sm" variant="outline" onClick={() => remind.mutate(d)} disabled={remind.isPending} data-testid={`button-person-remind-${d}`}>
                {d === 30 ? "a month" : d === 7 ? "a week" : `${d} days`}
              </Button>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          <Button onClick={copy} disabled={!draft} data-testid="button-copy-draft">
            {copied ? <Check className="mr-1.5 h-4 w-4" /> : <Copy className="mr-1.5 h-4 w-4" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
