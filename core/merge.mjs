/**
 * dck-merge 스킬의 엔트리 — 병합·판정.
 *
 * 결과를 만든 쪽이 자기 결과를 채점하지 않는다. 병합기는 축이 쓴 파일을 읽되 축의 자기 신고를
 * 믿지 않는다: 기대 축은 매니페스트에서 다시 세고(scan.json 을 권위로 삼지 않는다), 강등 표식은
 * 떼어내며, 심각도는 등록된 severity_cap 으로 자른다. 강등은 CLI 인자로만 들어온다.
 *
 * 실행: node core/merge.mjs --config <path> --repo <root> --run-id <id> [--out <dir>] [--waive <code>]…
 * 종료 코드: 0 pass · 1 fail(차단급 존재) · 2 병합 자체가 못 돔
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, parseCliArgs } from './lib/config.mjs';
import { SEVERITIES, capSeverity, foldFindings, validateFinding } from './lib/findings.mjs';
import { KIT_ROOT, loadAxes, parseAxisSelection } from './lib/manifest.mjs';
import { countSeverities, resolveRunPaths } from './scan.mjs';

/**
 * 축이 자기 판정을 낮추려고 붙일 수 있는 표식. 읽는 순간 떼고, 뗀 횟수는 리포트에 남는다 —
 * 조용히 지우면 우회 시도 자체가 보이지 않는다. found_by 도 여기 있다: 누가 함께 찾았는지는
 * 병합기가 접으면서 채우는 값이라 축이 자칭할 수 없다.
 */
export const SELF_DEMOTION_KEYS = ['_demoted', 'demoted', '_waived', 'waived', 'suppressed', 'severity_cap', 'found_by'];

export class MergeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MergeError';
  }
}

/** 리포트에 싣는 경로. 검사 대상 레포 안이면 상대, 키트 안이면 `<kit>/` 로 줄여 읽기 쉽게 둔다. */
function displayPath(path, repoRoot, kitRoot = KIT_ROOT) {
  const rel = relative(repoRoot, path);
  if (rel && !rel.startsWith('..')) return rel;
  const fromKit = relative(kitRoot, path);
  if (fromKit && !fromKit.startsWith('..')) return `<kit>/${fromKit}`;
  return path;
}

function coverageFinding({ axis, code, message, file, line }) {
  const finding = {
    axis,
    severity: 'block',
    code,
    message,
    locations: [line ? { file, line } : { file }],
  };
  const problems = validateFinding(finding);
  if (problems.length) throw new MergeError(`커버리지 finding 형식 위반: ${problems.join(' · ')}`);
  return finding;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 축이 쓴 finding 에서 자기 신고를 떼어낸다. 뗀 키 목록도 같이 돌려준다. */
export function stripSelfReport(finding) {
  if (finding === null || typeof finding !== 'object' || Array.isArray(finding)) {
    return { finding, stripped: [] };
  }
  const stripped = [];
  const clean = {};
  for (const [key, value] of Object.entries(finding)) {
    if (SELF_DEMOTION_KEYS.includes(key)) {
      stripped.push(key);
      continue;
    }
    clean[key] = value;
  }
  return { finding: clean, stripped };
}

/**
 * verdict 파일 하나를 읽는다. 파일명이 축 이름이다 — 한 파일이 여러 축을 자칭하지 못한다.
 * 형식이 어긋나면 그 축의 findings 를 통째로 버린다. 무엇을 보고했는지 알 수 없는 것은 결과가 아니다.
 */
export function readVerdict(path, { axisName, codeNamespaces = [] } = {}) {
  let raw;
  try {
    raw = readJson(path);
  } catch (error) {
    return { status: 'invalid', reason: `verdict 를 JSON 으로 읽지 못했다 (${error.message})`, findings: [] };
  }
  if (!Array.isArray(raw)) {
    return { status: 'invalid', reason: 'verdict 는 findings 봉투의 배열이어야 한다', findings: [] };
  }

  const problems = [];
  const findings = [];
  let stripped = 0;

  raw.forEach((entry, i) => {
    const { finding, stripped: removed } = stripSelfReport(entry);
    if (removed.length) stripped += 1;

    const violations = validateFinding(finding, { codeNamespaces });
    if (violations.length) {
      problems.push(`[${i}] ${violations.join(' · ')}`);
      return;
    }
    if (finding.axis !== axisName) {
      problems.push(`[${i}] axis 가 파일명과 다르다 (${finding.axis} ≠ ${axisName})`);
      return;
    }
    if (finding.code.startsWith('coverage.')) {
      problems.push(`[${i}] 축이 coverage.* 를 자칭했다 — 커버리지 판정은 병합기만 낸다`);
      return;
    }
    findings.push(finding);
  });

  if (problems.length) {
    return { status: 'invalid', reason: `형식 위반 ${problems.length}건: ${problems.join(' / ')}`, findings: [], stripped };
  }
  return { status: 'ok', findings, stripped };
}

function readScan(scanFile) {
  let raw;
  try {
    raw = readJson(scanFile);
  } catch (error) {
    return { status: 'missing', reason: `scan.json 을 읽지 못했다 (${error.message})`, axes: {} };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.axes !== 'object') {
    return { status: 'invalid', reason: 'scan.json 형식 위반 — axes 를 찾을 수 없다', axes: {} };
  }
  return { status: 'ok', axes: raw.axes ?? {} };
}

/** --waive 값은 `<code>` 또는 `code=<code>` 둘 다 받는다. */
export function normalizeWaivers(values = []) {
  const codes = values.map((value) => (value.startsWith('code=') ? value.slice('code='.length) : value).trim());
  const forged = codes.filter((code) => code.startsWith('coverage.'));
  if (forged.length) {
    throw new MergeError(
      `coverage.* 는 강등할 수 없다 (${forged.join(' · ')}) — 검증 못 한 축을 통과로 바꾸는 것이 이 게이트가 막는 바로 그것이다`,
    );
  }
  const empty = codes.filter((code) => code.length === 0);
  if (empty.length) throw new MergeError('--waive 에 빈 코드가 들어왔다');
  return [...new Set(codes)];
}

/**
 * 병합 한 번. report.json / report.md 를 쓰고 리포트를 돌려준다.
 * write=false 면 파일을 쓰지 않는다.
 */
export function runMerge({
  configPath,
  repoRoot,
  runId,
  out,
  waive = [],
  only = null,
  kitRoot = KIT_ROOT,
  write = true,
} = {}) {
  const waivers = normalizeWaivers(waive);
  const context = loadConfig(configPath, { repoRoot });
  const axes = loadAxes(context.config, { kitRoot, only });
  const outBase = out ? resolve(context.repoRoot, out) : context.outDir;
  const paths = resolveRunPaths(outBase, runId);

  const scan = readScan(paths.scanFile);
  const codeNamespaces = axes.map((axis) => axis.name);

  let verdictFiles = [];
  try {
    verdictFiles = readdirSync(paths.verdictsDir).filter((name) => extname(name) === '.json');
  } catch {
    verdictFiles = [];
  }
  const verdictByAxis = new Map(verdictFiles.map((name) => [basename(name, '.json'), join(paths.verdictsDir, name)]));

  const report = {};
  const collected = [];
  const coverage = [];

  for (const axis of axes) {
    const manifestPath = displayPath(axis.source, context.repoRoot, kitRoot);
    const active = axis.state === 'active';
    const entry = {
      title: axis.title,
      kind: axis.kind,
      severity_cap: axis.severity_cap,
      state: axis.state,
      script: active && axis.scriptPath ? 'missing' : 'n/a',
      contract: active && axis.contractPath ? 'missing' : 'n/a',
      findings: 0,
      stripped_self_reports: 0,
    };
    if (axis.state === 'skipped') entry.reason = axis.reason;

    // 1. 스크립트 쪽 — scan.json 이 권위가 아니라 매니페스트가 권위다. 등록됐는데 결과가 없으면 차단.
    const scanned = scan.axes[axis.name];
    if (axis.state === 'active' && axis.scriptPath) {
      if (!scanned || scanned.status !== 'ok') {
        entry.script = scanned?.status === 'crashed' ? 'crashed' : 'missing';
        entry.script_reason = scanned?.reason ?? scan.reason ?? 'scan.json 에 이 축의 결과가 없다';
        coverage.push(
          coverageFinding({
            axis: axis.name,
            code: 'coverage.missing',
            message: `축 "${axis.name}" 의 스크립트 결과가 없다 — ${entry.script_reason}. 검증 불가는 통과가 아니다.`,
            file: manifestPath,
          }),
        );
      } else {
        entry.script = 'ok';
        entry.stats = scanned.stats;
        for (const finding of scanned.findings) {
          collected.push({ ...finding, severity: capSeverity(finding.severity, axis.severity_cap) });
        }
      }
    }

    // 2. 계약 쪽 — 활성 축이 계약을 가졌으면 verdict 가 있어야 한다.
    if (axis.state === 'active' && axis.contractPath) {
      const verdictPath = verdictByAxis.get(axis.name);
      if (!verdictPath) {
        entry.contract = 'missing';
        entry.contract_reason = `verdict 파일이 없다 (${displayPath(paths.verdictsDir, context.repoRoot, kitRoot)}/${axis.name}.json)`;
        coverage.push(
          coverageFinding({
            axis: axis.name,
            code: 'coverage.missing',
            message: `축 "${axis.name}" 의 판정 결과가 없다 — ${entry.contract_reason}. 검증 불가는 통과가 아니다.`,
            file: manifestPath,
          }),
        );
      } else {
        const verdict = readVerdict(verdictPath, { axisName: axis.name, codeNamespaces });
        entry.stripped_self_reports = verdict.stripped ?? 0;
        if (verdict.status !== 'ok') {
          entry.contract = 'invalid';
          entry.contract_reason = verdict.reason;
          coverage.push(
            coverageFinding({
              axis: axis.name,
              code: 'coverage.invalid-verdict',
              message: `축 "${axis.name}" 의 verdict 를 읽을 수 없다 — ${verdict.reason}`,
              file: displayPath(verdictPath, context.repoRoot, kitRoot),
            }),
          );
        } else {
          entry.contract = 'ok';
          for (const finding of verdict.findings) {
            collected.push({ ...finding, severity: capSeverity(finding.severity, axis.severity_cap) });
          }
        }
      }
    }

    // 활성 계약 축이 쓴 verdict 만 소비한다. 남은 것은 돌지 않아야 할 축이 낸 결과다.
    if (axis.state === 'active' && axis.contractPath) verdictByAxis.delete(axis.name);
    report[axis.name] = entry;
  }

  // 3. 등록되지 않았거나 건너뛴 축의 verdict — 돌지 않아야 할 축이 결과를 밀어 넣은 것이다.
  for (const [name, verdictPath] of verdictByAxis) {
    const registered = axes.find((axis) => axis.name === name);
    let reason;
    if (!registered) reason = `등록되지 않은 축 이름의 verdict 다 (${name})`;
    else if (registered.state === 'skipped') reason = `축 "${name}" 은 ${registered.reason} — 돌지 않은 축이 verdict 를 냈다`;
    else reason = `축 "${name}" 은 판단 계약이 없는 ${registered.kind} 축이다 — 판정할 계약이 없는 축이 verdict 를 냈다`;
    coverage.push(
      coverageFinding({
        axis: registered ? name : 'coverage',
        code: 'coverage.unexpected-verdict',
        message: `${reason}. 그 판정은 반영하지 않는다.`,
        file: displayPath(verdictPath, context.repoRoot, kitRoot),
      }),
    );
    if (registered) report[name].contract_reason = reason;
  }

  // 4. 접기 → 강등. coverage.* 는 접지 않는다(축마다 별개 사실이라 접으면 "아무것도 검증 안 됨"이
  //    "여러 축이 함께 확인함"으로 뒤집힌다). 강등은 CLI 로 들어온 코드에만 적용한다.
  const folded = foldFindings([...collected, ...coverage], { codeNamespaces });
  const applied = new Map(waivers.map((code) => [code, 0]));
  const findings = folded.map((finding) => {
    if (!applied.has(finding.code)) return finding;
    applied.set(finding.code, applied.get(finding.code) + 1);
    return { ...finding, severity: 'info' };
  });

  for (const finding of findings) {
    for (const name of finding.found_by) {
      if (report[name]) report[name].findings += 1;
    }
  }

  const severities = countSeverities(findings);
  const outcome = severities.block > 0 ? 'fail' : 'pass';
  const reportJson = {
    run_id: runId,
    config: context.configPath,
    repo: context.repoRoot,
    run_dir: paths.runDir,
    outcome,
    scan: scan.status === 'ok' ? { status: 'ok' } : { status: scan.status, reason: scan.reason },
    axes: report,
    findings,
    waivers: waivers.map((code) => ({ code, applied: applied.get(code) })),
    summary: {
      ...severities,
      findings: findings.length,
      axes_expected: axes.length,
      axes_skipped: axes.filter((axis) => axis.state === 'skipped').length,
      coverage_blocks: coverage.length,
    },
  };

  const markdown = renderReport(reportJson);
  if (write) {
    writeFileSync(paths.reportJsonFile, `${JSON.stringify(reportJson, null, 2)}\n`);
    writeFileSync(paths.reportMdFile, markdown);
  }

  return { report: reportJson, markdown, paths, context, axes };
}

/* ------------------------------------------------------------ 사람용 요약 */

const OUTCOME_LABEL = { pass: '통과', fail: '차단' };
const SEVERITY_LABEL = { block: '차단', warn: '경고', info: '참고' };
const SOURCE_LABEL = {
  ok: '완주',
  crashed: '크래시',
  missing: '결과 없음',
  invalid: '형식 위반',
  'n/a': '—',
};

function cell(text) {
  return String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ');
}

function locationLabel(finding) {
  const [first, ...rest] = finding.locations;
  const head = first.line ? `${first.file}:${first.line}` : first.file;
  return rest.length ? `${head} 외 ${rest.length}곳` : head;
}

export function renderReport(report) {
  const { summary } = report;
  const lines = [];

  lines.push(`# 정합성 리포트 — ${report.run_id}`, '');
  lines.push(
    `**${OUTCOME_LABEL[report.outcome]}** · 차단 ${summary.block} · 경고 ${summary.warn} · 참고 ${summary.info}`,
    '',
  );
  lines.push(
    `등록 축 ${summary.axes_expected}개 중 ${summary.axes_skipped}개는 사유와 함께 건너뛰었고, 커버리지 차단은 ${summary.coverage_blocks}건이다.`,
    '',
  );
  if (report.scan.status !== 'ok') lines.push(`> scan.json: ${report.scan.reason}`, '');

  lines.push('## 축', '', '| 축 | 종류 | 상태 | 스크립트 | 판정 | 지적 |', '|---|---|---|---|---|---|');
  for (const [name, axis] of Object.entries(report.axes)) {
    const state = axis.state === 'skipped' ? `건너뜀 — ${axis.reason}` : '활성';
    lines.push(
      `| \`${name}\` | ${cell(axis.kind)} | ${cell(state)} | ${SOURCE_LABEL[axis.script]} | ${SOURCE_LABEL[axis.contract]} | ${axis.findings} |`,
    );
  }
  lines.push('');

  const reasons = Object.entries(report.axes).filter(([, axis]) => axis.script_reason || axis.contract_reason);
  if (reasons.length) {
    lines.push('### 결과가 없는 축', '');
    for (const [name, axis] of reasons) {
      for (const reason of [axis.script_reason, axis.contract_reason].filter(Boolean)) {
        lines.push(`- \`${name}\` — ${reason}`);
      }
    }
    lines.push('');
  }

  lines.push('## 지적', '');
  if (report.findings.length === 0) {
    lines.push('없음.', '');
  } else {
    lines.push('| 심각도 | 코드 | 위치 | 내용 | 찾은 축 |', '|---|---|---|---|---|');
    const order = [...SEVERITIES].reverse();
    const sorted = [...report.findings].sort(
      (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.code.localeCompare(b.code),
    );
    for (const finding of sorted) {
      lines.push(
        `| ${SEVERITY_LABEL[finding.severity]} | \`${finding.code}\` | ${cell(locationLabel(finding))} | ${cell(finding.message)} | ${finding.found_by.join(' · ')} |`,
      );
    }
    lines.push('');
  }

  const stripped = Object.entries(report.axes).filter(([, axis]) => axis.stripped_self_reports > 0);
  if (stripped.length) {
    lines.push('## 떼어낸 자기 신고', '');
    for (const [name, axis] of stripped) {
      lines.push(`- \`${name}\` — ${axis.stripped_self_reports}건에서 강등·발견자 표식을 떼고 판정했다.`);
    }
    lines.push('');
  }

  if (report.waivers.length) {
    lines.push('## 강등(CLI)', '');
    for (const waiver of report.waivers) lines.push(`- \`${waiver.code}\` — ${waiver.applied}건을 참고로 내렸다.`);
    lines.push('');
  }

  return lines.join('\n');
}

/* --------------------------------------------------------------------- CLI */

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseCliArgs(argv, {
      flags: ['config', 'repo', 'run-id', 'out', 'axes'],
      repeatable: ['waive'],
      required: ['config', 'run-id'],
    });
  } catch (error) {
    process.stderr.write(`[dck-merge] ${error.message}\n`);
    return 2;
  }

  let result;
  try {
    result = runMerge({
      configPath: args.config,
      repoRoot: args.repo,
      runId: args.runId,
      out: args.out,
      waive: args.waive,
      only: parseAxisSelection(args.axes),
    });
  } catch (error) {
    process.stderr.write(`[dck-merge] ${error?.message ?? error}\n`);
    return 2;
  }

  process.stdout.write(result.markdown.endsWith('\n') ? result.markdown : `${result.markdown}\n`);
  return result.report.outcome === 'fail' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
