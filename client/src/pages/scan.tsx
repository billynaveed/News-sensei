/**
 * Business card scanner.
 *
 * Photograph a card (or drop a stack of photos), the vision model reads it,
 * the normaliser fixes the phone numbers and names, and the review panel is
 * where anything doubtful gets corrected before it becomes a contact.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Download,
  Loader2,
  Maximize2,
  RefreshCw,
  ScanLine,
  Trash2,
  Upload,
  UserCheck,
  XCircle,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types mirroring server/card-normalize.ts
// ---------------------------------------------------------------------------

interface NormalizedPhone {
  e164: string | null;
  display: string | null;
  extension: string | null;
  slot: "mobile" | "office" | "fax" | "other";
  label: string | null;
  raw: string;
  inheritedPrefix?: boolean;
}

interface ParsedCard {
  fullName: string;
  nativeName: string | null;
  honorific: string | null;
  suffix: string | null;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  department: string | null;
  company: string | null;
  nativeCompany: string | null;
  phones: NormalizedPhone[];
  phoneMobile: string | null;
  phoneOffice: string | null;
  emails: string[];
  website: string | null;
  linkedin: string | null;
  address: string | null;
  country: string | null;
  otherText: string | null;
}

interface BusinessCard {
  id: string;
  personId: number | null;
  frontImage: string | null;
  parsed: ParsedCard | null;
  confidence: Record<string, number> | null;
  duplicates: { personId: number; fullName: string; reason: string }[] | null;
  status: "parsed" | "needs_review" | "saved" | "failed";
  source: string;
  eventNote: string | null;
  model: string | null;
  error: string | null;
  createdAt: string;
}

/** Labels say what to DO, not what state a row is in ("Ready" told nobody anything). */
const STATUS_BADGE: Record<string, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  parsed: { label: "Check & save", className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", icon: CheckCircle2 },
  needs_review: { label: "Needs a fix", className: "bg-amber-500/10 text-amber-600 dark:text-amber-400", icon: AlertTriangle },
  failed: { label: "Couldn't read", className: "bg-red-500/10 text-red-600 dark:text-red-400", icon: XCircle },
  saved: { label: "Saved", className: "bg-blue-500/10 text-blue-600 dark:text-blue-400", icon: UserCheck },
};

/** A field the model was unsure about gets an amber ring on the review form. */
const LOW_CONFIDENCE = 0.6;

// ---------------------------------------------------------------------------
// Image preparation
// ---------------------------------------------------------------------------

/**
 * Downscale to at most 1600px on the long edge and re-encode as JPEG. Card
 * text stays legible well below the original resolution, and a 4MB phone
 * photo becomes a ~300KB upload.
 */
async function fileToDataUrl(file: File, maxEdge = 1600): Promise<string> {
  const original = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("not an image"));
      el.src = original;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    if (scale === 1 && original.length < 1_500_000) return original;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return original;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    // HEIC and friends may not decode in-browser; let the server try.
    return original;
  }
}

// ---------------------------------------------------------------------------
// Review panel
// ---------------------------------------------------------------------------

function ReviewPanel({
  card,
  onSaved,
  onDiscarded,
}: {
  card: BusinessCard;
  onSaved: () => void;
  onDiscarded: () => void;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<ParsedCard | null>(card.parsed);
  const [note, setNote] = useState(card.eventNote ?? "");

  useEffect(() => {
    setDraft(card.parsed);
    setNote(card.eventNote ?? "");
  }, [card.id, card.parsed, card.eventNote]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const conclusive = card.duplicates?.find((d) => d.reason !== "same name");
      const res = await apiRequest("POST", `/api/cards/${card.id}/save`, {
        parsed: draft,
        eventNote: note || null,
        ...(conclusive ? { mergeIntoPersonId: conclusive.personId } : {}),
      });
      return (await res.json()) as { personId: number; fullName: string };
    },
    onSuccess: (data) => {
      toast({ title: "Contact saved", description: `${data.fullName} is now in Sensei.` });
      onSaved();
    },
    onError: (e: Error) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const reparseMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/cards/${card.id}/reparse`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cards"] });
      toast({ title: "Re-read", description: "The card was read again on the stronger model." });
    },
    onError: (e: Error) => toast({ title: "Re-read failed", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/cards/${card.id}`);
    },
    onSuccess: onDiscarded,
  });

  const conf = card.confidence ?? {};
  const ring = (field: string) =>
    typeof conf[field] === "number" && conf[field] < LOW_CONFIDENCE
      ? "border-amber-500/60 focus-visible:ring-amber-500"
      : "";

  const set = <K extends keyof ParsedCard>(key: K, value: ParsedCard[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  if (card.status === "failed") {
    return (
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-red-600 dark:text-red-400">
            <XCircle className="h-4 w-4" /> Could not read this card
          </div>
          <p className="text-sm text-muted-foreground">{card.error}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => reparseMutation.mutate()} disabled={reparseMutation.isPending} data-testid="button-card-reparse">
              {reparseMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
              Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={() => deleteMutation.mutate()} data-testid="button-card-discard">
              <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Discard
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!draft) return null;

  const displayName = [draft.honorific, draft.fullName].filter(Boolean).join(" ") || "(no name found)";
  const subtitle = [draft.jobTitle, draft.company].filter(Boolean).join(" · ");

  return (
    <Card>
      {/* The actions live at the TOP and stick there. A phone photo of a card
          is tall, and when the buttons sat only at the bottom of the form they
          were ~800px below the fold: the page looked like a dead end. */}
      <div className="sticky top-0 z-10 rounded-t-md border-b bg-card/95 backdrop-blur px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-semibold leading-tight truncate" data-testid="text-card-heading">{displayName}</div>
            {subtitle && <div className="text-xs text-muted-foreground truncate">{subtitle}</div>}
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !draft.fullName.trim()} data-testid="button-card-save">
              {saveMutation.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <UserCheck className="h-4 w-4 mr-1.5" />}
              Save contact
            </Button>
            <Button variant="outline" size="icon" title="Re-read with AI" onClick={() => reparseMutation.mutate()} disabled={reparseMutation.isPending} data-testid="button-card-reparse">
              {reparseMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
            <Button variant="outline" size="icon" title="Download vCard" asChild>
              <a href={`/api/cards/${card.id}/vcard`} download data-testid="link-card-vcard"><Download className="h-4 w-4" /></a>
            </Button>
            <Button variant="ghost" size="icon" title="Discard" onClick={() => deleteMutation.mutate()} data-testid="button-card-discard">
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
      <CardContent className="p-4 space-y-4">
        <p className="text-sm text-muted-foreground">
          Check the details below, correct anything wrong, then save.
          {card.model && <span className="ml-1 opacity-70">Read by {card.model.split("/").pop()}.</span>}
        </p>
        {card.duplicates && card.duplicates.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm" data-testid="card-duplicate-warning">
            <div className="font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4" /> Possible duplicate
            </div>
            <ul className="mt-1 text-muted-foreground">
              {card.duplicates.map((d) => (
                <li key={d.personId}>
                  {d.fullName} — {d.reason}
                </li>
              ))}
            </ul>
            {card.duplicates.some((d) => d.reason !== "same name") && (
              <p className="mt-1 text-xs text-muted-foreground">Saving will merge into the existing contact.</p>
            )}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="f-honorific">Honorific</Label>
            <Input id="f-honorific" value={draft.honorific ?? ""} onChange={(e) => set("honorific", e.target.value || null)} placeholder="Tan Sri, Dato', Dr" data-testid="input-card-honorific" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-name">Name</Label>
            <Input id="f-name" value={draft.fullName} onChange={(e) => set("fullName", e.target.value)} className={ring("fullName")} data-testid="input-card-name" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-title">Job title</Label>
            <Input id="f-title" value={draft.jobTitle ?? ""} onChange={(e) => set("jobTitle", e.target.value || null)} className={ring("jobTitle")} data-testid="input-card-title" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-company">Company</Label>
            <Input id="f-company" value={draft.company ?? ""} onChange={(e) => set("company", e.target.value || null)} className={ring("company")} data-testid="input-card-company" />
          </div>
          {draft.nativeName && (
            <div className="space-y-1.5">
              <Label htmlFor="f-native">Name in local script</Label>
              <Input id="f-native" value={draft.nativeName} onChange={(e) => set("nativeName", e.target.value || null)} data-testid="input-card-native-name" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="f-email">Email</Label>
            <Input id="f-email" value={draft.emails[0] ?? ""} onChange={(e) => set("emails", e.target.value ? [e.target.value] : [])} className={ring("emails")} data-testid="input-card-email" />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Phone numbers</Label>
          <div className="space-y-1.5">
            {draft.phones.length === 0 && <p className="text-sm text-muted-foreground">None found on the card.</p>}
            {draft.phones.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-sm" data-testid={`card-phone-${i}`}>
                <Badge variant="outline" className="w-16 justify-center shrink-0 capitalize">{p.slot}</Badge>
                <Input
                  value={p.e164 ?? p.raw}
                  onChange={(e) => {
                    const phones = [...draft.phones];
                    phones[i] = { ...p, e164: e.target.value || null, display: e.target.value || null };
                    set("phones", phones);
                  }}
                  className={p.e164 ? "" : "border-amber-500/60"}
                />
                {p.label && <span className="text-xs text-muted-foreground w-12 shrink-0">{p.label}</span>}
                {p.inheritedPrefix && (
                  <span className="text-xs text-amber-600 dark:text-amber-400 shrink-0" title={`Printed as "${p.raw}"; the area code was taken from the other number on this card`}>
                    area code added
                  </span>
                )}
                {!p.e164 && <span className="text-xs text-amber-600 dark:text-amber-400 shrink-0">unreadable</span>}
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="f-web">Website</Label>
            <Input id="f-web" value={draft.website ?? ""} onChange={(e) => set("website", e.target.value || null)} data-testid="input-card-website" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-li">LinkedIn</Label>
            <Input id="f-li" value={draft.linkedin ?? ""} onChange={(e) => set("linkedin", e.target.value || null)} data-testid="input-card-linkedin" />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="f-note">Where we met</Label>
          <Textarea id="f-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="SFF 2026, introduced by…" data-testid="input-card-note" />
        </div>

        {/* Save also sits at the end of the form, for a long card reviewed top-down. */}
        <div className="flex items-center gap-2 pt-1">
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !draft.fullName.trim()} data-testid="button-card-save-bottom">
            {saveMutation.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <UserCheck className="h-4 w-4 mr-1.5" />}
            Save contact
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ScanPage() {
  const { toast } = useToast();
  const search = useSearch();
  const [view, setView] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const [eventNote, setEventNote] = useState("");
  const [dragging, setDragging] = useState(false);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  // Deep link from the Telegram "Fix" button: /scan?card=<id>
  useEffect(() => {
    const id = new URLSearchParams(search).get("card");
    if (id) setSelectedId(id);
  }, [search]);

  const { data, isLoading } = useQuery<{ cards: BusinessCard[]; counts: Record<string, number> }>({
    queryKey: ["/api/cards", view === "all" ? "" : `?status=${view}`],
    queryFn: async () => {
      const res = await fetch(`/api/cards${view === "all" ? "" : `?status=${view}`}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load cards");
      return res.json();
    },
    refetchInterval: uploading > 0 ? 3000 : false,
  });

  const cards = data?.cards ?? [];
  const counts = data?.counts ?? {};
  const selected = useMemo(
    () => cards.find((c) => c.id === selectedId) ?? cards[0] ?? null,
    [cards, selectedId],
  );

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/cards"] });
  }, []);

  /** Upload one or many files; a single file is one card, several are a batch. */
  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files).filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
      if (list.length === 0) {
        toast({ title: "No images", description: "Pick a photo of a business card.", variant: "destructive" });
        return;
      }
      setUploading((n) => n + list.length);
      try {
        const images = await Promise.all(list.map((f) => fileToDataUrl(f)));
        if (images.length === 1) {
          const res = await apiRequest("POST", "/api/cards/scan", { images, eventNote: eventNote || null });
          const card = (await res.json()) as BusinessCard;
          setSelectedId(card.id);
        } else {
          const res = await apiRequest("POST", "/api/cards/scan-batch", {
            cards: images.map((i) => ({ images: [i] })),
            eventNote: eventNote || null,
          });
          const body = (await res.json()) as { cards: (BusinessCard | { error: string })[] };
          const first = body.cards.find((c): c is BusinessCard => "id" in c);
          if (first) setSelectedId(first.id);
          const failed = body.cards.filter((c) => "error" in c).length;
          if (failed) toast({ title: `${failed} of ${images.length} could not be read`, variant: "destructive" });
        }
        refresh();
      } catch (error) {
        toast({ title: "Scan failed", description: (error as Error).message, variant: "destructive" });
      } finally {
        setUploading(0);
      }
    },
    [eventNote, refresh, toast],
  );

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ScanLine className="h-6 w-6" /> Card Scanner
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Photograph a business card and it becomes a contact: numbers in international format, names and companies cased properly, duplicates caught before they split a record.
        </p>
      </div>

      {/* Capture */}
      <Card
        className={`border-dashed transition-colors ${dragging ? "border-primary bg-primary/5" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void handleFiles(e.dataTransfer.files); }}
        data-testid="card-dropzone"
      >
        <CardContent className="p-6 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => cameraRef.current?.click()} disabled={uploading > 0} data-testid="button-scan-camera">
              <Camera className="h-4 w-4 mr-1.5" /> Take photo
            </Button>
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading > 0} data-testid="button-scan-upload">
              <Upload className="h-4 w-4 mr-1.5" /> Upload cards
            </Button>
            {uploading > 0 && (
              <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-4 w-4 animate-spin" /> Reading {uploading} card{uploading === 1 ? "" : "s"}…
              </span>
            )}
            <span className="text-sm text-muted-foreground ml-auto hidden sm:inline">or drop a stack of photos here</span>
          </div>
          <div className="space-y-1.5 max-w-md">
            <Label htmlFor="batch-note">Where we met (applied to this upload)</Label>
            <Input id="batch-note" value={eventNote} onChange={(e) => setEventNote(e.target.value)} placeholder="SFF 2026" data-testid="input-scan-event" />
          </div>
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => e.target.files && handleFiles(e.target.files)} />
          <input ref={fileRef} type="file" accept="image/*,.heic,.heif" multiple className="hidden" onChange={(e) => e.target.files && handleFiles(e.target.files)} />
        </CardContent>
      </Card>

      <Tabs value={view} onValueChange={setView}>
        <TabsList>
          <TabsTrigger value="all" data-testid="tab-cards-all">Queue ({counts.pending ?? 0})</TabsTrigger>
          <TabsTrigger value="needs_review" data-testid="tab-cards-review">Needs review ({counts.needs_review ?? 0})</TabsTrigger>
          <TabsTrigger value="failed" data-testid="tab-cards-failed">Failed ({counts.failed ?? 0})</TabsTrigger>
          <TabsTrigger value="saved" data-testid="tab-cards-saved">Saved ({counts.saved ?? 0})</TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" /> Loading…
        </div>
      ) : cards.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground" data-testid="cards-empty">
          Nothing here yet. Take a photo of a card, or send one to the Telegram bot.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          {/* Queue */}
          <div className="space-y-2">
            {cards.map((c) => {
              const badge = STATUS_BADGE[c.status] ?? STATUS_BADGE.parsed;
              const Icon = badge.icon;
              const name = c.parsed?.fullName || (c.status === "failed" ? "Unreadable card" : "(no name)");
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={`w-full text-left rounded-md border p-3 transition-colors hover-elevate ${selected?.id === c.id ? "border-primary" : "border-border"}`}
                  data-testid={`card-queue-${c.id}`}
                >
                  <div className="flex items-start gap-3">
                    {c.frontImage && <img src={c.frontImage} alt="" className="w-16 h-10 object-cover rounded shrink-0 border" />}
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm truncate">{name}</div>
                      {c.parsed?.company && <div className="text-xs text-muted-foreground truncate">{c.parsed.company}</div>}
                      <div className="flex items-center gap-1.5 mt-1">
                        <Badge className={`text-[10px] px-1 py-0 gap-0.5 ${badge.className}`}>
                          <Icon className="h-2.5 w-2.5" /> {badge.label}
                        </Badge>
                        {c.source === "telegram" && <span className="text-[10px] text-muted-foreground">via Telegram</span>}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Review */}
          <div className="space-y-4">
            {selected && (
              <>
                {/* A thumbnail, not a poster. The photo is reference material —
                    at full width an uncropped phone shot pushed the whole form
                    and every button below the fold. Click to see it properly. */}
                {selected.frontImage && (
                  <button
                    type="button"
                    onClick={() => setZoomed(selected.frontImage)}
                    className="group relative rounded-md border overflow-hidden hover-elevate"
                    title="Click to enlarge"
                    data-testid="img-card-front"
                  >
                    <img src={selected.frontImage} alt="Scanned card" className="h-28 w-auto object-cover" />
                    <span className="absolute inset-0 hidden items-center justify-center bg-black/40 text-white text-xs group-hover:flex">
                      <Maximize2 className="h-4 w-4 mr-1" /> Enlarge
                    </span>
                  </button>
                )}
                <ReviewPanel
                  card={selected}
                  onSaved={() => { setSelectedId(null); refresh(); }}
                  onDiscarded={() => { setSelectedId(null); refresh(); }}
                />
              </>
            )}
          </div>
        </div>
      )}

      <Dialog open={!!zoomed} onOpenChange={(open) => !open && setZoomed(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Scanned card</DialogTitle>
          </DialogHeader>
          {zoomed && <img src={zoomed} alt="Scanned card, full size" className="w-full rounded-md" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
