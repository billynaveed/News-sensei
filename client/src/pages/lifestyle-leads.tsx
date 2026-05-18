import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Sparkles } from "lucide-react";
import { format } from "date-fns";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default function LifestyleLeadsPage() {
  const { data, isLoading } = useQuery<any[]>({ queryKey: ["/api/lifestyle-leads"] });

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Lifestyle Leads</h1>
        <p className="text-muted-foreground">Luxury, society, and people-led signals with a purple lane.</p>
      </div>

      {isLoading && <div className="text-sm text-muted-foreground">Loading lifestyle leads...</div>}

      <div className="grid gap-4">
        {(data || []).map((lead) => (
          <Card key={lead.id} className="border-fuchsia-200/60 dark:border-fuchsia-900/60">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="bg-fuchsia-500/10 text-fuchsia-700 border-fuchsia-500/20 dark:text-fuchsia-300">
                  <Sparkles className="h-3 w-3 mr-1" /> Lifestyle
                </Badge>
                {lead.eventType && <Badge variant="outline">{lead.eventType}</Badge>}
                <Badge variant="outline" className="bg-purple-500/10 text-purple-700 border-purple-500/20 dark:text-purple-300">Score {lead.relevanceScore || 0}</Badge>
              </div>
              <div className="font-semibold text-lg">{lead.headline || lead.title}</div>
              <div className="text-xs text-muted-foreground">{lead.sourceName} {lead.publishedAt ? `· ${format(new Date(lead.publishedAt), "MMM d, yyyy")}` : ""}</div>
            </CardHeader>
            <CardContent className="space-y-3">
              {lead.summary && <p className="text-sm leading-relaxed">{lead.summary}</p>}
              {lead.bankerAngle && <div className="rounded-md bg-fuchsia-500/5 border border-fuchsia-500/20 p-3 text-sm">{lead.bankerAngle}</div>}
              <Button asChild variant="outline" size="sm">
                <a href={lead.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4 mr-1" /> Open article
                </a>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
