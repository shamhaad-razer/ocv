// Render WorkspaceIntel → a source-grounded markdown project map.
//
// Every section shows its evidence (file refs) and the system never claims
// understanding it can't ground (13-...md §9, §11). Freshness + confidence +
// known-unknowns are first-class, not footnotes.

import type {
  Confidence,
  Finding,
  FreshnessStatus,
  Grounding,
  KnownUnknown,
  RepoIntel,
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

function findingLine<T>(label: string, f: Finding<T>): string {
  return `- ${label} — ${confBadge(f.grounding.confidence)} · src: ${citeList(f.grounding)}`;
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
  lines.push("> Generated by the OpenClaw project-intelligence scanner (milestone 1).");
  lines.push("> Source-grounded: every finding cites the file it came from. This is a");
  lines.push("> point-in-time snapshot — re-run after changes (see freshness below).");
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
  lines.push("- Run `npm run scan:check` to see which findings may have gone stale without a full re-scan.");
  lines.push("- Freshness is anchored to each repo's commit + per-file content hashes recorded in the JSON output.");
  lines.push("");
  return lines.join("\n");
}
