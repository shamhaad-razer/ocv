import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARTIFACTS,
  ProjectStorage,
  hostStorageDir,
  localStorageDir,
  projectIdFor,
  resolveStorageDir,
} from "../intel/storage.js";

describe("storage path resolution", () => {
  it("host storage is deterministic, keyed by project id, and outside the target", () => {
    const t = "/some/external/project";
    expect(hostStorageDir(t)).toBe(hostStorageDir(t)); // deterministic
    expect(hostStorageDir(t)).toContain(projectIdFor(t)); // keyed by id
    expect(hostStorageDir(t).startsWith(t)).toBe(false); // never inside target
    expect(hostStorageDir(t)).toContain(".openclaw-intel");
  });

  it("project id maps 1:1 to a storage dir", () => {
    expect(hostStorageDir("/a")).not.toBe(hostStorageDir("/b"));
  });

  it("resolveStorageDir: default=host, --local=inside target, --out wins", () => {
    const t = "/x/proj";
    expect(resolveStorageDir(t)).toBe(hostStorageDir(t));
    expect(resolveStorageDir(t, { local: true })).toBe(localStorageDir(t));
    expect(localStorageDir(t)).toBe(join(t, ".openclaw")); // only when opted in
    expect(resolveStorageDir(t, { explicitOut: "/custom" })).toBe("/custom");
  });
});

describe("ProjectStorage read/write round-trip", () => {
  let dir: string;
  let s: ProjectStorage;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "store-"));
    s = new ProjectStorage(dir, false);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes + reads the index by key (read back by project)", () => {
    const idx = { targetPath: "/x", scanVersion: "0.1.0", repos: [], generatedAt: 1, rootPath: "/x", knownUnknowns: [] };
    s.writeJson("index", idx);
    expect(s.has("index")).toBe(true);
    expect(s.readJson<typeof idx>("index")?.targetPath).toBe("/x");
    // canonical filename, not hardcoded by callers
    expect(existsSync(join(dir, ARTIFACTS.index))).toBe(true);
  });

  it("missing artifacts read back as null (no throw)", () => {
    expect(s.readJson("index")).toBeNull();
    expect(s.readText("map")).toBeNull();
    expect(s.has("verification")).toBe(false);
  });

  it("writeDoc writes under the docs/ subdir", () => {
    s.writeDoc("onboarding-overview.md", "# hi");
    expect(readFileSync(s.docPath("onboarding-overview.md"), "utf-8")).toBe("# hi");
  });

  it("appendReportHistory keeps an immutable, timestamped copy per run", () => {
    const r1 = s.appendReportHistory(1000, { v: 1 }, "# r1");
    const r2 = s.appendReportHistory(2000, { v: 2 }, "# r2");
    expect(r1.mdPath).not.toBe(r2.mdPath); // distinct files, not overwritten
    expect(readFileSync(r1.mdPath, "utf-8")).toBe("# r1");
    expect(readFileSync(r2.mdPath, "utf-8")).toBe("# r2");
    expect(r1.jsonPath).toContain("report-1000");
    expect(r2.jsonPath).toContain("report-2000");
  });
});

describe("ProjectStorage.for opt-in semantics", () => {
  it("defaults to host storage (target untouched)", () => {
    const t = "/ext/proj";
    const s = ProjectStorage.for(t);
    expect(s.isLocal).toBe(false);
    expect(s.dir).toBe(hostStorageDir(t));
  });
  it("--local opts into project-local storage explicitly", () => {
    const t = "/ext/proj";
    const s = ProjectStorage.for(t, { local: true });
    expect(s.isLocal).toBe(true);
    expect(s.dir).toBe(localStorageDir(t));
  });
  it("explicit --out overrides both and is not treated as local", () => {
    const s = ProjectStorage.for("/ext/proj", { local: true, explicitOut: "/custom/out" });
    expect(s.dir).toBe("/custom/out");
    expect(s.isLocal).toBe(false);
  });
});
