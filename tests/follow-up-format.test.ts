/**
 * Follow-up formatting: the bell's "due today / in 3 days" wording and the
 * WhatsApp / mail links the contact card opens.
 */
import { eq } from "./harness";
import { mailtoUrl, relativeDay, whatsappUrl } from "../client/src/lib/follow-up-format";

const now = new Date(2026, 9, 10, 15, 0);
eq("relativeDay: earlier today is today", relativeDay(new Date(2026, 9, 10, 9, 0).toISOString(), now), "today");
eq("relativeDay: tomorrow morning", relativeDay(new Date(2026, 9, 11, 8, 0).toISOString(), now), "tomorrow");
eq("relativeDay: yesterday", relativeDay(new Date(2026, 9, 9, 23, 0).toISOString(), now), "yesterday");
eq("relativeDay: three days ahead", relativeDay(new Date(2026, 9, 13, 1, 0).toISOString(), now), "in 3 days");
eq("relativeDay: overdue", relativeDay(new Date(2026, 9, 7, 12, 0).toISOString(), now), "3 days ago");
eq("relativeDay: across a month end", relativeDay(new Date(2026, 10, 1, 12, 0).toISOString(), now), "in 22 days");

eq("whatsapp: digits only", whatsappUrl("+65 9123 4567"), "https://wa.me/6591234567");
eq("whatsapp: prefilled text is encoded", whatsappUrl("+6591234567", "Hi Wei, coffee?"), "https://wa.me/6591234567?text=Hi%20Wei%2C%20coffee%3F");

eq("mailto: bare address", mailtoUrl("a@b.com"), "mailto:a@b.com");
eq("mailto: spaces are %20, not +", mailtoUrl("a@b.com", "Good to meet", "Hi Wei"), "mailto:a@b.com?subject=Good%20to%20meet&body=Hi%20Wei");
eq("mailto: a literal plus survives", mailtoUrl("a@b.com", "1+1"), "mailto:a@b.com?subject=1%2B1");
