import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";
import { findReferences, likelyCallersFrom } from "../intel/references.js";
import { listRepoFiles, explainSelection } from "../intel/explain.js";
import { SCAN_VERSION } from "../intel/grounding.js";
import type { WorkspaceIntel } from "../intel/types.js";

const NOW = 1_700_000_000_000;
const wsOf = (root: string, intel: ReturnType<typeof scanRepo>): WorkspaceIntel => ({
  rootPath: root, targetPath: root, scanVersion: SCAN_VERSION, generatedAt: NOW, repos: [intel], knownUnknowns: [],
});

describe("symbol extraction (stored, grounded)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sym-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(
      join(dir, "src", "checkout.ts"),
      [
        "export function checkout(cart) {",
        "  return charge(cart);",
        "}",
        "export class Cart {}",
        "const HANDLER = () => {};",
        "export const MAX_ITEMS = 100;",
      ].join("\n"),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("extracts functions/classes/exported consts with file:line + exported flag", () => {
    const intel = scanRepo(dir, { generatedAt: NOW });
    const byName = (n: string) => intel.symbols.find((s) => s.value.name === n)?.value;
    expect(byName("checkout")?.kind).toBe("function");
    expect(byName("checkout")?.exported).toBe(true);
    expect(byName("checkout")?.locator).toBe("src/checkout.ts:1");
    expect(byName("Cart")?.kind).toBe("class");
    expect(byName("HANDLER")?.kind).toBe("function"); // arrow const
    expect(byName("MAX_ITEMS")?.kind).toBe("const");
    // symbols are grounded "parsed" with the file hash (→ freshness works)
    const sym = intel.symbols.find((s) => s.value.name === "checkout")!;
    expect(sym.grounding.confidenceBasis.analysisQuality).toBe("parsed");
    expect(sym.grounding.fileHashes.length).toBeGreaterThan(0);
  });

  it("extracts Python def/class with method detection", () => {
    const py = mkdtempSync(join(tmpdir(), "sym-py-"));
    try {
      writeFileSync(join(py, "pyproject.toml"), "[project]\nname='x'\n");
      writeFileSync(join(py, "app.py"), ["def handler():", "    pass", "class Service:", "    def run(self):", "        pass"].join("\n"));
      const intel = scanRepo(py, { generatedAt: NOW });
      const names = intel.symbols.map((s) => s.value.name);
      expect(names).toEqual(expect.arrayContaining(["handler", "Service", "run"]));
      const run = intel.symbols.find((s) => s.value.name === "run")!;
      expect(run.value.kind).toBe("method"); // indented def
      expect(intel.symbols.find((s) => s.value.name === "handler")!.value.exported).toBe(true); // top-level
    } finally {
      rmSync(py, { recursive: true, force: true });
    }
  });
});

describe("reference search (confidence classified)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ref-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "src", "pay.ts"), "export function charge(c) { return c; }\n");
    writeFileSync(join(dir, "src", "main.ts"), ["import { charge } from './pay';", "const r = charge(cart);", "// charge happens here", ""].join("\n"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("classifies definition=high, call=medium, import=medium, mention=low", () => {
    const files = listRepoFiles(dir);
    const res = findReferences(dir, files, "charge", "src/pay.ts:1");
    const byKind = (k: string) => res.references.filter((r) => r.kind === k);
    expect(byKind("definition")[0]?.confidence).toBe("high");
    expect(byKind("call").length).toBeGreaterThanOrEqual(1);
    expect(byKind("call")[0]?.confidence).toBe("medium");
    expect(byKind("import").length).toBeGreaterThanOrEqual(1);
    // the comment line "// charge happens here" is a low-confidence mention
    expect(byKind("mention").some((r) => /happens here/.test(r.snippet))).toBe(true);
    expect(byKind("mention")[0]?.confidence).toBe("low");
  });

  it("likelyCallersFrom keeps call/import, excludes the def file", () => {
    const res = findReferences(dir, listRepoFiles(dir), "charge", "src/pay.ts:1");
    const callers = likelyCallersFrom(res, "src/pay.ts");
    expect(callers.every((r) => r.kind === "call" || r.kind === "import")).toBe(true);
    expect(callers.every((r) => !r.locator.startsWith("src/pay.ts:"))).toBe(true);
  });
});

describe("explain integration", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("explain surfaces symbolsInRange + classified references, still honest about call graph", () => {
    dir = mkdtempSync(join(tmpdir(), "exp-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "src", "a.ts"), "export function foo() { return 1; }\n");
    writeFileSync(join(dir, "src", "b.ts"), "import { foo } from './a';\nconst x = foo();\n");
    const intel = scanRepo(dir, { generatedAt: NOW });
    const ws = wsOf(dir, intel);
    const pkg = explainSelection(
      { repo: intel.name, path: "src/a.ts", startLine: 1, endLine: 1 },
      ws,
      { generatedAt: NOW, repoFiles: listRepoFiles(dir) },
    );
    expect(pkg.symbolsInRange.some((s) => s.name === "foo")).toBe(true);
    // references include the call/import in b.ts, each with a confidence
    expect(pkg.references.some((r) => r.locator.startsWith("src/b.ts") && (r.kind === "call" || r.kind === "import"))).toBe(true);
    expect(pkg.references.every((r) => ["high", "medium", "low"].includes(r.confidence))).toBe(true);
    // still NEVER claims a proven call graph
    expect(pkg.explanation).toMatch(/Direct callers are \*\*not yet known\*\*/);
    expect(pkg.confidence).not.toBe("high");
  });
});
