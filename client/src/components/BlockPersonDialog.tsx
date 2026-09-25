/**
 * Mark a person as covered by another banker, and propagate the block to the
 * relatives that follow from it.
 *
 * Billy's rule: a blocked child means the parents are covered too, so parents
 * come pre-checked. Spouse, siblings and children are offered but never
 * assumed. Blocks are ALWAYS a human action — no agent writes one.
 *
 * Shared by the family tree and the person page so the two can never drift.
 */

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Ban, Loader2 } from "lucide-react";

/** A relative, described from the blocked person's point of view. */
export interface BlockRelative {
  personId: number;
  fullName: string;
  kind: "parent" | "child" | "spouse" | "sibling" | "other";
  blocked?: boolean;
}

const GROUP_ORDER: { kind: BlockRelative["kind"]; label: string; hint?: string }[] = [
  { kind: "parent", label: "Parents", hint: "pre-checked — a covered child means the parents are covered too" },
  { kind: "spouse", label: "Spouse" },
  { kind: "sibling", label: "Siblings" },
  { kind: "child", label: "Children" },
];

export function BlockPersonDialog({
  personId,
  fullName,
  relatives,
  onOpenChange,
  onBlocked,
}: {
  personId: number;
  fullName: string;
  relatives: BlockRelative[];
  onOpenChange: (open: boolean) => void;
  onBlocked: () => void;
}) {
  const available = useMemo(() => relatives.filter((r) => !r.blocked && r.personId !== personId), [relatives, personId]);
  const [checked, setChecked] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(available.filter((r) => r.kind === "parent").map((r) => [r.personId, true])),
  );
  const [coveredBy, setCoveredBy] = useState("");
  const [reason, setReason] = useState("Covered by another banker");

  const blockMutation = useMutation({
    mutationFn: async () => {
      const alsoBlock = Object.entries(checked)
        .filter(([, on]) => on)
        .map(([id]) => parseInt(id, 10));
      await apiRequest("POST", `/api/persons/${personId}/block`, {
        alsoBlock,
        reason: reason || null,
        coveredBy: coveredBy || null,
      });
    },
    onSuccess: onBlocked,
  });

  const groups = GROUP_ORDER.map((g) => ({ ...g, people: available.filter((r) => r.kind === g.kind) })).filter(
    (g) => g.people.length > 0,
  );
  const alsoCount = Object.values(checked).filter(Boolean).length;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ban className="h-4 w-4 text-red-500" /> Block {fullName}
          </DialogTitle>
          <DialogDescription>
            Blocked people stay visible on leads with a ⛔ badge — they are covered elsewhere and should not be approached.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {groups.length > 0 ? (
            <div>
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Also block relatives?
              </div>
              <div className="space-y-2">
                {groups.map((g) => (
                  <div key={g.kind} className="space-y-1">
                    {g.people.map((r) => (
                      <label key={r.personId} className="flex cursor-pointer items-center gap-2 text-sm">
                        <Checkbox
                          checked={!!checked[r.personId]}
                          onCheckedChange={(v) => setChecked((s) => ({ ...s, [r.personId]: !!v }))}
                          data-testid={`checkbox-block-${r.personId}`}
                        />
                        <span className="font-medium">{r.fullName}</span>
                        <span className="text-xs text-muted-foreground">({g.label.replace(/s$/, "").toLowerCase()})</span>
                      </label>
                    ))}
                    {g.hint && <p className="pl-6 text-xs text-muted-foreground">{g.hint}</p>}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No relatives mapped yet, so only {fullName} will be blocked.
            </p>
          )}

          <div className="space-y-1">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Covered by (optional)</label>
            <Input value={coveredBy} onChange={(e) => setCoveredBy(e.target.value)} placeholder="Bank or banker name" data-testid="input-block-covered-by" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Reason</label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="input-block-reason" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => blockMutation.mutate()}
            disabled={blockMutation.isPending}
            data-testid="button-block-confirm"
          >
            {blockMutation.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Ban className="mr-1.5 h-4 w-4" />}
            Block {alsoCount > 0 ? `${alsoCount + 1} people` : fullName}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
