/**
 * Tiny zero-dependency test harness (no framework — runs under tsx).
 * Test files import `check`/`eq` and register assertions on import; the runner
 * (tests/run.ts) imports every suite, then calls `summary()` and sets the exit
 * code. Counters are module-global, so all suites accumulate into one report.
 */
let passed = 0;
let failed = 0;
const failures: string[] = [];

export function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    const line = detail ? `${name} — ${detail}` : name;
    failures.push(line);
    console.log(`[FAIL] ${line}`);
  }
}

export function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function summary(label: string): number {
  console.log(`\n${label}: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  return failed;
}
