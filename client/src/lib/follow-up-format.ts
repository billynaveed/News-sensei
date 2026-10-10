/** Pure formatting for follow-up reminders and contact links (unit-tested). */

/** "today", "tomorrow", "in 3 days", "2 days ago" — the bell is read at a glance. */
export function relativeDay(iso: string, now = new Date()): string {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(new Date(iso)) - startOf(now)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/** wa.me wants the number as bare digits, no "+" or spaces. */
export function whatsappUrl(e164: string, text?: string): string {
  const digits = e164.replace(/\D/g, "");
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

export function mailtoUrl(email: string, subject?: string, body?: string): string {
  const params = new URLSearchParams();
  if (subject) params.set("subject", subject);
  if (body) params.set("body", body);
  // URLSearchParams encodes spaces as "+", which mail clients show literally.
  const query = params.toString().replace(/\+/g, "%20");
  return `mailto:${email}${query ? `?${query}` : ""}`;
}

export const REMINDER_CHOICES: { days: number; label: string }[] = [
  { days: 1, label: "tomorrow" },
  { days: 3, label: "3 days" },
  { days: 7, label: "a week" },
];
