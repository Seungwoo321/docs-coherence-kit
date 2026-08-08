import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../core/lib/config.mjs';
import { CorpusError, allDocuments, expandBraces, globToRegExp, loadCorpus, matchingGlob } from '../core/lib/corpus.mjs';
import { fixture } from './helpers.mjs';

const context = loadConfig(fixture('corpus-a', 'dck.config.json'));
const corpus = loadCorpus(context, { skipDirs: ['vendor'] });

const reasonFor = (path) => corpus.excluded.find((entry) => entry.path === path)?.reason;

describe('글롭', () => {
  it('** 만 디렉토리 경계를 넘는다', () => {
    assert.equal(globToRegExp('**/*.md').test('a.md'), true);
    assert.equal(globToRegExp('**/*.md').test('x/y/a.md'), true);
    assert.equal(globToRegExp('*.md').test('x/a.md'), false);
    assert.equal(globToRegExp('notes/**').test('notes/deep/a.md'), true);
    assert.equal(globToRegExp('notes/**').test('note/a.md'), false);
  });

  it('중괄호를 편다', () => {
    assert.deepEqual(expandBraces('**/*.{md,markdown}'), ['**/*.md', '**/*.markdown']);
    assert.equal(globToRegExp('**/*.{md,markdown}').test('x/a.markdown'), true);
  });

  it('어느 패턴에 걸렸는지 돌려준다 — 사유 문구에 그대로 실린다', () => {
    assert.equal(matchingGlob('notes/scratch.md', ['docs/**', 'notes/**']), 'notes/**');
    assert.equal(matchingGlob('a.md', ['notes/**']), null);
  });
});

describe('corpus 로드', () => {
  it('include 에 걸린 문서만 검사 대상이 된다', () => {
    assert.deepEqual(
      corpus.documents.map((doc) => doc.path),
      ['glossary.md', 'scope-table.md'],
    );
    assert.equal(corpus.filesScanned, corpus.documents.length);
    assert.ok(corpus.documents.every((doc) => doc.text.length > 0));
  });

  it('parse 를 켜면 문서마다 줄 번호 보존 파싱 결과가 붙는다', () => {
    const parsedCorpus = loadCorpus(context, { parse: true, skipDirs: ['vendor'] });
    const baseline = parsedCorpus.documents.find((doc) => doc.path === 'scope-table.md');
    assert.equal(baseline.parsed.file, 'scope-table.md');
    assert.ok(baseline.parsed.headings.length > 0);
  });

  it('검사 범위에서 빠진 항목은 무엇을 왜 뺐는지 함께 남는다', () => {
    assert.deepEqual(
      corpus.excluded.map((entry) => entry.path),
      ['decisions/accepted.md', 'drafts/idea.markdown', 'notes/pinned.md', 'notes/scratch.md', 'vendor'],
    );
    assert.ok(corpus.excluded.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0));

    assert.match(reasonFor('decisions/accepted.md'), /frozen "decisions\/accepted\.md"/);
    assert.match(reasonFor('decisions/accepted.md'), /소급 편집 금지/);
    assert.match(reasonFor('notes/scratch.md'), /exclude 글롭 "notes\/\*\*"/);
    assert.match(reasonFor('drafts/idea.markdown'), /include 글롭에 걸리지 않음/);
    assert.match(reasonFor('vendor'), /기본 제외 디렉토리/);
  });

  it('제외된 문서는 검사 대상 목록에 없다 — 통과로 셀 수 없다', () => {
    const paths = corpus.documents.map((doc) => doc.path);
    for (const entry of corpus.excluded) assert.ok(!paths.includes(entry.path));
  });

  it('동결 문서는 검사 대상에서 빠지되 링크 대상 해석용으로 함께 로드된다', () => {
    assert.deepEqual(
      corpus.frozen.map((doc) => doc.path).sort((a, b) => a.localeCompare(b)),
      ['decisions/accepted.md', 'notes/pinned.md'],
    );
    const accepted = corpus.frozen.find((doc) => doc.path === 'decisions/accepted.md');
    assert.equal(accepted.frozen, true);
    assert.equal(accepted.frozenBy, 'decisions/accepted.md');
    assert.match(accepted.text, /채택된 결정/);

    assert.deepEqual(
      allDocuments(corpus).map((doc) => doc.path),
      ['decisions/accepted.md', 'glossary.md', 'notes/pinned.md', 'scope-table.md'],
    );
  });

  it('frozen 선언은 exclude 글롭보다 우선한다 — 집어 동결한 파일이 광역 제외에 지워지지 않는다', () => {
    const pinned = corpus.frozen.find((doc) => doc.path === 'notes/pinned.md');
    assert.ok(pinned, 'notes/pinned.md 가 frozen 으로 로드돼야 한다');
    assert.equal(pinned.frozenBy, 'notes/pinned.md');
    assert.match(reasonFor('notes/pinned.md'), /frozen "notes\/pinned\.md"/);
    // 겹치지 않는 이웃은 여전히 exclude 사유로 남는다 — 우선순위가 제외 선언 자체를 무너뜨리지 않는다.
    assert.match(reasonFor('notes/scratch.md'), /exclude 글롭 "notes\/\*\*"/);
  });

  it('제외 목록은 경로순으로 안정 정렬된다', () => {
    const paths = corpus.excluded.map((entry) => entry.path);
    assert.deepEqual(paths, [...paths].sort((a, b) => a.localeCompare(b)));
  });

  it('docs.root 가 없으면 사유를 담아 실패한다', () => {
    assert.throws(
      () => loadCorpus({ config: { docs: { root: 'no-such-dir' } }, repoRoot: fixture('corpus-a') }),
      CorpusError,
    );
    assert.throws(() => loadCorpus({ config: {} }), /docs\.root 가 없다/);
  });
});
