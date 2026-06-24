// Post-deploy smoke test: logs in and verifies the two failure modes that have
// bitten us — a white-screen crash (JS error / empty root, only visible when
// authenticated) and mobile horizontal overflow. Run after build+restart:
//   npm run build && systemctl restart news-sensei && sleep 3 && npm run smoke
//
// Env: SMOKE_URL (default http://127.0.0.1:$PORT), SMOKE_PASSWORD (default
// "openup"), CHROME_PATH (default /usr/bin/google-chrome). Exits 1 on failure.
import { chromium } from "playwright-core";

const BASE = process.env.SMOKE_URL || `http://127.0.0.1:${process.env.PORT || 5000}`;
const PASSWORD = process.env.SMOKE_PASSWORD || "openup";
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";

const failures = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ ${m}`); failures.push(m); };

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu"] });
} catch (e) {
  console.warn(`[smoke] no usable browser (${e.message}) — skipping smoke test`);
  process.exit(0);
}

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 25000 });
  await page.waitForTimeout(1200);
  const pw = await page.$('input[type=password]');
  if (pw) {
    await pw.fill(PASSWORD);
    const btn = await page.$('button[type=submit]');
    if (btn) await btn.click();
    await page.waitForTimeout(5000);
  }
}

// Desktop: authenticated dashboard renders with no JS errors.
{
  console.log("desktop (1280px):");
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await login(page);
  const cards = await page.$$eval('[data-testid^="lead-card-"]', (e) => e.length).catch(() => 0);
  const rootLen = await page.evaluate(() => document.getElementById("root")?.innerText?.length || 0);
  errs.length ? fail(`JS error(s): ${errs.slice(0, 3).join(" | ")}`) : ok("no JS errors");
  rootLen < 50 ? fail("#root is empty (white screen)") : ok(`app rendered (${cards} cards)`);
  await page.close();
}

// Mobile: no card wider than the viewport (no horizontal clipping).
{
  console.log("mobile (390px):");
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await login(page);
  const r = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid^="lead-card-"]')];
    const vw = window.innerWidth;
    return { over: cards.filter((c) => c.getBoundingClientRect().width > vw + 2).length, total: cards.length, vw };
  });
  errs.length ? fail(`JS error(s): ${errs.slice(0, 3).join(" | ")}`) : ok("no JS errors");
  r.over > 0 ? fail(`${r.over}/${r.total} cards overflow the ${r.vw}px viewport`) : ok(`${r.total} cards fit ${r.vw}px`);
  await page.close();
}

await browser.close();

if (failures.length) {
  console.error(`\n[smoke] FAILED — ${failures.length} issue(s)`);
  process.exit(1);
}
console.log("\n[smoke] all checks passed ✅");
process.exit(0);
