import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPreferenceUpdate,
  applyProjectMemoryUpdate,
  buildGuidance,
  defaultPreferences,
  emptyProjectMemory,
  loadPreferences,
  loadProjectMemory,
  savePreferences,
  saveProjectMemory,
} from "../intel/memory.js";

const NOW = 1_700_000_000_000;

describe("UserPreferences defaults + persistence", () => {
  let dir: string;
  let prefsFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-prefs-"));
    prefsFile = join(dir, "preferences.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("defaults to the junior-engineer lens, clear + step-by-step", () => {
    const p = defaultPreferences(NOW);
    expect(p.explanationLevel).toBe("junior");
    expect(p.style).toBe("clear-step-by-step");
    expect(p.includeDiagrams).toBe(true);
  });

  it("a missing file yields defaults (a new user already gets junior)", () => {
    const p = loadPreferences(NOW, prefsFile);
    expect(existsSync(prefsFile)).toBe(false);
    expect(p.explanationLevel).toBe("junior");
  });

  it("set once, persists across loads (across sessions)", () => {
    const updated = applyPreferenceUpdate(loadPreferences(NOW, prefsFile), { explanationLevel: "junior", style: "flow-oriented" }, NOW);
    savePreferences(updated, prefsFile);
    const reloaded = loadPreferences(NOW + 999, prefsFile);
    expect(reloaded.explanationLevel).toBe("junior");
    expect(reloaded.style).toBe("flow-oriented");
  });

  it("merges a partial/old file over defaults (forward-compatible)", () => {
    rmSync(prefsFile, { force: true });
    // write a partial file by hand
    savePreferences({ ...defaultPreferences(NOW), riskTolerance: "cautious" }, prefsFile);
    const p = loadPreferences(NOW, prefsFile);
    expect(p.riskTolerance).toBe("cautious");
    expect(p.explanationLevel).toBe("junior"); // still defaulted
  });

  it("corrupt file falls back to defaults (never throws)", () => {
    writeFileSync(prefsFile, "{not json", "utf-8");
    expect(loadPreferences(NOW, prefsFile).explanationLevel).toBe("junior");
  });
});

describe("ProjectMemory is per-project + curated", () => {
  let storeDir: string;
  let memFile: string;
  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "mem-proj-"));
    memFile = join(storeDir, "user-memory.json");
  });
  afterEach(() => rmSync(storeDir, { recursive: true, force: true }));

  it("starts empty and round-trips through disk", () => {
    const mem = applyProjectMemoryUpdate(emptyProjectMemory("pid", "/ext/proj", NOW), { nickname: "the API", addConfusion: "auth flow" }, NOW);
    saveProjectMemory(mem, memFile);
    const reloaded = loadProjectMemory("/ext/proj", "pid", NOW + 1, memFile);
    expect(reloaded.nickname).toBe("the API");
    expect(reloaded.confusionPoints).toContain("auth flow");
    expect(reloaded.projectId).toBe("pid");
  });

  it("de-dupes and caps lists (curated, not a log)", () => {
    let mem = emptyProjectMemory("pid", "/p", NOW);
    mem = applyProjectMemoryUpdate(mem, { addInspectedFile: "src/a.ts" }, NOW);
    mem = applyProjectMemoryUpdate(mem, { addInspectedFile: "src/a.ts" }, NOW); // dup
    expect(mem.inspectedFiles).toEqual(["src/a.ts"]);
    for (let i = 0; i < 100; i++) mem = applyProjectMemoryUpdate(mem, { addInspectedFile: `src/f${i}.ts` }, NOW);
    expect(mem.inspectedFiles.length).toBeLessThanOrEqual(50); // capped
    expect(mem.inspectedFiles.at(-1)).toBe("src/f99.ts"); // keeps most recent
  });
});

describe("buildGuidance turns memory into a presentation lens", () => {
  it("encodes the junior lens explicitly", () => {
    const g = buildGuidance(defaultPreferences(NOW));
    expect(g.level).toBe("junior");
    expect(g.lines.join(" ")).toMatch(/JUNIOR engineer/);
    expect(g.lines.join(" ")).toMatch(/step-by-step/i);
    expect(g.includeDiagrams).toBe(true);
  });

  it("a senior lens swaps one line, same machinery", () => {
    const g = buildGuidance(applyPreferenceUpdate(defaultPreferences(NOW), { explanationLevel: "senior" }, NOW));
    expect(g.level).toBe("senior");
    expect(g.lines.join(" ")).toMatch(/SENIOR engineer/);
  });

  it("weaves in project memory (nickname, confusion, inspected files) so the user needn't re-explain", () => {
    const mem = applyProjectMemoryUpdate(
      applyProjectMemoryUpdate(emptyProjectMemory("pid", "/p", NOW), { nickname: "payments", addConfusion: "the retry logic" }, NOW),
      { addInspectedFile: "src/pay.ts" },
      NOW,
    );
    const g = buildGuidance(defaultPreferences(NOW), mem);
    const text = g.lines.join(" ");
    expect(text).toMatch(/payments/);
    expect(text).toMatch(/retry logic/);
    expect(text).toMatch(/src\/pay\.ts/);
  });

  it("always notes the guidance is remembered context, not a fresh instruction", () => {
    const g = buildGuidance(defaultPreferences(NOW));
    expect(g.lines.join(" ")).toMatch(/remembered preference\/context/i);
  });

  it("carries risk tolerance for change-confidence wording", () => {
    const g = buildGuidance(applyPreferenceUpdate(defaultPreferences(NOW), { riskTolerance: "cautious" }, NOW));
    expect(g.riskTolerance).toBe("cautious");
  });
});
