#!/usr/bin/env tsx
/**
 * CLI-Docker tier runner.
 *
 * Globs `tests/cli-docker/test-*.ts`, runs each in its own `tsx` process
 * (sequentially — they share host port 52077 and a single CLI image), and
 * merges the coverage output emitted by each test's `withCliDocker` call
 * into a single `coverage/cli-docker/coverage-final.json`.
 *
 * Filter: pass `--grep <substring>` to run only test files whose basename
 * (without the `test-` prefix and `.ts` suffix) contains the substring.
 *
 * After every test passes, the runner enforces a 100% coverage gate by
 * collecting every per-invocation raw v8 coverage file the harness wrote
 * to `coverage/cli-docker/<container>/v8-raw/<id>/`, rewriting the URL
 * field of each entry from the in-container path (`file:///app/dist/...`)
 * to the matching host path (`file://<repoRoot>/dist/...`), and then
 * invoking `c8 check-coverage` against the merged dir. The gate config
 * (thresholds, includes, reporters) lives in `tests/cli-docker/.c8rc.json`
 * so c8's CLI flags don't drift from what's documented. The HTML report
 * is written to `coverage/cli-docker/html/` for local debugging; source
 * maps in the host's `dist/` remap dist/cli.js → src/cli.ts in the report.
 *
 * On gate failure run.ts exits non-zero and surfaces c8's stdout/stderr
 * verbatim — no custom formatting, so the standard
 *   "ERROR: Coverage for lines (XX%) does not meet threshold (100%)"
 * line is what the user sees.
 *
 * This tier is intentionally opt-in. It is NOT wired into `pretest` or
 * `check`; invoke via `npm run test:cli-docker`.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const coverageRoot = resolve(repoRoot, "coverage", "cli-docker");

function parseArgs(argv: string[]): { grep: string | null } {
  let grep: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--grep") {
      grep = argv[++i] ?? null;
    } else if (a.startsWith("--grep=")) {
      grep = a.slice("--grep=".length);
    }
  }
  return { grep };
}

/**
 * Turn a discovered test path into the label used for filtering and for the
 * progress line. Two layouts are supported in parallel:
 *   - `test-<name>.ts`                 → label = "<name>"
 *   - `scenarios/<name>.spec.ts`       → label = "<name>"
 * Both live under `tests/cli-docker/`, both use the `withCliDocker` harness,
 * and both share the same `--grep <substring>` filter.
 */
function labelFor(relPath: string): string {
  if (relPath.startsWith("scenarios/")) {
    return relPath.replace(/^scenarios\//, "").replace(/\.spec\.ts$/, "");
  }
  return relPath.replace(/^test-/, "").replace(/\.ts$/, "");
}

function listTests(grep: string | null): string[] {
  const topLevel = readdirSync(here)
    .filter((f) => f.startsWith("test-") && f.endsWith(".ts"))
    .sort();
  // Also pick up Playwright-style specs under scenarios/<name>.spec.ts so the
  // directory-per-feature layout coexists with the historical flat layout.
  // The files themselves are self-executing tsx scripts that call into the
  // `withCliDocker` harness — no extra runner is introduced.
  const scenariosDir = join(here, "scenarios");
  const scenarioFiles = existsSync(scenariosDir)
    ? readdirSync(scenariosDir)
        .filter((f) => f.endsWith(".spec.ts"))
        .map((f) => `scenarios/${f}`)
        .sort()
    : [];
  const files = [...topLevel, ...scenarioFiles];
  if (!grep) return files;
  return files.filter((f) => labelFor(f).includes(grep));
}

/**
 * Walk a directory and collect every `coverage-final.json` under it.
 */
function findCoverageFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(cur, name);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        stack.push(p);
      } else if (name === "coverage-final.json") {
        out.push(p);
      }
    }
  }
  return out;
}

/**
 * Merge multiple istanbul coverage-final.json files produced by per-
 * invocation c8 runs into a single map keyed by absolute source path.
 *
 * c8 is backed by V8's native coverage, which has a subtle quirk for
 * branches: per-run `branchMap` only lists branches that were NOT taken
 * in that run. When a branch IS taken its hits live on the enclosing
 * block's counter, not as its own entry — so the branchMap shrinks and
 * the taken branch simply disappears from the per-run output.
 *
 * That means a naive "sum hits by location" merge gets branch coverage
 * badly wrong: a branch that's reported with hits=[0] in run A and is
 * absent entirely in run B (because B executed it) sums to [0] and
 * looks uncovered. The correct semantics is union: if ANY run executed
 * the branch (hits>0, or the branch was absent from that run's map
 * while the file itself was loaded) the branch is covered.
 *
 * We also re-key by source location (line/column/type) rather than the
 * per-run integer IDs, since c8 assigns local IDs in file-appearance
 * order and those diverge between runs.
 */
function mergeCoverage(files: string[]): Record<string, unknown> {
  const acc: Record<string, any> = {};
  // For each file, track the set of runs in which the file was loaded
  // (appeared at all in the run's coverage). We need this to tell the
  // difference between "run didn't cover this branch" (branch present
  // with hits=[0]) and "run executed this branch" (branch absent).
  const fileRunCount: Record<string, number> = {};
  // For each file -> branchKey -> how many runs LISTED the branch as
  // unhit. A branch is uncovered in the final merge only when every
  // run that loaded the file listed it with hits=[0].
  const branchUnhitRuns: Record<string, Record<string, number>> = {};

  for (const f of files) {
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(readFileSync(f, "utf8"));
    } catch (err) {
      console.warn(`[cli-docker] skipping unreadable ${f}: ${(err as Error).message}`);
      continue;
    }
    for (const [file, cov] of Object.entries(parsed)) {
      fileRunCount[file] = (fileRunCount[file] ?? 0) + 1;
      const perFile = (branchUnhitRuns[file] ??= {});
      for (const [bid, bm] of Object.entries((cov as any).branchMap ?? {})) {
        const hits = ((cov as any).b?.[bid] as number[]) ?? [];
        if (hits.every((h) => (h ?? 0) === 0)) {
          perFile[branchKey(bm as any)] = (perFile[branchKey(bm as any)] ?? 0) + 1;
        }
      }

      const existing = acc[file];
      if (!existing) {
        acc[file] = cov;
        continue;
      }
      acc[file] = mergeFileCoverage(existing, cov);
    }
  }

  // Final pass:
  //   1. Promote every branch that was seen in at least one run where it
  //      was EXECUTED (i.e., listed-unhit-count < loaded-file-count) to
  //      hits=[1]. This corrects for v8-to-istanbul's "unhit-only" branch
  //      reporting and is what yields accurate branch coverage.
  //   2. Renumber every file's maps so IDs are 0..N and line up 1:1 with
  //      the hit tables.
  for (const file of Object.keys(acc)) {
    const normalized = acc[file].__keyedByLoc
      ? acc[file]
      : normalizeFileCoverage(acc[file]);
    const totalRuns = fileRunCount[file] ?? 0;
    const perFileUnhit = branchUnhitRuns[file] ?? {};
    for (const key of Object.keys(normalized.b as Record<string, number[]>)) {
      const unhitIn = perFileUnhit[key] ?? 0;
      if (unhitIn < totalRuns) {
        // Some run executed this branch (absent from its unhit list).
        const arr = normalized.b[key] as number[];
        for (let i = 0; i < arr.length; i++) {
          if (!arr[i]) arr[i] = 1;
        }
      }
    }
    acc[file] = renumberFileCoverage(normalized);
  }
  return acc;
}

function stmtKey(loc: { start: { line: number; column: number }; end: { line: number; column: number } }): string {
  return `s:${loc.start.line}:${loc.start.column}:${loc.end.line}:${loc.end.column}`;
}

function fnKey(fn: { name?: string; decl: { start: { line: number; column: number } } }): string {
  return `f:${fn.name ?? ""}:${fn.decl.start.line}:${fn.decl.start.column}`;
}

function branchKey(bm: { type?: string; line?: number; loc?: { start: { line: number; column: number } } }): string {
  const line = bm.line ?? bm.loc?.start.line ?? 0;
  const col = bm.loc?.start.column ?? 0;
  return `b:${bm.type ?? ""}:${line}:${col}`;
}

/**
 * Accumulate the metadata + hit counts from `cov` into `acc`. Both args
 * use string keys during accumulation — final integer IDs are assigned
 * in a separate pass.
 */
function mergeFileCoverage(acc: any, cov: any): any {
  if (!acc || typeof acc !== "object") return cov;
  if (!cov || typeof cov !== "object") return acc;

  // Normalize the accumulator once: first call receives a raw per-run
  // coverage object keyed by integer IDs. After normalization the
  // accumulator carries keyed-by-location entries so subsequent merges
  // are straightforward.
  const normAcc = acc.__keyedByLoc ? acc : normalizeFileCoverage(acc);
  const normCov = normalizeFileCoverage(cov);

  for (const [k, v] of Object.entries(normCov.s as Record<string, number>)) {
    normAcc.s[k] = (normAcc.s[k] ?? 0) + (v ?? 0);
    if (!normAcc.statementMap[k]) normAcc.statementMap[k] = (normCov.statementMap as any)[k];
  }
  for (const [k, v] of Object.entries(normCov.f as Record<string, number>)) {
    normAcc.f[k] = (normAcc.f[k] ?? 0) + (v ?? 0);
    if (!normAcc.fnMap[k]) normAcc.fnMap[k] = (normCov.fnMap as any)[k];
  }
  for (const [k, v] of Object.entries(normCov.b as Record<string, number[]>)) {
    const av: number[] = normAcc.b[k] ?? [];
    const len = Math.max(av.length, v.length);
    const merged: number[] = [];
    for (let i = 0; i < len; i++) merged.push((av[i] ?? 0) + (v[i] ?? 0));
    normAcc.b[k] = merged;
    if (!normAcc.branchMap[k]) normAcc.branchMap[k] = (normCov.branchMap as any)[k];
  }
  return normAcc;
}

function normalizeFileCoverage(raw: any): any {
  if (raw.__keyedByLoc) return raw;
  const out: any = {
    path: raw.path,
    statementMap: {},
    fnMap: {},
    branchMap: {},
    s: {},
    f: {},
    b: {},
    __keyedByLoc: true,
  };
  if (raw.all !== undefined) out.all = raw.all;
  if (raw.hash !== undefined) out.hash = raw.hash;
  for (const [id, sm] of Object.entries(raw.statementMap ?? {})) {
    const key = stmtKey(sm as any);
    out.statementMap[key] = sm;
    out.s[key] = (raw.s?.[id] as number) ?? 0;
  }
  for (const [id, fm] of Object.entries(raw.fnMap ?? {})) {
    const key = fnKey(fm as any);
    out.fnMap[key] = fm;
    out.f[key] = (raw.f?.[id] as number) ?? 0;
  }
  for (const [id, bm] of Object.entries(raw.branchMap ?? {})) {
    const key = branchKey(bm as any);
    out.branchMap[key] = bm;
    out.b[key] = (raw.b?.[id] as number[]) ?? [];
  }
  return out;
}

function renumberFileCoverage(file: any): any {
  if (!file?.__keyedByLoc) return file;
  const out: any = { path: file.path, statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {} };
  if (file.all !== undefined) out.all = file.all;
  if (file.hash !== undefined) out.hash = file.hash;
  let i = 0;
  for (const key of Object.keys(file.statementMap)) {
    const id = String(i++);
    out.statementMap[id] = file.statementMap[key];
    out.s[id] = file.s[key] ?? 0;
  }
  i = 0;
  for (const key of Object.keys(file.fnMap)) {
    const id = String(i++);
    out.fnMap[id] = file.fnMap[key];
    out.f[id] = file.f[key] ?? 0;
  }
  i = 0;
  for (const key of Object.keys(file.branchMap)) {
    const id = String(i++);
    out.branchMap[id] = file.branchMap[key];
    out.b[id] = file.b[key] ?? [];
  }
  return out;
}

async function main(): Promise<void> {
  const { grep } = parseArgs(process.argv.slice(2));
  const files = listTests(grep);

  if (files.length === 0) {
    console.error(
      grep
        ? `No cli-docker tests matched --grep ${JSON.stringify(grep)}`
        : "No cli-docker tests found in tests/cli-docker/",
    );
    process.exit(1);
  }

  mkdirSync(coverageRoot, { recursive: true });

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  console.log(`Running ${files.length} cli-docker test(s)...\n`);

  for (const file of files) {
    const full = join(here, file);
    const label = labelFor(file);
    process.stdout.write(`  ${label} ... `);
    const start = Date.now();
    // Each test spawns its own docker container via withCliDocker.
    // Sequential on purpose — they all want host port 52077 by default
    // and share the same image build cache.
    const result = spawnSync("npx", ["tsx", full], {
      stdio: "pipe",
      encoding: "utf8",
      timeout: 180_000,
      env: process.env,
    });
    const ms = Date.now() - start;
    if (result.status === 0) {
      passed += 1;
      console.log(`ok (${ms}ms)`);
    } else {
      failed += 1;
      failures.push(file);
      console.log(`FAIL (${ms}ms, exit ${result.status ?? "?"})`);
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    }
  }

  // Merge whatever coverage the containers managed to emit (even for
  // failing runs — partial coverage is still useful for diagnostics).
  // Skip the merged top-level file we wrote on the previous run AND skip
  // anything under v8-raw/ (those are raw v8 dumps, not istanbul JSON).
  const covFiles = findCoverageFiles(coverageRoot).filter(
    (f) =>
      !f.endsWith(`${coverageRoot}/coverage-final.json`) &&
      !f.includes(`${sep}v8-raw${sep}`),
  );
  if (covFiles.length > 0) {
    const merged = mergeCoverage(covFiles);
    writeFileSync(
      join(coverageRoot, "coverage-final.json"),
      JSON.stringify(merged),
    );
    console.log(
      `\nMerged coverage from ${covFiles.length} file(s) → coverage/cli-docker/coverage-final.json`,
    );
  } else {
    console.log(
      `\nNo coverage-final.json files were produced under ${coverageRoot}.`,
    );
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failed:", failures.join(", "));
    process.exit(1);
  }

  // Tests all passed — enforce the 100% CLI coverage gate. We exec
  // `c8 check-coverage` against the raw v8 dumps the harness left in
  // coverage/cli-docker/<container>/v8-raw/ after rewriting in-container
  // paths to host paths.
  const gateExit = runCoverageGate();
  if (gateExit !== 0) {
    process.exit(gateExit);
  }
}

/**
 * Walk the per-container coverage subtrees, copy every raw v8 file into a
 * single dir, and rewrite each entry's `url` from the in-container path
 * (`file:///app/dist/...`) to the matching host path so that c8 on the
 * host can find the JS files (and their source maps) when computing
 * coverage. Returns the absolute path to the merged dir, or `null` if no
 * raw v8 files were found.
 */
function collectRewrittenV8(): string | null {
  if (!existsSync(coverageRoot)) return null;
  const merged = join(coverageRoot, ".v8-merged");
  rmSync(merged, { recursive: true, force: true });
  mkdirSync(merged, { recursive: true });

  const hostDistPrefix = pathToFileURL(join(repoRoot, "dist")).href; // file:///.../dist
  const containerDistPrefix = "file:///app/dist";

  let count = 0;
  const containerDirs = readdirSync(coverageRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("flockctl-cli-test-"))
    .map((e) => join(coverageRoot, e.name));

  for (const containerDir of containerDirs) {
    const v8Root = join(containerDir, "v8-raw");
    if (!existsSync(v8Root)) continue;
    const stack: string[] = [v8Root];
    while (stack.length) {
      const cur = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(cur);
      } catch {
        continue;
      }
      for (const name of entries) {
        const p = join(cur, name);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          stack.push(p);
          continue;
        }
        if (!name.endsWith(".json")) continue;
        let body: string;
        try {
          body = readFileSync(p, "utf8");
        } catch {
          continue;
        }
        let parsed: { result?: Array<{ url?: string }> };
        try {
          parsed = JSON.parse(body);
        } catch {
          continue;
        }
        if (!parsed || !Array.isArray(parsed.result)) continue;
        let rewrote = false;
        for (const entry of parsed.result) {
          if (typeof entry.url === "string" && entry.url.startsWith(containerDistPrefix)) {
            entry.url = hostDistPrefix + entry.url.slice(containerDistPrefix.length);
            rewrote = true;
          }
        }
        // Always write — even files with no /app/dist entries are harmless
        // (c8 will ignore them via the include filter), and skipping them
        // would only save IO. Keeping them avoids a divergence between
        // "what c8 sees" and "what the harness produced".
        const outName = `coverage-${count++}.json`;
        writeFileSync(join(merged, outName), JSON.stringify(parsed));
        if (!rewrote) {
          // Most node-internal entries (file:///node:... etc.) come through
          // here unchanged. That's fine.
        }
      }
    }
  }

  if (count === 0) return null;
  return merged;
}

/**
 * Runs `c8 check-coverage` on the merged v8 dir. Streams c8 output (which
 * already contains the standard "ERROR: Coverage for ..." lines) verbatim
 * to our stdio so the user sees exactly what c8 said. Returns c8's exit
 * code (0 on pass, non-zero on threshold miss or other error).
 */
function runCoverageGate(): number {
  const merged = collectRewrittenV8();
  if (!merged) {
    console.error(
      `\n[cli-docker] coverage gate: no raw v8 coverage files were found under ${coverageRoot}. ` +
        `Did the harness fail to copy /flockctl-home/v8-raw out of the containers?`,
    );
    return 1;
  }

  const htmlDir = join(coverageRoot, "html");
  mkdirSync(htmlDir, { recursive: true });

  // `c8 check-coverage` only enforces thresholds; it does NOT run the
  // configured reporters. So we run `c8 report` first to land the
  // text + html + json-summary outputs under coverage/cli-docker/html/,
  // then run `c8 check-coverage` to enforce the gate. cwd = repoRoot so
  // c8 resolves include patterns (`dist/cli.js`, `dist/cli-commands/**`)
  // against the actual host dist/ tree where the rewritten URLs point.
  // Source maps in <repoRoot>/dist/*.js.map remap dist/cli.js → src/cli.ts
  // in the HTML report (the threshold check itself runs against the
  // dist/ matches because c8's include filter sees the original URL).
  const configPath = join(here, ".c8rc.json");

  console.log(
    `\nGenerating c8 coverage report → ${htmlDir} (config: ${configPath})...`,
  );
  const reportResult = spawnSync(
    "npx",
    [
      "c8",
      "report",
      `--config=${configPath}`,
      `--temp-directory=${merged}`,
      `--reports-dir=${htmlDir}`,
    ],
    { stdio: "inherit", cwd: repoRoot, env: process.env },
  );
  if (reportResult.error) {
    console.error(
      `[cli-docker] failed to invoke c8 report: ${(reportResult.error as Error).message}`,
    );
    return 1;
  }

  console.log(`\nRunning c8 check-coverage gate (config: ${configPath})...`);
  const gateResult = spawnSync(
    "npx",
    [
      "c8",
      "check-coverage",
      `--config=${configPath}`,
      `--temp-directory=${merged}`,
    ],
    { stdio: "inherit", cwd: repoRoot, env: process.env },
  );
  if (gateResult.error) {
    console.error(
      `[cli-docker] failed to invoke c8 check-coverage: ${(gateResult.error as Error).message}`,
    );
    return 1;
  }
  return gateResult.status ?? 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
