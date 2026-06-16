/**
 * SSRF guard: only allow http(s) fetches to public hosts. Article URLs can
 * originate from the unauthenticated browser-ingest endpoint, so a server-side
 * fetch must not be steerable to loopback / private / link-local / cloud-metadata
 * addresses. (Hostnames that resolve to private IPs via DNS rebinding are not
 * covered here — see remaining-work notes for pinned-resolution hardening.)
 *
 * Kept dependency-free so it is cheap to unit-test in isolation.
 */
export function isPublicHttpUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return false;
  }
  // IPv4 literals in private / loopback / link-local / unspecified ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;            // link-local + cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return false;   // 172.16.0.0/12
    if (a === 192 && b === 168) return false;            // 192.168.0.0/16
    if (a >= 224) return false;                          // multicast / reserved
  }
  // IPv6 loopback / unique-local / link-local.
  if (host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return false;
  }
  return true;
}
