import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  findHeadingBySection,
  isInsideFence,
  lineText,
  parseMarkdown,
  parseSectionNumber,
  slugify,
  splitTableCells,
} from '../core/lib/markdown.mjs';
import { fixture } from './helpers.mjs';

// 줄 번호를 그대로 단언하기 위해 줄 단위로 조립한다.
const DOC = [
  '# 제목', // 1
  '', // 2
  '## §2 분류', // 3
  '', // 4
  '| 구분 | 개수 |', // 5
  '| --- | ---: |', // 6
  '| 1차 전환 | 41 |', // 7
  '| 합계 \\| 계 | 50 |', // 8
  '', // 9
  '[타일](#doc/glossary) 를 본다.', // 10
  '', // 11
  '```json', // 12
  '# 헤딩이 아니다', // 13
  '| 표 | 아니다 |', // 14
  '[가짜](#doc/none)', // 15
  '```', // 16
  '', // 17
  '`usedByTiles` 는 실재한다.', // 18
  '`[코드 안 링크](#none)` 는 링크가 아니다.', // 19
  '## 제목', // 20
  '## 제목', // 21
].join('\n');

const parsed = parseMarkdown(DOC, { file: 'sample.md' });

describe('마크다운 파서 — 헤딩', () => {
  it('level·text·line 을 보존한다', () => {
    assert.equal(parsed.headings.length, 4);
    assert.deepEqual(
      parsed.headings.map((h) => [h.level, h.text, h.line]),
      [
        [1, '제목', 1],
        [2, '§2 분류', 3],
        [2, '제목', 20],
        [2, '제목', 21],
      ],
    );
  });

  it('§ 절 번호를 뽑는다', () => {
    assert.equal(parsed.headings[1].section, '2');
    assert.equal(parsed.headings[0].section, null);
    assert.equal(parseSectionNumber('§5.1 무엇'), '5.1');
    assert.equal(parseSectionNumber('5.1 무엇'), '5.1');
    assert.equal(parseSectionNumber('§6'), '6');
    assert.equal(parseSectionNumber('2026년 계획'), null);
  });

  it('앵커를 만들고 같은 제목은 -1, -2 로 가른다', () => {
    assert.equal(slugify('§2 분류'), '2-분류');
    assert.deepEqual(
      parsed.headings.filter((h) => h.text === '제목').map((h) => h.anchor),
      ['제목', '제목-1', '제목-2'],
    );
  });

  it('절 번호로 헤딩을 찾는다 — 없는 절은 null', () => {
    assert.equal(findHeadingBySection(parsed, '§2').line, 3);
    assert.equal(findHeadingBySection(parsed, '2').text, '§2 분류');
    assert.equal(findHeadingBySection(parsed, '6'), null);
  });
});

describe('마크다운 파서 — 표', () => {
  it('헤더·정렬·행을 줄 번호와 함께 준다', () => {
    assert.equal(parsed.tables.length, 1);
    const [table] = parsed.tables;
    assert.deepEqual(table.header, ['구분', '개수']);
    assert.deepEqual(table.alignments, [null, 'right']);
    assert.equal(table.line, 5);
    assert.equal(table.endLine, 8);
    assert.deepEqual(
      table.rows.map((row) => [row.line, row.cells]),
      [
        [7, ['1차 전환', '41']],
        [8, ['합계 | 계', '50']],
      ],
    );
  });

  it('이스케이프한 파이프는 셀을 가르지 않는다', () => {
    assert.deepEqual(splitTableCells('| a \\| b | c |'), ['a | b', 'c']);
    assert.deepEqual(splitTableCells('a | b'), ['a', 'b']);
  });

  it('구분선이 없으면 표가 아니다', () => {
    const notTable = parseMarkdown(['| a | b |', '내용 | 내용'].join('\n'));
    assert.equal(notTable.tables.length, 0);
  });
});

describe('마크다운 파서 — 링크·코드스팬', () => {
  it('인라인 링크의 표시명·대상·줄을 준다', () => {
    assert.deepEqual(
      parsed.links.map((link) => [link.text, link.target, link.line]),
      [['타일', '#doc/glossary', 10]],
    );
  });

  it('이미지는 링크와 구분한다', () => {
    const withImage = parseMarkdown('![도표](img/a.png) 와 [글](b.md)');
    assert.deepEqual(
      withImage.links.map((link) => [link.isImage, link.target]),
      [
        [true, 'img/a.png'],
        [false, 'b.md'],
      ],
    );
  });

  it('코드스팬 안의 링크는 링크가 아니다', () => {
    assert.ok(!parsed.links.some((link) => link.target === '#none'));
  });

  it('백틱 런을 짝지어 코드스팬을 준다', () => {
    const span = parsed.codeSpans.find((s) => s.line === 18);
    assert.equal(span.text, 'usedByTiles');
    assert.equal(span.column, 1);

    const double = parseMarkdown('``a `b` c`` 끝');
    assert.equal(double.codeSpans[0].text, 'a `b` c');
  });
});

describe('마크다운 파서 — fenced code block', () => {
  it('범위를 보고한다', () => {
    assert.deepEqual(parsed.fences, [{ start: 12, end: 16, marker: '```', info: 'json', closed: true }]);
    assert.equal(isInsideFence(parsed, 13), true);
    assert.equal(isInsideFence(parsed, 17), false);
  });

  it('코드블록 안의 헤딩·표·링크는 파싱하지 않는다', () => {
    assert.ok(!parsed.headings.some((h) => h.line === 13));
    assert.ok(!parsed.tables.some((t) => t.line === 14));
    assert.ok(!parsed.links.some((l) => l.line === 15));
  });

  it('닫히지 않은 펜스는 문서 끝까지로 보고 그 사실을 남긴다', () => {
    const unclosed = parseMarkdown(['본문', '~~~', '# 안 닫힘'].join('\n'));
    assert.deepEqual(unclosed.fences, [{ start: 2, end: 3, marker: '~~~', info: '', closed: false }]);
    assert.equal(unclosed.headings.length, 0);
  });
});

describe('마크다운 파서 — 픽스처 문서', () => {
  const doc = readFileSync(fixture('corpus-a', 'docs', 'scope-table.md'), 'utf8');
  const baseline = parseMarkdown(doc, { file: 'scope-table.md' });

  it('§ 절을 전부 찾는다', () => {
    assert.deepEqual(
      baseline.headings.filter((h) => h.section).map((h) => h.section),
      ['1', '2', '2.1', '3'],
    );
  });

  it('합계 행을 표에서 찾아 줄 번호로 인용할 수 있다', () => {
    const table = baseline.tables[0];
    const total = table.rows.find((row) => row.cells[0] === '합계');
    assert.equal(total.cells[1], '48');
    assert.match(lineText(baseline, total.line), /합계/);
  });

  it('코드블록 안의 가짜 링크는 세지 않는다', () => {
    assert.ok(!baseline.links.some((link) => link.target === '#doc/none'));
    assert.deepEqual(
      baseline.links.map((link) => link.target),
      ['#doc/glossary', '#doc/access-policy', '#doc/access-policy'],
    );
  });
});
