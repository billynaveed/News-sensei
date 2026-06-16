/**
 * Regression tests for priorityLevelFor — the score→level banding shared by the
 * news scanner, lifestyle pipeline, and the dashboard high-priority count.
 * Locks the boundaries (high >= 70, medium >= 40) so a refactor can't shift them.
 */
import { priorityLevelFor } from "../server/lead-scoring";
import { eq } from "./harness";

eq("100 -> high", priorityLevelFor(100), "high");
eq("70 (boundary) -> high", priorityLevelFor(70), "high");
eq("69 -> medium", priorityLevelFor(69), "medium");
eq("40 (boundary) -> medium", priorityLevelFor(40), "medium");
eq("39 -> low", priorityLevelFor(39), "low");
eq("0 -> low", priorityLevelFor(0), "low");
