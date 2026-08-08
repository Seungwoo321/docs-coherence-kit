import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  AXIS,
  citesOwner,
  classifyLine,
  containsName,
  extractNumbers,
  extractOwnedItems,
  isExampleFence,
  keyColumnIndex,
  linksToOwner,
  normalizeText,
  ownedItemsIn,
  runOwnershipCheck,
  significantTokens,
  valueWindow,
  withoutStructuralMarkers,
} from '../core/axes/ownership/check.mjs';
import { DEFAULTS, loadConfig } from '../core/lib/config.mjs';
import { allDocuments, loadCorpus } from '../core/lib/corpus.mjs';
import { validateFinding } from '../core/lib/findings.mjs';
import { parseMarkdown } from '../core/lib/markdown.mjs';
import { TESTS_DIR, fixture } from './helpers.mjs';

const docOf = (text, path = 'x.md') => ({ path, parsed: parseMarkdown(text, { file: path }) });
const columnsOf = (text) => new Set(parseMarkdown(text).tables[0].header.map((cell) => cell.toLowerCase()));

const REPO_ROOT = resolve(TESTS_DIR, '..');
const CHECK = resolve(REPO_ROOT, 'core/axes/ownership/check.mjs');
const CONFIG = fixture('ownership', 'dck.config.json');

const context = loadConfig(CONFIG);
const result = runOwnershipCheck(context);

const findingsOf = (code) => result.findings.filter((finding) => finding.code === code);
const candidateFor = (name) => result.candidates.find((candidate) => candidate.item.name === name);
const locationsOf = (candidate) => candidate.duplicate_locations.map((l) => `${l.file}:${l.line}`);

describe('소유 대상 추출', () => {
  const corpus = loadCorpus(context, { parse: true });
  const byPath = new Map(allDocuments(corpus).map((doc) => [doc.path, doc]));

  it('표 행은 첫 셀이 이름, 나머지 셀이 값이 된다', () => {
    const items = ownedItemsIn(byPath.get('scope-table.md'));
    assert.deepEqual(
      items.map((item) => [item.name, item.value, item.column, item.kind]),
      [
        ['커버리지', '64%', '개수', 'table-row'],
        ['1차 전환', '41', '개수', 'table-row'],
        ['2차 전환', '5', '개수', 'table-row'],
      ],
    );
    assert.deepEqual(
      items.map((item) => item.line),
      [9, 10, 11],
    );
  });

  it('이름이 강조·코드스팬으로 표시된 정의 항목만 뽑는다', () => {
    const items = ownedItemsIn(byPath.get('rules/transition-gate.md'));
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'definition');
    assert.equal(items[0].name, '전환 게이트');
    assert.match(items[0].value, /^의존수가 임계를 넘고/);
    assert.match(items[0].value, /면제신청 라벨이 붙은 건은 예외다\.$/);
  });

  it('소유 선언마다 소유자·what·hint 가 항목에 붙는다', () => {
    const { items, missingOwners } = extractOwnedItems(context.config.ownership, byPath);
    assert.equal(missingOwners.length, 0);
    assert.equal(items.length, 4);
    assert.deepEqual(
      [...new Set(items.map((item) => item.owner))],
      ['scope-table.md', 'rules/transition-gate.md'],
    );
    assert.equal(items.find((item) => item.name === '전환 게이트').hint, '게이트 통과 조건 전문');
  });

  it('합계 행은 소유 항목이 아니다 — 표 안의 자리를 부르는 말이라 문서를 넘어 같은 것을 가리키지 않는다', () => {
    const doc = docOf(['| 구분 | 개수 |', '| --- | --- |', '| 1차 전환 | 41 |', '| 합계 | 49 |'].join('\n'));
    assert.deepEqual(
      ownedItemsIn(doc, { totalRowLabels: DEFAULTS.total_row_labels }).map((item) => item.name),
      ['1차 전환'],
    );
    assert.deepEqual(
      ownedItemsIn(doc).map((item) => item.name),
      ['1차 전환', '합계'],
      '합계 라벨을 주지 않으면 예전대로 뽑는다',
    );
  });

  it('첫 열이 분류인 표는 행마다 다른 열이 이름이 된다', () => {
    const glossary = docOf(
      [
        '| 분류 | 용어 | 코드 |',
        '| --- | --- | --- |',
        '| 코드 구조 | 호스트 | `@repo/base-ui` · `@repo/ui` |',
        '| 코드 구조 | 기능블록 | `packages/blocks/*` |',
      ].join('\n'),
    );
    assert.equal(keyColumnIndex(glossary.parsed.tables[0]), 1);
    assert.deepEqual(
      ownedItemsIn(glossary).map((item) => [item.name, item.value, item.column]),
      [
        ['호스트', '코드 구조', '분류'],
        ['호스트', '@repo/base-ui · @repo/ui', '코드'],
        ['기능블록', '코드 구조', '분류'],
        ['기능블록', 'packages/blocks/*', '코드'],
      ],
      '분류 열로는 행이 지목되지 않아 같은 분류의 행들이 서로를 덮어쓴다',
    );

    const keyed = docOf(['| 구분 | 개수 |', '| --- | --- |', '| 1차 전환 | 41 |'].join('\n'));
    assert.equal(keyColumnIndex(keyed.parsed.tables[0]), 0, '첫 열이 행마다 다르면 그대로 이름이다');
  });

  it('언어 없는 펜스는 산문이고 언어를 밝힌 펜스만 예시다', () => {
    const doc = docOf(
      [
        '```',
        '- **호스트**: `@repo/base-ui` · `@repo/ui`',
        '```',
        '',
        '```tsx',
        '- **기능블록**: `@repo/block-api`',
        '```',
      ].join('\n'),
    );
    assert.equal(isExampleFence(doc.parsed, 2), false, '트리·계약식은 단조 폰트로 적은 산문이다');
    assert.equal(isExampleFence(doc.parsed, 6), true);
    assert.deepEqual(
      ownedItemsIn(doc).map((item) => item.name),
      ['호스트'],
      '예시 코드 안의 정의는 사실을 주장하지 않는다',
    );
  });

  it('측정 열이 둘 이상인 표는 교차표로 표시된다 — 행 이름만으로는 칸이 지목되지 않는다', () => {
    const cross = docOf(
      ['| 앱 | 등록 타일 | 1차 전환 |', '| --- | --- | --- |', '| portal | 20 | 17 |'].join('\n'),
    );
    const single = docOf(['| 구분 | 개수 |', '| --- | --- |', '| 1차 전환 | 41 |'].join('\n'));
    assert.deepEqual(
      ownedItemsIn(cross).map((item) => [item.column, item.cross_tab]),
      [
        ['등록 타일', true],
        ['1차 전환', true],
      ],
    );
    assert.deepEqual(
      ownedItemsIn(single).map((item) => [item.column, item.cross_tab]),
      [['개수', false]],
    );
  });
});

describe('재서술 판별', () => {
  const numberItem = { name: '1차 전환', value: '41' };
  const ruleItem = {
    name: '전환 게이트',
    value: '의존수가 임계를 넘고 검토자가 2명 이상이면 통과시킨다. 단 면제신청 라벨이 붙은 건은 예외다.',
  };

  it('수치값은 이름 주변 창의 숫자와 대조한다', () => {
    assert.equal(classifyLine(numberItem, '1차 전환 41 건').match, 'same');
    assert.equal(classifyLine(numberItem, '1차 전환 대상은 49 개다').match, 'different');
    assert.equal(classifyLine(numberItem, '1차 전환 순서는 의존 그래프를 따른다'), null);
    assert.equal(classifyLine(numberItem, '41 건을 처리했다'), null, '이름 없는 숫자는 재서술이 아니다');
  });

  it('이름에서 먼 숫자는 그 항목의 값으로 읽지 않는다', () => {
    const near = '1차 전환 49 건';
    const far = `1차 전환 대상은 다음 분기로 미루며 세부 일정은 아직 잡히지 않았고 담당도 미정이다. 그때 49 건을 본다`;
    assert.equal(classifyLine(numberItem, near).match, 'different');
    assert.equal(classifyLine(numberItem, far), null);
    assert.equal(valueWindow('1차 전환 49 건', '1차 전환').includes('49'), true);
  });

  it('다음 문장의 숫자는 다른 주장의 수다 (회귀)', () => {
    // 실측 오검출: `기능블록`(214) 의 값으로 뒤 문장의 `6`(앞 문단이 말한 배포단위 수)이 읽혀
    // 차단으로 확정됐다. 문장을 넘어간 수는 이 항목의 값이 아니다.
    const item = { name: '기능블록', value: '214' };
    const line =
      '배포단위 6에 속하지 않으므로, 그 유래 기능블록에서 나온 조각은 **소유를 비운다.** ' +
      '없는 주인을 6 중에서 골라 채우지 않는다.';
    assert.equal(classifyLine(item, line), null);
    assert.equal(valueWindow(normalizeText(line), '기능블록').includes('6 중'), false);
    // 같은 문장 안이면 그대로 잡는다 — 문장 경계가 검출을 끄는 스위치가 되면 안 된다.
    assert.equal(classifyLine(item, '그 유래 기능블록은 6 이다').match, 'different');
  });

  it('ASCII 이름은 단어 경계를 요구한다', () => {
    assert.equal(containsName('usedby is 3', 'usedBy'), true);
    assert.equal(containsName('usedbytiles is 3', 'usedBy'), false);
    assert.equal(containsName('커버리지는 72% 다', '커버리지'), true);
  });

  it('식별자 안에 든 부분 일치는 이름을 부른 자리가 아니다', () => {
    assert.equal(containsName('현행 레포 bluebird-portal-web 를 4 개로 나눈다', 'portal'), false);
    assert.equal(containsName('portal 은 20 개다', 'portal'), true);
    assert.equal(containsName('room-registry.json 을 읽는다', 'room-registry.json'), true);
  });

  it('차례를 부르는 숫자와 절 번호는 측정값이 아니다', () => {
    const stage = { name: 'assignedTo', value: '1단계 · 코드 안 봄' };
    // 측정값으로 읽으면 "1" 과 다른 아무 숫자나 갈라진 복제가 된다. 서술값이므로 토큰 대조로 간다.
    assert.equal(classifyLine(stage, 'assignedTo 판정은 6 개 제품을 대상으로 한다'), null);
    const section = { name: '타일', value: '§7.1' };
    assert.equal(classifyLine(section, '타일 4 개를 옮긴다'), null);
  });

  it('이름에 붙은 숫자는 세어진 수가 아니다', () => {
    assert.deepEqual(extractNumbers('214개를 옮긴다'), [], '수량 접미사가 붙으면 이름 쪽이다');
    assert.deepEqual(extractNumbers('adr-021 을 따른다'), [], '식별자의 일련번호');
    assert.deepEqual(extractNumbers('r121 사용'), []);
    assert.deepEqual(extractNumbers('i18n 번들'), []);
    assert.deepEqual(extractNumbers('비율은 1:1 이다'), [], '비율은 세어진 수가 아니다');
    assert.deepEqual(extractNumbers('1,200 건'), [1200]);
    assert.deepEqual(extractNumbers('3.5'), [3.5]);
    assert.deepEqual(extractNumbers('61 (console 38 · portal 20 · widget 3)'), [61, 38, 20, 3]);
  });

  it('제목 번호와 목록 차례는 값 자리에 들이지 않는다', () => {
    assert.equal(withoutStructuralMarkers('### 5.2 조각은 슬롯으로 꽂는다'), '### 조각은 슬롯으로 꽂는다');
    assert.equal(withoutStructuralMarkers('6. **RoomPanel 해체**'), '**RoomPanel 해체**');
    assert.equal(withoutStructuralMarkers('2026-05-20 에 잠근다'), '2026-05-20 에 잠근다', '날짜는 차례가 아니다');
    const item = { name: 'RoomPanel', value: '2' };
    assert.equal(classifyLine(item, '6. **RoomPanel 해체**'), null);
  });

  it('창이 토큰을 자르면 남은 조각을 버린다', () => {
    const tail = `타일${' '.repeat(27)}r121 사용`;
    assert.equal(valueWindow(tail, '타일').includes('1'), false, '잘린 r12 의 꼬리가 수로 둔갑하면 안 된다');
    const head = `adr-021${' '.repeat(27)}타일`;
    assert.equal(valueWindow(head, '타일').includes('21'), false);
  });

  it('값이 데리고 다니는 말이 그 수의 주어다', () => {
    const item = { name: '전환 게이트', value: '배포단위 6' };
    assert.equal(classifyLine(item, '전환 게이트는 배포단위 6 개에 건다').match, 'same');
    assert.equal(classifyLine(item, '전환 게이트는 배포단위 4 개에 건다').match, 'different', '같은 주어면 갈라진 값을 잡는다');
    assert.equal(classifyLine(item, '전환 게이트는 타일 4 개를 가른다'), null, '다른 주어의 수');
    // 값이 숫자뿐이면 주어를 밝힐 말이 없어 이 제약을 걸지 않는다.
    assert.equal(classifyLine({ name: '1차 전환', value: '41' }, '1차 전환 대상은 49 개다').match, 'different');
  });

  it('교차표의 칸은 열 이름을 밝힌 자리하고만 대조한다', () => {
    const cell = { name: 'portal', value: '20', column: '등록 타일', cross_tab: true };
    assert.equal(classifyLine(cell, 'portal 의 등록 타일은 17 개다').match, 'different');
    assert.equal(classifyLine(cell, 'portal 만 BookingContext 를 10개 라우트에 얹는다'), null);
    // 측정 열이 하나인 표의 행 이름은 곧 사실 이름이라 이 제약을 받지 않는다.
    const single = { name: '1차 전환', value: '41', column: '개수', cross_tab: false };
    assert.equal(classifyLine(single, '1차 전환 대상은 49 개다').match, 'different');
  });

  it('다른 표의 다른 열에 있는 숫자는 같은 사실이 아니다', () => {
    const item = { name: '1차 전환', value: '41', column: '개수', cross_tab: false };
    const other = columnsOf(['| 구분 | 잔여 |', '| --- | --- |', '| 1차 전환 | 49 |'].join('\n'));
    const same = columnsOf(['| 구분 | 개수 |', '| --- | --- |', '| 1차 전환 | 49 |'].join('\n'));
    assert.equal(classifyLine(item, '| 1차 전환 | 49 |', other), null);
    assert.equal(classifyLine(item, '| 1차 전환 | 49 |', same).match, 'different');
  });

  it('서술값은 유의 토큰 포함률로 본다 — 전부면 전문 복제, 절반 이상이면 부분 반영', () => {
    assert.equal(significantTokens(ruleItem.value).length, 12);

    const full = '전환 게이트는 의존수가 임계를 넘고 검토자가 2명 이상이면 통과시킨다. 단 면제신청 라벨이 붙은 건은 예외다.';
    const stale = '전환 게이트는 의존수가 임계를 넘고 검토자가 2명 이상이면 통과시킨다.';
    const mention = '전환 게이트 판정 결과는 활동 로그에 남긴다.';

    assert.equal(classifyLine(ruleItem, full).match, 'same');
    const partial = classifyLine(ruleItem, stale);
    assert.equal(partial.match, 'partial');
    assert.ok(partial.missing_tokens.includes('면제신청'));
    assert.equal(classifyLine(ruleItem, mention), null);
  });
});

describe('인용 판별', () => {
  it('상대 경로와 매니페스트 id 참조 둘 다 소유 문서로 해석된다', () => {
    assert.equal(linksToOwner('scope-table.md', 'quality-targets.md', 'scope-table.md'), true);
    assert.equal(linksToOwner('../rules/transition-gate.md', 'gates/a.md', 'rules/transition-gate.md'), true);
    assert.equal(linksToOwner('scope-table.md#s2', 'quality-targets.md', 'scope-table.md'), true);
    assert.equal(linksToOwner('#doc/scope-table', 'quality-targets.md', 'scope-table.md'), true);
    assert.equal(linksToOwner('#s2', 'quality-targets.md', 'scope-table.md'), false);
    assert.equal(linksToOwner('https://example.com/scope-table.md', 'quality-targets.md', 'scope-table.md'), false);
    assert.equal(linksToOwner('glossary.md', 'quality-targets.md', 'scope-table.md'), false);
  });

  it('인용은 그 줄 또는 그 줄이 속한 절 안에 있어야 한다', () => {
    const corpus = loadCorpus(context, { parse: true });
    const doc = corpus.documents.find((document) => document.path === 'gate-policy.md');
    assert.equal(citesOwner(doc, 5, 'scope-table.md'), true, '§1 — 같은 줄의 링크');
    assert.equal(citesOwner(doc, 11, 'scope-table.md'), true, '§2 — 같은 절 앞줄의 링크');
    assert.equal(citesOwner(doc, 15, 'scope-table.md'), false, '§3 — 다른 절의 링크는 가려주지 않는다');
  });
});

describe('링크 없는 재서술', () => {
  it('소유 문서의 실측값을 링크 없이 다시 적은 줄이 후보로 올라온다', () => {
    const candidate = candidateFor('커버리지');
    assert.equal(candidate.owner_doc, 'scope-table.md');
    assert.equal(candidate.what, '범위 표 수치');
    assert.deepEqual(locationsOf(candidate), ['quality-targets.md:5']);
    assert.equal(candidate.duplicate_locations[0].value_match, 'same');
    assert.match(candidate.duplicate_locations[0].quote, /현행 커버리지 64%/);
  });

  it('후보는 소유자 문서와 소유 항목을 함께 제시한다', () => {
    const candidate = candidateFor('커버리지');
    assert.equal(candidate.item.line, 9);
    assert.equal(candidate.item.value, '64%');
    assert.match(candidate.item.quote, /\| 커버리지 \| 64% \|/);
    assert.match(candidate.why, /링크 없이/);
  });

  it('링크로 인용만 한 곳은 후보가 아니다', () => {
    const cited = ['gate-policy.md:5', 'gate-policy.md:11', 'gates/cited.md:7'];
    const reported = result.candidates.flatMap(locationsOf);
    for (const location of cited) assert.ok(!reported.includes(location), `${location} 은 인용이다`);
  });

  it('다른 절에서 링크 없이 다시 적으면 후보가 된다', () => {
    assert.deepEqual(locationsOf(candidateFor('2차 전환')), ['gate-policy.md:15']);
  });

  it('값을 다시 적지 않은 단순 언급은 후보가 아니다', () => {
    const reported = result.candidates.flatMap(locationsOf);
    assert.ok(!reported.some((location) => location.startsWith('activity-log.md')));
  });

  it('코드 블록 안의 값은 재서술로 읽지 않는다', () => {
    const nfr = readFileSync(fixture('ownership', 'docs', 'quality-targets.md'), 'utf8');
    assert.match(nfr, /"커버리지": "51%"/, '픽스처가 코드 블록에 다른 값을 갖고 있어야 의미가 있는 검사다');

    const reported = [...result.candidates.flatMap(locationsOf), ...result.findings.flatMap((f) => f.locations.map((l) => `${l.file}:${l.line}`))];
    assert.ok(!reported.includes('quality-targets.md:13'));
  });
});

describe('이미 갈라진 복제는 확정 위반', () => {
  const [finding] = findingsOf('ownership.drifted-copy');

  it('소유 문서와 다른 값을 적은 곳은 최고 심각도로 확정된다', () => {
    assert.equal(findingsOf('ownership.drifted-copy').length, 1);
    assert.equal(finding.axis, AXIS);
    assert.equal(finding.severity, 'block');
    assert.deepEqual(validateFinding(finding), []);
  });

  it('고쳐야 할 곳이 locations[0], 소유 문서가 마지막에 온다', () => {
    assert.deepEqual(finding.locations[0], {
      file: 'phase-notes.md',
      line: 5,
      quote: '1차 전환 대상은 49 개이고, 나머지는 다음 분기로 미룬다.',
    });
    assert.deepEqual(finding.locations.at(-1), {
      file: 'scope-table.md',
      line: 10,
      quote: '| 1차 전환 | 41 |',
    });
  });

  it('payload 가 소유자·복제 위치·갈라진 내역을 담는다', () => {
    assert.equal(finding.payload.owner_doc, 'scope-table.md');
    assert.equal(finding.payload.what, '범위 표 수치');
    assert.equal(finding.payload.already_drifted, true);
    assert.deepEqual(finding.payload.duplicate_locations.map((l) => `${l.file}:${l.line}`), ['phase-notes.md:5']);
    assert.deepEqual(finding.payload.drift_detail, [
      { file: 'phase-notes.md', line: 5, owner_values: [41], found_values: [49] },
    ]);
    assert.match(finding.message, /41/);
    assert.match(finding.message, /49/);
  });

  it('확정된 위반은 후보로 중복 보고하지 않는다', () => {
    const reported = result.candidates.flatMap(locationsOf);
    assert.ok(!reported.includes('phase-notes.md:5'));
  });
});

describe('같은 규칙의 부분 반영 드리프트', () => {
  const candidate = candidateFor('전환 게이트');

  it('복제된 5곳을 하나의 후보에 모두 나열한다', () => {
    assert.deepEqual(locationsOf(candidate), [
      'gates/a.md:5',
      'gates/b.md:5',
      'gates/c.md:5',
      'gates/d.md:5',
      'gates/e.md:5',
    ]);
    assert.equal(candidate.owner_doc, 'rules/transition-gate.md');
    assert.equal(candidate.hint, '게이트 통과 조건 전문');
  });

  it('최신 조건을 반영한 2곳과 낡은 3곳이 구분된다', () => {
    const byState = (match) =>
      candidate.duplicate_locations.filter((l) => l.value_match === match).map((l) => l.file);
    assert.deepEqual(byState('same'), ['gates/a.md', 'gates/b.md']);
    assert.deepEqual(byState('partial'), ['gates/c.md', 'gates/d.md', 'gates/e.md']);
  });

  it('낡은 곳마다 무엇이 빠졌는지 그대로 실린다 — 계약이 조건 누락인지 축약인지 가른다', () => {
    for (const location of candidate.duplicate_locations.filter((l) => l.value_match === 'partial')) {
      assert.deepEqual(location.missing_tokens, ['면제신청', '라벨이', '붙은', '건은', '예외다']);
      assert.ok(location.coverage >= 0.5 && location.coverage < 1);
    }
  });
});

describe('축 실행 계약', () => {
  it('config 에 ownership 선언이 없으면 사유와 함께 skipped 로 보고한다', () => {
    const bare = runOwnershipCheck(loadConfig(fixture('ownership', 'dck.no-ownership.config.json')));
    assert.equal(bare.stats.skipped, true);
    assert.match(bare.stats.skip_reason, /ownership 선언이 없다/);
    assert.deepEqual(bare.findings, []);
  });

  it('소유 문서가 검사 대상에 없으면 조용히 통과하지 않는다', () => {
    const missing = runOwnershipCheck(loadConfig(fixture('ownership', 'dck.missing-owner.config.json')));
    const [finding] = missing.findings;
    assert.equal(finding.code, 'ownership.owner-missing');
    assert.equal(finding.severity, 'block');
    assert.equal(finding.payload.owner_doc, 'wiring-spec.md');
    assert.equal(finding.locations[0].file, 'dck.missing-owner.config.json');
    assert.match(finding.message, /검사 대상 문서 집합에 없다/);
  });

  it('stats 가 검사한 문서 수와 제외 사유를 남긴다', () => {
    assert.equal(result.stats.skipped, false);
    assert.equal(result.stats.files_scanned, 12);
    assert.ok(Array.isArray(result.stats.excluded));

    const missing = runOwnershipCheck(loadConfig(fixture('ownership', 'dck.missing-owner.config.json')));
    assert.ok(missing.stats.excluded.length > 0);
    assert.ok(missing.stats.excluded.every((entry) => entry.reason.length > 0));
  });

  it('모든 findings 가 봉투 형식을 지킨다', () => {
    for (const finding of result.findings) assert.deepEqual(validateFinding(finding), []);
  });

  it('CLI 로 부르면 stdout 에 JSON 한 덩어리를 내고 0 으로 끝난다', () => {
    const stdout = execFileSync(process.execPath, [CHECK, '--config', CONFIG], { encoding: 'utf8' });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.axis, AXIS);
    assert.equal(parsed.findings.length, result.findings.length);
    assert.equal(parsed.candidates.length, result.candidates.length);
  });

  it('config 인자가 없으면 사유를 stderr 에 내고 0 이 아닌 코드로 끝난다', () => {
    assert.throws(
      () => execFileSync(process.execPath, [CHECK], { encoding: 'utf8', stdio: 'pipe' }),
      (error) => error.status !== 0 && /--config/.test(error.stderr),
    );
  });
});

describe('판단 계약', () => {
  const contract = readFileSync(resolve(REPO_ROOT, 'core/axes/ownership/contract.md'), 'utf8');

  it('구현 계약이 정한 섹션을 모두 갖는다', () => {
    for (const heading of ['# 소유 중복', '## 입력', '## 판정 기준', '## 반드시 지킬 것', '## 출력']) {
      assert.ok(contract.includes(heading), `${heading} 이 없다`);
    }
  });

  it('반드시 지킬 것 4항을 담는다', () => {
    const section = contract.split('## 반드시 지킬 것')[1].split('## 출력')[0];
    assert.match(section, /탐색 범위/);
    assert.match(section, /집합 성격/);
    assert.match(section, /기계 생성 파일/);
    assert.match(section, /verdict 파일 하나만/);
    assert.equal(section.match(/^\d\./gm).length, 4);
  });

  it('계약이 내는 code 를 명시하고 스크립트 소유 code 와 겹치지 않는다', () => {
    assert.match(contract, /ownership\.duplicate/);
    assert.match(contract, /ownership\.partial-update/);
    assert.match(contract, /`ownership\.drifted-copy` 는 스크립트가 소유하므로 여기서 다시 내지 않는다/);
  });

  it('후보의 실제 필드를 입력으로 설명한다', () => {
    for (const field of ['duplicate_locations', 'value_match', 'missing_tokens', 'already_drifted_locations']) {
      assert.ok(contract.includes(field), `${field} 설명이 없다`);
    }
  });
});
