import cron, { type ScheduledTask } from "node-cron";
import { runExamples } from "./pipeline-examples";
import { ingestArticleUrl } from "./scanner";
import { log } from "./log";

let task: ScheduledTask | null = null;

/** Re-judge every reference example (dry run) so prompt drift shows up by morning. */
export async function runExamplesNow() {
  return runExamples(async (url) => {
    const { outcome } = await ingestArticleUrl(url, { dryRun: true });
    return { status: outcome.status, reason: outcome.reason };
  });
}

export function startExamplesCron() {
  stopExamplesCron();
  if (process.env.EXAMPLES_CRON_ENABLED === "false") return;
  task = cron.schedule("30 3 * * *", async () => {
    try {
      const r = await runExamplesNow();
      log(`[Examples] nightly run: ${r.passing}/${r.ran} passing`, "pipeline");
    } catch (error) {
      log(`[Examples] nightly run failed: ${(error as Error).message}`, "pipeline");
    }
  }, { timezone: "Asia/Singapore" });
  console.log("Reference-examples cron started (daily 03:30 SGT)");
}

export function stopExamplesCron() {
  if (task) { task.stop(); task = null; }
}
