import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { Loader2, RefreshCw, ExternalLink, Building2 } from "lucide-react";

interface IpoFiling {
  id: string;
  exchange: string;
  stockCode: string;
  companyName: string;
  industry: string | null;
  prospectusUrl: string | null;
  listingDate: string | null;
  filingDate: string | null;
  alertSent: boolean;
  createdAt: string;
}

const exchangeLabels: Record<string, string> = {
  hkex_main: "HKEX Main",
  hkex_gem: "HKEX GEM",
  sgx: "SGX",
};

const exchangeColors: Record<string, string> = {
  hkex_main: "bg-red-500/10 text-red-600 dark:text-red-400",
  hkex_gem: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  sgx: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
};

export default function IpoFilingsPage() {
  const [exchangeFilter, setExchangeFilter] = useState<string>("all");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const queryKey = exchangeFilter === "all"
    ? ["/api/ipo-filings"]
    : ["/api/ipo-filings", { exchange: exchangeFilter }];

  const { data: filings, isLoading } = useQuery<IpoFiling[]>({
    queryKey,
    queryFn: async () => {
      const params = exchangeFilter !== "all" ? `?exchange=${exchangeFilter}` : "";
      const res = await fetch(`/api/ipo-filings${params}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const scanMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/ipo-scan", { method: "POST" });
      if (!res.ok) throw new Error("Scan failed");
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "IPO Scan Complete",
        description: `Found ${data.newFilings} new filings (${data.totalScanned} total scanned)`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/ipo-filings"] });
    },
    onError: () => {
      toast({ title: "Scan Failed", description: "Failed to run IPO scan", variant: "destructive" });
    },
  });

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Building2 className="h-6 w-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">IPO Filings</h1>
              <p className="text-sm text-muted-foreground">
                New listings from SGX, IDX and PSE exchanges
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Select value={exchangeFilter} onValueChange={setExchangeFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="All Exchanges" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Exchanges</SelectItem>
                {/* HKEX disabled for now */}
                <SelectItem value="sgx">SGX</SelectItem>
                <SelectItem value="idx">IDX</SelectItem>
                <SelectItem value="pse">PSE</SelectItem>
              </SelectContent>
            </Select>
            <Button
              onClick={() => scanMutation.mutate()}
              disabled={scanMutation.isPending}
              variant="outline"
            >
              {scanMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Scan Now
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Recent IPO Filings
              {filings && (
                <Badge variant="secondary" className="ml-2">
                  {filings.length}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : !filings?.length ? (
              <div className="text-center py-8 text-muted-foreground">
                No IPO filings found. Click "Scan Now" to fetch the latest.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Exchange</TableHead>
                    <TableHead>Stock Code</TableHead>
                    <TableHead>Company Name</TableHead>
                    <TableHead>Prospectus</TableHead>
                    <TableHead>Detected</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filings.map((filing) => (
                    <TableRow key={filing.id}>
                      <TableCell>
                        <Badge className={exchangeColors[filing.exchange] || ""} variant="secondary">
                          {exchangeLabels[filing.exchange] || filing.exchange}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono">{filing.stockCode}</TableCell>
                      <TableCell className="font-medium max-w-[300px] truncate">
                        {filing.companyName}
                      </TableCell>
                      <TableCell>
                        {filing.prospectusUrl ? (
                          <a
                            href={filing.prospectusUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-primary hover:underline text-sm"
                          >
                            View <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(filing.createdAt).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
}
