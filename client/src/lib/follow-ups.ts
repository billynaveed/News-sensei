/**
 * Setting, pushing back and clearing follow-up reminders.
 *
 * Every place that shows a reminder (the notification bell, the scanner's
 * History, a person page) reads it from a different query, so one mutation
 * refreshes all of them rather than each caller remembering the list.
 */

import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";

export function refreshReminders(personId?: number): void {
  queryClient.invalidateQueries({ queryKey: ["/api/follow-ups"] });
  queryClient.invalidateQueries({ queryKey: ["/api/cards/history"] });
  if (personId) queryClient.invalidateQueries({ queryKey: [`/api/people/${personId}/profile`] });
}

/** `days` of null clears the reminder (dismiss / followed up). */
export function useSetReminder() {
  return useMutation({
    mutationFn: async ({ personId, days }: { personId: number; days: number | null }) => {
      const res = await apiRequest("POST", `/api/people/${personId}/follow-up`, { days });
      return (await res.json()) as { remindAt: string | null };
    },
    onSuccess: (_data, { personId }) => refreshReminders(personId),
  });
}

export { mailtoUrl, relativeDay, REMINDER_CHOICES, whatsappUrl } from "./follow-up-format";
