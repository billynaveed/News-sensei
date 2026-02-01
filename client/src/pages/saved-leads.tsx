import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import {
  ExternalLink,
  Building2,
  User,
  Briefcase,
  Calendar,
  Linkedin,
  FileText,
  Trash2,
  ChevronDown,
  ChevronUp,
  Clock,
  Edit2,
  Save,
  X as XIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Lead, PriorityLevel, SourceTier, SavedLead } from "@shared/schema";

const priorityColors: Record<PriorityLevel, string> = {
  high: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
  medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  low: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
};

const tierColors: Record<SourceTier, string> = {
  tier1: "bg-primary/10 text-primary border-primary/20",
  tier2: "bg-secondary text-secondary-foreground border-secondary-border",
  tier3: "bg-muted text-muted-foreground border-muted-border",
};

const tierLabels: Record<SourceTier, string> = {
  tier1: "Tier 1",
  tier2: "Tier 2",
  tier3: "Tier 3",
};

type SavedLeadWithLead = SavedLead & { lead: Lead };

function SavedLeadCard({ savedLead, onDelete, onUpdate }: {
  savedLead: SavedLeadWithLead;
  onDelete: (id: string) => void;
  onUpdate: (id: string, updates: Partial<SavedLead>) => void;
}) {
  const { lead } = savedLead;
  const [founderExpanded, setFounderExpanded] = useState(false);
  const [companyExpanded, setCompanyExpanded] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  const [editingFounder, setEditingFounder] = useState(false);
  const [editingCompany, setEditingCompany] = useState(false);
  const [notes, setNotes] = useState(savedLead.notes || "");
  const [linkedInUrl, setLinkedInUrl] = useState(savedLead.founderLinkedInUrl || "");
  const [founderBio, setFounderBio] = useState(savedLead.founderBio || "");
  const [companyDescription, setCompanyDescription] = useState(savedLead.companyDescription || "");

  const priorityClass = priorityColors[lead.priorityLevel];
  const tierClass = tierColors[lead.sourceTier];

  const handleSaveNotes = () => {
    onUpdate(savedLead.id, { notes });
    setEditingNotes(false);
  };

  const handleSaveFounder = () => {
    onUpdate(savedLead.id, { founderLinkedInUrl: linkedInUrl, founderBio });
    setEditingFounder(false);
  };

  const handleSaveCompany = () => {
    onUpdate(savedLead.id, { companyDescription });
    setEditingCompany(false);
  };

  return (
    <Card className="group">
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={tierClass} size="sm">
              {tierLabels[lead.sourceTier]}
            </Badge>
            <Badge variant="outline" className={priorityClass} size="sm">
              {lead.priorityLevel.charAt(0).toUpperCase() + lead.priorityLevel.slice(1)} Priority
            </Badge>
            <Badge variant="outline" className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20" size="sm">
              Saved {format(new Date(savedLead.savedAt), "MMM d")}
            </Badge>
          </div>
          <a
            href={lead.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block font-semibold text-base leading-snug hover:text-primary transition-colors line-clamp-2"
          >
            {lead.headline}
            <ExternalLink className="inline-block ml-1.5 h-3.5 w-3.5 opacity-50" />
          </a>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <div className="flex items-center justify-center w-10 h-10 rounded-md bg-muted font-mono text-sm font-bold">
            {lead.priorityScore}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {/* Basic Info */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {lead.companyNames.length > 0 && (
            <div className="flex items-start gap-2">
              <Building2 className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-0.5">Companies</div>
                <div className="text-sm font-medium">{lead.companyNames.join(", ")}</div>
              </div>
            </div>
          )}
          {lead.founderNames.length > 0 && (
            <div className="flex items-start gap-2">
              <User className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-0.5">Key People</div>
                <div className="text-sm font-medium">{lead.founderNames.join(", ")}</div>
              </div>
            </div>
          )}
          {lead.investors && lead.investors.length > 0 && (
            <div className="flex items-start gap-2">
              <Briefcase className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-0.5">Investors</div>
                <div className="text-sm">{lead.investors.join(", ")}</div>
              </div>
            </div>
          )}
          <div className="flex items-start gap-2">
            <Calendar className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-0.5">Published</div>
              <div className="text-sm">{format(new Date(lead.publishedAt), "MMM d, yyyy 'at' h:mm a")}</div>
            </div>
          </div>
        </div>

        {/* Expandable Founder Details */}
        <Collapsible open={founderExpanded} onOpenChange={setFounderExpanded}>
          <div className="border border-border rounded-lg overflow-hidden">
            <CollapsibleTrigger className="w-full flex items-center justify-between p-3 bg-muted/30 hover:bg-muted/50 transition-colors">
              <div className="flex items-center gap-2">
                <Linkedin className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                <span className="text-sm font-medium">Founder Details</span>
              </div>
              {founderExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="p-3 space-y-3">
                {editingFounder ? (
                  <div className="space-y-2">
                    <div>
                      <label className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1 block">LinkedIn URL</label>
                      <Input
                        value={linkedInUrl}
                        onChange={(e) => setLinkedInUrl(e.target.value)}
                        placeholder="https://linkedin.com/in/..."
                        className="text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1 block">Biography</label>
                      <Textarea
                        value={founderBio}
                        onChange={(e) => setFounderBio(e.target.value)}
                        placeholder="Add founder background, experience, education..."
                        className="text-sm min-h-24"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleSaveFounder}>
                        <Save className="h-3 w-3 mr-1" />
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingFounder(false)}>
                        <XIcon className="h-3 w-3 mr-1" />
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    {linkedInUrl && (
                      <div>
                        <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1">LinkedIn Profile</div>
                        <a
                          href={linkedInUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                        >
                          View Profile <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    )}
                    {founderBio && (
                      <div>
                        <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1">Biography</div>
                        <p className="text-sm leading-relaxed">{founderBio}</p>
                      </div>
                    )}
                    {!linkedInUrl && !founderBio && (
                      <p className="text-sm text-muted-foreground italic">No founder details added yet.</p>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setEditingFounder(true)}>
                      <Edit2 className="h-3 w-3 mr-1" />
                      {linkedInUrl || founderBio ? "Edit" : "Add Details"}
                    </Button>
                  </>
                )}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        {/* Expandable Company Details */}
        <Collapsible open={companyExpanded} onOpenChange={setCompanyExpanded}>
          <div className="border border-border rounded-lg overflow-hidden">
            <CollapsibleTrigger className="w-full flex items-center justify-between p-3 bg-muted/30 hover:bg-muted/50 transition-colors">
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4" />
                <span className="text-sm font-medium">Company Details</span>
              </div>
              {companyExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="p-3 space-y-3">
                {editingCompany ? (
                  <div className="space-y-2">
                    <div>
                      <label className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1 block">Description</label>
                      <Textarea
                        value={companyDescription}
                        onChange={(e) => setCompanyDescription(e.target.value)}
                        placeholder="Add company description, business model, key products..."
                        className="text-sm min-h-24"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleSaveCompany}>
                        <Save className="h-3 w-3 mr-1" />
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingCompany(false)}>
                        <XIcon className="h-3 w-3 mr-1" />
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    {companyDescription ? (
                      <div>
                        <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1">Description</div>
                        <p className="text-sm leading-relaxed">{companyDescription}</p>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">No company details added yet.</p>
                    )}
                    {lead.investors && lead.investors.length > 0 && (
                      <div>
                        <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1">Known Investors</div>
                        <p className="text-sm">{lead.investors.join(", ")}</p>
                      </div>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setEditingCompany(true)}>
                      <Edit2 className="h-3 w-3 mr-1" />
                      {companyDescription ? "Edit" : "Add Details"}
                    </Button>
                  </>
                )}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        {/* AI Summary (Always visible) */}
        <div className="bg-muted/50 rounded-md p-3">
          <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1.5">AI Summary</div>
          <p className="text-sm leading-relaxed">{lead.aiSummary}</p>
        </div>

        {/* Expandable Notes */}
        <Collapsible open={notesExpanded} onOpenChange={setNotesExpanded}>
          <div className="border border-border rounded-lg overflow-hidden">
            <CollapsibleTrigger className="w-full flex items-center justify-between p-3 bg-muted/30 hover:bg-muted/50 transition-colors">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4" />
                <span className="text-sm font-medium">My Notes</span>
              </div>
              {notesExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="p-3">
                {editingNotes ? (
                  <div className="space-y-2">
                    <Textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Add your private notes here..."
                      className="text-sm min-h-24"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleSaveNotes}>
                        <Save className="h-3 w-3 mr-1" />
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => {
                        setNotes(savedLead.notes || "");
                        setEditingNotes(false);
                      }}>
                        <XIcon className="h-3 w-3 mr-1" />
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    {notes ? (
                      <p className="text-sm leading-relaxed mb-2">{notes}</p>
                    ) : (
                      <p className="text-sm text-muted-foreground italic mb-2">No notes added yet.</p>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setEditingNotes(true)}>
                      <Edit2 className="h-3 w-3 mr-1" />
                      {notes ? "Edit Notes" : "Add Notes"}
                    </Button>
                  </>
                )}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        {/* Keywords and Metadata */}
        <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-border">
          <span className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Keywords:</span>
          {lead.matchedKeywords.map((keyword) => (
            <Badge key={keyword} variant="secondary" size="sm">
              {keyword}
            </Badge>
          ))}
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{lead.sourceName}</span>
          <span>{lead.region}</span>
        </div>
      </CardContent>
      <CardFooter className="flex items-center justify-between gap-2 pt-0">
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          <Clock className="h-3 w-3" />
          Saved {format(new Date(savedLead.savedAt), "MMM d, yyyy 'at' h:mm a")}
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600 dark:text-red-400"
            >
              <Trash2 className="h-4 w-4" />
              Remove
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove from saved leads?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove this lead from your saved collection. You can always save it again later from the dashboard.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => onDelete(savedLead.id)}>Remove</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardFooter>
    </Card>
  );
}

function SavedLeadCardSkeleton() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-20" />
          </div>
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </div>
        <Skeleton className="h-10 w-10 rounded-md" />
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
        <Skeleton className="h-20 w-full" />
      </CardContent>
    </Card>
  );
}

export default function SavedLeadsPage() {
  const { data: savedLeads, isLoading } = useQuery<SavedLeadWithLead[]>({
    queryKey: ["/api/saved-leads"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/saved-leads/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/saved-leads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<SavedLead> }) => {
      await apiRequest("PATCH", `/api/saved-leads/${id}`, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/saved-leads"] });
    },
  });

  const handleDelete = (id: string) => {
    deleteMutation.mutate(id);
  };

  const handleUpdate = (id: string, updates: Partial<SavedLead>) => {
    updateMutation.mutate({ id, updates });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Saved Leads</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Your curated collection of high-value opportunities with detailed research
        </p>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <div className="grid gap-4">
            {[...Array(3)].map((_, i) => (
              <SavedLeadCardSkeleton key={i} />
            ))}
          </div>
        ) : !savedLeads || savedLeads.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <Clock className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No saved leads yet</h3>
            <p className="text-muted-foreground max-w-md">
              Save leads from the dashboard to keep track of high-priority opportunities and add detailed research notes.
            </p>
          </div>
        ) : (
          <div className="grid gap-4">
            <AnimatePresence mode="popLayout">
              {savedLeads.map((savedLead) => (
                <motion.div
                  key={savedLead.id}
                  layout
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -100, transition: { duration: 0.2 } }}
                  transition={{ duration: 0.2 }}
                >
                  <SavedLeadCard
                    savedLead={savedLead}
                    onDelete={handleDelete}
                    onUpdate={handleUpdate}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}
