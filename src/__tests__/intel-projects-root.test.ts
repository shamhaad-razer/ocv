import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isInsideProjectsRoot, assertInsideProjectsRoot, projectsRoot, expandTilde, displayRoot } from "../intel/projects-root.js";

// Use a real temp dir as the allowed root via OPENCLAW_PROJECTS_ROOT so the tests
// don't depend on the runner's actual ~/Projects.
let ROOT: string;
let OUTSIDE: string;

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "vk-projects-"));
  OUTSIDE = mkdtempSync(join(tmpdir(), "vk-outside-"));
  process.env.OPENCLAW_PROJECTS_ROOT = ROOT;
});
afterEach(() => {
  delete process.env.OPENCLAW_PROJECTS_ROOT;
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

describe("isInsideProjectsRoot — allowed", () => {
  it("accepts a direct child (~/Projects/my-app)", () => {
    const p = join(ROOT, "my-app"); mkdirSync(p);
    expect(isInsideProjectsRoot(p)).toBe(true);
  });
  it("accepts a nested folder (~/Projects/company/project-a)", () => {
    const p = join(ROOT, "company", "project-a"); mkdirSync(p, { recursive: true });
    expect(isInsideProjectsRoot(p)).toBe(true);
  });
  it("accepts a multi-repo workspace under the root", () => {
    const p = join(ROOT, "workspace-with-many-repos"); mkdirSync(p);
    expect(isInsideProjectsRoot(p)).toBe(true);
  });
  it("accepts a non-existent (but inside) path (normalized, not yet created)", () => {
    expect(isInsideProjectsRoot(join(ROOT, "not-created-yet"))).toBe(true);
  });
});

describe("isInsideProjectsRoot — rejected", () => {
  it("rejects an arbitrary outside dir (~/Desktop/my-app analogue)", () => {
    const p = join(OUTSIDE, "my-app"); mkdirSync(p);
    expect(isInsideProjectsRoot(p)).toBe(false);
  });
  it("rejects /", () => {
    expect(isInsideProjectsRoot("/")).toBe(false);
  });
  it("rejects the home dir (~)", () => {
    expect(isInsideProjectsRoot(homedir())).toBe(false);
  });
  it("rejects the projects root ITSELF (you select a project under it)", () => {
    expect(isInsideProjectsRoot(ROOT)).toBe(false);
  });
  it("rejects a sibling prefix-collision (Projects-evil)", () => {
    const evil = `${ROOT}-evil`; mkdirSync(evil);
    try { expect(isInsideProjectsRoot(join(evil, "app"))).toBe(false); }
    finally { rmSync(evil, { recursive: true, force: true }); }
  });
  it("rejects a .. escape that lands outside the root", () => {
    // ROOT/../<basename-of-OUTSIDE>/x resolves outside ROOT
    const escape = join(ROOT, "..", "vk-escape-target");
    expect(isInsideProjectsRoot(escape)).toBe(false);
  });
  it("rejects a .. escape even when it dresses up as inside", () => {
    const tricky = join(ROOT, "ok", "..", "..", "elsewhere");
    expect(isInsideProjectsRoot(tricky)).toBe(false);
  });
});

describe("symlink resolution", () => {
  it("rejects a symlink (inside root) that points OUTSIDE the root", () => {
    const link = join(ROOT, "sneaky");
    symlinkSync(OUTSIDE, link); // realpath escapes the root
    expect(isInsideProjectsRoot(link)).toBe(false);
  });
});

describe("assertInsideProjectsRoot — message", () => {
  it("returns null when allowed", () => {
    const p = join(ROOT, "ok"); mkdirSync(p);
    expect(assertInsideProjectsRoot(p)).toBeNull();
  });
  it("returns a clear, move/clone-oriented message when rejected", () => {
    const msg = assertInsideProjectsRoot(OUTSIDE);
    expect(msg).toBeTruthy();
    expect(msg!).toMatch(/only scans projects inside/i);
    expect(msg!).toMatch(/move or clone/i);
  });
});

describe("expandTilde + projectsRoot + displayRoot", () => {
  it("expands ~ and ~/x to the home dir", () => {
    expect(expandTilde("~")).toBe(homedir());
    expect(expandTilde("~/Projects/app")).toBe(resolve(homedir(), "Projects/app"));
    expect(expandTilde("/abs/path")).toBe("/abs/path");
  });
  it("projectsRoot honors OPENCLAW_PROJECTS_ROOT", () => {
    expect(projectsRoot()).toBe(ROOT);
  });
  it("displayRoot shows the real root when overridden (not ~/Projects)", () => {
    expect(displayRoot()).toBe(ROOT);
  });
  it("displayRoot shows ~/Projects for the default home-based root", () => {
    delete process.env.OPENCLAW_PROJECTS_ROOT;
    expect(displayRoot()).toBe("~/Projects");
  });
});
