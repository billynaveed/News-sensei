/**
 * Console logger extracted from server/index.ts so non-server code
 * (pipeline-stages, ETL scripts) can use it without triggering the
 * express server bootup IIFE in index.ts.
 */
export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}
