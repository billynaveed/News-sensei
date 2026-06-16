/**
 * Test runner. Imports every suite (each registers its assertions on import via
 * the shared harness), then prints one aggregate report and exits non-zero on
 * any failure. Add new suites by importing them here.
 *
 * Run with:  npm test
 */
import "./sea-guard.test";
import "./normalize-url.test";
import "./ssrf-guard.test";
import "./lead-scoring.test";
import { summary } from "./harness";

const failed = summary("All suites");
process.exit(failed > 0 ? 1 : 0);
