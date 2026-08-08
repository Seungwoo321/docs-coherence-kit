/**
 * dck-scan 스킬의 엔트리 — 결정 단계.
 *
 * 등록된 축 중 스크립트를 가진 활성 축을 전부 자식 프로세스로 돌려 scan.json 에 모은다.
 * 판단이 필요한 축(judgment·hybrid 의 계약 쪽)은 여기서 돌지 않고 awaiting_verdicts 로만 오른다 —
 * 값싼 결정 검사가 먼저 끝나고 그 결과가 통과일 때만 서브에이전트를 띄우기 때문이다.
 *
 * 한 축이 깨져도 스캔은 계속한다. 깨진 축은 status=crashed 로 남고, 그 사실이 사라지지 않도록
 * 종료 코드가 1 이 된다 — 검증 못 한 축을 두고 판단 단계로 넘어가지 않는다.
 *
 * 실행: node core/scan.mjs --config <dck.config.json> --repo <root> --run-id <id> [--out <dir>]
 * 종료 코드: 0 정상 · 1 게이트 차단(block finding 또는 crashed 축) · 2 스캔 자체가 못 돔
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, parseCliArgs } from './lib/config.mjs';
import { SEVERITIES, capSeverity, validateScanResult } from './lib/findings.mjs';
import { KIT_ROOT, loadAxes, parseAxisSelection } from './lib/manifest.mjs';

/** run-id 는 디렉토리 이름이 된다 — 경로를 벗어나는 값을 받지 않는다. */
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 자식 프로세스 stdout 상한. 축 하나가 큰 후보 목록을 낼 수 있다. */
const MAX_BUFFER = 64 * 1024 * 1024;

/** 크래시 사유에 붙일 stderr 꼬리 길이. 전문을 실으면 리포트가 로그가 된다. */
const STDERR_TAIL = 500;

export class ScanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScanError';
  }
}

/** 한 실행의 산출 경로. 병합기도 같은 배치를 봐야 하므로 여기서 한 번만 정한다. */
export function resolveRunPaths(outBase, runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new ScanError(`run-id 가 경로 조각으로 쓸 수 없는 값이다: ${JSON.stringify(runId)}`);
  }
  const runDir = join(outBase, runId);
  return {
    outBase,
    runDir,
    scanFile: join(runDir, 'scan.json'),
    verdictsDir: join(runDir, 'verdicts'),
    candidatesDir: join(runDir, 'candidates'),
    reportJsonFile: join(runDir, 'report.json'),
    reportMdFile: join(runDir, 'report.md'),
  };
}

export function countSeverities(findings) {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function tail(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed.length > STDERR_TAIL ? `…${trimmed.slice(-STDERR_TAIL)}` : trimmed;
}

function crashed(reason, stderr) {
  const detail = tail(stderr);
  return {
    status: 'crashed',
    reason: detail ? `${reason} — ${detail}` : reason,
    findings: [],
    candidates: [],
    stats: { files_scanned: 0, excluded: [], skipped: false },
  };
}

/**
 * 축 스크립트 하나를 돌리고 봉투를 검사한다.
 * 형식이 어긋난 stdout 은 크래시와 같이 다룬다 — 무엇을 보고했는지 알 수 없는 것은 결과가 아니다.
 */
export function runScriptAxis(axis, { configPath, repoRoot, spawn = spawnSync } = {}) {
  const result = spawn(process.execPath, [axis.scriptPath, '--config', configPath, '--repo', repoRoot], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });

  if (result.error) return crashed(`축 스크립트를 실행하지 못했다 (${result.error.message})`, result.stderr);
  if (result.signal) return crashed(`축 스크립트가 시그널로 끊겼다 (${result.signal})`, result.stderr);
  if (result.status !== 0) return crashed(`축 스크립트가 exit ${result.status} 로 끝났다`, result.stderr);

  let raw;
  try {
    raw = JSON.parse(result.stdout);
  } catch (error) {
    return crashed(`stdout 이 JSON 한 덩어리가 아니다 (${error.message})`, result.stderr);
  }

  const problems = validateScanResult(raw);
  if (problems.length) return crashed(`stdout 형식 위반: ${problems.join(' · ')}`, result.stderr);
  if (raw.axis !== axis.name) {
    return crashed(`봉투의 축 이름이 등록 이름과 다르다 (${raw.axis} ≠ ${axis.name})`, result.stderr);
  }
  // coverage.* 는 병합기만 낸다. 축이 자기 커버리지를 자칭하면 "검증 못 했다"를 스스로 덮을 수 있다.
  if (raw.findings.some((finding) => finding.code.startsWith('coverage.'))) {
    return crashed('축이 coverage.* 를 자칭했다 — 커버리지 판정은 병합기만 낸다', result.stderr);
  }

  return {
    status: 'ok',
    findings: raw.findings.map((finding) => ({
      ...finding,
      severity: capSeverity(finding.severity, axis.severity_cap),
    })),
    candidates: raw.candidates ?? [],
    stats: raw.stats,
  };
}

function skippedEntry(axis) {
  return {
    status: 'skipped',
    reason: axis.reason,
    findings: [],
    candidates: [],
    stats: { files_scanned: 0, excluded: [], skipped: true, skip_reason: axis.reason },
  };
}

/**
 * 스캔 한 번. 산출을 디스크에 쓰고 집계를 돌려준다.
 * write=false 면 파일을 쓰지 않는다(테스트·드라이런).
 */
export function runScan({
  configPath,
  repoRoot,
  runId,
  out,
  only = null,
  kitRoot = KIT_ROOT,
  spawn = spawnSync,
  write = true,
} = {}) {
  const context = loadConfig(configPath, { repoRoot });
  const axes = loadAxes(context.config, { kitRoot, checkExists: true, only });
  const outBase = out ? resolve(context.repoRoot, out) : context.outDir;
  const paths = resolveRunPaths(outBase, runId);

  if (write) {
    mkdirSync(paths.verdictsDir, { recursive: true });
    mkdirSync(paths.candidatesDir, { recursive: true });
  }

  const entries = {};
  const awaiting = [];

  for (const axis of axes) {
    const base = { kind: axis.kind, title: axis.title, severity_cap: axis.severity_cap };

    if (axis.state === 'skipped') {
      entries[axis.name] = { ...base, ...skippedEntry(axis) };
      continue;
    }

    let ran = null;
    if (axis.scriptPath) {
      ran = runScriptAxis(axis, { configPath: context.configPath, repoRoot: context.repoRoot, spawn });
      entries[axis.name] = { ...base, ...ran };
    }

    // 계약을 가진 활성 축은 판단 단계의 대기 목록에 오른다. 스크립트가 깨졌으면 후보가
    // 없으므로 대기 목록에도 올리지 않는다 — 병합기가 그 축을 커버리지 미달로 잡는다.
    if (!axis.contractPath || (ran && ran.status !== 'ok')) continue;

    const candidatesFile = ran ? join(paths.candidatesDir, `${axis.name}.json`) : null;
    if (write && candidatesFile) {
      writeFileSync(candidatesFile, `${JSON.stringify(ran.candidates, null, 2)}\n`);
    }
    awaiting.push({
      axis: axis.name,
      kind: axis.kind,
      title: axis.title,
      contract: axis.contractPath,
      candidates_file: candidatesFile,
      candidates: ran ? ran.candidates.length : null,
      verdict_file: join(paths.verdictsDir, `${axis.name}.json`),
    });
  }

  const findings = Object.values(entries).flatMap((entry) => entry.findings);
  const severities = countSeverities(findings);
  const states = Object.values(entries).map((entry) => entry.status);

  const scan = {
    run_id: runId,
    config: context.configPath,
    repo: context.repoRoot,
    run_dir: paths.runDir,
    axes: entries,
    awaiting_verdicts: awaiting,
    summary: {
      ...severities,
      findings: findings.length,
      ok: states.filter((state) => state === 'ok').length,
      crashed: states.filter((state) => state === 'crashed').length,
      skipped: states.filter((state) => state === 'skipped').length,
      awaiting: awaiting.length,
    },
  };

  if (write) writeFileSync(paths.scanFile, `${JSON.stringify(scan, null, 2)}\n`);

  return { scan, paths, context, axes };
}

/** 결정 게이트: 차단급 지적이 있거나 축이 깨졌으면 판단 단계로 넘어가지 않는다. */
export function gateBlocked(scan) {
  return scan.summary.block > 0 || scan.summary.crashed > 0;
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseCliArgs(argv, {
      flags: ['config', 'repo', 'run-id', 'out', 'axes'],
      required: ['config', 'run-id'],
    });
  } catch (error) {
    process.stderr.write(`[dck-scan] ${error.message}\n`);
    return 2;
  }

  let scan;
  try {
    ({ scan } = runScan({
      configPath: args.config,
      repoRoot: args.repo,
      runId: args.runId,
      out: args.out,
      only: parseAxisSelection(args.axes),
    }));
  } catch (error) {
    process.stderr.write(`[dck-scan] ${error?.message ?? error}\n`);
    return 2;
  }

  process.stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
  return gateBlocked(scan) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
