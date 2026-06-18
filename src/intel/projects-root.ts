// Target-project path policy (prompt 50). Pure + host-only, node builtins only.
//
// VoiceKit only watches/registers/scans/selects target projects that live inside
// the user's ~/Projects directory. This module is the SINGLE SOURCE OF TRUTH for
// that rule; the CLI (registration/selection/scan/context) and — mirrored — the
// service-openclaw API/UI enforce it.
//
// Design:
//   - resolve the allowed root from $HOME (override with OPENCLAW_PROJECTS_ROOT for
//     tests / unusual layouts),
//   - normalize + realpath both the root and the candidate so `..` tricks and
//     symlinks can't escape,
//   - "inside" means strictly under the root (the root itself is NOT a target,
//     and a sibling like `~/Projects-evil` must not match a prefix check).
//
// READ-ONLY: this only inspects paths; it never writes to or modifies any target.

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

/** The allowed projects root: ~/Projects (override via OPENCLAW_PROJECTS_ROOT). */
export function projectsRoot(): string {
  const override = process.env.OPENCLAW_PROJECTS_ROOT;
  const base = override && override.trim() ? override.trim() : join_home("Projects");
  return canonical(base);
}

function join_home(...parts: string[]): string {
  return resolve(homedir(), ...parts);
}

/** Expand a leading `~` / `~/...` to the user's home dir. Other paths unchanged. */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

/**
 * Canonicalize a path: absolute + normalized, and realpath'd when it exists (so
 * symlinks resolve to their true location). Non-existent paths are still
 * normalized so `..` segments are collapsed before the containment check.
 */
export function canonical(p: string): string {
  const abs = resolve(expandTilde(p));
  try {
    if (existsSync(abs)) return realpathSync(abs);
  } catch {
    /* fall through to the normalized absolute path */
  }
  return abs;
}

/**
 * Is `candidate` strictly INSIDE the allowed projects root? The root itself is
 * not a valid target (you select a project under it, not the whole folder), and
 * prefix-collisions (`~/Projects-evil`) are excluded by comparing on a trailing
 * separator boundary.
 */
export function isInsideProjectsRoot(candidate: string, root = projectsRoot()): boolean {
  const c = canonical(candidate);
  const r = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  if (c === r) return false; // the root itself is not a target
  return c.startsWith(r + sep);
}

/** The standard, user-facing rejection message. One place so it never drifts. */
export function projectsRootError(candidate: string, root = projectsRoot()): string {
  return (
    `VoiceKit only scans projects inside ${displayRoot(root)}. ` +
    `\`${candidate}\` is outside it — move or clone your project into ${displayRoot(root)}, then try again.`
  );
}

/** Pretty root for messages: show "~/Projects" when it's the literal home one. */
export function displayRoot(root = projectsRoot()): string {
  const home = canonical(homedir());
  if (root === resolve(home, "Projects")) return "~/Projects";
  return root;
}

/**
 * Assert a candidate path is inside the allowed root. Returns null when allowed,
 * or a human-readable error string when rejected (caller decides how to surface
 * it — CLI prints to stderr + exits; API returns 400).
 */
export function assertInsideProjectsRoot(candidate: string, root = projectsRoot()): string | null {
  return isInsideProjectsRoot(candidate, root) ? null : projectsRootError(candidate, root);
}
