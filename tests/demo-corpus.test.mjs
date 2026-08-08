/**
 * examples/bluebird-docs 데모 코퍼스 회귀.
 *
 * 데모는 "킷이 무엇을 잡는지" 를 보여 주는 산출물이라, 심어 둔 결함이 실제로 재현되지 않으면
 * 데모가 거짓말을 하는 것이다. 그래서 여기서는 데모 문서를 고칠 때 깨지도록 축별 결함을
 * 코드·자리 단위로 못 박는다. 판정 축이 사람에게 넘기는 것은 결함이 아니라 후보라, 후보가
 * 나오는 것까지만 본다 — 그 판정은 계약이 소유한다.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { gateBlocked, runScan } from '../core/scan.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_ROOT = resolve(REPO_ROOT, 'examples', 'bluebird-docs');
const DEMO_CONFIG = resolve(DEMO_ROOT, 'dck.config.json');

let scan;

before(() => {
  ({ scan } = runScan({
    configPath: DEMO_CONFIG,
    runId: 'demo-test',
    kitRoot: REPO_ROOT,
    write: false,
  }));
});

/** 그 축이 낸 findings 중 이 코드를 가진 것들. */
function findingsOf(axis, code) {
  return (scan.axes[axis]?.findings ?? []).filter((finding) => finding.code === code);
}

describe('데모 코퍼스는 자기완결이다', () => {
  it('examples 아래에는 Bluebird 데모만 있다', () => {
    assert.deepEqual(readdirSync(resolve(REPO_ROOT, 'examples')), ['bluebird-docs']);
  });

  it('측정·스키마·매니페스트가 config 가 가리키는 자리에 실재한다', () => {
    for (const relative of [
      'docs/index.json',
      'docs/decisions.json',
      'docs/decisions/accepted.md',
      'data/tiles.json',
      'data/deploy-units.json',
      'tools/count-tiles.mjs',
      'tools/count-deploy-units.mjs',
      'schema/tile.schema.json',
    ]) {
      assert.ok(existsSync(resolve(DEMO_ROOT, relative)), `${relative} 가 없다`);
    }
  });

  it('다섯 축이 모두 돌고 아무 축도 깨지지 않는다', () => {
    const status = Object.fromEntries(Object.entries(scan.axes).map(([axis, entry]) => [axis, entry.status]));
    assert.deepEqual(status, {
      numbers: 'ok',
      ownership: 'ok',
      concepts: 'ok',
      links: 'ok',
      decisions: 'ok',
    });
    assert.equal(scan.summary.crashed, 0);
  });

  it('게이트가 막힌다 — 데모는 통과하면 안 된다', () => {
    assert.equal(gateBlocked(scan), true);
    assert.ok(scan.summary.block > 0);
  });
});

describe('축마다 심어 둔 결함이 재현된다', () => {
  it('수치 — 합계 행이 부분 합과 어긋난다', () => {
    const [finding] = findingsOf('numbers', 'numbers.table-sum');
    assert.ok(finding, 'numbers.table-sum 이 나오지 않았다');
    assert.equal(finding.severity, 'block');
    assert.equal(finding.locations[0].file, 'scope-table.md');
    assert.match(finding.message, /26 \+ 14 \+ 8 = 48 ≠ 46/);
  });

  it('수치 — 문서의 수가 실측 데이터와 어긋난다', () => {
    const [finding] = findingsOf('numbers', 'numbers.data-mismatch');
    assert.ok(finding, 'numbers.data-mismatch 가 나오지 않았다');
    assert.equal(finding.severity, 'block');
    assert.equal(finding.locations[0].file, 'scope-table.md');
    // 측정 스크립트가 실제로 돌아 tiles.json 을 세었다는 뜻이다.
    assert.match(finding.message, /46 이라 적었는데 실측은 48/);
  });

  it('소유 — 정본 밖에서 값이 갈라진 복제', () => {
    const [finding] = findingsOf('ownership', 'ownership.drifted-copy');
    assert.ok(finding, 'ownership.drifted-copy 가 나오지 않았다');
    assert.equal(finding.severity, 'block');
    assert.equal(finding.locations[0].file, 'phase-notes.md');
    assert.equal(finding.payload.owner_doc, 'scope-table.md');
    assert.equal(finding.payload.item.name, '1차 전환');
    assert.deepEqual(finding.payload.drift_detail, [
      { file: 'phase-notes.md', line: 9, owner_values: [26], found_values: [31] },
    ]);
  });

  it('개념 — 스키마에 없는 유령 필드', () => {
    const [finding] = findingsOf('concepts', 'concepts.ghost-field');
    assert.ok(finding, 'concepts.ghost-field 가 나오지 않았다');
    assert.equal(finding.severity, 'block');
    assert.equal(finding.locations[0].file, 'field-spec.md');
    assert.equal(finding.payload.concept, 'usedBy');
    assert.deepEqual(finding.payload.candidates, ['usedByBlocks', 'usedByTiles']);
    assert.equal(scan.axes.concepts.stats.field_check.ran, true);
  });

  it('링크 — 없는 앵커와 없는 절', () => {
    const [dead] = findingsOf('links', 'links.dead-target');
    assert.ok(dead, 'links.dead-target 이 나오지 않았다');
    assert.equal(dead.severity, 'block');
    assert.equal(dead.locations[0].file, 'phase-notes.md');
    assert.match(dead.payload.target.raw, /wiring-spec\.md#/);

    const [section] = findingsOf('links', 'links.dead-section');
    assert.ok(section, 'links.dead-section 이 나오지 않았다');
    assert.equal(section.severity, 'block');
    assert.equal(section.payload.section, '9');
    assert.equal(section.payload.target.file, 'gate-policy.md');
    // 대상 문서를 본문이 링크로 밝혔기 때문에 차단급이다.
    assert.equal(section.payload.resolved_via, 'link');
  });

  it('결정 — 카드 누락과 인용 끊김', () => {
    const [card] = findingsOf('decisions', 'decisions.card-missing');
    assert.ok(card, 'decisions.card-missing 이 나오지 않았다');
    assert.equal(card.severity, 'block');
    assert.equal(card.payload.decision_id, 'ADR-004');

    const [citation] = findingsOf('decisions', 'decisions.citation-missing');
    assert.ok(citation, 'decisions.citation-missing 이 나오지 않았다');
    assert.equal(citation.severity, 'block');
    assert.equal(citation.payload.decision_id, 'ADR-003');
    assert.equal(citation.locations[0].file, 'phase-notes.md');
  });

  it('심어 둔 것 말고 다른 결함은 없다 — 데모가 잡음을 내지 않는다', () => {
    const codes = Object.values(scan.axes)
      .flatMap((entry) => entry.findings ?? [])
      .map((finding) => finding.code)
      .sort();
    assert.deepEqual(codes, [
      'concepts.ghost-field',
      'decisions.card-missing',
      'decisions.citation-missing',
      'links.dead-section',
      'links.dead-target',
      'numbers.data-mismatch',
      'numbers.table-sum',
      'ownership.drifted-copy',
    ]);
  });
});

describe('판정 축은 후보를 내고 판단은 계약에 넘긴다', () => {
  it('세 판정 축이 판정 대기에 오른다', () => {
    const awaiting = scan.awaiting_verdicts.map((entry) => [entry.axis, entry.kind, entry.candidates]);
    assert.deepEqual(awaiting.sort(), [
      ['concepts', 'hybrid', 6],
      ['decisions', 'hybrid', 3],
      ['ownership', 'hybrid', 1],
    ]);
  });

  it('개념 — 흔한 이름과 한 조각 차이인 이름이 후보로 나간다', () => {
    const ghosts = scan.axes.concepts.candidates.filter((candidate) => candidate.kind === 'ghost');
    assert.deepEqual(
      ghosts.map((candidate) => candidate.name),
      ['booking-cores'],
    );
    assert.equal(ghosts[0].dominant.name, 'booking-core');
  });

  it('소유 — 링크 없이 다시 적은 정의가 후보로 나간다', () => {
    const names = scan.axes.ownership.candidates.map((candidate) => candidate.item.name);
    assert.deepEqual(names, ['슬롯']);
    assert.equal(scan.axes.ownership.candidates[0].owner_doc, 'glossary.md');
  });

  it('결정 — 채택된 결정의 반영 여부가 후보로 나간다', () => {
    const ids = scan.axes.decisions.candidates
      .filter((candidate) => candidate.kind === 'reflection')
      .map((candidate) => candidate.decision_id);
    assert.deepEqual(ids, ['ADR-001', 'ADR-002', 'ADR-003']);
  });
});

describe('검사 범위 설정이 실제로 걸린다', () => {
  it('exclude 글롭과 동결 문서가 모든 축에서 같게 빠진다', () => {
    for (const [axis, entry] of Object.entries(scan.axes)) {
      const excluded = Object.fromEntries((entry.stats?.excluded ?? []).map((item) => [item.path, item.reason]));
      assert.match(excluded['issues/parking-lot.md'] ?? '', /exclude/, `${axis} 가 issues/** 를 빼지 않았다`);
      assert.match(excluded['decisions/accepted.md'] ?? '', /frozen/, `${axis} 가 동결 문서를 빼지 않았다`);
    }
  });

  it('제외된 보류함의 어긋난 수는 아무 축도 보고하지 않는다', () => {
    const files = Object.values(scan.axes)
      .flatMap((entry) => entry.findings ?? [])
      .flatMap((finding) => (finding.locations ?? []).map((location) => location.file));
    assert.ok(!files.includes('issues/parking-lot.md'));
  });

  it('링크 축만 동결 문서를 읽는다 — 결정 본문의 문서 id 링크를 대조해야 하기 때문이다', () => {
    assert.equal(scan.axes.links.stats.files_scanned, 8);
    assert.equal(scan.axes.numbers.stats.files_scanned, 7);
  });
});
