import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

import {
  AXIS,
  checkTableSums,
  classifyTableNote,
  crossDocumentCandidates,
  extractProseNumbers,
  findLabelledValues,
  labelVariantsBefore,
  parseMeasuredValue,
  runMeasurements,
  runNumbersAxis,
  TOTAL_ROW_LABELS,
} from '../core/axes/numbers/check.mjs';
import { DEFAULTS, loadConfig, normalizeConfig } from '../core/lib/config.mjs';
import { loadCorpus } from '../core/lib/corpus.mjs';
import { validateFinding } from '../core/lib/findings.mjs';
import { parseMarkdown } from '../core/lib/markdown.mjs';
import { fixture } from './helpers.mjs';

const CHECK = resolve(fixture('..', '..'), 'core/axes/numbers/check.mjs');

function contextFor(name) {
  return loadConfig(fixture('numbers', name, 'dck.config.json'));
}

function runFixture(name) {
  return runNumbersAxis(contextFor(name));
}

function documentsOf(name) {
  return loadCorpus(contextFor(name), { parse: true }).documents;
}

function documentOf(name, path) {
  return documentsOf(name).find((document) => document.path === path);
}

const findingsFor = (result, file) =>
  result.findings.filter((finding) => finding.locations[0].file === file);

const tables = runFixture('tables');
const cross = runFixture('cross');
const marker = runFixture('marker');
const data = runFixture('data');

describe('축 봉투', () => {
  it('모든 finding 이 봉투 형식을 지킨다', () => {
    for (const result of [tables, cross, marker, data]) {
      assert.equal(result.axis, AXIS);
      assert.equal(result.stats.skipped, false);
      for (const finding of result.findings) {
        assert.deepEqual(validateFinding(finding), []);
        assert.ok(['block', 'warn'].includes(finding.severity), `예상 밖 severity: ${finding.severity}`);
      }
    }
  });

  it('when.requires 가 비어 있어 어떤 config 로도 건너뛰지 않는다', () => {
    assert.equal(tables.stats.files_scanned, 6);
    assert.equal(cross.stats.skipped, false);
  });

  it('실행 계약 — stdout 은 JSON 한 덩어리, 로그는 stderr, 완주하면 exit 0', () => {
    const stdout = execFileSync(process.execPath, [CHECK, '--config', fixture('numbers', 'data', 'dck.config.json')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.axis, AXIS);
    assert.ok(Array.isArray(parsed.findings));
    assert.ok(parsed.stats.files_scanned >= 1);
  });
});

describe('표 산술', () => {
  const taxonomy = findingsFor(tables, 'split-table.md');

  it('부분의 합과 표기된 합계를 함께 제시한다', () => {
    assert.equal(taxonomy.length, 1);
    const [finding] = taxonomy;
    assert.equal(finding.code, 'numbers.table-sum');
    assert.equal(finding.severity, 'block');
    assert.equal(finding.payload.parts_sum, 56);
    assert.equal(finding.payload.declared_total, 48);
    assert.deepEqual(
      finding.payload.parts.map((part) => part.value),
      [49, 5, 2],
    );
    assert.match(finding.message, /49 \+ 5 \+ 2 = 56 ≠ 48/);
  });

  it('합계 행을 첫 위치로 짚고 부분 행도 file:line + quote 로 남긴다', () => {
    const [finding] = taxonomy;
    assert.deepEqual(finding.locations[0], {
      file: 'split-table.md',
      line: 10,
      quote: '| 합계 | 48 |',
    });
    assert.deepEqual(
      finding.locations.slice(1).map((location) => location.line),
      [7, 8, 9],
    );
    assert.ok(finding.locations.every((location) => location.quote.length > 0));
  });

  it('부분 합이 합계보다 작은 표도 잡는다', () => {
    const [finding] = findingsFor(tables, 'coverage.md');
    assert.equal(finding.severity, 'block');
    assert.equal(finding.payload.direction, 'under');
    assert.equal(finding.payload.parts_sum, 30);
    assert.equal(finding.payload.declared_total, 35);
  });

  it('"계" 처럼 짧은 합계 라벨도 인식한다', () => {
    const [finding] = findingsFor(tables, 'mixed.md');
    assert.equal(finding.payload.declared_total, 12);
    assert.equal(finding.payload.parts_sum, 11);
  });

  it('합계 라벨 기본값은 numbers 블록 선언 여부와 무관하게 같다', () => {
    // tables 픽스처에는 numbers 블록이 없고 marker 픽스처에는 있다 — 기본값이 갈리면 안 된다.
    assert.deepEqual(TOTAL_ROW_LABELS, DEFAULTS.total_row_labels);
    assert.deepEqual(
      normalizeConfig({ docs: { root: 'docs' }, numbers: {} }).numbers.total_row_labels,
      DEFAULTS.total_row_labels,
    );
    assert.ok(TOTAL_ROW_LABELS.includes('계'));
  });

  it('산술이 맞는 표와 숫자가 아닌 열은 보고하지 않는다', () => {
    // mixed.md §1 은 합이 맞고 "상태" 열은 수치가 아니다 — 유일한 finding 은 §2 의 "계" 표다.
    assert.equal(findingsFor(tables, 'mixed.md').length, 1);
    assert.equal(findingsFor(tables, 'mixed.md')[0].payload.table_line, 13);
  });

  it('다중 배정 각주가 있는 표는 합이 커져도 위반이 아니다', () => {
    assert.deepEqual(findingsFor(tables, 'multi-assign.md'), []);
    const note = classifyTableNote(documentOf('tables', 'multi-assign.md'), documentOf('tables', 'multi-assign.md').parsed.tables[0]);
    assert.equal(note.kind, 'multi-assignment');
    assert.match(note.quote, /다중 배정/);
  });

  it('발췌 각주가 있는 표는 합이 작아도 위반이 아니다', () => {
    assert.deepEqual(findingsFor(tables, 'excerpt.md'), []);
    // 같은 수치의 각주 없는 표(coverage.md)는 block 이다 — 면제는 각주가 만든다.
    assert.equal(findingsFor(tables, 'coverage.md').length, 1);
  });

  it('초과를 설명하지 않는 각주가 붙어 있으면 warn 으로 낮춘다', () => {
    const [finding] = findingsFor(tables, 'annotated.md');
    assert.equal(finding.severity, 'warn');
    assert.equal(finding.payload.note.kind, 'other-note');
  });

  it('fenced code block 안의 표는 파싱 대상이 아니다', () => {
    const document = {
      path: 'fenced.md',
      parsed: parseMarkdown(
        ['```md', '| 항목 | 수 |', '| --- | --- |', '| a | 5 |', '| b | 6 |', '| 합계 | 99 |', '```'].join('\n'),
        { file: 'fenced.md' },
      ),
    };
    assert.deepEqual(checkTableSums(document), []);
  });
});

describe('문서 간 교차', () => {
  it('마커가 없으면 확정하지 않고 후보로 낸다 (기본 동작)', () => {
    assert.deepEqual(
      cross.findings.filter((finding) => finding.code === 'numbers.cross-doc'),
      [],
    );
    assert.ok(cross.candidates.length > 0);
    assert.ok(
      cross.candidates.every((candidate) => candidate.question.includes('같은 모집단')),
      '후보는 판단 계약이 무엇을 답해야 하는지 함께 실어야 한다',
    );
  });

  it('같은 라벨의 41 과 49 를 두 위치로 짚는다', () => {
    const candidate = cross.candidates.find((entry) => entry.label === '1차 전환 대상');
    assert.ok(candidate, '선언 라벨 후보가 없다');
    assert.deepEqual(candidate.distinct_values, [41, 49]);
    assert.deepEqual(
      candidate.occurrences.map((occurrence) => [occurrence.file, occurrence.line, occurrence.value]),
      [
        ['scope-table.md', 5, 41],
        ['scope-table.md', 9, 49],
      ],
    );
    assert.ok(candidate.occurrences.every((occurrence) => occurrence.quote.length > 0));
  });

  it('config numbers.labels 선언 라벨을 먼저 추적한다', () => {
    assert.equal(cross.candidates[0].label, '1차 전환 대상');
    assert.equal(cross.candidates[0].declared, true);
    assert.ok(cross.candidates.slice(1).every((candidate) => candidate.declared === false));
  });

  it('선언되지 않은 라벨도 문서를 넘어 묶는다', () => {
    const candidate = cross.candidates.find((entry) => entry.label === '호스트 표면');
    assert.deepEqual(candidate.distinct_values, [5, 6]);
    assert.deepEqual(
      candidate.occurrences.map((occurrence) => occurrence.file),
      ['phase-notes.md', 'wiring-spec.md'],
    );
  });

  it('같은 불일치를 라벨 폭마다 중복해서 내지 않는다', () => {
    // "호스트 표면" 이 채택되면 같은 위치만 담은 "표면" 묶음은 버린다.
    assert.deepEqual(
      cross.candidates.map((candidate) => candidate.label),
      ['1차 전환 대상', '호스트 표면'],
    );
  });

  it('다른 것을 세는 두 수는 묶이지 않는다 — 라벨이 다르다', () => {
    const values = cross.candidates.flatMap((candidate) => candidate.distinct_values);
    assert.ok(!values.includes(63) && !values.includes(73), '"타일 등록 73" 과 "타일 접근 63" 은 다른 라벨이다');
  });

  it('fenced code block · 코드스팬 안의 수치는 세지 않는다', () => {
    const values = extractProseNumbers(documentOf('cross', 'scope-table.md')).map((entry) => entry.value);
    assert.ok(!values.includes(999), 'fenced code block 안의 수치를 셌다');
    assert.ok(!values.includes(888), '코드스팬 안의 수치를 셌다');
    assert.ok(values.includes(41) && values.includes(49));
  });

  it('표 안의 수치는 (a) 가 소유한다 — 산문 추출이 겹쳐 세지 않는다', () => {
    const values = extractProseNumbers(documentOf('tables', 'split-table.md')).map((entry) => entry.value);
    assert.deepEqual(values, []);
  });

  it('절 번호 · 버전 · 날짜는 라벨 붙은 수치가 아니다', () => {
    const occurrences = extractProseNumbers({
      path: 'refs.md',
      parsed: parseMarkdown(
        ['## §5.1 절 참조', '', '버전 v1.4.0 은 2026-08-07 에 나왔다. 전환 대상은 41개다.'].join('\n'),
        { file: 'refs.md' },
      ),
    });
    assert.deepEqual(
      occurrences.map((entry) => entry.value),
      [41],
    );
  });

  it('라벨은 숫자 바로 앞 1~3 토큰이고 조사를 떼어 맞춘다', () => {
    assert.deepEqual(labelVariantsBefore('따라서 1차 전환 대상은 '), ['대상', '전환 대상', '1차 전환 대상']);
    assert.deepEqual(labelVariantsBefore('  '), []);
    // "41개" 에서 끊기고 남은 "중" 은 한 글자라 모집단을 지목하지 못한다.
    assert.deepEqual(labelVariantsBefore('전체 41개 중 '), []);
  });

  it('값이 하나뿐인 라벨은 후보가 아니다', () => {
    const candidates = crossDocumentCandidates([
      { file: 'a.md', line: 1, value: 5, variants: ['표면'], quote: 'x' },
      { file: 'b.md', line: 2, value: 5, variants: ['표면'], quote: 'y' },
    ]);
    assert.deepEqual(candidates, []);
  });
});

describe('마커 승격', () => {
  it('마커된 수치가 갈리면 후보가 아니라 확정 위반이다', () => {
    const crossDoc = marker.findings.filter((finding) => finding.code === 'numbers.cross-doc');
    assert.equal(crossDoc.length, 1);
    const [finding] = crossDoc;
    assert.equal(finding.severity, 'block');
    assert.equal(finding.payload.mode, 'marker');
    assert.equal(finding.payload.label, 'phase1');
    assert.deepEqual(finding.payload.distinct_values, [41, 49]);
    assert.deepEqual(
      finding.locations.map((location) => [location.file, location.line]),
      [
        ['phase-notes.md', 5],
        ['scope-table.md', 5],
      ],
    );
  });

  it('마커로 확정된 위치는 후보에서 빠진다', () => {
    const markedLines = marker.candidates.flatMap((candidate) =>
      candidate.occurrences.map((occurrence) => `${occurrence.file}:${occurrence.line}`),
    );
    assert.ok(!markedLines.includes('scope-table.md:5'));
    assert.ok(!markedLines.includes('phase-notes.md:5'));
  });

  it('마커가 없는 수치는 같은 실행에서 여전히 후보로 남는다', () => {
    const candidate = marker.candidates.find((entry) => entry.label === '미전환 잔여');
    assert.ok(candidate, '마커 승격이 무마커 후보 추출을 끄면 안 된다');
    assert.deepEqual(candidate.distinct_values, [9, 12]);
  });
});

describe('데이터 대조', () => {
  const mismatch = data.findings.find((finding) => finding.code === 'numbers.data-mismatch');

  it('문서값 · 실측 · 세는 방법을 함께 보고하고 문서가 틀렸다고 판정한다', () => {
    assert.ok(mismatch, 'data-mismatch finding 이 없다');
    assert.equal(mismatch.severity, 'block');
    assert.equal(mismatch.payload.label, '타일');
    assert.deepEqual(mismatch.payload.measured, { value: 73, method: 'node tools/count-tiles.mjs' });
    assert.equal(mismatch.payload.verdict, 'doc_wrong');
    assert.deepEqual(
      mismatch.payload.documented.map((entry) => entry.value),
      [59, 59],
    );
    assert.match(mismatch.message, /문서는 59 이라 적었는데 실측은 73 다/);
  });

  it('같은 라벨이 나온 모든 줄을 file:line 으로 짚는다', () => {
    assert.deepEqual(
      mismatch.locations.map((location) => [location.file, location.line]),
      [
        ['scope-table.md', 5],
        ['scope-table.md', 13],
      ],
    );
    assert.match(mismatch.locations[0].quote, /타일 59개/);
  });

  it('실측과 맞는 수치는 보고하지 않는다', () => {
    assert.ok(!data.findings.some((finding) => JSON.stringify(finding.payload).includes('라우트')));
  });

  it('명령이 실패한 항목은 그 항목만 unverifiable 로 보고하고 축은 완주한다', () => {
    const unverifiable = data.findings.filter((finding) => finding.code === 'numbers.unverifiable');
    assert.equal(unverifiable.length, 2);
    assert.ok(unverifiable.every((finding) => finding.severity === 'warn'));
    assert.ok(unverifiable.every((finding) => finding.payload.verdict === 'unverifiable'));

    const failed = unverifiable.find((finding) => finding.payload.label === '호스트 표면');
    assert.match(failed.payload.reason, /명령이 실패했다/);
    assert.equal(failed.locations[0].file, 'dck.config.json');
  });

  it('expect_in 문서에 그 수치가 없으면 unverifiable 이다', () => {
    const missing = data.findings.find((finding) => finding.payload?.label === '아이콘');
    assert.equal(missing.code, 'numbers.unverifiable');
    assert.match(missing.payload.reason, /찾지 못했다/);
  });

  it('타임아웃도 크래시가 아니라 unverifiable 이다', () => {
    const context = contextFor('data');
    const corpus = loadCorpus(context, { parse: true });
    const findings = runMeasurements(
      { ...context, config: { ...context.config, measurements: [{ label: '타일', cmd: 'sleep 999' }] } },
      corpus,
      {
        exec: () => {
          const error = new Error('spawn timeout');
          error.signal = 'SIGTERM';
          throw error;
        },
      },
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, 'numbers.unverifiable');
    assert.match(findings[0].payload.reason, /안에 끝나지 않았다/);
  });

  it('stdout 마지막 비어 있지 않은 줄이 실측값이다', () => {
    assert.equal(parseMeasuredValue('warning: x\n73\n'), 73);
    assert.equal(parseMeasuredValue('   1,146  \n'), 1146);
    assert.equal(parseMeasuredValue(''), null);
    assert.equal(parseMeasuredValue('없음\n'), null);
  });

  it('라벨 수치는 표 안에서도 찾는다', () => {
    const hits = findLabelledValues(documentOf('tables', 'split-table.md'), '합계');
    assert.deepEqual(
      hits.map((hit) => [hit.line, hit.value]),
      [[10, 48]],
    );
  });

  it('표 헤더의 숫자는 그 라벨의 값이 아니다 — 옆 열 이름의 일부다', () => {
    const text = [
      '| 등록 타일 | 매핑 범위 밖(§6) |',
      '| --- | --- |',
      '| 73 | 9 |',
      '',
      '등록 타일 73 개 중 9 개가 범위 밖이다.',
    ].join('\n');
    const hits = findLabelledValues({ path: 'x.md', parsed: parseMarkdown(text) }, '등록 타일');
    assert.deepEqual(
      hits.map((hit) => [hit.line, hit.value]),
      [[5, 73]],
      '헤더 줄(1)의 6 을 "등록 타일 = 6" 으로 읽지 않는다',
    );
  });

  it('절 번호·코드스팬의 숫자는 값이 아니라 참조다', () => {
    const text = [
      '전환 대상은 §5.2 가 정한다.',
      '',
      '전환 대상 키는 `verdict: 1` 이다.',
      '',
      '전환 대상은 56 건이다.',
    ].join('\n');
    const hits = findLabelledValues({ path: 'x.md', parsed: parseMarkdown(text) }, '전환 대상');
    assert.deepEqual(
      hits.map((hit) => [hit.line, hit.value]),
      [[5, 56]],
    );
  });
});

describe('라벨-수치 결합', () => {
  const hitsOf = (text, label) =>
    findLabelledValues({ path: 'x.md', parsed: parseMarkdown(text, { file: 'x.md' }) }, label).map((hit) => [
      hit.line,
      hit.value,
    ]);

  it('연결어미로 나뉜 두 절은 각자의 수치를 갖는다', () => {
    // "A개가 X이고 B개는 Y" — X 의 값은 앞 절의 A 다. 뒤 절의 B 가 더 가깝다고 그것을 집으면
    // 문서가 맞는데도 실측과 갈렸다고 차단하게 된다.
    const text = '73 타일 중 **56개가 전환 대상**이고 9개는 범위 밖이다(§6).';
    assert.deepEqual(hitsOf(text, '전환 대상'), [[1, 56]]);
    assert.deepEqual(hitsOf(text, '범위 밖'), [[1, 9]]);
  });

  it('"이며" 로 이어진 절도 같다 — 라벨 뒤 수치라고 무조건 그 라벨의 값이 아니다', () => {
    const text = '전환 대상 56개이며 범위 밖 9개다.';
    assert.deepEqual(hitsOf(text, '전환 대상'), [[1, 56]]);
    assert.deepEqual(hitsOf(text, '범위 밖'), [[1, 9]]);
  });

  it('나열 부호 너머의 수치도 다른 항목의 값이다', () => {
    const text = '전환 대상 56개, 범위 밖 9개다.';
    assert.deepEqual(hitsOf(text, '전환 대상'), [[1, 56]]);
    assert.deepEqual(hitsOf(text, '범위 밖'), [[1, 9]]);
  });

  it('앞 문장의 수치를 끌어오지 않는다 — 못 찾은 것이 틀리게 찾은 것보다 낫다', () => {
    assert.deepEqual(hitsOf('보드는 73 타일이다. 전환 대상은 다음 절이 정한다.', '전환 대상'), []);
  });

  it('같은 절 안에 양쪽 수치가 있으면 가까운 쪽이 그 라벨의 값이다', () => {
    assert.deepEqual(hitsOf('73 타일 중 전환 대상 56개다.', '전환 대상'), [[1, 56]]);
    assert.deepEqual(hitsOf('전환 대상 56개는 73 타일 기준이다.', '전환 대상'), [[1, 56]]);
  });

  it('절이 갈린 문장에서 문서와 실측이 같으면 차단하지 않는다', () => {
    const document = {
      path: 'baseline.md',
      parsed: parseMarkdown('73 타일 중 **56개가 전환 대상**이고 9개는 범위 밖이다.', { file: 'baseline.md' }),
    };
    const context = {
      repoRoot: '/repo',
      configPath: '/repo/dck.config.json',
      config: { measurements: [{ label: '전환 대상', cmd: 'node tools/count-targets.mjs' }] },
    };
    assert.deepEqual(
      runMeasurements(context, { documents: [document] }, { exec: () => '56\n' }),
      [],
      '문서의 56 을 뒤 절의 9 로 읽으면 맞는 문서가 block 된다',
    );
  });
});
