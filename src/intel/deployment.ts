// Deployment Explorer (09-deployment-explorer.md, prompt 38). Read-only reader.
//
// Answers "how is this (possibly multi-repo) target deployed, or how might it be?"
// by DETECTING deployment signals from the target's files (Dockerfile, compose,
// k8s, CI configs, scripts, Makefiles, env examples, README deploy sections, cloud
// config) and EXPLAINING them — current model, service boundaries, runtime deps,
// env vars, build/run/deploy commands — with a hard line between what's
// source-grounded, what's inferred, and what's unknown (esp. production topology,
// which configs can't reveal — 09-...md §7 DR1/DR5).
//
// HONEST BY CONSTRUCTION:
//   - declared config files = facts (high confidence); inferred runtime deps and
//     cross-repo coupling = clearly marked lower confidence;
//   - production deployment is reported as UNKNOWN, never invented (req #4);
//   - env vars referenced by NAME only — values are never read (S6, DR7).
//
// READ-ONLY w.r.t. the target: this module only reads files + reuses the index.
// It never writes into the target (HOST_VS_TARGET_PROJECT_MODEL.md). Persisting a
// report is the CLI's job and only ever to HOST storage.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { hashContent } from "./grounding.js";
import { flowForRepo } from "./flowmap.js";
import type {
  Confidence,
  DeploymentReport,
  DeploymentSignal,
  DeploymentSignalType,
  FreshnessStatus,
  KnownUnknown,
  RepoDeployment,
  RepoIntel,
  RuntimeDependency,
  SourceRef,
  WorkspaceIntel,
} from "./types.js";

export interface DeploymentOptions {
  generatedAt: number;
  /** Max files to walk per repo (bound for huge trees). */
  maxFiles?: number;
}

const MAX_FILES = 4000;
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".venv", "venv",
  "__pycache__", ".turbo", "coverage", ".pytest_cache", "dist-scan",
]);
// Env var names that are too ubiquitous to imply a real runtime dependency.
const UBIQUITOUS_ENV = new Set(["NODE_ENV", "PORT", "HOST", "PATH", "HOME", "PWD", "TZ", "LANG", "DEBUG", "LOG_LEVEL", "CI"]);

const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const FRESH_RANK: Record<FreshnessStatus, number> = { "known-stale": 0, "potentially-stale": 1, unverified: 2, fresh: 3 };
function worse(a: Confidence, b: Confidence): Confidence {
  return CONF_RANK[a] <= CONF_RANK[b] ? a : b;
}
function worseFresh(a: FreshnessStatus, b: FreshnessStatus): FreshnessStatus {
  return FRESH_RANK[a] <= FRESH_RANK[b] ? a : b;
}

/** Classify a repo-relative path into a deployment signal type, or null. */
function classify(rel: string): DeploymentSignalType | null {
  const base = rel.split("/").pop() as string;
  const lower = rel.toLowerCase();
  if (/^Dockerfile(\..+)?$/i.test(base) || /\.dockerfile$/i.test(base)) return "dockerfile";
  if (/^docker-compose.*\.ya?ml$/i.test(base) || /^compose\.ya?ml$/i.test(base)) return "compose";
  if (/^bitbucket-pipelines\.ya?ml$/i.test(base)) return "bitbucket-pipelines";
  if (/^\.gitlab-ci\.ya?ml$/i.test(base)) return "gitlab-ci";
  if (/(^|\/)\.github\/workflows\/.+\.ya?ml$/i.test(lower)) return "github-actions";
  if (/^Jenkinsfile$/i.test(base) || /\.jenkinsfile$/i.test(base)) return "jenkins";
  if (/(^|\/)cicd\/.*\.ya?ml$/i.test(lower)) return "cicd-config";
  // Kubernetes / helm manifests (path hint or k8s-y filename)
  if (/(^|\/)(k8s|kube|kubernetes|helm|deploy|manifests|charts)\/.*\.ya?ml$/i.test(lower)) return "kubernetes";
  if (/(deployment|service|ingress|statefulset|daemonset|configmap)\.ya?ml$/i.test(base)) return "kubernetes";
  if (/^Makefile$/i.test(base) || /\.mk$/i.test(base)) return "makefile";
  if (/(^|\/)(scripts|bin|deploy)\/.*(deploy|release|ship|publish|provision).*\.(sh|bash|ps1)$/i.test(lower)) return "deploy-script";
  if (/\.(env\.example|env\.template)$/i.test(base) || base === ".env.example" || base === ".env.template") return "env-example";
  if (/(app\.yaml|app\.yml|fly\.toml|vercel\.json|netlify\.toml|render\.yaml|Procfile|serverless\.ya?ml|now\.json|railway\.json)$/i.test(base)) return "cloud-config";
  if (/^README(\..+)?$/i.test(base)) return "readme-deploy"; // only kept if it has a deploy section (checked later)
  return null;
}

/** Walk the repo for deployment-relevant files (bounded, read-only). */
function walkDeployFiles(root: string, max: number): string[] {
  const out: string[] = [];
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < max) {
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
        const rel = relative(root, abs);
        if (classify(rel)) out.push(rel);
      }
    }
  }
  return out;
}

function readText(abs: string): string | null {
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

/** Extract ports, env names, commands, deps from a signal file's text (heuristic). */
function extractFromText(type: DeploymentSignalType, text: string): {
  ports: number[];
  envVars: string[];
  commands: string[];
  dependencies: string[];
} {
  const ports = new Set<number>();
  const envVars = new Set<string>();
  const commands: string[] = [];
  const dependencies = new Set<string>();
  const lines = text.split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    // Ports: EXPOSE 3000 / ports: "3000:3000" / containerPort: 8080 / listen 7860
    let m: RegExpExecArray | null;
    const portRe = /\b(?:EXPOSE|containerPort:|port:|listen)\s*["']?(\d{2,5})\b/gi;
    while ((m = portRe.exec(line))) {
      const p = parseInt(m[1], 10);
      if (p >= 1 && p <= 65535) ports.add(p);
    }
    const mapRe = /["']?(\d{2,5}):(\d{2,5})["']?/g;
    while ((m = mapRe.exec(line))) {
      const p = parseInt(m[2], 10);
      if (p >= 1 && p <= 65535) ports.add(p);
    }

    // Env var NAMES (never values): UPPER_SNAKE on env lines / ${VAR} / process.env.X
    const envRe = /\b([A-Z][A-Z0-9_]{2,})\b/g;
    if (/env|ENV|environment|variables?/i.test(line) || /^\s*[A-Z][A-Z0-9_]+\s*[:=]/.test(raw) || type === "env-example") {
      while ((m = envRe.exec(line))) {
        const name = m[1];
        if (!UBIQUITOUS_ENV.has(name) && !/^(FROM|RUN|CMD|COPY|ADD|WORKDIR|EXPOSE|ENTRYPOINT|ARG|LABEL|USER|VOLUME)$/.test(name)) {
          envVars.add(name);
        }
      }
    }
    const interpRe = /\$\{?([A-Z][A-Z0-9_]{2,})\}?/g;
    while ((m = interpRe.exec(line))) if (!UBIQUITOUS_ENV.has(m[1])) envVars.add(m[1]);

    // Dockerfile base image + entry command
    if (type === "dockerfile") {
      const from = /^FROM\s+(\S+)/i.exec(line);
      if (from) dependencies.add(`image:${from[1]}`);
      const cmd = /^(?:CMD|ENTRYPOINT)\s+(.+)/i.exec(line);
      if (cmd) commands.push(cmd[1].replace(/^\[|\]$/g, "").replace(/"/g, "").trim());
    }

    // Compose service images / depends_on
    if (type === "compose" || type === "kubernetes") {
      const img = /image:\s*["']?([^\s"']+)/i.exec(line);
      if (img) dependencies.add(`image:${img[1]}`);
    }

    // CI / scripts / make: capture run-ish lines (build/test/deploy verbs)
    if (/(run:|script:|^\t|^\s*-\s|npm |yarn |pnpm |make |docker |kubectl |helm |terraform |gcloud |aws |fly |vercel |bash |sh )/i.test(raw)) {
      const cleaned = line.replace(/^-\s*/, "").replace(/^run:\s*/i, "").replace(/^script:\s*/i, "").trim();
      if (/(build|deploy|push|release|ship|publish|test|lint|migrate|docker|kubectl|helm|terraform|start|serve)/i.test(cleaned) && cleaned.length < 200) {
        commands.push(cleaned);
      }
    }
  }
  return {
    ports: [...ports].sort((a, b) => a - b),
    envVars: [...envVars].sort(),
    commands: dedupe(commands).slice(0, 12),
    dependencies: [...dependencies].sort(),
  };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}

const TYPE_LABEL: Record<DeploymentSignalType, string> = {
  dockerfile: "Dockerfile (container image)",
  compose: "docker-compose (local/test topology)",
  kubernetes: "Kubernetes/Helm manifest",
  "github-actions": "GitHub Actions workflow",
  "gitlab-ci": "GitLab CI pipeline",
  jenkins: "Jenkins pipeline",
  "bitbucket-pipelines": "Bitbucket pipeline",
  "cicd-config": "CI/CD config",
  "package-script": "package.json script",
  makefile: "Makefile target",
  "deploy-script": "deploy script",
  "env-example": "env example (var names)",
  "readme-deploy": "README deployment section",
  "cloud-config": "cloud platform config",
};
/** Container/orchestration/CI configs are strong evidence; README/env are weaker. */
const STRONG_TYPES = new Set<DeploymentSignalType>(["dockerfile", "compose", "kubernetes", "github-actions", "gitlab-ci", "jenkins", "bitbucket-pipelines", "cicd-config", "cloud-config"]);

/** Does a README actually contain a deployment-ish section? (avoid noise) */
function readmeHasDeploySection(text: string): boolean {
  return /(^|\n)#+\s*(deploy|deployment|hosting|production|release|ci\/cd|docker|kubernetes)/i.test(text);
}

function mkUnknown(id: string, title: string, detail: string, impact: Confidence, evidence: SourceRef[] = []): KnownUnknown {
  return { id, kind: "missing-deploy-config", title, detail, evidence, status: "open", confidenceImpact: impact };
}

/**
 * Build the deployment report for a target workspace (prompt 38). Pure-ish: reads
 * the target's files read-only + reuses the index. Never writes to the target.
 */
export function buildDeploymentReport(ws: WorkspaceIntel, opts: DeploymentOptions): DeploymentReport {
  const now = opts.generatedAt;
  const max = opts.maxFiles ?? MAX_FILES;
  const targetPath = ws.targetPath ?? ws.rootPath;
  const repos: RepoDeployment[] = [];
  const allUnknowns: KnownUnknown[] = [];

  for (const repo of ws.repos) {
    repos.push(buildRepoDeployment(repo, now, max, allUnknowns));
  }

  // ---- cross-repo coupling (multi-repo only; inferred, never invented) ----
  const multiRepo = ws.repos.length > 1;
  const crossRepoLinks: DeploymentReport["crossRepoLinks"] = [];
  if (multiRepo && ws.flowMap) {
    for (const repo of ws.repos) {
      for (const e of flowForRepo(ws.flowMap, repo.name).edges) {
        if (e.from !== repo.name) continue; // emit once, from the source side
        const kind =
          e.kind === "shared-package" ? "co-deployed"
          : e.kind === "localhost-port" || e.kind === "http-url" ? "runtime-coupled"
          : "shared-config";
        crossRepoLinks.push({ from: e.from, to: e.to, via: e.label, kind, confidence: e.confidence, sources: e.evidence });
      }
    }
  }

  // ---- source-grounded vs inferred vs unknown ----
  const sourceGrounded: string[] = [];
  const inferred: string[] = [];
  const unknown: string[] = [];

  const totalSignals = repos.reduce((n, r) => n + r.signals.length, 0);
  const strongSignals = repos.reduce((n, r) => n + r.signals.filter((s) => STRONG_TYPES.has(s.type)).length, 0);
  for (const r of repos) {
    for (const s of r.signals) sourceGrounded.push(`\`${s.sourceFile}\` → ${TYPE_LABEL[s.type]}${s.ports.length ? ` (ports ${s.ports.join(", ")})` : ""}`);
    for (const d of r.runtimeDependencies) inferred.push(`${r.repo} → ${d.to} (${d.kind}, via ${d.via}, ${d.confidence})`);
  }
  for (const l of crossRepoLinks) inferred.push(`${l.from} ⇄ ${l.to}: ${l.kind} (${l.via}, ${l.confidence})`);

  // The one thing configs can never reveal: the live production topology (DR1/DR5).
  unknown.push(
    "Live production topology (running replicas, the actual cluster/host, load balancing, scaling) is NOT observable from source — only declared config is read.",
  );
  if (strongSignals === 0) {
    unknown.push("No container/orchestration/CI config was found — how (and whether) this is deployed to production is unknown from source.");
    allUnknowns.push(
      mkUnknown("deploy:no-strong-signal", "production deployment unknown", "No Dockerfile/compose/k8s/CI config detected; deployment strategy can't be determined from source.", "high"),
    );
  }
  if (multiRepo && !ws.flowMap) {
    unknown.push("Cross-repo deploy coupling not computed (no flow map) — repos may be runtime-coupled but it isn't inferred.");
  }

  // ---- overall confidence / freshness (worst included signal) ----
  let confidence: Confidence = totalSignals ? "high" : "low";
  let freshness: FreshnessStatus = totalSignals ? "fresh" : "unverified";
  for (const r of repos) {
    confidence = worse(confidence, r.confidence);
    freshness = worseFresh(freshness, r.freshness);
  }

  // ---- diagram (only if enough evidence — req #5/acceptance) ----
  const diagram = totalSignals > 0 ? buildMermaid(repos, crossRepoLinks) : "";

  const dedupU = dedupeUnknowns(allUnknowns);
  const summary = buildSummary(repos, crossRepoLinks, strongSignals, multiRepo, confidence, freshness);

  return {
    version: 1,
    generatedAt: now,
    scanVersion: ws.scanVersion,
    targetPath,
    multiRepo,
    repos,
    crossRepoLinks,
    sourceGrounded: dedupe(sourceGrounded),
    inferred: dedupe(inferred),
    unknown,
    diagram,
    confidence,
    freshness,
    knownUnknowns: dedupU,
    summary,
  };
}

function buildRepoDeployment(repo: RepoIntel, now: number, max: number, sink: KnownUnknown[]): RepoDeployment {
  const files = walkDeployFiles(repo.rootPath, max);
  const signals: DeploymentSignal[] = [];
  const repoUnknowns: KnownUnknown[] = [];

  for (const rel of files) {
    const type = classify(rel);
    if (!type) continue;
    const text = readText(join(repo.rootPath, rel));
    if (text == null) continue;
    if (type === "readme-deploy" && !readmeHasDeploySection(text)) continue; // README without deploy info → skip

    const extracted = extractFromText(type, text);
    const hash = hashContent(text);
    const conf: Confidence = STRONG_TYPES.has(type) ? "high" : type === "env-example" ? "high" : "medium";
    const signal: DeploymentSignal = {
      sourceFile: rel,
      type,
      repo: repo.name,
      commands: extracted.commands,
      envVars: extracted.envVars,
      ports: extracted.ports,
      dependencies: extracted.dependencies,
      summary: summarizeSignal(type, extracted),
      confidence: conf,
      freshness: "fresh", // hashed now from the live file; the report is a point-in-time read
      sources: [{ kind: "file", ref: rel, hash }],
      knownUnknownIds: [],
    };
    // compose is often TEST infra, not prod — flag, don't assume (09-...md PQ4).
    if (type === "compose" && /\btest\b/i.test(rel)) {
      const id = `deploy:${repo.name}:compose-is-test`;
      repoUnknowns.push(mkUnknown(id, "compose file may be test infra", `\`${rel}\` looks like a test fixture, not a production deploy topology — treat as local/test only.`, "medium", signal.sources));
      signal.knownUnknownIds.push(id);
    }
    signals.push(signal);
  }

  // Pull deploy/build/run commands from the index's detected scripts too.
  const scriptCommands = repo.scripts
    .filter((s) => ["build", "deploy", "docker", "dev-server"].includes(s.value.category))
    .map((s) => ({
      category: (s.value.category === "deploy" ? "deploy" : s.value.category === "build" ? "build" : "run") as "build" | "run" | "deploy" | "other",
      command: s.value.command,
      source: s.value.source,
    }));

  // Service boundaries from the index.
  const services = repo.services.map((s) => ({
    name: s.value.name,
    kind: s.value.kind,
    ports: s.value.defaultPort ? [s.value.defaultPort] : [],
    evidence: s.value.evidence,
  }));

  // Runtime dependencies (inferred from env var names + signal deps).
  const runtimeDependencies = inferRuntimeDeps(repo, signals);

  // Required env vars: union of signal env vars + index env vars (names only).
  const envFromSignals = signals.flatMap((s) => s.envVars);
  const envFromIndex = repo.envVars.map((e) => e.value.name);
  const requiredEnvVars = dedupe([...envFromSignals, ...envFromIndex]).sort();

  // Build/run/deploy commands: signals + script commands.
  const signalCommands = signals.flatMap((s) =>
    s.commands.map((c) => ({
      category: (/(deploy|push|release|ship|publish|kubectl|helm|terraform)/i.test(c) ? "deploy" : /(build|docker build|compile|tsc)/i.test(c) ? "build" : /(start|serve|run|dev)/i.test(c) ? "run" : "other") as "build" | "run" | "deploy" | "other",
      command: c,
      source: s.sourceFile,
    })),
  );
  const commands = dedupeCommands([...signalCommands, ...scriptCommands]);

  if (signals.length === 0) {
    const id = `deploy:${repo.name}:no-signals`;
    repoUnknowns.push(mkUnknown(id, "no deployment signals in repo", `No deployment-related files detected in \`${repo.name}\`. Its deployment is unknown from source.`, "high"));
  }

  // confidence/freshness for the repo = worst signal (or low if none).
  let confidence: Confidence = signals.length ? "high" : "low";
  let freshness: FreshnessStatus = signals.length ? "fresh" : "unverified";
  for (const s of signals) confidence = worse(confidence, s.confidence);

  for (const u of repoUnknowns) sink.push(u);

  return {
    repo: repo.name,
    model: characterizeModel(signals, services),
    signals,
    runtimeDependencies,
    services,
    requiredEnvVars,
    commands,
    confidence,
    freshness,
    knownUnknowns: repoUnknowns,
  };
}

/** Infer runtime dependencies from env var names + image deps (heuristic, low/medium). */
function inferRuntimeDeps(repo: RepoIntel, signals: DeploymentSignal[]): RuntimeDependency[] {
  const out: RuntimeDependency[] = [];
  const seen = new Set<string>();
  const add = (to: string, kind: RuntimeDependency["kind"], via: string, conf: Confidence, sources: SourceRef[]) => {
    const key = `${to}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ from: repo.name, to, kind, via, required: kind === "datastore" || kind === "internal-service", confidence: conf, sources });
  };

  const envNames = dedupe([...repo.envVars.map((e) => e.value.name), ...signals.flatMap((s) => s.envVars)]);
  for (const name of envNames) {
    const src: SourceRef[] = [{ kind: "intel-entity", ref: `env:${name}` }];
    if (/DATABASE_URL|POSTGRES|MYSQL|MONGO|DB_|_DB$|SQL/i.test(name)) add("datastore (database)", "datastore", `env ${name}`, "medium", src);
    else if (/REDIS|CACHE_URL/i.test(name)) add("redis/cache", "datastore", `env ${name}`, "medium", src);
    else if (/RABBIT|KAFKA|SQS|QUEUE|AMQP/i.test(name)) add("message queue", "message-queue", `env ${name}`, "medium", src);
    else if (/_API_KEY$|_TOKEN$|ELEVENLABS|OPENAI|ANTHROPIC|GROQ|BEDROCK|STRIPE/i.test(name)) add(`external API (${name.replace(/_API_KEY$|_TOKEN$/, "")})`, "external-api", `env ${name}`, "low", src);
    else if (/_URL$|_HOST$|_ENDPOINT$/i.test(name)) add(`service via ${name}`, "internal-service", `env ${name}`, "low", src);
  }
  // compose/k8s image deps that look like infra
  for (const s of signals) {
    for (const dep of s.dependencies) {
      const img = dep.replace(/^image:/, "");
      if (/postgres|mysql|mongo|mariadb/i.test(img)) add(`datastore (${img})`, "datastore", `${s.type} image`, "high", s.sources);
      else if (/redis|memcached/i.test(img)) add(`cache (${img})`, "datastore", `${s.type} image`, "high", s.sources);
      else if (/rabbitmq|kafka/i.test(img)) add(`queue (${img})`, "message-queue", `${s.type} image`, "high", s.sources);
    }
  }
  return out;
}

function summarizeSignal(type: DeploymentSignalType, x: { ports: number[]; envVars: string[]; commands: string[]; dependencies: string[] }): string {
  const bits: string[] = [TYPE_LABEL[type]];
  if (x.dependencies.length) bits.push(`deps: ${x.dependencies.slice(0, 3).join(", ")}`);
  if (x.ports.length) bits.push(`ports: ${x.ports.join(", ")}`);
  if (x.commands.length) bits.push(`${x.commands.length} command(s)`);
  if (x.envVars.length) bits.push(`${x.envVars.length} env var(s)`);
  return bits.join(" · ");
}

function characterizeModel(signals: DeploymentSignal[], services: { name: string; kind: string }[]): string {
  const types = new Set(signals.map((s) => s.type));
  const parts: string[] = [];
  if (types.has("kubernetes")) parts.push("Kubernetes/Helm-orchestrated");
  if (types.has("compose")) parts.push("docker-compose topology (often local/test)");
  if (types.has("dockerfile")) parts.push("containerized (Dockerfile)");
  if (types.has("github-actions") || types.has("gitlab-ci") || types.has("jenkins") || types.has("bitbucket-pipelines") || types.has("cicd-config")) parts.push("CI/CD pipeline present");
  if (types.has("cloud-config")) parts.push("cloud-platform config present");
  if (parts.length === 0) parts.push(signals.length ? "scripts/env only — no container/orchestration config" : "no deployment config detected");
  const svc = services.length ? ` · ${services.length} service boundary(ies)` : "";
  return parts.join(" + ") + svc;
}

/** A simple Mermaid topology diagram from services + runtime deps + cross-repo links. */
function buildMermaid(repos: RepoDeployment[], links: DeploymentReport["crossRepoLinks"]): string {
  const lines: string[] = ["flowchart TB"];
  const id = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");
  const depNodes = new Set<string>();

  for (const r of repos) {
    const portInfo = r.services.flatMap((s) => s.ports);
    const label = `${r.repo}${portInfo.length ? `\\n:${[...new Set(portInfo)].join(",")}` : ""}`;
    lines.push(`  ${id(r.repo)}["${label}"]`);
    for (const d of r.runtimeDependencies) {
      const dn = id(`dep_${d.to}`);
      if (!depNodes.has(dn)) {
        depNodes.add(dn);
        const shape = d.kind === "datastore" ? `[(${d.to})]` : `["${d.to}"]`;
        lines.push(`  ${dn}${shape}`);
      }
      const arrow = d.required ? "-->" : "-.->";
      lines.push(`  ${id(r.repo)} ${arrow}|"${d.via}"| ${dn}`);
    }
  }
  for (const l of links) {
    const arrow = l.kind === "runtime-coupled" ? "-->" : l.kind === "co-deployed" ? "==>" : "-.->";
    lines.push(`  ${id(l.from)} ${arrow}|"${l.kind}"| ${id(l.to)}`);
  }
  lines.push("  %% solid = required runtime path; dashed = optional/inferred; ==> = co-deployed");
  return lines.join("\n");
}

function buildSummary(
  repos: RepoDeployment[],
  links: DeploymentReport["crossRepoLinks"],
  strong: number,
  multiRepo: boolean,
  confidence: Confidence,
  freshness: FreshnessStatus,
): string {
  const totalSignals = repos.reduce((n, r) => n + r.signals.length, 0);
  const repoModels = repos.map((r) => `${r.repo}: ${r.model}`).join("; ");
  let s = `Deployment report across ${repos.length} repo(s) from ${totalSignals} detected signal(s). ${repoModels}. `;
  if (multiRepo) {
    s += links.length
      ? `${links.length} inferred cross-repo deploy link(s) — these are HINTS, not a verified production topology. `
      : "No cross-repo deploy coupling inferred. ";
  }
  if (strong === 0) s += "No container/orchestration/CI config was found, so production deployment is UNKNOWN from source. ";
  s += `Overall confidence ${confidence}, freshness ${freshness}. This describes what the CONFIG says — the live production deployment (replicas, cluster, scaling) is not observable and is reported as unknown.`;
  return s;
}

function dedupeUnknowns(us: KnownUnknown[]): KnownUnknown[] {
  const seen = new Set<string>();
  return us.filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)));
}
function dedupeCommands(cs: { category: "build" | "run" | "deploy" | "other"; command: string; source: string }[]) {
  const seen = new Set<string>();
  return cs.filter((c) => (seen.has(c.command) ? false : (seen.add(c.command), true))).slice(0, 30);
}
