// Onboarding doc + command book generation (milestone 3).
//
// Pure and host-independent: turns a scanned WorkspaceIntel (from scanner.ts)
// into grounded onboarding artifacts — a per-repo summary, a multi-repo overview,
// and a command book. Design refs: 05-onboarding-engine.md (the 10 questions),
// 07-command-and-setup-assistant.md (categories + provenance), 13-...md (every
// answer cites sources + carries freshness/confidence, never claims completeness
// when evidence is missing).
//
// These are GENERATED ARTIFACTS, not hand-authored truth — the rendered headers
// say so, and every section degrades honestly when evidence is absent.

import type { Guidance } from "./memory.js";
import type {
  CommandBook,
  CommandBookEntry,
  CommandCategory,
  Confidence,
  DetectedScript,
  Finding,
  FreshnessStatus,
  Grounding,
  KnownUnknown,
  RepoIntel,
  WorkspaceIntel,
} from "./types.js";
import { deriveSetupCompatibility } from "./env.js";
import { classifyCommand } from "./verify.js";

// ---------- badges (shared style with render.ts) ----------

function confBadge(c: Confidence): string {
  return c === "high" ? "🟢 high" : c === "medium" ? "🟡 medium" : "🔴 low";
}
function freshBadge(s: FreshnessStatus): string {
  switch (s) {
    case "fresh":
      return "✓ fresh";
    case "potentially-stale":
      return "⚠ potentially stale";
    case "known-stale":
      return "✗ known stale";
    default:
      return "? unverified";
  }
}
function isoUtc(ms: number): string {
  return new Date(ms).toISOString();
}
function cite(g: Grounding): string {
  if (g.sources.length === 0) return "_no source — inferred, treat as a hint_";
  return g.sources.slice(0, 4).map((s) => `\`${s.locator ?? s.ref}\``).join(", ");
}

// ---------- command book ----------

/** Map the scanner's script category onto the command book's category set. */
function toCommandCategory(c: DetectedScript["category"]): CommandCategory {
  switch (c) {
    case "dev-server":
      return "dev";
    case "install":
    case "setup":
    case "build":
    case "test":
    case "lint":
    case "deploy":
    case "docker":
    case "database":
    case "inspect":
      return c;
    default:
      return "uncategorized";
  }
}

/**
 * Does a command modify the target project or local machine? (install deps,
 * build artifacts, migrate DBs, format/codegen, start services, push/deploy).
 * Used to populate `mayModify` — conservative: when unsure for a non-read-only
 * category, assume it may write.
 */
function commandMayModify(command: string, category: CommandCategory): boolean {
  if (category === "inspect") return false;
  if (/\b(--version|--help|-h|\bstatus\b|\blist\b|\bshow\b|\bps\b|\blogs\b)\b/.test(command)) return false;
  // install/build/deploy/docker/database/dev all create files, processes, or state.
  return true;
}

/** Tools a command assumes are installed (drives env-assumption surfacing). */
function envAssumptionsFor(command: string): string[] {
  const first = command.trim().replace(/^\.\//, "").split(/\s+/)[0];
  const map: Record<string, string> = {
    npm: "node", npx: "node", pnpm: "pnpm", yarn: "yarn", node: "node",
    python: "python", python3: "python", pip: "python", uv: "uv", poetry: "poetry",
    pytest: "python", ruff: "python", go: "go", cargo: "rust", make: "make",
    just: "just", docker: "docker", "docker-compose": "docker", bash: "bash", sh: "sh",
  };
  return map[first] ? [map[first]] : [];
}

/** Build the cross-repo command book from the scanned scripts (grounded). */
export function buildCommandBook(ws: WorkspaceIntel): CommandBook {
  const entries: CommandBookEntry[] = [];
  const gaps: KnownUnknown[] = [];

  for (const repo of ws.repos) {
    for (const s of repo.scripts) {
      const g = s.grounding;
      const category = toCommandCategory(s.value.category);
      // Reuse the SAME safety classifier the verify command uses (single source
      // of truth) so the book and the runner never disagree.
      const { classification, reason } = classifyCommand(s.value.command);
      entries.push({
        repo: repo.name,
        category,
        command: s.value.command,
        name: s.value.name,
        sourceFile: s.value.source,
        sourceLocator: g.sources[0]?.locator,
        confidence: g.confidence,
        freshness: g.status,
        // No command is ever executed in this MVP — honesty: not runtime-verified.
        runtimeVerified: g.verification === "runtime-verified",
        verification: g.verification,
        safety: classification,
        safeToRunAutomatically: classification === "safe-auto",
        confirmationRequired: classification === "confirm-required",
        mayModify: classification === "blocked" || commandMayModify(s.value.command, category),
        safetyReason: reason,
        envAssumptions: envAssumptionsFor(s.value.command),
      });
    }
    // Surface command-relevant gaps from this repo's known-unknowns.
    for (const u of repo.knownUnknowns) {
      if (
        u.kind === "unvalidated-command" ||
        u.kind === "missing-test-command" ||
        u.kind === "missing-deploy-command" ||
        u.kind === "ambiguous-command"
      ) {
        gaps.push({ ...u, id: `${repo.name}:${u.id}` });
      }
    }
  }

  return { generatedAt: ws.generatedAt, scanVersion: ws.scanVersion, entries, gaps };
}

const CATEGORY_ORDER: CommandCategory[] = [
  "install",
  "setup",
  "dev",
  "build",
  "test",
  "lint",
  "inspect",
  "docker",
  "database",
  "deploy",
  "uncategorized",
];

/** Safety marker for the command book table. */
function safetyBadge(e: CommandBookEntry): string {
  if (e.safety === "blocked") return "🚫 never auto-run";
  if (e.safety === "safe-auto") return "✅ safe-auto";
  return "⚠ confirm";
}

export function renderCommandBookMarkdown(book: CommandBook): string {
  const lines: string[] = [];
  lines.push("# Command Book (generated)");
  lines.push("");
  lines.push("> **Generated artifact — not hand-authored truth.** Commands are read");
  lines.push("> from manifests/Makefiles and **not executed**, so none is runtime-verified");
  lines.push("> yet. Regenerate with `npm run scan` (or `npm run docs`).");
  lines.push(`> generated: \`${isoUtc(book.generatedAt)}\` · scan version: \`${book.scanVersion}\``);
  lines.push("");

  const byCat = new Map<CommandCategory, CommandBookEntry[]>();
  for (const e of book.entries) {
    if (!byCat.has(e.category)) byCat.set(e.category, []);
    byCat.get(e.category)!.push(e);
  }

  for (const cat of CATEGORY_ORDER) {
    const items = byCat.get(cat);
    lines.push(`## ${cat}`);
    if (!items || items.length === 0) {
      lines.push(`_no \`${cat}\` commands detected_`);
      lines.push("");
      continue;
    }
    lines.push("| repo | name | command | source | confidence | safety | may modify | env | verified |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const e of items) {
      lines.push(
        `| \`${e.repo}\` | ${e.name} | \`${e.command}\` | \`${e.sourceLocator ?? e.sourceFile}\` | ${confBadge(e.confidence)} | ${safetyBadge(e)} | ${e.mayModify ? "yes" : "no"} | ${e.envAssumptions.join(",") || "—"} | ${e.runtimeVerified ? "✓" : "✗"} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Known gaps (commands)");
  if (book.gaps.length === 0) {
    lines.push("_none recorded_");
  } else {
    // Collapse identical gaps (same kind+title) that recur across repos, but
    // list which repos they affect so nothing is hidden.
    const grouped = new Map<string, { gap: (typeof book.gaps)[number]; repos: string[] }>();
    for (const u of book.gaps) {
      const key = `${u.kind}|${u.title}`;
      const repo = u.id.split(":")[0];
      if (!grouped.has(key)) grouped.set(key, { gap: u, repos: [] });
      grouped.get(key)!.repos.push(repo);
    }
    for (const { gap, repos } of grouped.values()) {
      lines.push(`- **${gap.title}** (${gap.kind}, impact ${confBadge(gap.confidenceImpact)}; repos: ${repos.map((r) => `\`${r}\``).join(", ")}) — ${gap.detail}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ---------- per-repo onboarding summary ----------

function scriptsByCategory(repo: RepoIntel, cat: DetectedScript["category"][]): Finding<DetectedScript>[] {
  return repo.scripts.filter((s) => cat.includes(s.value.category));
}

function answerOrGap(findings: Finding<DetectedScript>[], gapMsg: string): string {
  if (findings.length === 0) return `_${gapMsg}_`;
  return findings
    .map((f) => `\`${f.value.command}\` — ${confBadge(f.grounding.confidence)}${f.grounding.status !== "fresh" ? ` · ${freshBadge(f.grounding.status)}` : ""} (src: ${cite(f.grounding)})`)
    .join("\n  - ");
}

export function renderRepoOnboarding(repo: RepoIntel): string {
  const lines: string[] = [];
  lines.push(`# Onboarding — \`${repo.name}\` (generated)`);
  lines.push("");
  lines.push("> **Generated from a source scan — not hand-authored.** Every answer below");
  lines.push("> cites its evidence; missing evidence is shown as a gap, never guessed.");
  lines.push(
    `> branch: \`${repo.gitBranch ?? "?"}\` · commit: \`${repo.gitCommit ?? "?"}\` · scan freshness: ${freshBadge(repo.grounding.status)} · confidence: ${confBadge(repo.grounding.confidence)}`,
  );
  lines.push("");

  // What is this repo?
  lines.push("## What is this repo?");
  const langs = repo.languages.length ? repo.languages.join(", ") : "unknown";
  lines.push(`- languages: ${langs}`);
  if (repo.docFiles.length) {
    lines.push(`- docs: ${repo.docFiles.slice(0, 5).map((d) => `\`${d.value}\``).join(", ")}`);
    lines.push(`- _Inferred from structure; see the README above for the authoritative description._`);
  } else {
    lines.push("- _No README found — purpose is inferred from structure only (low confidence)._");
  }
  lines.push("");

  // How do I install / run / test / build?
  lines.push("## How do I install dependencies?");
  lines.push(`  - ${answerOrGap(scriptsByCategory(repo, ["install", "setup"]), "no install/setup command detected — check the README or CI config")}`);
  lines.push("");
  lines.push("## How do I run it locally?");
  lines.push(`  - ${answerOrGap(scriptsByCategory(repo, ["dev-server"]), "no dev/run command detected")}`);
  lines.push("");
  lines.push("## How do I test it?");
  lines.push(`  - ${answerOrGap(scriptsByCategory(repo, ["test"]), "no test command detected — testing approach unknown from manifests")}`);
  lines.push("");
  lines.push("## How do I build it?");
  lines.push(`  - ${answerOrGap(scriptsByCategory(repo, ["build"]), "no build command detected")}`);
  lines.push("");

  // Config / env
  lines.push("## What config / env files matter?");
  if (repo.envFiles.length) {
    lines.push(`- env files: ${repo.envFiles.map((e) => `\`${e.value}\``).join(", ")}`);
  } else {
    lines.push("- _no env files detected_");
  }
  if (repo.envVars.length) {
    lines.push(`- required vars (names only, from committed examples): ${repo.envVars.map((v) => `\`${v.value.name}\``).join(", ")}`);
  }
  if (repo.deployFiles.length) {
    lines.push(`- deploy/config: ${repo.deployFiles.map((d) => `\`${d.value}\``).join(", ")}`);
  }
  lines.push("");

  // Known / inferred / stale / unknown
  lines.push("## What is known, inferred, stale, or unknown?");
  lines.push(`- **directly evidenced** (declared in manifests): package files, scripts, env-var names, deploy files.`);
  lines.push(`- **inferred** (heuristic, medium confidence): services, routes — verify before relying.`);
  lines.push(`- **runtime-verified**: none yet — no command has been executed (milestone 10).`);
  const stale = [...repo.packageFiles, ...repo.scripts, ...repo.deployFiles].filter((f) => f.grounding.status !== "fresh");
  lines.push(`- **stale / potentially stale**: ${stale.length ? `${stale.length} finding(s) — re-run \`npm run scan\`` : "none at last scan"}.`);
  lines.push("");
  lines.push("### Known unknowns");
  if (repo.knownUnknowns.length === 0) {
    lines.push("_none recorded_");
  } else {
    const order: Confidence[] = ["high", "medium", "low"];
    for (const u of [...repo.knownUnknowns].sort((a, b) => order.indexOf(a.confidenceImpact) - order.indexOf(b.confidenceImpact))) {
      lines.push(`- **${u.title}** (${u.kind}, impact ${confBadge(u.confidenceImpact)}) — ${u.detail}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ---------- multi-repo overview ----------

export function renderOverview(ws: WorkspaceIntel, guidance?: Guidance): string {
  const lines: string[] = [];
  lines.push("# Multi-Repo Onboarding Overview (generated)");
  lines.push("");
  lines.push("> **Generated artifact — not hand-authored truth.** Re-run `npm run scan`");
  lines.push("> after changes. Cross-repo runtime wiring is NOT yet mapped (see gaps).");
  lines.push(`> target project: \`${ws.targetPath ?? ws.rootPath}\``);
  lines.push(`> generated: \`${isoUtc(ws.generatedAt)}\` · scan version: \`${ws.scanVersion}\``);
  // Remembered presentation preferences (prompt 36) — shown so onboarding adapts
  // to the user (junior by default) and the applied lens is transparent.
  if (guidance) {
    lines.push(`> presented for: **${guidance.level}** engineer (your saved preference — change with \`prefs set\`)`);
  }
  lines.push("");
  if (guidance) {
    lines.push("> _Reading guidance:_ " + guidance.lines.slice(0, 3).join(" "));
    lines.push("");
  }

  lines.push("## Repos at a glance");
  lines.push("| repo | languages | install? | run? | test? | build? | freshness |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of ws.repos) {
    const has = (cats: DetectedScript["category"][]) => (scriptsByCategory(r, cats).length ? "✓" : "—");
    lines.push(
      `| \`${r.name}\` | ${r.languages.join(", ") || "?"} | ${has(["install", "setup"])} | ${has(["dev-server"])} | ${has(["test"])} | ${has(["build"])} | ${freshBadge(r.grounding.status)} |`,
    );
  }
  lines.push("");

  lines.push("## How the repos fit together");
  lines.push("- Each repo is summarized in its own `onboarding-<repo>.md`.");
  lines.push("- **Cross-repo runtime/contract wiring is not yet derived** by this MVP — it is");
  lines.push("  tracked as a workspace known-unknown below and planned for a later milestone.");
  lines.push("");

  // Setup compatibility against the detected machine (milestone 4).
  if (ws.machineEnv) {
    const env = ws.machineEnv;
    lines.push("## Setup compatibility (this machine)");
    lines.push(`- machine: \`${env.os}\`${env.isWSL ? " (WSL)" : ""}, shell \`${env.shell ?? "?"}\`. Tools present: ${env.tools.filter((t) => t.available).map((t) => `\`${t.name}\``).join(", ") || "none detected"}.`);
    const compat = deriveSetupCompatibility(ws);
    for (const c of compat) {
      if (c.toolsMissing.length === 0 && c.notes.length === 0) {
        lines.push(`- \`${c.repo}\`: needed tools present (${c.toolsPresent.map((t) => `\`${t}\``).join(", ") || "no tool-specific commands"}).`);
      } else {
        lines.push(`- \`${c.repo}\`: ${c.toolsMissing.length ? `**missing ${c.toolsMissing.map((t) => `\`${t}\``).join(", ")}**` : "tools present"}.`);
        for (const n of c.notes) lines.push(`  - ${n}`);
      }
    }
    lines.push("");
  } else {
    lines.push("## Setup compatibility (this machine)");
    lines.push("_Machine environment not detected — run `npm run scan` (auto-detects) or `npm run env`._");
    lines.push("");
  }

  lines.push("## Workspace known unknowns");
  const allGaps = [...ws.knownUnknowns];
  if (allGaps.length === 0) {
    lines.push("_none recorded at workspace level_");
  } else {
    for (const u of allGaps) {
      lines.push(`- **${u.title}** (${u.kind}, impact ${confBadge(u.confidenceImpact)}) — ${u.detail}`);
    }
  }
  lines.push("");
  lines.push("## Generated docs index");
  lines.push("- `command-book.md` — all commands across repos, grouped + grounded.");
  for (const r of ws.repos) lines.push(`- \`onboarding-${r.name}.md\` — per-repo summary.`);
  lines.push("");
  return lines.join("\n");
}
