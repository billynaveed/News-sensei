import type { PriorityLevel } from "@shared/schema";

/**
 * Maps a 0-100 priority/relevance score to a priority level.
 * Thresholds: high >= 70, medium >= 40, otherwise low.
 *
 * Single source of truth for the banding used by both the news scanner and the
 * lifestyle pipeline (and the dashboard's high-priority count).
 */
export function priorityLevelFor(score: number): PriorityLevel {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}
