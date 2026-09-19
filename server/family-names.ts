/** Pure name helpers for family seeding (no I/O, unit-tested). */

const HONORIFICS = /^(tan sri|puan sri|datuk seri|dato'? sri|datuk|dato'?|tun|toh puan|khun|dr\.?|mr\.?|mrs\.?)\s+/i;

/** "Tan Sri Lim Kok Thay family" → "Lim Kok Thay family". */
export function stripHonorifics(name: string): string {
  return name.replace(HONORIFICS, "").trim();
}
