import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FOLD_KEY_SEPARATOR,
  FindingError,
  capSeverity,
  createFinding,
  createScanResult,
  createSkippedScanResult,
  foldFindings,
  foldKey,
  severityRank,
  validateFinding,
} from '../core/lib/findings.mjs';

const base = {
  axis: 'numbers',
  severity: 'block',
  code: 'numbers.table-sum',
  message: '합계 행이 나머지 행의 합과 다르다',
  locations: [{ file: 'docs/scope-table.md', line: 12, quote: '| 합계 | 48 |' }],
};

describe('findings 봉투', () => {
  it('필수 필드를 갖춘 finding 을 만든다', () => {
    const finding = createFinding({ ...base, payload: { expected: 50, actual: 58 } });
    assert.equal(finding.axis, 'numbers');
    assert.deepEqual(finding.locations, base.locations);
    assert.deepEqual(finding.payload, { expected: 50, actual: 58 });
  });

  it('locations 가 비면 거절한다', () => {
    assert.throws(() => createFinding({ ...base, locations: [] }), FindingError);
    assert.deepEqual(validateFinding({ ...base, locations: [] }), [
      'locations: 최소 1개 항목이 있어야 한다',
    ]);
  });

  it('code 네임스페이스가 축 이름과 다르면 거절한다', () => {
    const problems = validateFinding({ ...base, code: 'links.dangling' });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /네임스페이스가 축 이름과 다르다/);
  });

  it('coverage.* 는 축 이름과 달라도 허용한다 — 병합기가 주입하는 예약 네임스페이스다', () => {
    assert.deepEqual(
      validateFinding({
        axis: 'links',
        severity: 'block',
        code: 'coverage.missing',
        message: '축 결과가 없다',
        locations: [{ file: 'core/manifest.json' }],
      }),
      [],
    );
  });

  it('알 수 없는 키와 잘못된 severity 를 모두 모아 보고한다', () => {
    const problems = validateFinding({ ...base, severity: 'fatal', hint: 'x' });
    assert.equal(problems.length, 2);
    assert.ok(problems.some((p) => p.startsWith('severity:')));
    assert.ok(problems.some((p) => p.startsWith('hint:')));
  });

  it('severity_cap 을 넘는 심각도를 cap 으로 낮춘다', () => {
    assert.equal(capSeverity('block', 'warn'), 'warn');
    assert.equal(capSeverity('info', 'warn'), 'info');
    assert.equal(createFinding({ ...base, severityCap: 'warn' }).severity, 'warn');
    assert.ok(severityRank('block') > severityRank('warn'));
  });

  it('중복 접기 키는 (code, 첫 location 의 file·line) 이다', () => {
    // 구분자는 경로에 들어갈 수 없는 NUL — 공백이면 "a b.md" 같은 경로에서 키가 겹친다.
    assert.equal(FOLD_KEY_SEPARATOR.charCodeAt(0), 0);
    assert.equal(
      foldKey(base),
      ['numbers.table-sum', 'docs/scope-table.md', 12].join(FOLD_KEY_SEPARATOR),
    );
    const otherQuote = { ...base, locations: [{ ...base.locations[0], quote: '다른 인용' }] };
    assert.equal(foldKey(otherQuote), foldKey(base));
    const otherLine = { ...base, locations: [{ file: 'docs/scope-table.md', line: 13 }] };
    assert.notEqual(foldKey(otherLine), foldKey(base));
  });

  it('같은 키를 접고 found_by 에 원 축을 남긴다', () => {
    const folded = foldFindings([
      { ...base, severity: 'warn' },
      { ...base, axis: 'numbers', severity: 'block' },
    ]);
    assert.equal(folded.length, 1);
    assert.equal(folded[0].severity, 'block', '접힌 항목은 더 높은 심각도를 남긴다');
    assert.deepEqual(folded[0].found_by, ['numbers']);
  });

  it('coverage.* 는 접지 않는다 — 축마다 별개 사실이다', () => {
    const coverage = (axis) => ({
      axis,
      severity: 'block',
      code: 'coverage.missing',
      message: '결과 없음',
      locations: [{ file: 'core/manifest.json' }],
    });
    const folded = foldFindings([coverage('links'), coverage('concepts')]);
    assert.equal(folded.length, 2);
  });

  it('scanResult 는 files_scanned·excluded·skipped 를 항상 갖는다', () => {
    const result = createScanResult({ axis: 'numbers', findings: [base] });
    assert.deepEqual(result.stats, { files_scanned: 0, excluded: [], skipped: false });
    assert.equal(result.candidates, undefined);
  });

  it('봉투의 축과 다른 finding 을 섞으면 거절한다', () => {
    assert.throws(
      () => createScanResult({ axis: 'links', findings: [base] }),
      /봉투의 축과 다르다/,
    );
  });

  it('hybrid 축은 candidates 를 함께 낼 수 있다', () => {
    const result = createScanResult({
      axis: 'ownership',
      findings: [],
      candidates: [{ what: '용어 정의', file: 'docs/quality-targets.md', line: 12 }],
      stats: { files_scanned: 3, excluded: [{ path: 'decisions/accepted.md', reason: 'frozen' }] },
    });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.stats.files_scanned, 3);
    assert.deepEqual(result.stats.excluded, [{ path: 'decisions/accepted.md', reason: 'frozen' }]);
  });

  it('skipped 봉투는 사유 없이 만들 수 없다', () => {
    assert.throws(() => createSkippedScanResult({ axis: 'ownership' }), FindingError);
    const skipped = createSkippedScanResult({ axis: 'ownership', reason: 'config 에 "ownership" 선언이 없어 건너뜀' });
    assert.equal(skipped.stats.skipped, true);
    assert.match(skipped.stats.skip_reason, /ownership/);
  });
});
