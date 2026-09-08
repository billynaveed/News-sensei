/**
 * Pipeline prompt endpoints.
 *
 * Registered from inside `registerRoutes()` so they sit behind the same
 * `/api/*` session check as everything else. All state lives in
 * `server/prompts.ts`; this module is transport only — parse, validate, map
 * errors to status codes.
 */

import type { Express, Request, Response } from "express";
import {
  isPromptKey,
  listPromptStates,
  listPromptVersions,
  resetPrompt,
  revertPrompt,
  savePrompt,
  unknownPlaceholders,
  DEFAULT_PROMPTS,
  PROMPT_META,
  type PromptKey,
} from "./prompts";

/** Longest body we accept. Generous — Stage 6 is already ~12k characters. */
const MAX_BODY_LENGTH = 60_000;

/** Shortest body worth saving. Guards against an accidentally cleared textarea. */
const MIN_BODY_LENGTH = 20;

/** Recorded on every save. There is one operator; the UI is the only writer. */
const UPDATED_BY = "settings";

/**
 * Validates `:key` and answers 404 when it is not a known prompt.
 *
 * @returns The typed key, or null when a response has already been sent.
 */
function resolveKey(req: Request, res: Response): PromptKey | null {
  const { key } = req.params;
  if (!isPromptKey(key)) {
    res.status(404).json({ message: `Unknown prompt "${key}"` });
    return null;
  }
  return key;
}

/** Rejects bodies that are empty, oversized, or use variables the key cannot fill. */
function bodyProblem(key: PromptKey, body: unknown): string | null {
  if (typeof body !== "string") return "body must be a string";

  const trimmed = body.trim();
  if (trimmed.length < MIN_BODY_LENGTH) return `body must be at least ${MIN_BODY_LENGTH} characters`;
  if (body.length > MAX_BODY_LENGTH) return `body must be at most ${MAX_BODY_LENGTH} characters`;

  const unknown = unknownPlaceholders(key, body);
  if (unknown.length > 0) {
    const allowed = PROMPT_META[key].variables.map((v) => `{{${v.name}}}`).join(", ") || "(none)";
    return `Unknown variable${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `{{${n}}}`).join(", ")}. ` +
      `Allowed for ${key}: ${allowed}`;
  }

  return null;
}

export function registerPromptRoutes(app: Express): void {
  /** Every prompt with its live body, version, variables and default-ness. */
  app.get("/api/prompts", async (_req, res) => {
    try {
      res.json({ prompts: await listPromptStates() });
    } catch (error) {
      console.error("Error listing pipeline prompts:", error);
      res.status(500).json({ message: "Failed to load pipeline prompts" });
    }
  });

  /** Saved history for one prompt, newest first. */
  app.get("/api/prompts/:key/versions", async (req, res) => {
    const key = resolveKey(req, res);
    if (!key) return;

    try {
      res.json({ key, versions: await listPromptVersions(key) });
    } catch (error) {
      console.error(`Error loading versions for prompt ${key}:`, error);
      res.status(500).json({ message: "Failed to load prompt history" });
    }
  });

  /** Save a new body. Appends a history row and bumps the live version. */
  app.put("/api/prompts/:key", async (req, res) => {
    const key = resolveKey(req, res);
    if (!key) return;

    const { body, note } = req.body ?? {};
    const problem = bodyProblem(key, body);
    if (problem) return res.status(400).json({ message: problem });

    try {
      const version = await savePrompt(
        key,
        body as string,
        typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null,
        UPDATED_BY,
      );
      res.json({ key, version });
    } catch (error) {
      console.error(`Error saving prompt ${key}:`, error);
      res.status(500).json({ message: "Failed to save prompt" });
    }
  });

  /** Re-save an earlier version as the newest one, so the revert is itself undoable. */
  app.post("/api/prompts/:key/revert", async (req, res) => {
    const key = resolveKey(req, res);
    if (!key) return;

    const version = Number(req.body?.version);
    if (!Number.isInteger(version) || version < 1) {
      return res.status(400).json({ message: "version must be a positive integer" });
    }

    try {
      res.json({ key, version: await revertPrompt(key, version, UPDATED_BY) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to revert prompt";
      const missing = /^No version /.test(message);
      if (!missing) console.error(`Error reverting prompt ${key}:`, error);
      res.status(missing ? 404 : 500).json({ message });
    }
  });

  /** Drop the override so the code default takes over again. History is kept. */
  app.post("/api/prompts/:key/reset", async (req, res) => {
    const key = resolveKey(req, res);
    if (!key) return;

    try {
      await resetPrompt(key);
      res.json({ key, body: DEFAULT_PROMPTS[key], isDefault: true });
    } catch (error) {
      console.error(`Error resetting prompt ${key}:`, error);
      res.status(500).json({ message: "Failed to reset prompt" });
    }
  });
}
