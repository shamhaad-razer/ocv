// Repo Mirroring Assistant (12-repo-mirroring-assistant.md, prompt 41). READ-ONLY.
//
// Helps make a TARGET repo mirror a SOURCE repo's structure / config / commands /
// deployment — WITHOUT the user re-explaining the intent, and WITHOUT modifying
// either repo. It is propose-only: it compares the two repos' scanned intelligence
// (role-based, not blind file diff), classifies each difference's INTENT (safe to
// align vs intentional vs risky), and emits a dry-run plan + validation hand-off.
//
// Two hard principles (12-...md §0):
//   1. PLAN BEFORE WRITE — this module never writes; it produces a plan. Apply is
//      a separate, explicit, gated step (not implemented here — propose-only MVP).
//   2. COMPARE VIA THE MODEL — alignment is by ROLE over the intelligence entities
//      (a test command maps to a test command even if `npm test` vs `pytest`), so
//      "mirror the deploy strategy" is a structured diff, not a literal copy.
//
// Safety rails (12-...md §3):
//   - ECOSYSTEM: never propose copying something stack-specific into a different
//     stack (the classic unsafe copy) — flagged out-of-scope.
//   - IDENTITY: per-service identity (name, ports, secret VALUES, deploy targets)
//     is never copied (S6) — out-of-scope.
//   - BIAS: EXTRA-in-target → KEEP (additions are risky); MISSING convention →
//     propose (low-risk gap-fill); DIVERGENT infra → propose with explicit risk.

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { classifyCommand } from "./verify.js";
import type {
  Confidence,
  KnownUnknown,
  MirrorDimension,
  MirrorFinding,
  MirrorIntent,
  MirrorPlanStep,
  MirrorReport,
  RepoIntel,
  SourceRef,
} from "./types.js";

export interface MirrorOptions {
  generatedAt: number;
  scanVersion: string;
  /** Which dimensions to compare (default: all). */
  dimensions?: MirrorDimension[];
}

const ALL_DIMENSIONS: MirrorDimension[] = ["conventions", "scripts", "structure", "config", "ci-cd", "deployment", "env", "docs"];
const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
function worse(a: Confidence, b: Confidence): Confidence {
  return CONF_RANK[a] <= CONF_RANK[b] ? a : b;
}

/** Primary ecosystem of a repo, from its languages (drives the ecosystem rail). */
function ecosystemOf(repo: RepoIntel): "node" | "python" | "go" | "rust" | "unknown" {
  const langs = repo.languages.map((l) => l.toLowerCase());
  if (langs.some((l) => /(type|java)?script|node/.test(l))) return "node";
  if (langs.some((l) => /python/.test(l))) return "python";
  if (langs.some((l) => /\bgo\b|golang/.test(l))) return "go";
  if (langs.some((l) => /rust/.test(l))) return "rust";
  return "unknown";
}

/** Convention files (lowest risk) — name → "what it is". */
const CONVENTION_FILES: { match: RegExp; role: string }[] = [
  { match: /^\.eslintrc(\..+)?$|^eslint\.config\.(js|mjs|cjs|ts)$/i, role: "eslint config" },
  { match: /^\.prettierrc(\..+)?$|^prettier\.config\.(js|cjs)$/i, role: "prettier config" },
  { match: /^ruff\.toml$|^\.ruff\.toml$/i, role: "ruff config" },
  { match: /^\.editorconfig$/i, role: "editorconfig" },
  { match: /^\.gitignore$/i, role: "gitignore" },
  { match: /^\.nvmrc$|^\.node-version$/i, role: "node version pin" },
  { match: /^\.python-version$/i, role: "python version pin" },
  { match: /^tsconfig(\..+)?\.json$|^tsconfig\.json$/i, role: "tsconfig" },
];

/** Config/manifest files compared by purpose. */
const CONFIG_FILES: { match: RegExp; role: string; ecosystem?: string }[] = [
  { match: /^package\.json$/i, role: "node manifest", ecosystem: "node" },
  { match: /^pyproject\.toml$/i, role: "python manifest", ecosystem: "python" },
  { match: /^requirements\.txt$/i, role: "python requirements", ecosystem: "python" },
  { match: /^vitest\.config\.(ts|js)$/i, role: "vitest config", ecosystem: "node" },
  { match: /^jest\.config\.(ts|js|cjs)$/i, role: "jest config", ecosystem: "node" },
  { match: /^pytest\.ini$|^setup\.cfg$/i, role: "pytest config", ecosystem: "python" },
  { match: /^next\.config\.(ts|js)$/i, role: "next config", ecosystem: "node" },
];

/** CI/CD + deployment files compared by kind. */
const CICD_FILES: { match: RegExp; role: string; risk: "medium" | "high" }[] = [
  { match: /(^|\/)\.github\/workflows\//i, role: "GitHub Actions workflow", risk: "high" },
  { match: /^\.gitlab-ci\.ya?ml$/i, role: "GitLab CI", risk: "high" },
  { match: /^bitbucket-pipelines\.ya?ml$/i, role: "Bitbucket pipeline", risk: "high" },
  { match: /^Jenkinsfile$/i, role: "Jenkins pipeline", risk: "high" },
  { match: /(^|\/)cicd\//i, role: "cicd config", risk: "high" },
];
const DEPLOY_FILES: { match: RegExp; role: string }[] = [
  { match: /^Dockerfile/i, role: "Dockerfile" },
  { match: /^docker-compose.*\.ya?ml$/i, role: "docker-compose" },
  { match: /(deployment|service|ingress|configmap)\.ya?ml$/i, role: "kubernetes manifest" },
  { match: /(fly\.toml|vercel\.json|render\.yaml|Procfile|app\.yaml)$/i, role: "cloud config" },
];

function mkUnknown(id: string, title: string, detail: string, impact: Confidence): KnownUnknown {
  return { id, kind: "other", title, detail, evidence: [], status: "open", confidenceImpact: impact };
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "venv", "__pycache__", ".turbo", "coverage", ".pytest_cache", "dist-scan"]);
const MIRROR_MAX_FILES = 3000;

/**
 * All repo-relative file paths relevant to mirroring. Starts from what the scan
 * already recorded, then adds a BOUNDED read-only walk so config/CI files the
 * scanner doesn't index (eslintrc, .github/workflows, cicd/, k8s manifests) are
 * still comparable. Read-only — only directory listings + stat, no content reads.
 */
function knownFiles(repo: RepoIntel): Set<string> {
  const out = new Set<string>();
  for (const f of repo.packageFiles) out.add(f.value);
  for (const f of repo.docFiles) out.add(f.value);
  for (const f of repo.deployFiles) out.add(f.value);
  for (const f of repo.envFiles) out.add(f.value);
  // bounded walk for the config/CI/convention files the scan doesn't list
  const stack = [repo.rootPath];
  let seen = 0;
  while (stack.length && seen < MIRROR_MAX_FILES) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let isDir: boolean;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (!IGNORE_DIRS.has(name)) stack.push(abs);
      } else {
        seen++;
        out.add(relative(repo.rootPath, abs));
      }
    }
  }
  return out;
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

/**
 * Compare two scanned repos and produce a propose-only mirroring report.
 * Pure: reads only the two RepoIntel objects; writes nothing.
 */
export function buildMirrorReport(source: RepoIntel, target: RepoIntel, opts: MirrorOptions): MirrorReport {
  const dims = opts.dimensions ?? ALL_DIMENSIONS;
  const findings: MirrorFinding[] = [];
  const knownUnknowns: KnownUnknown[] = [];
  const srcEco = ecosystemOf(source);
  const tgtEco = ecosystemOf(target);
  const sameEcosystem = srcEco === tgtEco && srcEco !== "unknown";

  const srcFiles = knownFiles(source);
  const tgtFiles = knownFiles(target);
  const srcBase = new Map([...srcFiles].map((f) => [basename(f), f]));
  const tgtBase = new Map([...tgtFiles].map((f) => [basename(f), f]));

  const ev = (repo: RepoIntel, file: string): SourceRef[] => [{ kind: "file", ref: `${repo.name}/${file}` }];

  // ---- conventions (lowest risk) ----
  if (dims.includes("conventions")) {
    for (const { match, role } of CONVENTION_FILES) {
      const s = [...srcFiles].find((f) => match.test(basename(f)));
      const t = [...tgtFiles].find((f) => match.test(basename(f)));
      if (s && !t) {
        // ecosystem rail: don't propose a stack-specific convention into a different stack
        const ecoForced = (/tsconfig|eslint|prettier|node/.test(role) && tgtEco === "python") || (/ruff|python/.test(role) && tgtEco === "node");
        findings.push({
          dimension: "conventions",
          role,
          status: "missing-in-target",
          intent: ecoForced ? "out-of-scope" : "safe-to-align",
          source: s,
          target: null,
          reason: ecoForced
            ? `\`${role}\` is specific to the source's ${srcEco} stack; the target is ${tgtEco} — not applicable.`
            : `Target lacks a \`${role}\` that the source defines; adding it aligns a low-risk convention.`,
          risk: ecoForced ? "" : "Low — conventions are stylistic, not behavioral.",
          confidence: "high",
          sources: ev(source, s),
        });
      } else if (s && t) {
        findings.push({ dimension: "conventions", role, status: "match", intent: "intentionally-kept", source: s, target: t, reason: `Both repos have a \`${role}\`.`, risk: "", confidence: "high", sources: ev(source, s) });
      }
    }
  }

  // ---- scripts / commands (medium) — align by ROLE (category), not literal string ----
  if (dims.includes("scripts")) {
    const srcByCat = groupScripts(source);
    const tgtByCat = groupScripts(target);
    for (const cat of ["test", "lint", "build", "dev-server", "install"] as const) {
      const s = srcByCat.get(cat);
      const t = tgtByCat.get(cat);
      if (s && !t) {
        findings.push({
          dimension: "scripts",
          role: `${cat} command`,
          status: "missing-in-target",
          intent: "worth-aligning",
          source: s.command,
          target: null,
          reason: `Source has a \`${cat}\` command but the target has none. Add the ROLE (a ${cat} script); keep it ecosystem-correct for the target (${tgtEco}) — do NOT copy the literal source command.`,
          risk: sameEcosystem ? "Low — same ecosystem, but verify the script fits the target's layout." : `Medium — different ecosystem (${srcEco}→${tgtEco}); the literal command won't transfer, only the role.`,
          confidence: "medium",
          sources: [{ kind: "file", ref: `${source.name}/${s.source}`, locator: s.command }],
        });
      } else if (s && t && s.command !== t.command) {
        findings.push({
          dimension: "scripts",
          role: `${cat} command`,
          status: "divergent",
          intent: !sameEcosystem ? "intentionally-kept" : "needs-your-call",
          source: s.command,
          target: t.command,
          reason: !sameEcosystem
            ? `Both have a \`${cat}\` command but in different ecosystems (${srcEco} vs ${tgtEco}) — the difference is ecosystem-forced; keep the target's.`
            : `Both have a \`${cat}\` command but they differ. Aligning is optional — decide if the target should follow the source's exact command.`,
          risk: "Changing a working command can break the build/test gate — verify after.",
          confidence: "medium",
          sources: [{ kind: "file", ref: `${source.name}/${s.source}`, locator: s.command }],
        });
      }
    }
  }

  // ---- config / manifest files (by purpose) ----
  if (dims.includes("config")) {
    for (const { match, role, ecosystem } of CONFIG_FILES) {
      const s = [...srcFiles].find((f) => match.test(basename(f)));
      const t = [...tgtFiles].find((f) => match.test(basename(f)));
      if (s && !t) {
        const ecoForced = ecosystem && ecosystem !== tgtEco;
        findings.push({
          dimension: "config",
          role,
          status: "missing-in-target",
          intent: ecoForced ? "out-of-scope" : "worth-aligning",
          source: s,
          target: null,
          reason: ecoForced
            ? `\`${role}\` belongs to the ${ecosystem} stack; the target is ${tgtEco} — not applicable.`
            : `Target lacks \`${role}\`. Consider adding it, adapted to the target — don't copy values verbatim.`,
          risk: ecoForced ? "" : "Medium — config files can change build/test behavior; review before applying.",
          confidence: "medium",
          sources: ev(source, s),
        });
      }
    }
  }

  // ---- CI/CD (high scrutiny) ----
  if (dims.includes("ci-cd")) {
    for (const { match, role, risk } of CICD_FILES) {
      const s = [...srcFiles].find((f) => match.test(f));
      const t = [...tgtFiles].find((f) => match.test(f));
      if (s && !t) {
        findings.push({
          dimension: "ci-cd",
          role,
          status: "missing-in-target",
          intent: "high-scrutiny",
          source: s,
          target: null,
          reason: `Source ships a \`${role}\` the target lacks. Mirroring the CI SHAPE (test-gate → build → deploy) is high-value, but the pipeline references images/registries/secrets that differ per project.`,
          risk: "High — copying a pipeline blindly can target the wrong registry/deploy target or run with the wrong secrets. Mirror the structure, not the identity.",
          confidence: "medium",
          sources: ev(source, s),
        });
      }
    }
  }

  // ---- deployment (highest scrutiny) ----
  if (dims.includes("deployment")) {
    for (const { match, role } of DEPLOY_FILES) {
      const s = [...srcFiles].find((f) => match.test(basename(f)) || match.test(f));
      const t = [...tgtFiles].find((f) => match.test(basename(f)) || match.test(f));
      if (s && !t) {
        findings.push({
          dimension: "deployment",
          role,
          status: "missing-in-target",
          intent: "high-scrutiny",
          source: s,
          target: null,
          reason: `Source has a \`${role}\`; the target doesn't. Mirroring the deployment PATTERN can help, but ports, image names, and runtime config must differ per service.`,
          risk: "High — a copied Dockerfile/manifest may expose the wrong port, use the source's base image assumptions, or duplicate a deploy target. Adapt, never copy verbatim.",
          confidence: "medium",
          sources: ev(source, s),
        });
      } else if (s && t) {
        findings.push({ dimension: "deployment", role, status: "match", intent: "intentionally-kept", source: s, target: t, reason: `Both repos have a \`${role}\` — review the contents separately; identity (ports/targets) is expected to differ.`, risk: "", confidence: "medium", sources: ev(source, s) });
      }
    }
  }

  // ---- env examples (names only; values are out-of-scope, S6) ----
  if (dims.includes("env")) {
    const srcEnvExample = [...srcFiles].find((f) => /\.env\.(example|template)$/.test(f));
    const tgtEnvExample = [...tgtFiles].find((f) => /\.env\.(example|template)$/.test(f));
    if (srcEnvExample && !tgtEnvExample) {
      findings.push({
        dimension: "env",
        role: "env example",
        status: "missing-in-target",
        intent: "safe-to-align",
        source: srcEnvExample,
        target: null,
        reason: "Source documents required env via a committed .env.example but the target doesn't. Adding one (with NAMES only, no values) is a safe onboarding improvement.",
        risk: "Low — but only mirror variable NAMES the target actually needs; never copy secret values (S6).",
        confidence: "high",
        sources: ev(source, srcEnvExample),
      });
    }
    // Always note: env VALUES are out of scope.
    findings.push({
      dimension: "env",
      role: "env values",
      status: "extra-in-target",
      intent: "out-of-scope",
      source: null,
      target: null,
      reason: "Environment variable VALUES (secrets, URLs, per-service identity) are never mirrored — only the set of required names is comparable (S6).",
      risk: "",
      confidence: "high",
      sources: [],
    });
  }

  // ---- structure / docs (medium / low) ----
  if (dims.includes("structure")) {
    const srcDirs = new Set(source.importantDirs.map((d) => d.value));
    const tgtDirs = new Set(target.importantDirs.map((d) => d.value));
    for (const d of srcDirs) {
      if (!tgtDirs.has(d) && /^(src|server|cicd|k8s|tests?|__tests__|scripts|docs|app)$/i.test(d)) {
        findings.push({
          dimension: "structure",
          role: `directory \`${d}/\``,
          status: "missing-in-target",
          intent: "needs-your-call",
          source: d,
          target: null,
          reason: `Source organizes code under \`${d}/\` which the target doesn't have. A layout move ripples into imports — decide if the target should adopt this convention.`,
          risk: "Medium — moving files changes import paths; run the target's build/tests after.",
          confidence: "low",
          sources: ev(source, d),
        });
      }
    }
  }
  if (dims.includes("docs")) {
    const srcReadme = [...srcFiles].find((f) => /(^|\/)readme/i.test(f));
    const tgtReadme = [...tgtFiles].find((f) => /(^|\/)readme/i.test(f));
    if (srcReadme && !tgtReadme) {
      findings.push({ dimension: "docs", role: "README", status: "missing-in-target", intent: "safe-to-align", source: srcReadme, target: null, reason: "Source has a README; the target lacks one. Adding a setup/README doc improves onboarding.", risk: "Low — documentation only.", confidence: "high", sources: ev(source, srcReadme) });
    }
  }

  // ---- known-unknowns (honesty) ----
  if (!sameEcosystem) {
    knownUnknowns.push(mkUnknown("mirror:cross-ecosystem", "cross-ecosystem mirror", `Source is ${srcEco}, target is ${tgtEco}. Many patterns won't transfer; only roles/conventions are comparable, and stack-specific files are out of scope.`, "high"));
  }
  knownUnknowns.push(mkUnknown("mirror:no-content-diff", "compares presence + roles, not file contents", "This MVP compares which files/roles exist and their categories — it does NOT diff file CONTENTS line-by-line, so two same-named configs may still differ inside.", "medium"));
  knownUnknowns.push(mkUnknown("mirror:no-blast-radius", "no dependency/blast-radius check", "Whether the target's own code depends on a difference (making it intentional/load-bearing) is not verified here — review before applying any structural change.", "medium"));

  // ---- dry-run plan (only actionable proposals; never identity/out-of-scope) ----
  const plan = buildPlan(findings, target);

  // ---- validation hand-off (change-confidence, req #7) ----
  const validation = buildValidation(plan, target);

  // ---- overall confidence + summary ----
  let confidence: Confidence = "high";
  for (const f of findings) if (f.intent !== "out-of-scope" && f.intent !== "intentionally-kept") confidence = worse(confidence, f.confidence);

  const summary = buildSummary(source, target, sameEcosystem, srcEco, tgtEco, findings, plan);

  return {
    version: 1,
    generatedAt: opts.generatedAt,
    scanVersion: opts.scanVersion,
    source: { name: source.name, path: source.rootPath, languages: source.languages },
    target: { name: target.name, path: target.rootPath, languages: target.languages },
    sameEcosystem,
    dimensions: dims,
    findings,
    plan,
    validation,
    confidence,
    knownUnknowns,
    summary,
  };
}

/** Group a repo's scripts by category, keeping the first command per category. */
function groupScripts(repo: RepoIntel): Map<string, { command: string; source: string }> {
  const m = new Map<string, { command: string; source: string }>();
  for (const s of repo.scripts) {
    if (!m.has(s.value.category)) m.set(s.value.category, { command: s.value.command, source: s.value.source });
  }
  return m;
}

/** Turn actionable findings into ordered dry-run steps (low→high risk). */
function buildPlan(findings: MirrorFinding[], target: RepoIntel): MirrorPlanStep[] {
  const actionable = findings.filter((f) => f.intent === "safe-to-align" || f.intent === "worth-aligning" || f.intent === "high-scrutiny");
  const riskOf = (i: MirrorIntent): "low" | "medium" | "high" => (i === "safe-to-align" ? "low" : i === "worth-aligning" ? "medium" : "high");
  const actionFor = (f: MirrorFinding): MirrorPlanStep["action"] => {
    if (f.status === "divergent") return "align-file";
    if (f.dimension === "scripts") return "add-config"; // a script lives in a manifest
    if (f.dimension === "config" || f.dimension === "conventions") return "add-config";
    return "add-file";
  };
  const steps: MirrorPlanStep[] = actionable.map((f) => ({
    action: actionFor(f),
    description:
      f.status === "missing-in-target"
        ? `Add a ${f.role} to \`${target.name}\` (adapt from source: \`${f.source}\`) — ${f.intent.replace(/-/g, " ")}.`
        : `Align ${f.role} in \`${target.name}\` toward the source — review the divergence first.`,
    targetPath: f.status === "missing-in-target" && f.source ? basename(f.source) : undefined,
    fromSource: f.source ?? undefined,
    risk: riskOf(f.intent),
    dimension: f.dimension,
  }));
  // sort low→high risk
  const order = { low: 0, medium: 1, high: 2 };
  return steps.sort((a, b) => order[a.risk] - order[b.risk]);
}

/** Recommend validation checks for the target after applying (req #7 / 12-...md §6). */
function buildValidation(plan: MirrorPlanStep[], target: RepoIntel): string[] {
  const out: string[] = [];
  if (plan.length === 0) return ["No changes proposed — nothing to validate."];
  // Always: run change-confidence on the target after applying.
  out.push(`Run \`report --target ${target.name}\` (change-confidence) on the TARGET after applying any change — it must not say "safe to push" without checks.`);
  // Suggest the target's own test/lint/build if present.
  const cats = new Set(target.scripts.map((s) => s.value.category));
  for (const cat of ["test", "lint", "build"] as const) {
    if (cats.has(cat)) {
      const cmd = target.scripts.find((s) => s.value.category === cat)!.value.command;
      const safety = classifyCommand(cmd).classification;
      out.push(`Run the target's \`${cat}\` (\`${cmd}\`, safety: ${safety}) to confirm the mirrored result still passes its own checks.`);
    }
  }
  if (plan.some((s) => s.risk === "high")) out.push("For CI/deployment changes: verify the pipeline/Dockerfile parses + targets the RIGHT registry/port/secret — never the source's identity.");
  return out;
}

function buildSummary(
  source: RepoIntel,
  target: RepoIntel,
  sameEco: boolean,
  srcEco: string,
  tgtEco: string,
  findings: MirrorFinding[],
  plan: MirrorPlanStep[],
): string {
  const byIntent = (i: MirrorIntent) => findings.filter((f) => f.intent === i).length;
  return (
    `Mirror comparison: target \`${target.name}\` (${tgtEco}) ⇐ source \`${source.name}\` (${srcEco}). ` +
    `${byIntent("safe-to-align")} safe-to-align, ${byIntent("worth-aligning")} worth-aligning, ${byIntent("high-scrutiny")} high-scrutiny, ` +
    `${byIntent("intentionally-kept")} intentionally kept, ${byIntent("needs-your-call")} need your call, ${byIntent("out-of-scope")} out of scope. ` +
    (sameEco ? "" : `⚠ Cross-ecosystem (${srcEco}→${tgtEco}) — most patterns won't transfer. `) +
    `Dry-run plan has ${plan.length} proposed step(s). This is PROPOSE-ONLY: no file is changed until you explicitly approve an apply step.`
  );
}
