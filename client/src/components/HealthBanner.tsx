import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertTriangle, XCircle } from "lucide-react";
import type { HealthResponse } from "@/components/HealthCard";

/**
 * Header pill that surfaces a degraded pipeline without anyone opening /debug.
 * Renders nothing while everything is green, so the header stays clean.
 */
export function HealthBanner() {
  const { data } = useQuery<HealthResponse>({
    queryKey: ["/api/health"],
    refetchInterval: 60_000,
  });

  if (!data || data.overall === "ok") return null;

  const errors = data.checks.filter((c) => c.status === "error").length;
  const warnings = data.checks.filter((c) => c.status === "warn").length;
  const isError = data.overall === "error";
  const count = isError ? errors : warnings;
  const label = `${count} ${isError ? "error" : "warning"}${count === 1 ? "" : "s"}`;

  const tone = isError
    ? "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20"
    : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20";

  return (
    <Link href="/debug">
      <span
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${tone}`}
        title={data.checks
          .filter((c) => c.status !== "ok")
          .map((c) => `${c.label}: ${c.message}`)
          .join("\n")}
        data-testid="health-banner"
      >
        {isError ? <XCircle className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
        {label}
      </span>
    </Link>
  );
}

export default HealthBanner;
