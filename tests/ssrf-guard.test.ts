/**
 * Regression tests for isPublicHttpUrl — the SSRF guard on server-side article
 * fetches (article URLs can arrive via the unauthenticated browser-ingest
 * endpoint). Must reject loopback / private / link-local / cloud-metadata
 * targets and non-http schemes. Pure function, no I/O.
 */
import { isPublicHttpUrl } from "../server/url-safety";
import { check } from "./harness";

const allow = [
  "https://example.com/article",
  "http://example.com",
  "https://www.straitstimes.com/business/x",
  "http://8.8.8.8/x",            // public IP
  "http://172.32.0.1/x",         // just outside the 172.16/12 private range
];
const block = [
  "ftp://example.com/x",          // non-http scheme
  "file:///etc/passwd",
  "https://localhost/x",
  "http://127.0.0.1/x",           // loopback
  "http://169.254.169.254/latest/meta-data/",  // cloud metadata
  "http://10.0.0.5/x",            // private
  "http://192.168.1.1/x",         // private
  "http://172.16.0.1/x",          // private (172.16/12)
  "https://[::1]/x",              // ipv6 loopback
  "https://service.local/x",      // .local
  "https://api.internal/x",       // .internal
  "not-a-url",                    // unparseable
];

for (const u of allow) check(`allow ${u}`, isPublicHttpUrl(u) === true, "expected allowed");
for (const u of block) check(`block ${u}`, isPublicHttpUrl(u) === false, "expected blocked");
