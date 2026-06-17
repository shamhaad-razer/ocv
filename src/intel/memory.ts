// Persistent User Memory & Explanation Preferences (10-...md, prompt 36).
//
// Two HOST-side stores that let OpenClaw REMEMBER how the user wants help, so the
// user never has to re-explain who they are:
//   1. UserPreferences — GLOBAL, follows the user across every target project
//      (junior-engineer lens by default). Source of truth = the user (10-...md §1
//      category 2: never auto-invalidated by code).
//   2. ProjectMemory — PER TARGET PROJECT (keyed by project id), holding the
//      durable, reusable facts about working on that project (nickname, past
//      questions, useful explanations, confusion points, inspected files,
//      preferred flows/docs). Source of truth = the interaction (category 4).
//
// BOTH live under ~/.openclaw-intel/ (host storage), NEVER inside a target
// project (HOST_VS_TARGET_PROJECT_MODEL.md). Global prefs sit at the intel root;
// per-project memory sits inside that project's existing host storage dir, so it
// is naturally scoped + deleted with the project. Privacy: prefs/memory hold only
// what the user stated or asked about — never secrets, never .env VALUES, never a
// chat transcript (10-...md §4 PM3/PM6). Everything is plain JSON the user can
// read, edit, or delete (PM5 — no hidden state).
//
// Only node builtins → host-independent + testable. Time is injected by callers.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostIntelRoot, hostStorageDir } from "./storage.js";

// ---------------------------------------------------------------------------
// Global user preferences (follow the user everywhere)
// ---------------------------------------------------------------------------

export type ExperienceLevel = "new-to-repo" | "junior" | "mid" | "senior";

/**
 * How the user wants explanations + project help presented. GLOBAL scope: one
 * profile per user/machine, applied to every target unless a project overrides a
 * field (10-...md §2 precedence: project > global). Defaults encode the stated
 * preference: explain like I'm a JUNIOR engineer, clear + step-by-step.
 */
export interface UserPreferences {
  version: 1;
  /** Preferred explanation level. Default: junior engineer. */
  explanationLevel: ExperienceLevel;
  /** Preferred style of presentation. */
  style: "clear-step-by-step" | "flow-oriented" | "concise" | "reference";
  /** Preferred amount of detail. */
  detail: "brief" | "balanced" | "thorough";
  /** Include analogies / worked examples when helpful. */
  includeAnalogies: boolean;
  /** Include diagrams (e.g. Mermaid flow maps) when the data is available. */
  includeDiagrams: boolean;
  /** Preferred command shell/environment, if the user told us (else null = detect). */
  preferredShell: string | null;
  /**
   * Risk tolerance for change-confidence wording. "cautious" → emphasize unknowns
   * + checks; "balanced" → default; "pragmatic" → lead with what's verified.
   * NEVER changes the honesty rule (we still never say "safe to push").
   */
  riskTolerance: "cautious" | "balanced" | "pragmatic";
  /** epoch ms of the last update (transparency — when did this get set?). */
  updatedAt: number;
}

/** The stated-preference defaults: junior engineer, clear + step-by-step. */
export function defaultPreferences(now: number): UserPreferences {
  return {
    version: 1,
    explanationLevel: "junior",
    style: "clear-step-by-step",
    detail: "balanced",
    includeAnalogies: true,
    includeDiagrams: true,
    preferredShell: null,
    riskTolerance: "balanced",
    updatedAt: now,
  };
}

/** Global preferences file, at the HOST intel root (never inside a target). */
export function preferencesPath(): string {
  return join(hostIntelRoot(), "preferences.json");
}

/**
 * Load global preferences, merged over defaults so a partial/old file still
 * yields a complete, valid profile (forward-compatible). Read-only; missing file
 * → defaults (so a brand-new user already gets the junior lens).
 */
export function loadPreferences(now: number, path = preferencesPath()): UserPreferences {
  const base = defaultPreferences(now);
  if (!existsSync(path)) return base;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<UserPreferences>;
    return { ...base, ...parsed, version: 1 };
  } catch {
    return base; // corrupt file → safe defaults, never throw
  }
}

/** Persist global preferences to host storage (creating the dir). */
export function savePreferences(prefs: UserPreferences, path = preferencesPath()): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(prefs, null, 2), "utf-8");
}

/** The fields a user may set (everything except bookkeeping). */
export type PreferenceUpdate = Partial<Omit<UserPreferences, "version" | "updatedAt">>;

/** Apply a validated partial update, stamping updatedAt. Pure transform. */
export function applyPreferenceUpdate(prefs: UserPreferences, update: PreferenceUpdate, now: number): UserPreferences {
  return { ...prefs, ...update, version: 1, updatedAt: now };
}

// ---------------------------------------------------------------------------
// Per-project memory (keyed by target project id)
// ---------------------------------------------------------------------------

/** A durable, reusable fact remembered about working on ONE target project. */
export interface ProjectMemory {
  version: 1;
  /** The target project id (path hash) this memory belongs to. */
  projectId: string;
  /** The target path — recorded so the file is self-describing (no code, just path). */
  targetPath: string;
  /** User's nickname for the project (e.g. "the payments service"). */
  nickname: string | null;
  /** Questions the user previously asked (curated, capped — not a transcript). */
  previousQuestions: string[];
  /** Explanations the user found useful and may want reused (short notes). */
  usefulExplanations: { note: string; about?: string; at: number }[];
  /** Points the user was confused about (so we can pre-empt them). */
  confusionPoints: string[];
  /** Files the user inspected / cares about (repo-relative paths). */
  inspectedFiles: string[];
  /** Flows/docs the user prefers for this project (e.g. "flow-map", "onboarding-api"). */
  preferredFlows: string[];
  /** epoch ms of the last update. */
  updatedAt: number;
}

/** A fresh, empty project memory. */
export function emptyProjectMemory(projectId: string, targetPath: string, now: number): ProjectMemory {
  return {
    version: 1,
    projectId,
    targetPath,
    nickname: null,
    previousQuestions: [],
    usefulExplanations: [],
    confusionPoints: [],
    inspectedFiles: [],
    preferredFlows: [],
    updatedAt: now,
  };
}

/**
 * Per-project memory lives INSIDE that project's HOST storage dir (so it's keyed
 * by project id and removed with the project) — never inside the target itself.
 */
export function projectMemoryPath(targetPath: string): string {
  return join(hostStorageDir(targetPath), "user-memory.json");
}

/** Load a target's project memory, or an empty one. Read-only. */
export function loadProjectMemory(targetPath: string, projectId: string, now: number, path = projectMemoryPath(targetPath)): ProjectMemory {
  const base = emptyProjectMemory(projectId, targetPath, now);
  if (!existsSync(path)) return base;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ProjectMemory>;
    return { ...base, ...parsed, version: 1, projectId, targetPath };
  } catch {
    return base;
  }
}

/** Persist a target's project memory to its host storage dir. */
export function saveProjectMemory(mem: ProjectMemory, path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(mem, null, 2), "utf-8");
}

/** Caps so memory stays high-signal, not a log (10-...md §7 anti-bloat). */
const CAP_QUESTIONS = 20;
const CAP_EXPLANATIONS = 20;
const CAP_CONFUSION = 20;
const CAP_FILES = 50;
const CAP_FLOWS = 20;

/** De-dupe + cap a string list, keeping the most recent at the end. */
function pushCapped(list: string[], value: string, cap: number): string[] {
  const v = value.trim();
  if (!v) return list;
  const without = list.filter((x) => x !== v);
  without.push(v);
  return without.slice(-cap);
}

export interface ProjectMemoryUpdate {
  nickname?: string | null;
  addQuestion?: string;
  addExplanation?: { note: string; about?: string; at: number };
  addConfusion?: string;
  addInspectedFile?: string;
  addPreferredFlow?: string;
}

/** Apply a project-memory update (curated, capped, de-duped). Pure transform. */
export function applyProjectMemoryUpdate(mem: ProjectMemory, update: ProjectMemoryUpdate, now: number): ProjectMemory {
  const next: ProjectMemory = { ...mem };
  if (update.nickname !== undefined) next.nickname = update.nickname;
  if (update.addQuestion) next.previousQuestions = pushCapped(mem.previousQuestions, update.addQuestion, CAP_QUESTIONS);
  if (update.addConfusion) next.confusionPoints = pushCapped(mem.confusionPoints, update.addConfusion, CAP_CONFUSION);
  if (update.addInspectedFile) next.inspectedFiles = pushCapped(mem.inspectedFiles, update.addInspectedFile, CAP_FILES);
  if (update.addPreferredFlow) next.preferredFlows = pushCapped(mem.preferredFlows, update.addPreferredFlow, CAP_FLOWS);
  if (update.addExplanation) {
    const note = update.addExplanation.note.trim();
    if (note) {
      const without = mem.usefulExplanations.filter((e) => e.note !== note);
      without.push({ ...update.addExplanation, note });
      next.usefulExplanations = without.slice(-CAP_EXPLANATIONS);
    }
  }
  next.updatedAt = now;
  return next;
}

// ---------------------------------------------------------------------------
// Guidance: the single seam that turns memory into LLM/presentation guidance
// ---------------------------------------------------------------------------

/**
 * Bounded, transparent guidance assembled from memory and injected into every
 * feature (10-...md §6). It is the ONE place that turns preferences + project
 * memory into presentation instructions, so personalization needs no per-feature
 * fork — explain/report/onboarding all read the same `lines`.
 */
export interface Guidance {
  /** Human-readable guidance lines (the personalization lens + project context). */
  lines: string[];
  /** The effective explanation level after applying prefs (project may override). */
  level: ExperienceLevel;
  /** Whether diagrams should be included when available. */
  includeDiagrams: boolean;
  /** Risk-tolerance wording knob for change-confidence (never overrides honesty). */
  riskTolerance: UserPreferences["riskTolerance"];
}

/**
 * Turn preferences (+ optional project memory) into bounded guidance. Pure: no
 * I/O, so it's trivially testable and the caller controls what memory it passes.
 */
export function buildGuidance(prefs: UserPreferences, mem?: ProjectMemory | null): Guidance {
  const lines: string[] = [];

  // --- Preference lens (category 2) — the headline personalization ---
  const levelLabel: Record<ExperienceLevel, string> = {
    "new-to-repo": "someone NEW to this repo (assume general engineering skill, but no repo context)",
    junior: "a JUNIOR engineer (expand jargon, explain the why, don't assume deep context)",
    mid: "a MID-level engineer (skip basics, focus on this system's specifics)",
    senior: "a SENIOR engineer (be concise and precise; assume strong fundamentals)",
  };
  lines.push(`Explain for ${levelLabel[prefs.explanationLevel]}.`);

  const styleLabel: Record<UserPreferences["style"], string> = {
    "clear-step-by-step": "Be clear and step-by-step.",
    "flow-oriented": "Lead with how things flow end-to-end.",
    concise: "Be concise; lead with the answer.",
    reference: "Present as a structured reference.",
  };
  lines.push(styleLabel[prefs.style]);

  const detailLabel: Record<UserPreferences["detail"], string> = {
    brief: "Keep it brief.",
    balanced: "Use a balanced amount of detail.",
    thorough: "Be thorough.",
  };
  lines.push(detailLabel[prefs.detail]);

  if (prefs.includeAnalogies) lines.push("Use analogies/examples when they aid understanding.");
  if (prefs.includeDiagrams) lines.push("Include diagrams (e.g. flow maps) when available.");
  if (prefs.preferredShell) lines.push(`Prefer \`${prefs.preferredShell}\` for shell commands.`);

  // --- Project memory (category 4) — so the user needn't re-explain context ---
  if (mem) {
    if (mem.nickname) lines.push(`The user calls this project "${mem.nickname}".`);
    if (mem.confusionPoints.length) {
      lines.push(`The user has previously been confused about: ${mem.confusionPoints.slice(-3).join("; ")} — pre-empt these.`);
    }
    if (mem.inspectedFiles.length) {
      lines.push(`The user has inspected: ${mem.inspectedFiles.slice(-5).join(", ")} — they likely have context on these.`);
    }
    if (mem.preferredFlows.length) {
      lines.push(`Preferred flows/docs for this project: ${mem.preferredFlows.slice(-5).join(", ")}.`);
    }
    if (mem.previousQuestions.length) {
      lines.push(`Recent questions (don't re-explain from scratch): ${mem.previousQuestions.slice(-3).join("; ")}.`);
    }
  }

  // Recalled memory is background context, not user instructions, and reflects
  // what was true when written — features must still verify against current code.
  lines.push("(This guidance is remembered preference/context, not a fresh instruction; verify any named file/flow against current code.)");

  return {
    lines,
    level: prefs.explanationLevel,
    includeDiagrams: prefs.includeDiagrams,
    riskTolerance: prefs.riskTolerance,
  };
}
