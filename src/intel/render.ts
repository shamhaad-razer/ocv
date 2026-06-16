// Render WorkspaceIntel → a source-grounded markdown project map.
//
// Every section shows its evidence (file refs) and the system never claims
// understanding it can't ground (13-...md §9, §11). Freshness + confidence +
// known-unknowns are first-class, not footnotes.

import type {
  ChangeConfidenceReport,
  Confidence,
  Finding,
  FreshnessStatus,
  Grounding,
  KnownUnknown,
  MachineEnv,
  RepoChangeReport,
  RepoIntel,
  VerificationStore,
  WorkspaceDiff,
  WorkspaceIntel,
} from "./types.js";

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
  // Deterministic ISO string from the injected timestamp.
  return new Date(ms).toISOString();
}

function citeList(g: Grounding): string {
  if (g.sources.length === 0) return "_no sources — treat as a hint, not a fact_";
  return g.sources
    .slice(0, 6)
    .map((s) => `\`${s.locator ?? s.ref}\``)
    .join(", ") + (g.sources.length > 6 ? `, +${g.sources.length - 6} more` : "");
}

/** A short stale marker, only shown when a finding is NOT fresh (keeps fresh output clean). */
function staleMarker(g: Grounding): string {
  if (g.status === "fresh") return "";
  return ` · ${freshBadge(g.status)}${g.staleReason ? ` (${g.staleReason})` : ""}`;
}

function findingLine<T>(label: string, f: Finding<T>): string {
  return `- ${label} — ${confBadge(f.grounding.confidence)}${staleMarker(f.grounding)} · src: ${citeList(f.grounding)}`;
}

function renderUnknowns(unknowns: KnownUnknown[]): string {
  if (unknowns.length === 0) return "_none recorded_\n";
  const order: Confidence[] = ["high", "medium", "low"];
  const sorted = [...unknowns].sort(
    (a, b) => order.indexOf(a.confidenceImpact) - order.indexOf(b.confidenceImpact),
  );
  return sorted
    .map(
      (u) =>
        `- **${u.title}** (${u.kind}, impact: ${confBadge(u.confidenceImpact)}, ${u.status})\n  - ${u.detail}` +
        (u.evidence.length ? `\n  - evidence: ${u.evidence.map((e) => `\`${e.locator ?? e.ref}\``).join(", ")}` : ""),
    )
    .join("\n");
}

function renderRepo(repo: RepoIntel): string {
  const lines: string[] = [];
  lines.push(`## Repo: \`${repo.name}\``);
  lines.push("");
  lines.push(
    `- branch: \`${repo.gitBranch ?? "unknown"}\` · commit: \`${repo.gitCommit ?? "unknown"}\` · git: ${repo.isGitRepo ? "yes" : "no"}`,
  );
  lines.push(`- languages: ${repo.languages.length ? repo.languages.join(", ") : "_none detected_"}`);
  lines.push(
    `- scan freshness: ${freshBadge(repo.grounding.status)} · overall confidence: ${confBadge(repo.grounding.confidence)}`,
  );
  lines.push("");

  lines.push("### Scan coverage (what was scanned / skipped)");
  lines.push(`- files scanned: ${repo.coverage.filesScanned}${repo.coverage.truncated ? ` (TRUNCATED at ${repo.coverage.maxFiles} — knowledge incomplete)` : ""}`);
  lines.push(`- dirs scanned: ${repo.coverage.dirsScanned.length ? repo.coverage.dirsScanned.map((d) => `\`${d}/\``).join(", ") : "_none_"}`);
  lines.push(`- dirs skipped (vendored/build): ${repo.coverage.dirsSkipped.length ? repo.coverage.dirsSkipped.map((d) => `\`${d}/\``).join(", ") : "_none_"}`);
  lines.push("");

  lines.push("### Important directories");
  lines.push(repo.importantDirs.length ? repo.importantDirs.map((d) => `- \`${d.value}/\``).join("\n") : "_none_");
  lines.push("");

  lines.push("### Package / config files");
  lines.push(
    repo.packageFiles.length
      ? repo.packageFiles.map((p) => `- \`${p.value}\` — ${confBadge(p.grounding.confidence)}`).join("\n")
      : "_none detected_",
  );
  lines.push("");

  lines.push("### Scripts / commands");
  if (repo.scripts.length) {
    for (const s of repo.scripts.slice(0, 40)) {
      lines.push(
        `- **${s.value.name}** (${s.value.category}): \`${s.value.command}\` — ${confBadge(s.grounding.confidence)} · src: ${citeList(s.grounding)}`,
      );
    }
    if (repo.scripts.length > 40) lines.push(`- _+${repo.scripts.length - 40} more_`);
  } else {
    lines.push("_none detected — run commands may live only in docs (see known unknowns)_");
  }
  lines.push("");

  lines.push("### Detected services");
  lines.push(
    repo.services.length
      ? repo.services.map((s) => findingLine(`\`${s.value.name}\` (${s.value.kind}${s.value.defaultPort ? `, :${s.value.defaultPort}` : ""})`, s)).join("\n")
      : "_none detected_",
  );
  lines.push("");

  lines.push("### Detected routes / APIs (heuristic)");
  if (repo.routes.length) {
    for (const r of repo.routes.slice(0, 30)) {
      lines.push(`- \`${r.value.method} ${r.value.pathPattern}\` — ${confBadge(r.grounding.confidence)} · src: \`${r.value.locator}\``);
    }
    if (repo.routes.length > 30) lines.push(`- _+${repo.routes.length - 30} more_`);
  } else {
    lines.push("_none detected by heuristics (does not mean none exist — see known unknowns)_");
  }
  lines.push("");

  lines.push("### Environment files & variables");
  lines.push(repo.envFiles.length ? repo.envFiles.map((e) => `- \`${e.value}\``).join("\n") : "_no env files detected_");
  if (repo.envVars.length) {
    lines.push("");
    lines.push(`Variable names (from \`.example\`/\`.template\` only, values never read):`);
    lines.push(repo.envVars.map((v) => `\`${v.value.name}\``).join(", "));
  }
  lines.push("");

  lines.push("### Docker / deployment files");
  lines.push(
    repo.deployFiles.length
      ? repo.deployFiles.map((d) => `- \`${d.value}\` — ${confBadge(d.grounding.confidence)}`).join("\n")
      : "_none detected (see known unknowns)_",
  );
  lines.push("");

  lines.push("### Known unknowns (what this scan could NOT confirm)");
  lines.push(renderUnknowns(repo.knownUnknowns));
  lines.push("");

  return lines.join("\n");
}

export function renderWorkspaceMarkdown(ws: WorkspaceIntel): string {
  const lines: string[] = [];
  lines.push("# Project Intelligence Map (MVP)");
  lines.push("");
  lines.push("> Generated by the OpenClaw project-intelligence scanner.");
  lines.push("> Source-grounded: every finding cites the file it came from. This is a");
  lines.push("> point-in-time snapshot — re-run after changes (see freshness below).");
  lines.push(">");
  lines.push("> **Legend** — confidence: 🟢 high (declared & fresh) · 🟡 medium (heuristic/inferred) · 🔴 low (no/ stale/missing evidence).");
  lines.push("> freshness: ✓ fresh · ⚠ potentially stale · ✗ known stale · ? unverified.");
  lines.push("> Evidence kinds: declared/parsed = directly evidenced · heuristic/inferred = inferred · verification is `static` (NOT runtime-verified yet).");
  lines.push("");
  lines.push("## Scan metadata");
  lines.push(`- workspace: \`${ws.rootPath}\``);
  lines.push(`- scan version: \`${ws.scanVersion}\``);
  lines.push(`- generated at: \`${isoUtc(ws.generatedAt)}\` (epoch ms: ${ws.generatedAt})`);
  lines.push(`- repos scanned: ${ws.repos.map((r) => `\`${r.name}\``).join(", ")}`);
  lines.push("");
  lines.push("### Per-repo freshness anchor");
  lines.push("| repo | branch | commit | freshness | confidence |");
  lines.push("|---|---|---|---|---|");
  for (const r of ws.repos) {
    lines.push(
      `| \`${r.name}\` | \`${r.gitBranch ?? "?"}\` | \`${r.gitCommit ?? "?"}\` | ${freshBadge(r.grounding.status)} | ${confBadge(r.grounding.confidence)} |`,
    );
  }
  lines.push("");

  if (ws.machineEnv) {
    lines.push(renderMachineEnv(ws.machineEnv));
    lines.push("");
  }

  if (ws.knownUnknowns.length) {
    lines.push("## Workspace-level known unknowns");
    lines.push(renderUnknowns(ws.knownUnknowns));
    lines.push("");
  }

  for (const repo of ws.repos) {
    lines.push(renderRepo(repo));
    lines.push("---");
    lines.push("");
  }

  lines.push("## How to keep this accurate");
  lines.push("- Re-run `npm run scan` after code changes to regenerate.");
  lines.push("- Run `npm run scan:check` to mark findings whose sources drifted as potentially stale (no full re-scan).");
  lines.push("- Run `npm run scan:diff` to compare the previous scan with a fresh one.");
  lines.push("- Freshness is anchored to each repo's commit + per-file content hashes recorded in the JSON output.");
  lines.push("");
  return lines.join("\n");
}

/** Render the local machine environment (milestone 4) — detected vs missing vs unchecked. */
export function renderMachineEnv(env: MachineEnv): string {
  const lines: string[] = [];
  lines.push("## Local machine environment");
  lines.push(`- OS: \`${env.os}\`${env.isWSL ? " (WSL)" : ""} · arch: \`${env.arch}\` · shell: \`${env.shell ?? "unknown"}\` — ${freshBadge(env.grounding.status)}, ${env.grounding.verification === "runtime-verified" ? "runtime-verified ✓" : env.grounding.verification}`);
  lines.push("");
  lines.push("### Detected tools (runtime-verified)");
  lines.push("| tool | available | version | probe |");
  lines.push("|---|---|---|---|");
  for (const t of env.tools) {
    lines.push(`| \`${t.name}\` | ${t.available ? "✓" : "✗"} | ${t.version ?? "—"} | \`${t.probe}\` |`);
  }
  lines.push("");
  if (env.ports.length) {
    lines.push("### Port checks (opt-in, confirmed)");
    for (const p of env.ports) lines.push(`- port \`${p.port}\`: **${p.state}**`);
    lines.push("");
  } else {
    lines.push("_Ports not checked (opt-in via `env --check-ports`)._");
    lines.push("");
  }
  return lines.join("\n");
}

/** Render a scan-to-scan diff (requirement 8) as a readable changelog. */
export function renderDiffMarkdown(diff: WorkspaceDiff): string {
  const lines: string[] = [];
  lines.push("# Project Intelligence — Scan Diff");
  lines.push("");
  lines.push(`- previous scan: \`${isoUtc(diff.prevGeneratedAt)}\``);
  lines.push(`- current scan: \`${isoUtc(diff.nextGeneratedAt)}\``);
  if (diff.reposAdded.length) lines.push(`- repos added: ${diff.reposAdded.map((r) => `\`${r}\``).join(", ")}`);
  if (diff.reposRemoved.length) lines.push(`- repos removed: ${diff.reposRemoved.map((r) => `\`${r}\``).join(", ")}`);
  lines.push("");

  for (const repo of diff.repoDiffs) {
    const moved = repo.commitBefore !== repo.commitAfter;
    const hasAny =
      repo.deltas.length || repo.unknownsOpened.length || repo.unknownsResolved.length || moved;
    if (!hasAny) continue;

    lines.push(`## \`${repo.name}\``);
    if (moved) {
      lines.push(`- commit: \`${repo.commitBefore ?? "?"}\` → \`${repo.commitAfter ?? "?"}\``);
    }
    if (repo.branchBefore !== repo.branchAfter) {
      lines.push(`- branch: \`${repo.branchBefore ?? "?"}\` → \`${repo.branchAfter ?? "?"}\``);
    }
    const added = repo.deltas.filter((d) => d.change === "added");
    const removed = repo.deltas.filter((d) => d.change === "removed");
    const changed = repo.deltas.filter((d) => d.change === "changed");
    if (added.length) lines.push(`- **added** (${added.length}): ${added.map((d) => `\`${d.section}:${d.key}\``).join(", ")}`);
    if (removed.length) lines.push(`- **removed** (${removed.length}): ${removed.map((d) => `\`${d.section}:${d.key}\``).join(", ")}`);
    if (changed.length) {
      lines.push(`- **changed** (${changed.length}):`);
      for (const d of changed) lines.push(`  - \`${d.section}:${d.key}\`: \`${d.before}\` → \`${d.after}\``);
    }
    if (repo.unknownsOpened.length) lines.push(`- known-unknowns opened: ${repo.unknownsOpened.map((u) => `\`${u}\``).join(", ")}`);
    if (repo.unknownsResolved.length) lines.push(`- known-unknowns resolved: ${repo.unknownsResolved.map((u) => `\`${u}\``).join(", ")}`);
    lines.push("");
  }

  if (!diff.repoDiffs.some((r) => r.deltas.length || r.unknownsOpened.length || r.unknownsResolved.length || r.commitBefore !== r.commitAfter) && !diff.reposAdded.length && !diff.reposRemoved.length) {
    lines.push("_No changes detected between scans._");
    lines.push("");
  }
  return lines.join("\n");
}

// ---------- Change Confidence Report (08-...md) ----------

function bullets(items: string[], empty = "_none_"): string {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : empty;
}

function renderRepoChange(r: RepoChangeReport): string {
  const lines: string[] = [];
  lines.push(`## \`${r.repo}\``);
  if (!r.isGitRepo) {
    lines.push("_not a git repository — changes can't be determined_");
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`- branch: \`${r.branch ?? "?"}\` · head: \`${r.headCommit ?? "?"}\` · changed files: ${r.summary.total}`);
  if (r.summary.total === 0) {
    lines.push("- _no working-tree changes_");
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`- breakdown: ${r.summary.code} code · ${r.summary.config} config · ${r.summary.test} test · ${r.summary.deploy} deploy · ${r.summary.docs} docs · ${r.summary.other} other`);
  lines.push("");

  lines.push("### Changed files → affected entities");
  lines.push("| file | change | +/- | affected entities |");
  lines.push("|---|---|---|---|");
  for (const f of r.changedFiles) {
    const ent = f.affectedEntities.length
      ? f.affectedEntities.map((e) => `${e.kind}:${e.label} (${confBadge(e.confidence)})`).join("; ")
      : f.indexed ? "—" : "_not indexed_";
    const counts = f.added != null || f.deleted != null ? `+${f.added ?? 0}/-${f.deleted ?? 0}` : "—";
    lines.push(`| \`${f.path}\` | ${f.changeKind} | ${counts} | ${ent} |`);
  }
  lines.push("");

  lines.push("### Recommended commands (NOT run — recommend only)");
  if (r.recommendedCommands.length) {
    for (const c of r.recommendedCommands) {
      lines.push(`- **${c.name}** (${c.category}): \`${c.command}\` — ${c.reason} ${c.runtimeVerified ? "" : "· ✗ not verified"}`);
    }
  } else {
    lines.push("_no commands recommended (none known, or no changes)_");
  }
  lines.push("");

  lines.push("### High confidence (directly evidenced from git)");
  lines.push(bullets(r.highConfidenceNotes));
  lines.push("");
  lines.push("### Inferred (heuristic index links)");
  lines.push(bullets(r.inferredNotes));
  lines.push("");
  lines.push("### What may become stale");
  lines.push(bullets(r.staleWarnings));
  lines.push("");
  lines.push("### Do not know yet");
  lines.push(bullets(r.doNotKnowYet));
  lines.push("");
  lines.push("### Review manually before pushing");
  lines.push(bullets(r.manualReview));
  lines.push("");
  lines.push("### Known unknowns");
  lines.push(r.knownUnknowns.length ? r.knownUnknowns.map((u) => `- **${u.title}** (${u.kind}, impact ${confBadge(u.confidenceImpact)}) — ${u.detail}`).join("\n") : "_none_");
  lines.push("");
  return lines.join("\n");
}

export function renderChangeReportMarkdown(report: ChangeConfidenceReport): string {
  const lines: string[] = [];
  lines.push("# Change Confidence Report (generated)");
  lines.push("");
  lines.push("> **Generated from live `git status`/`diff` — not hand-authored.** This report");
  lines.push("> does **NOT** assert the changes are safe. Recommended tests are NOT run.");
  lines.push(`> generated: \`${isoUtc(report.generatedAt)}\` · scan version: \`${report.scanVersion}\` · index available: ${report.indexAvailable ? "yes" : "no"}`);
  lines.push("");
  lines.push("## Verdict");
  lines.push(report.verdict);
  lines.push("");
  for (const r of report.repos) {
    lines.push(renderRepoChange(r));
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

// ---------- Safe Runtime Verification (13-...md §7) ----------

export function renderVerificationMarkdown(store: VerificationStore): string {
  const lines: string[] = [];
  lines.push("# Runtime Verification Results (generated)");
  lines.push("");
  lines.push("> Results of SAFE, explicit runtime checks. Statically-inferred facts");
  lines.push("> are NOT here — only things that were actually run/observed.");
  lines.push(`> generated: \`${isoUtc(store.generatedAt)}\` · scan version: \`${store.scanVersion}\``);
  lines.push("");
  lines.push("| check | classification | status | exit | confidence | when | summary |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of store.results) {
    const status = r.status === "ran" ? (r.passed ? "PASS" : "FAIL") : r.status;
    const conf = r.confidenceImpact === "raises" ? "↑ raises" : r.confidenceImpact === "lowers" ? "↓ lowers" : "—";
    const summary = r.outputSummary.replace(/\n/g, " ").slice(0, 80);
    lines.push(`| ${r.label} | ${r.classification} | ${status} | ${r.exitCode ?? "—"} | ${conf} | ${isoUtc(r.ranAt)} | ${summary} |`);
  }
  lines.push("");
  const blocked = store.results.filter((r) => r.status === "blocked");
  if (blocked.length) {
    lines.push(`**${blocked.length} blocked** (destructive/installing/long-running — never run): ${blocked.map((r) => `\`${r.command}\``).join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}
