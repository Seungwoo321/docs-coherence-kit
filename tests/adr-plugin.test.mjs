/**
 * ADR 플러그인 축(P1) — 결함 형상을 축약 재현한 집합으로 검증한다.
 *
 * 결정↔본문 반영 · 소유 경계 역전 · 인용 그래프.
 * 앞의 둘은 의미 판정이라 스크립트가 후보만 내고 확정은 contract.md 가 한다 —
 * 여기서는 "판정에 필요한 것이 후보에 다 실렸는가"를 본다.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { before, describe, test } from 'node:test';

import { loadConfig, normalizeConfig } from '../core/lib/config.mjs';
import { loadAxes } from '../core/lib/manifest.mjs';
import { parseMarkdown } from '../core/lib/markdown.mjs';
import {
  POINTER_CODES,
  buildChain,
  parseAdrSettings,
  parseDecisionBodies,
  runDecisionsAxis,
} from '../plugins/adr/axes/decisions/check.mjs';
import { TESTS_DIR, fixture } from './helpers.mjs';

const CHECK = resolve(TESTS_DIR, '..', 'plugins/adr/axes/decisions/check.mjs');
const CONFIG = fixture('adr', 'dck.config.json');
const CONTRACT = resolve(TESTS_DIR, '..', 'plugins/adr/axes/decisions/contract.md');

function byCode(result, code) {
  return result.findings.filter((finding) => finding.code === code);
}

function forDecision(result, code, id) {
  return byCode(result, code).filter((finding) => finding.payload.decision_id === id);
}

function candidatesOf(result, kind) {
  return result.candidates.filter((candidate) => candidate.kind === kind);
}

describe('decisions 축 — 실행 계약', () => {
  let result;
  before(() => {
    result = runDecisionsAxis(loadConfig(CONFIG));
  });

  test('봉투가 axis·findings·candidates·stats 를 갖는다', () => {
    assert.equal(result.axis, 'decisions');
    assert.ok(Array.isArray(result.findings));
    assert.ok(Array.isArray(result.candidates));
    assert.equal(result.stats.skipped, false);
    // 동결(accepted.md · legacy-note.md)을 뺀 나머지 문서만 검사 대상이다.
    assert.equal(result.stats.files_scanned, 3);
    assert.equal(result.stats.decisions_parsed, 8);
    assert.equal(result.stats.accepted, 4);
  });

  test('모든 finding 의 code 네임스페이스가 축 이름이고 자리를 갖는다', () => {
    for (const finding of result.findings) {
      assert.equal(finding.axis, 'decisions');
      assert.match(finding.code, /^decisions\.[a-z][a-z0-9-]*$/);
      assert.ok(finding.locations.length > 0);
      assert.ok(finding.payload.decision_id);
      assert.ok(['block', 'warn', 'info'].includes(finding.severity));
    }
  });

  test('CLI 로 돌리면 stdout 한 덩어리 JSON 과 exit 0 을 낸다', () => {
    const stdout = execFileSync(process.execPath, [CHECK, '--config', CONFIG], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(stdout), JSON.parse(JSON.stringify(result)));
  });

  test('config 에 adr 선언이 없으면 사유를 달고 skipped 로 끝난다 — 조용한 통과가 아니다', () => {
    const skipped = runDecisionsAxis(loadConfig(fixture('config', 'adr-plugin-without-settings.json')));
    assert.equal(skipped.stats.skipped, true);
    assert.match(skipped.stats.skip_reason, /"adr"/);
    assert.deepEqual(skipped.findings, []);
  });
});

describe('결정이 지목한 자리가 그 번호를 인용하는가 (a)', () => {
  let result;
  before(() => {
    result = runDecisionsAxis(loadConfig(CONFIG));
  });

  test('두 지목처가 모두 다른 번호만 인용하면 결정마다 문서마다 하나씩 보고한다', () => {
    const missing = forDecision(result, 'decisions.citation-missing', 'ADR-001');
    assert.deepEqual(
      missing.map((finding) => finding.locations[0].file).sort(),
      ['field-spec.md', 'gate-policy.md'],
    );
    // §6·§10 두 절을 지목했어도 인용은 문서 단위 사실이라 보고는 문서당 하나다.
    const strategy = missing.find((f) => f.locations[0].file === 'gate-policy.md');
    assert.deepEqual(strategy.payload.sections, ['6', '10']);
  });

  test('결정 절이 지목했고 어느 지목처도 인용하지 않으면 block 이다', () => {
    for (const finding of forDecision(result, 'decisions.citation-missing', 'ADR-001')) {
      assert.equal(finding.severity, 'block');
      assert.equal(finding.payload.designated_by, 'decision');
      assert.equal(finding.payload.kind, 'citation_missing');
    }
  });

  test('내용이 반영돼 있어도 번호가 없으면 추적 끊김으로 잡는다', () => {
    const contract = forDecision(result, 'decisions.citation-missing', 'ADR-001').find(
      (finding) => finding.locations[0].file === 'field-spec.md',
    );
    // §4.2 는 ADR-001 의 결정 내용을 그대로 서술하면서 근거로는 ADR-004 만 단다.
    const text = readFileSync(fixture('adr', 'docs', 'field-spec.md'), 'utf8').split('\n');
    assert.match(text[6], /배치 판정의 입력이 아니다/);
    assert.match(text[7], /ADR-004/);
    assert.equal(contract.payload.target.section, '4.2');
    assert.equal(contract.locations[0].line, 5); // §4.2 제목 줄
    assert.equal(contract.locations[1].file, 'decisions/accepted.md'); // 근거가 된 결정 자리
  });

  test('인용한 문서는 보고하지 않는다', () => {
    assert.deepEqual(forDecision(result, 'decisions.citation-missing', 'ADR-002'), []);
    assert.deepEqual(forDecision(result, 'decisions.citation-missing', 'ADR-004'), []);
  });

  test('코드 펜스 안의 번호는 인용으로 세지 않는다', () => {
    // field-spec.md 는 펜스 안에서만 ADR-001 을 적는다 — 그래서 위 보고가 성립한다.
    const parsed = parseMarkdown(readFileSync(fixture('adr', 'docs', 'field-spec.md'), 'utf8'), {
      file: 'field-spec.md',
    });
    const fenced = parsed.lines.filter((line) => line.includes('ADR-001'));
    assert.equal(fenced.length, 1);
    assert.match(fenced[0], /"decision"/);
  });
});

describe('의미 판정은 후보로만 넘긴다 (b)(c)', () => {
  let result;
  before(() => {
    result = runDecisionsAxis(loadConfig(CONFIG));
  });

  test('accepted 결정마다 후보가 하나씩 나온다', () => {
    assert.deepEqual(
      candidatesOf(result, 'reflection').map((candidate) => candidate.decision_id),
      ['ADR-001', 'ADR-002', 'ADR-004', 'ADR-010'],
    );
    assert.equal(candidatesOf(result, 'reflection').length, result.stats.accepted);
  });

  test('후보에 결정 요약·결정문·지목 대상이 실린다 — 계약이 이것만으로 판정한다', () => {
    const candidate = candidatesOf(result, 'reflection').find((c) => c.decision_id === 'ADR-001');
    assert.equal(candidate.decision_status, 'accepted');
    assert.deepEqual(candidate.decision_heading, { file: 'decisions/accepted.md', line: 5 });
    assert.match(candidate.decision_summary, /배치 판정의 축은 도메인 지식 유무 하나다/);
    assert.match(candidate.decision_text, /`kind` 는 배치 판정의 입력이 아니다/);
    assert.equal(candidate.designated_by, 'decision');
    assert.deepEqual(
      candidate.targets.map((target) => `${target.file}#${target.section}`),
      ['field-spec.md#4.2', 'gate-policy.md#6', 'gate-policy.md#10'],
    );
  });

  test('후보가 읽을 범위를 좁혀 준다 — 절이 잡히면 줄 범위까지', () => {
    const candidate = candidatesOf(result, 'reflection').find((c) => c.decision_id === 'ADR-001');
    const [contract, strategy6, strategy10] = candidate.targets;
    assert.deepEqual(contract.line_range, [5, 9]);
    assert.deepEqual(strategy6.line_range, [5, 8]);
    // 결정 본문은 동결이라 지금 없는 §10 을 고칠 수 없다 — 결함이 아니라 문서 전체를 보라는 신호다.
    assert.equal(strategy10.heading_line, null);
    assert.equal(strategy10.line_range, null);
    assert.equal(byCode(result, 'decisions.section-missing').length, 0);
  });

  test('소유 선언이 대상마다 붙는다 — 역전 판정의 입력이다', () => {
    const candidate = candidatesOf(result, 'reflection').find((c) => c.decision_id === 'ADR-001');
    const strategy = candidate.targets.find((target) => target.file === 'gate-policy.md');
    assert.deepEqual(strategy.ownership_declared, [
      { what: '게이트 축·임계·판정 규칙', owner: 'gate-policy.md' },
    ]);
    const glossary = candidatesOf(result, 'reflection')
      .find((c) => c.decision_id === 'ADR-002')
      .targets.find((target) => target.file === 'glossary.md');
    assert.deepEqual(glossary.ownership_declared, [{ what: '용어 정의', owner: 'glossary.md' }]);
  });

  test('이미 번호를 인용한 대상도 후보에는 남는다 — 인용과 반영은 다른 사실이다', () => {
    const candidate = candidatesOf(result, 'reflection').find((c) => c.decision_id === 'ADR-004');
    assert.equal(candidate.targets[0].cites_decision, true);
    assert.equal(candidate.targets[0].file, 'gate-policy.md');
  });

  test('스크립트는 의미 판정을 확정하지 않는다', () => {
    const semantic = ['unreflected', 'contradicted', 'ownership_inverted'];
    for (const finding of result.findings) assert.ok(!semantic.includes(finding.payload.kind));
  });
});

describe('지목을 적지 않은 결정 (회귀)', () => {
  let result;
  before(() => {
    result = runDecisionsAxis(loadConfig(fixture('adr', 'undesignated.config.json')));
  });

  test('결정 절이 아무 문서도 지목하지 않아도 후보는 나온다', () => {
    // 지목이 없다고 후보를 안 내면, 반영을 아무도 묻지 않은 결정이야말로 검사 밖에 선다.
    const [candidate] = candidatesOf(result, 'reflection');
    assert.ok(candidate, '맥락의 링크가 후보의 출발점이 된다');
    assert.equal(candidate.decision_id, 'ADR-001');
    assert.equal(candidate.designated_by, 'body', '지목이 아니라 출발점임을 밝힌다');
    assert.deepEqual(
      candidate.targets.map((target) => `${target.file}#${target.section}`),
      ['gate-policy.md#6'],
    );
    assert.deepEqual(candidate.targets[0].ownership_declared, [
      { what: '게이트 축·임계·판정 규칙', owner: 'gate-policy.md' },
    ]);
  });

  test('맥락의 링크는 지목이 아니므로 인용 추적에는 쓰지 않는다', () => {
    assert.equal(byCode(result, 'decisions.citation-missing').length, 0);
  });
});

describe('supersede 체인 (d)', () => {
  let result;
  before(() => {
    result = runDecisionsAxis(loadConfig(CONFIG));
  });

  test('대체된 결정을 아직 인용하는 줄을 후보로 낸다', () => {
    const stale = candidatesOf(result, 'stale_supersede');
    assert.equal(stale.length, 1);
    assert.equal(stale[0].decision_id, 'ADR-003');
    assert.equal(stale[0].superseded_by, 'ADR-004');
    assert.deepEqual(stale[0].chain, ['ADR-003', 'ADR-004']);
    assert.deepEqual(stale[0].target, {
      file: 'field-spec.md',
      section: null,
      current_text: '파이프라인 현황은 콘솔 출력으로 확인한다(ADR-003).',
      line: 12,
    });
  });

  test('죽은 대체 참조는 결함이다', () => {
    const dangling = byCode(result, 'decisions.supersede-dangling');
    assert.equal(dangling.length, 1);
    assert.equal(dangling[0].payload.decision_id, 'ADR-009');
    assert.equal(dangling[0].payload.superseded_by, 'ADR-099');
    assert.match(dangling[0].message, /죽은 참조/);
  });

  test('순환하는 체인은 참여한 결정마다 보고한다', () => {
    const cycles = byCode(result, 'decisions.supersede-cycle');
    assert.deepEqual(
      cycles.map((finding) => finding.payload.decision_id),
      ['ADR-005', 'ADR-006'],
    );
    assert.deepEqual(cycles[0].payload.chain, ['ADR-005', 'ADR-006', 'ADR-005']);
  });

  test('체인 종점 판정 — 유효·순환·없음', () => {
    const parsed = parseMarkdown(readFileSync(fixture('adr', 'docs', 'decisions', 'accepted.md'), 'utf8'), {
      file: 'decisions/accepted.md',
    });
    const settings = parseAdrSettings({ adr: { bodies: 'x.md' } });
    const byId = new Map(parseDecisionBodies(parsed, settings).map((d) => [d.id, d]));

    assert.deepEqual(buildChain('ADR-003', byId), { chain: ['ADR-003', 'ADR-004'], terminal: 'accepted' });
    assert.equal(buildChain('ADR-005', byId).terminal, 'cycle');
    assert.equal(buildChain('ADR-009', byId).terminal, 'missing');
  });

  test('대체된 결정은 반영 후보를 만들지 않는다', () => {
    const ids = candidatesOf(result, 'reflection').map((candidate) => candidate.decision_id);
    for (const id of ['ADR-003', 'ADR-005', 'ADR-006', 'ADR-009']) assert.ok(!ids.includes(id));
  });
});

describe('카드 대조 — 같은 사실의 두 기록', () => {
  let result;
  before(() => {
    result = runDecisionsAxis(loadConfig(CONFIG));
  });

  test('본문과 카드의 상태가 다르면 양쪽 자리를 함께 보고한다', () => {
    const mismatch = byCode(result, 'decisions.card-mismatch');
    assert.equal(mismatch.length, 1);
    assert.equal(mismatch[0].payload.decision_id, 'ADR-002');
    assert.equal(mismatch[0].payload.body_status, 'accepted');
    assert.equal(mismatch[0].payload.card_status, 'draft');
    assert.equal(mismatch[0].locations[0].file, 'decisions.json');
    assert.equal(mismatch[0].locations[0].line, 6);
    assert.equal(mismatch[0].locations[1].file, 'decisions/accepted.md');
  });

  test('대체 상태는 표기가 같으면 일치로 본다', () => {
    const ids = byCode(result, 'decisions.card-mismatch').map((finding) => finding.payload.decision_id);
    for (const id of ['ADR-003', 'ADR-005', 'ADR-006', 'ADR-009']) assert.ok(!ids.includes(id));
  });

  test('한쪽에만 있는 결정은 방향을 구분해 보고한다', () => {
    assert.deepEqual(
      byCode(result, 'decisions.card-missing').map((finding) => finding.payload.decision_id),
      ['ADR-010'],
    );
    assert.deepEqual(
      byCode(result, 'decisions.card-orphan').map((finding) => finding.payload.decision_id),
      ['ADR-077'],
    );
  });

  test('cards 선언이 없으면 카드 검사 자체를 하지 않는다', () => {
    const context = loadConfig(CONFIG);
    const config = { ...context.config, adr: { ...context.config.adr } };
    delete config.adr.cards;
    const without = runDecisionsAxis({ ...context, config });
    for (const code of ['card-mismatch', 'card-missing', 'card-orphan']) {
      assert.deepEqual(byCode(without, `decisions.${code}`), []);
    }
    assert.equal(byCode(without, 'decisions.citation-missing').length, 2);
  });
});

describe('동결 규율 (e)', () => {
  let result;
  before(() => {
    result = runDecisionsAxis(loadConfig(CONFIG));
  });

  test('동결 문서를 지목한 결정은 후보만 내고 결함으로 보고하지 않는다', () => {
    const candidate = candidatesOf(result, 'reflection').find((c) => c.decision_id === 'ADR-010');
    assert.equal(candidate.targets[0].file, 'legacy-note.md');
    assert.equal(candidate.targets[0].cites_decision, false);
    assert.deepEqual(forDecision(result, 'decisions.citation-missing', 'ADR-010'), []);
  });

  test('묻어 둔 것이 아니라 사유를 남긴다 — 조용한 통과 금지', () => {
    const suppressed = result.stats.excluded.filter((entry) => entry.path === 'legacy-note.md');
    assert.ok(suppressed.some((entry) => /동결 문서라 "decisions.citation-missing"/.test(entry.reason)));
  });

  test('결정 본문 자체를 고쳐야 하는 결함은 내지 않는다', () => {
    for (const finding of result.findings) {
      if (POINTER_CODES.includes(finding.code)) continue;
      assert.notEqual(finding.locations[0].file, 'decisions/accepted.md');
    }
  });

  test('죽은 대체 참조만 예외다 — 상태 필드는 대체될 때 갱신되는 가변부다', () => {
    for (const finding of byCode(result, 'decisions.supersede-dangling')) {
      assert.equal(finding.locations[0].file, 'decisions/accepted.md');
    }
  });
});

describe('검사 밖 반영처를 통과로 읽히게 두지 않는다 (a\')', () => {
  let result;
  before(() => {
    result = runDecisionsAxis(loadConfig(fixture('adr', 'out-of-scope.config.json')));
  });

  test('제외 글롭에 걸린 반영처를 지목하면 사유와 함께 지적한다', () => {
    const [finding] = forDecision(result, 'decisions.target-out-of-scope', 'ADR-001');
    assert.ok(finding, '후보 0건으로 침묵하면 그 결정은 지적 없음으로 읽힌다');
    assert.equal(finding.severity, 'warn');
    assert.equal(finding.payload.target.file, 'issues/gate-threshold.md');
    assert.match(finding.payload.scope_reason, /issues\/\*\*/);
    // 첫 자리는 결정 본문의 그 링크 줄이다 — 코퍼스 안에는 가리킬 자리가 없다.
    assert.equal(finding.locations[0].file, 'decisions/accepted.md');
    assert.equal(finding.locations[0].line, 8);
  });

  test('매니페스트 id 든 상대 경로든 같게 해석한다', () => {
    const [finding] = forDecision(result, 'decisions.target-out-of-scope', 'ADR-002');
    assert.ok(finding);
    assert.equal(finding.payload.target.file, 'issues/sequencing.md');
  });

  test('검사한 문서를 지목한 결정은 이 지적을 받지 않는다', () => {
    assert.deepEqual(forDecision(result, 'decisions.target-out-of-scope', 'ADR-003'), []);
  });

  test('실재하지 않는 대상은 (e) 동결 규율대로 조용하다', () => {
    // 동결된 결정 본문의 낡은 링크는 설계상 허용이고, "실재하지만 안 본 문서"와 고치는 법이 다르다.
    assert.deepEqual(forDecision(result, 'decisions.target-out-of-scope', 'ADR-004'), []);
  });

  test('코퍼스가 남긴 제외 사유를 그대로 인용한다 — 지어내지 않는다', () => {
    const excluded = result.stats.excluded.find(
      (entry) => entry.path === 'issues/gate-threshold.md',
    );
    const [finding] = forDecision(result, 'decisions.target-out-of-scope', 'ADR-001');
    assert.equal(finding.payload.scope_reason, excluded.reason);
  });
});

describe('선언만으로 붙고 빠진다', () => {
  test('플러그인을 설치해도 adr 키가 없으면 코어 로더가 사유와 함께 skipped 로 올린다', () => {
    const declared = loadConfig(fixture('config', 'adr-plugin-without-settings.json')).config;
    const axis = loadAxes(declared).find((entry) => entry.name === 'decisions');
    assert.equal(axis.state, 'skipped');
    assert.match(axis.reason, /"adr"/);
  });

  test('adr 키가 채워지면 같은 축이 사유 없이 active 로 바뀐다 — 코드는 그대로다', () => {
    const axis = loadAxes(loadConfig(CONFIG).config).find((entry) => entry.name === 'decisions');
    assert.equal(axis.state, 'active');
    assert.equal(axis.reason, undefined);
    assert.equal(axis.kind, 'hybrid');
    assert.equal(axis.severity_cap, 'block');
    // 매니페스트의 run 경로가 실제 산출물을 가리킨다 — 죽은 선언이 아니다.
    assert.equal(axis.source, resolve(TESTS_DIR, '..', 'plugins/adr/manifest.json'));
    assert.equal(axis.scriptPath, CHECK);
    assert.equal(axis.contractPath, CONTRACT);
    for (const path of [axis.scriptPath, axis.contractPath]) assert.ok(existsSync(path));
  });

  test('플러그인을 선언하지 않은 집합에는 축이 목록에 오르지도 않는다', () => {
    const axes = loadAxes(loadConfig(fixture('config', 'core-only.json')).config);
    assert.equal(axes.find((entry) => entry.name === 'decisions'), undefined);
  });

  test('본문 형식은 선언으로 갈아끼운다 — 코드에 "상태"·"결정"·번호꼴이 박혀 있지 않다', () => {
    const settings = parseAdrSettings(
      normalizeConfig({
        docs: { root: 'docs' },
        adr: { bodies: 'log.md', id_pattern: 'DEC\\d+', status_field: 'state', decision_field: 'ruling' },
      }),
    );
    const parsed = parseMarkdown(
      ['## DEC7 로그를 남긴다', '', '- state: accepted', '- ruling: [용어집](glossary.md) §2 가 뜻을 갖는다', ''].join(
        '\n',
      ),
      { file: 'log.md' },
    );
    const [decision] = parseDecisionBodies(parsed, settings);
    assert.equal(decision.id, 'DEC7');
    assert.equal(decision.status, 'accepted');
    assert.match(decision.decisionText, /뜻을 갖는다/);
  });

  test('선언이 형식을 어기면 조용히 넘기지 않고 사유를 모아 throw 한다', () => {
    assert.throws(() => parseAdrSettings({ adr: {} }), /bodies/);
    assert.throws(() => parseAdrSettings({ adr: { bodies: 'x.md', id_pattern: '(' } }), /id_pattern/);
  });
});

describe('판단 계약 — 스크립트가 넘긴 것을 계약이 받는가', () => {
  const contract = readFileSync(CONTRACT, 'utf8');

  test('구현 계약 v1 의 고정 절을 갖는다', () => {
    for (const section of ['## 입력', '## 판정 기준', '## 반드시 지킬 것', '## 출력']) {
      assert.ok(contract.includes(section), `${section} 절이 없다`);
    }
  });

  test('결정 반영·소유 경계·(d) 판정 기준이 각각 서 있다', () => {
    for (const kind of ['unreflected', 'contradicted', 'ownership_inverted', 'stale_supersede']) {
      assert.ok(contract.includes(kind), `${kind} 판정 기준이 없다`);
    }
    assert.match(contract, /소유 경계 역전/);
    assert.match(contract, /동결 규율/);
  });

  test('반드시 지킬 것 4항이 다 있다', () => {
    for (const item of ['탐색 범위 규율', '집합 성격 주입', '기계 생성 파일 금독', 'verdict 파일 하나만 쓰기']) {
      assert.ok(contract.includes(item), `${item} 항이 없다`);
    }
  });

  test('계약이 요구하는 payload 필드를 스크립트가 후보로 다 준다', () => {
    for (const field of ['decision_id', 'decision_summary', 'target', 'kind']) {
      assert.ok(contract.includes(field), `${field} 가 출력 규정에 없다`);
    }
    const result = runDecisionsAxis(loadConfig(CONFIG));
    for (const candidate of result.candidates) {
      assert.ok(candidate.decision_id && candidate.decision_summary);
      assert.ok(candidate.kind === 'reflection' ? candidate.targets.length > 0 : Boolean(candidate.target));
    }
  });
});
