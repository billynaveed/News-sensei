import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Activity, FileText, CheckCircle, AlertTriangle, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ScanLog } from "@shared/schema";

function LogsTableSkeleton() {
  return (
    <div className="space-y-2">
      {[...Array(5)].map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

export default function LogsPage() {
  const { data: logs, isLoading } = useQuery<ScanLog[]>({
    queryKey: ["/api/scan-logs"],
  });

  const totalScanned = logs?.reduce((sum, log) => sum + log.articlesScanned, 0) ?? 0;
  const totalMatches = logs?.reduce((sum, log) => sum + log.matchesFound, 0) ?? 0;
  const totalNewLeads = logs?.reduce((sum, log) => sum + log.newLeads, 0) ?? 0;

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto overflow-auto h-full">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Scan Logs</h1>
        <p className="text-muted-foreground">
          View the history of news article scans and their results.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1">Total Scanned</div>
                <div className="text-2xl font-bold font-mono tabular-nums">{totalScanned}</div>
              </div>
              <div className="flex items-center justify-center w-10 h-10 rounded-md bg-primary/10 text-primary">
                <FileText className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1">Total Matches</div>
                <div className="text-2xl font-bold font-mono tabular-nums">{totalMatches}</div>
              </div>
              <div className="flex items-center justify-center w-10 h-10 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-1">New Leads</div>
                <div className="text-2xl font-bold font-mono tabular-nums">{totalNewLeads}</div>
              </div>
              <div className="flex items-center justify-center w-10 h-10 rounded-md bg-green-500/10 text-green-600 dark:text-green-400">
                <CheckCircle className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Scan History</CardTitle>
          </div>
          <CardDescription>
            Recent scanning activity showing articles processed and leads generated.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LogsTableSkeleton />
          ) : logs && logs.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scan Time</TableHead>
                  <TableHead className="text-right">Articles Scanned</TableHead>
                  <TableHead className="text-right">Matches Found</TableHead>
                  <TableHead className="text-right">New Leads</TableHead>
                  <TableHead className="text-right">Duplicates</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id} data-testid={`log-row-${log.id}`}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        {format(new Date(log.scannedAt), "MMM d, yyyy 'at' h:mm a")}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {log.articlesScanned}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {log.matchesFound}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant={log.newLeads > 0 ? "default" : "secondary"} size="sm">
                        {log.newLeads}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                      {log.duplicatesSkipped}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge 
                        variant="outline" 
                        className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20"
                        size="sm"
                      >
                        Complete
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="flex flex-col items-center justify-center h-48 text-center">
              <Activity className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No scan history</h3>
              <p className="text-muted-foreground max-w-md">
                Start scanning for news articles to see your scan history here.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
