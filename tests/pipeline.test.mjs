/**
 * 오케스트레이션 전 구간. 스캔 → (판정 verdict 주입) → 병합.
 *
 * 판정 단계는 서브에이전트가 하는 일이라 여기서는 그 산출물(verdict 파일)을 손으로 넣어
 * 스캐너·병합기가 계약대로 반응하는지만 본다. 팬아웃 규율 자체는 skills/dck-judge/SKILL.md 가 소유한다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runMerge } from '../core/merge.mjs';
import { gateBlocked, runScan } from '../core/scan.mjs';
import { fixture } from './helpers.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = fixture('pipeline', 'kit');
const CONFIG = fixture('pipeline', 'dck.config.json');

const scratch = resolve(REPO_ROOT, 'tmp');
mkdirSync(scratch, { recursive: true });
const workDir = mkdtempSync(join(scratch, 'pipeline-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

let runCounter = 0;

/** 스캔 한 번. 실행마다 다른 run-id 를 써 산출이 서로 덮이지 않는다. */
function scan({ config = CONFIG, kitRoot = KIT } = {}) {
  runCounter += 1;
  const runId = `r${runCounter}`;
  const result = runScan({ configPath: config, runId, out: workDir, kitRoot });
  return { ...result, runId };
}

function writeVerdict(paths, axis, findings) {
  writeFileSync(join(paths.verdictsDir, `${axis}.json`), JSON.stringify(findings, null, 2));
}

function merge({ runId, config = CONFIG, kitRoot = KIT, waive = [] }) {
  return runMerge({ configPath: config, runId, out: workDir, kitRoot, waive });
}

function findingsOf(report, code) {
  return report.findings.filter((finding) => finding.code === code);
}

describe('결정 검사가 먼저 끝나고, 통과일 때만 판단 단계로 넘어간다', () => {
  it('스캔은 스크립트를 가진 활성 축만 돌린다 — 판단 축은 대기 목록에만 오른다', () => {
    const { scan: result } = scan();

    // 스크립트를 실제로 돌린 축은 alpha·beta·capped 뿐이다.
    const ran = Object.entries(result.axes)
      .filter(([, entry]) => entry.status === 'ok')
      .map(([name]) => name);
    assert.deepEqual(ran.sort(), ['alpha', 'beta', 'capped']);

    // 스크립트가 없는 판단 축은 스캔 결과를 갖지 않는다. "0건 통과"로 읽히면 안 된다.
    assert.ok(!('gamma' in result.axes));
    // 건너뛴 축은 사유와 함께 남는다 — 목록에서 사라지지 않는다.
    assert.equal(result.axes.delta.status, 'skipped');
    assert.equal(result.axes.broken.status, 'skipped');

    assert.deepEqual(
      result.awaiting_verdicts.map((entry) => entry.axis),
      ['beta', 'gamma'],
    );
  });

  it('대기 목록이 축마다 계약·후보·verdict 경로를 지정해 준다 — 축이 경로를 짓지 않는다', () => {
    const { scan: result, paths } = scan();
    const beta = result.awaiting_verdicts.find((entry) => entry.axis === 'beta');
    const gamma = result.awaiting_verdicts.find((entry) => entry.axis === 'gamma');

    assert.equal(beta.contract, join(KIT, 'core', 'axes', 'beta', 'contract.md'));
    assert.equal(beta.candidates_file, join(paths.candidatesDir, 'beta.json'));
    assert.equal(beta.candidates, 1);
    assert.equal(beta.verdict_file, join(paths.verdictsDir, 'beta.json'));

    // 스크립트가 없는 축은 넘길 후보도 없다 — 없는 파일 경로를 지어내지 않는다.
    assert.equal(gamma.candidates_file, null);
    assert.equal(gamma.verdict_file, join(paths.verdictsDir, 'gamma.json'));
  });

  it('차단급이 없으면 게이트가 열린다 — 상한을 넘겨 신고한 심각도는 등록값으로 잘린다', () => {
    const { scan: result } = scan();
    const capped = result.axes.capped.findings[0];

    assert.equal(capped.severity, 'warn', 'severity_cap=warn 축의 block 신고는 warn 으로 잘린다');
    assert.equal(result.summary.block, 0);
    assert.equal(gateBlocked(result), false);
  });

  it('축이 크래시하면 스캔은 계속하되 게이트는 닫힌다 — 검증 못 한 축을 두고 넘어가지 않는다', () => {
    const { scan: result } = scan({ config: fixture('pipeline', 'dck.broken.config.json') });

    assert.equal(result.axes.broken.status, 'crashed');
    assert.match(result.axes.broken.reason, /exit 1/);
    assert.match(result.axes.broken.reason, /TypeError/, '크래시 사유에 축의 stderr 가 남는다');
    assert.equal(result.axes.alpha.status, 'ok', '한 축이 죽어도 나머지는 완주한다');

    assert.equal(gateBlocked(result), true);
    // 크래시한 축은 후보가 없으므로 팬아웃 대기 목록에도 오르지 않는다.
    assert.ok(!result.awaiting_verdicts.some((entry) => entry.axis === 'broken'));
  });
});

describe('축이 결과를 못 내면 커버리지로 차단한다', () => {
  it('기대 축의 verdict 가 없으면 그 축마다 coverage.missing 이 주입된다', () => {
    const { runId, paths } = scan();
    writeVerdict(paths, 'beta', []);
    // gamma 의 verdict 를 일부러 넣지 않는다 — 서브에이전트가 죽은 상황이다.

    const { report } = merge({ runId });
    const missing = findingsOf(report, 'coverage.missing');

    assert.equal(missing.length, 1);
    assert.equal(missing[0].axis, 'gamma');
    assert.equal(missing[0].severity, 'block');
    assert.match(missing[0].message, /검증 불가는 통과가 아니다/);
    assert.equal(report.outcome, 'fail');
    assert.equal(report.axes.gamma.contract, 'missing');
    assert.equal(report.axes.beta.contract, 'ok');
  });

  it('스크립트가 크래시한 축도 커버리지로 막힌다 — 0건 통과로 읽히지 않는다', () => {
    const config = fixture('pipeline', 'dck.broken.config.json');
    const { runId, paths } = scan({ config });
    writeVerdict(paths, 'beta', []);
    writeVerdict(paths, 'gamma', []);

    const { report } = merge({ runId, config });
    const missing = findingsOf(report, 'coverage.missing');

    assert.deepEqual(
      missing.map((finding) => finding.axis),
      ['broken'],
    );
    assert.equal(report.axes.broken.script, 'crashed');
    assert.equal(report.outcome, 'fail');
  });

  it('형식이 어긋난 verdict 는 그 축의 판정을 통째로 버리고 차단한다', () => {
    const { runId, paths } = scan();
    writeVerdict(paths, 'beta', []);
    // 파일명은 gamma 인데 봉투는 다른 축을 자칭한다 — 한 파일이 여러 축을 자칭하지 못한다.
    writeVerdict(paths, 'gamma', [
      {
        axis: 'alpha',
        severity: 'info',
        code: 'alpha.shared-defect',
        message: '남의 축 이름으로 낸 판정',
        locations: [{ file: 'docs/shared.md', line: 3 }],
      },
    ]);

    const { report } = merge({ runId });
    const invalid = findingsOf(report, 'coverage.invalid-verdict');

    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].axis, 'gamma');
    assert.match(invalid[0].message, /axis 가 파일명과 다르다/);
    assert.equal(report.axes.gamma.contract, 'invalid');
    // 버려진 판정은 findings 에 섞이지 않는다 — gamma 가 남기는 것은 커버리지 차단뿐이다.
    const shared = findingsOf(report, 'alpha.shared-defect');
    assert.deepEqual(shared[0].found_by, ['alpha']);
    assert.deepEqual(
      report.findings.filter((finding) => finding.found_by.includes('gamma')).map((f) => f.code),
      ['coverage.invalid-verdict'],
    );
    assert.equal(report.outcome, 'fail');
  });

  it('돌지 않아야 할 축이 verdict 를 밀어 넣으면 반영하지 않고 차단한다', () => {
    const { runId, paths } = scan();
    writeVerdict(paths, 'beta', []);
    writeVerdict(paths, 'gamma', []);
    writeVerdict(paths, 'delta', [
      {
        axis: 'delta',
        severity: 'info',
        code: 'delta.sneaked-in',
        message: '선언이 없어 건너뛴 축이 낸 판정',
        locations: [{ file: 'docs/shared.md', line: 3 }],
      },
    ]);

    const { report } = merge({ runId });
    const unexpected = findingsOf(report, 'coverage.unexpected-verdict');

    assert.equal(unexpected.length, 1);
    assert.equal(unexpected[0].axis, 'delta');
    assert.equal(findingsOf(report, 'delta.sneaked-in').length, 0);
  });

  it('coverage.* 는 접히지 않는다 — 축마다 별개 사실이다', () => {
    const config = fixture('pipeline', 'dck.broken.config.json');
    const { runId } = scan({ config });
    // beta·gamma·broken 셋 다 결과가 없는 상태로 병합한다.

    const { report } = merge({ runId, config });
    const missing = findingsOf(report, 'coverage.missing');

    assert.deepEqual(missing.map((finding) => finding.axis).sort(), ['beta', 'broken', 'gamma']);
    for (const finding of missing) assert.deepEqual(finding.found_by, [finding.axis]);
  });
});

describe('같은 결함을 여러 축이 찾으면 한 건으로 접고 발견자를 남긴다', () => {
  it('같은 (code, 파일, 줄)은 1건으로 접히고 found_by 에 두 축이 남는다', () => {
    const { runId, paths } = scan();
    writeVerdict(paths, 'beta', []);
    // 판단 축이 결정 축과 같은 결함을 독립적으로 확인했다.
    writeVerdict(paths, 'gamma', [
      {
        axis: 'gamma',
        severity: 'block',
        code: 'alpha.shared-defect',
        message: '같은 줄을 문맥으로 다시 확인했다',
        locations: [{ file: 'docs/shared.md', line: 3 }],
      },
    ]);

    const { report } = merge({ runId });
    const shared = findingsOf(report, 'alpha.shared-defect');

    assert.equal(shared.length, 1, '두 축의 같은 발견은 한 건이다');
    assert.deepEqual(shared[0].found_by, ['alpha', 'gamma']);
    assert.equal(shared[0].severity, 'block', '접힌 건의 심각도는 더 높은 쪽을 따른다');
  });

  it('다른 줄의 같은 코드는 접지 않는다', () => {
    const { runId, paths } = scan();
    writeVerdict(paths, 'beta', []);
    writeVerdict(paths, 'gamma', [
      {
        axis: 'gamma',
        severity: 'warn',
        code: 'alpha.shared-defect',
        message: '다른 줄에서 찾은 별개 결함',
        locations: [{ file: 'docs/shared.md', line: 12 }],
      },
    ]);

    const { report } = merge({ runId });
    assert.equal(findingsOf(report, 'alpha.shared-defect').length, 2);
  });
});

describe('축이 자기 결과를 통과시키지 못한다', () => {
  it('verdict 의 강등·발견자 자기 신고를 떼고 판정한다', () => {
    const { runId, paths } = scan();
    writeVerdict(paths, 'beta', [
      {
        axis: 'beta',
        severity: 'block',
        code: 'beta.confirmed',
        message: '축이 스스로 강등하려 한 차단급',
        locations: [{ file: 'docs/shared.md', line: 7 }],
        _demoted: true,
        waived: true,
        found_by: ['beta', 'alpha', 'gamma'],
      },
    ]);
    writeVerdict(paths, 'gamma', []);

    const { report } = merge({ runId });
    const confirmed = findingsOf(report, 'beta.confirmed')[0];

    assert.equal(confirmed.severity, 'block', '자기 신고 강등은 무시된다');
    assert.deepEqual(confirmed.found_by, ['beta'], '발견자는 병합기가 채운다 — 자칭할 수 없다');
    assert.equal(Object.hasOwn(confirmed, '_demoted'), false);
    assert.equal(report.axes.beta.stripped_self_reports, 1);
    assert.equal(report.outcome, 'fail');
  });

  it('강등은 CLI 인자로만 들어오고, coverage.* 는 강등 대상이 아니다', () => {
    const { runId, paths } = scan();
    writeVerdict(paths, 'beta', []);
    writeVerdict(paths, 'gamma', []);

    const waived = merge({ runId, waive: ['code=alpha.shared-defect'] }).report;
    assert.equal(findingsOf(waived, 'alpha.shared-defect')[0].severity, 'info');
    assert.deepEqual(waived.waivers, [{ code: 'alpha.shared-defect', applied: 1 }]);

    assert.throws(() => merge({ runId, waive: ['coverage.missing'] }), /coverage\.\* 는 강등할 수 없다/);
  });
});

describe('건너뛴 축은 차단하지 않되 사유와 함께 남는다', () => {
  it('선언이 없어 빠진 축은 커버리지 차단을 만들지 않는다', () => {
    const { runId, scan: scanned, paths } = scan();
    writeVerdict(paths, 'beta', []);
    writeVerdict(paths, 'gamma', []);

    assert.equal(scanned.axes.delta.status, 'skipped');
    assert.match(scanned.axes.delta.reason, /"delta"/);

    const { report, markdown } = merge({ runId });
    assert.equal(report.axes.delta.state, 'skipped');
    assert.match(report.axes.delta.reason, /"delta"/);
    assert.equal(
      report.findings.some((finding) => finding.axis === 'delta'),
      false,
    );
    assert.equal(report.summary.axes_skipped, 2, 'delta·broken 둘 다 선언이 없어 빠진다');
    assert.match(markdown, /건너뜀 — config 에 "delta" 선언이 없어 건너뜀/);
  });

  it('결과가 깨끗하면 pass 로 끝난다 — 건너뛴 축이 있어도 마찬가지다', () => {
    const { runId, paths } = scan();
    writeVerdict(paths, 'beta', []);
    writeVerdict(paths, 'gamma', []);

    const { report } = merge({ runId, waive: ['alpha.shared-defect'] });
    assert.equal(report.summary.block, 0);
    assert.equal(report.outcome, 'pass');
  });
});

describe('--axes 로 좁혀도 빠진 축은 사유와 함께 남는다', () => {
  it('선택되지 않은 축은 skipped 로 기록되고 차단을 만들지 않는다', () => {
    runCounter += 1;
    const runId = `r${runCounter}`;
    const only = ['alpha'];
    const { scan: scanned } = runScan({ configPath: CONFIG, runId, out: workDir, kitRoot: KIT, only });

    assert.equal(scanned.axes.alpha.status, 'ok');
    assert.equal(scanned.axes.beta.status, 'skipped');
    assert.equal(scanned.axes.beta.reason, '--axes 로 선택되지 않아 건너뜀');
    assert.deepEqual(scanned.awaiting_verdicts, [], '선택 밖 계약 축은 팬아웃 대상이 아니다');

    const { report } = runMerge({ configPath: CONFIG, runId, out: workDir, kitRoot: KIT, only });
    assert.equal(findingsOf(report, 'coverage.missing').length, 0);
    assert.equal(report.summary.axes_skipped, 5);
  });

  it('한쪽만 좁히면 멀쩡한 축이 커버리지로 잡힌다 — 양쪽에 같이 넘겨야 한다', () => {
    runCounter += 1;
    const runId = `r${runCounter}`;
    runScan({ configPath: CONFIG, runId, out: workDir, kitRoot: KIT, only: ['alpha'] });

    const { report } = merge({ runId });
    const missing = findingsOf(report, 'coverage.missing');
    assert.deepEqual(missing.map((finding) => finding.axis).sort(), ['beta', 'beta', 'capped', 'gamma']);
    // hybrid 축은 스크립트 쪽·계약 쪽이 각각 별개 사실이라 둘 다 남는다.
    const betaMessages = missing.filter((finding) => finding.axis === 'beta').map((f) => f.message);
    assert.equal(betaMessages.filter((message) => message.includes('스크립트 결과가 없다')).length, 1);
    assert.equal(betaMessages.filter((message) => message.includes('판정 결과가 없다')).length, 1);
  });

  it('등록되지 않은 축 이름은 조용히 무시하지 않고 거절한다', () => {
    assert.throws(
      () => runScan({ configPath: CONFIG, runId: 'bad-axes', out: workDir, kitRoot: KIT, only: ['nope'] }),
      /등록되지 않은 축/,
    );
  });
});

describe('리포트 산출', () => {
  it('report.json / report.md 가 실행 디렉토리에 남고 축 상태를 전수로 싣는다', () => {
    const { runId, paths } = scan();
    writeVerdict(paths, 'beta', []);
    writeVerdict(paths, 'gamma', []);

    const { report, markdown } = merge({ runId });

    assert.equal(report.run_id, runId);
    assert.equal(report.summary.axes_expected, 6);
    assert.deepEqual(Object.keys(report.axes).sort(), ['alpha', 'beta', 'broken', 'capped', 'delta', 'gamma']);
    assert.match(markdown, /# 정합성 리포트/);
    for (const axis of ['alpha', 'beta', 'gamma', 'capped', 'delta', 'broken']) {
      assert.match(markdown, new RegExp(`\\| \`${axis}\` \\|`), `${axis} 축이 리포트 표에 있다`);
    }

    const written = JSON.parse(readFileSync(paths.reportJsonFile, 'utf8'));
    assert.equal(written.outcome, report.outcome);
  });
});
