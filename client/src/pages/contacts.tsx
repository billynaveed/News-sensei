import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Bookmark,
  BookmarkCheck,
  Trash2,
  RotateCcw,
  Clock,
  ChevronDown,
  Building2,
  MapPin,
  DollarSign,
  ExternalLink,
  Plus,
  Link2,
  Users,
  Loader2,
} from "lucide-react";

type Contact = {
  id: number;
  fullName: string;
  region: string | null;
  city: string | null;
  nationality: string | null;
  bio: string | null;
  netWorthEstimate: string | null;
  mentionCount: number | null;
  sources: string[] | null;
  email: string | null;
  status: "active" | "saved" | "deleted" | "muted";
  remindAt: string | null;
  notes: string | null;
  companies: string[] | null;
  articleCount: number;
};

type ContactArticle = {
  url: string;
  headline: string | null;
  title: string | null;
  summary: string | null;
  eventType: string | null;
  publishedAt: string | null;
};

const STATUS_TABS = [
  { value: "active", label: "All" },
  { value: "saved", label: "Contacts" },
  { value: "due", label: "Reminders" },
  { value: "muted", label: "Muted" },
  { value: "deleted", label: "Deleted" },
];

const REMIND_OPTIONS = [
  { days: 1, label: "Tomorrow" },
  { days: 7, label: "In 1 week" },
  { days: 14, label: "In 2 weeks" },
  { days: 30, label: "In 1 month" },
  { days: 90, label: "In 3 months" },
];

function ContactArticles({ personId }: { personId: number }) {
  const { data, isLoading } = useQuery<ContactArticle[]>({
    queryKey: [`/api/contacts/${personId}/articles`],
  });
  if (isLoading) return <div className="px-4 pb-3 text-sm text-muted-foreground">Loading articles…</div>;
  if (!data || data.length === 0) return <div className="px-4 pb-3 text-sm text-muted-foreground">No linked articles.</div>;
  return (
    <div className="space-y-2 px-4 pb-3">
      {data.map((a) => (
        <a
          key={a.url}
          href={a.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-start gap-2 rounded-md border border-border p-2 text-sm hover:bg-muted/50"
        >
          <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate font-medium">{a.headline || a.title || a.url}</div>
            {a.summary && <div className="line-clamp-2 text-xs text-muted-foreground">{a.summary}</div>}
          </div>
        </a>
      ))}
    </div>
  );
}

function ContactCard({
  contact,
  onPatch,
}: {
  contact: Contact;
  onPatch: (id: number, body: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(contact.email ?? "");
  const location = [contact.city, contact.region, contact.nationality].filter(Boolean)[0] || null;
  const isSaved = contact.status === "saved";
  const isDeleted = contact.status === "deleted";
  const isMuted = contact.status === "muted";
  const showLifecycle = !isDeleted && !isMuted;

  return (
    <Card data-testid={`contact-${contact.id}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-base font-semibold">{contact.fullName}</h3>
              {isSaved && <Badge variant="secondary" size="sm">Saved</Badge>}
              {isMuted && <Badge variant="outline" size="sm" className="text-zinc-500">Muted</Badge>}
              {contact.remindAt && (
                <Badge variant="outline" size="sm" className="text-amber-600 dark:text-amber-400">
                  <Clock className="mr-1 h-3 w-3" />
                  {new Date(contact.remindAt).toLocaleDateString()}
                </Badge>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {contact.companies && contact.companies.length > 0 && (
                <span className="flex items-center gap-1"><Building2 className="h-3.5 w-3.5" />{contact.companies.join(", ")}</span>
              )}
              {location && <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{location}</span>}
              {contact.netWorthEstimate && (
                <span className="flex items-center gap-1"><DollarSign className="h-3.5 w-3.5" />{contact.netWorthEstimate}</span>
              )}
            </div>
          </div>
        </div>

        {/* email */}
        <div className="mt-3 flex items-center gap-2">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => { if (email !== (contact.email ?? "")) onPatch(contact.id, { email }); }}
            placeholder="email (to be scraped)…"
            className="h-8 max-w-xs text-sm"
            data-testid={`contact-email-${contact.id}`}
          />
        </div>

        {/* actions */}
        <div className="mt-3 flex flex-wrap items-center gap-1">
          {showLifecycle && (
            <Button
              variant="ghost"
              size="sm"
              className="text-emerald-600 dark:text-emerald-400"
              onClick={() => onPatch(contact.id, { status: isSaved ? "active" : "saved" })}
              data-testid={`contact-save-${contact.id}`}
            >
              {isSaved ? <BookmarkCheck className="h-4 w-4 fill-current" /> : <Bookmark className="h-4 w-4" />}
              {isSaved ? "Saved" : "Save"}
            </Button>
          )}
          {showLifecycle && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="text-amber-600 dark:text-amber-400" data-testid={`contact-remind-${contact.id}`}>
                  <Clock className="h-4 w-4" />
                  Remind me
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Remind me in…</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {REMIND_OPTIONS.map((o) => (
                  <DropdownMenuItem key={o.days} onClick={() => onPatch(contact.id, { remindInDays: o.days })}>
                    {o.label}
                  </DropdownMenuItem>
                ))}
                {contact.remindAt && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => onPatch(contact.id, { remindAt: null })}>Clear reminder</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {isMuted && (
            <Button variant="ghost" size="sm" onClick={() => onPatch(contact.id, { status: "active" })} data-testid={`contact-unmute-${contact.id}`}>
              <RotateCcw className="h-4 w-4" />
              Unmute
            </Button>
          )}
          {isDeleted ? (
            <Button variant="ghost" size="sm" onClick={() => onPatch(contact.id, { status: "active" })} data-testid={`contact-restore-${contact.id}`}>
              <RotateCcw className="h-4 w-4" />
              Restore
            </Button>
          ) : (
            <Button variant="ghost" size="sm" className="text-red-600 dark:text-red-400" onClick={() => onPatch(contact.id, { status: "deleted" })} data-testid={`contact-delete-${contact.id}`}>
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          )}

          {/* articles */}
          <Collapsible open={open} onOpenChange={setOpen} className="ml-auto">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" data-testid={`contact-articles-${contact.id}`}>
                {contact.articleCount} article{contact.articleCount === 1 ? "" : "s"}
                <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
              </Button>
            </CollapsibleTrigger>
          </Collapsible>
        </div>
      </CardContent>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleContent>{open && <ContactArticles personId={contact.id} />}</CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

export default function ContactsPage() {
  const [status, setStatus] = useState("active");
  const [search, setSearch] = useState("");
  const [addName, setAddName] = useState("");
  const [addUrl, setAddUrl] = useState("");

  const { data: contacts, isLoading } = useQuery<Contact[]>({
    queryKey: [`/api/contacts?status=${status}&search=${encodeURIComponent(search)}`],
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [`/api/contacts?status=${status}&search=${encodeURIComponent(search)}`] });
    queryClient.invalidateQueries({ queryKey: ["/api/contacts/due-count"] });
  };

  const patchMutation = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: Record<string, unknown> }) => {
      await apiRequest("PATCH", `/api/contacts/${id}`, body);
    },
    onSuccess: invalidate,
  });

  const addNameMutation = useMutation({
    mutationFn: async (name: string) => { await apiRequest("POST", "/api/contacts", { name }); },
    onSuccess: () => { setAddName(""); invalidate(); },
  });

  const addLinkMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest("POST", "/api/contacts/from-link", { url });
      return res.json();
    },
    onSuccess: () => { setAddUrl(""); invalidate(); },
  });

  const onPatch = (id: number, body: Record<string, unknown>) => patchMutation.mutate({ id, body });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
        <div className="flex items-center gap-2">
          <Users className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Founders</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          One card per person. <strong>All</strong> = every founder seen; <strong>Contacts</strong> = the ones you saved;
          <strong> Muted</strong> = hidden from your leads (unmute to bring them back). Articles are linked under each.
        </p>

        {/* add row */}
        <div className="grid gap-2 sm:grid-cols-2">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); if (addName.trim().length >= 2) addNameMutation.mutate(addName.trim()); }}
          >
            <Input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="Add a contact by name…" className="h-9" data-testid="add-contact-name" />
            <Button type="submit" size="sm" disabled={addNameMutation.isPending || addName.trim().length < 2}>
              {addNameMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            </Button>
          </form>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); if (/^https?:\/\//i.test(addUrl)) addLinkMutation.mutate(addUrl.trim()); }}
          >
            <Input value={addUrl} onChange={(e) => setAddUrl(e.target.value)} placeholder="…or paste an article link" className="h-9" data-testid="add-contact-link" />
            <Button type="submit" size="sm" disabled={addLinkMutation.isPending || !/^https?:\/\//i.test(addUrl)}>
              {addLinkMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
            </Button>
          </form>
        </div>
        {addLinkMutation.isPending && <div className="text-xs text-muted-foreground">Reading the link and extracting names…</div>}

        {/* tabs + search */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-1">
            {STATUS_TABS.map((t) => (
              <Button key={t.value} variant={status === t.value ? "default" : "ghost"} size="sm" onClick={() => setStatus(t.value)} data-testid={`tab-${t.value}`}>
                {t.label}
              </Button>
            ))}
          </div>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search names…" className="h-9 max-w-[200px]" data-testid="contacts-search" />
        </div>

        {/* list */}
        {isLoading ? (
          <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-28 w-full" />)}</div>
        ) : !contacts || contacts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No contacts in “{STATUS_TABS.find((t) => t.value === status)?.label}”.
          </div>
        ) : (
          <div className="space-y-3">
            {contacts.map((c) => <ContactCard key={c.id} contact={c} onPatch={onPatch} />)}
          </div>
        )}
      </div>
    </div>
  );
}
