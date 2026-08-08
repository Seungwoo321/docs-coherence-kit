/**
 * 새 문서 집합에 붙일 때 코드 수정 없이 선언 파일만으로 동작하는가.
 * 같은 코드 경로에 서로 다른 dck.config.json 을 물려 결과가 선언을 따라가는지 본다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../core/lib/config.mjs';
import { loadCorpus } from '../core/lib/corpus.mjs';
import { loadAxes } from '../core/lib/manifest.mjs';
import { fixture } from './helpers.mjs';

function attach(configPath, options = {}) {
  const context = loadConfig(configPath);
  return {
    context,
    corpus: loadCorpus(context, options),
    axes: loadAxes(context.config),
  };
}

describe('선언만으로 새 문서 집합에 붙는다', () => {
  const a = attach(fixture('corpus-a', 'dck.config.json'), { skipDirs: ['vendor'] });
  const b = attach(fixture('corpus-b', 'dck.config.json'));

  it('검사 대상이 config 의 root·include 를 따라간다', () => {
    assert.equal(a.context.docsRoot, fixture('corpus-a', 'docs'));
    assert.equal(b.context.docsRoot, fixture('corpus-b', 'handbook'));
    assert.deepEqual(a.corpus.documents.map((doc) => doc.path), ['glossary.md', 'scope-table.md']);
    assert.deepEqual(b.corpus.documents.map((doc) => doc.path), ['index.md', 'rules.md']);
  });

  it('소유 표가 config 선언 그대로 실린다 — 코드에는 소유자가 없다', () => {
    assert.deepEqual(a.context.config.ownership, [
      { what: '용어 정의', owner: 'glossary.md' },
      { what: '범위 표 수치', owner: 'scope-table.md' },
    ]);
    assert.deepEqual(b.context.config.ownership, [{ what: '규칙 정의', owner: 'rules.md' }]);

    // 선언된 소유 문서는 실제 검사 대상 안에 있다.
    for (const set of [a, b]) {
      const paths = set.corpus.documents.map((doc) => doc.path);
      for (const entry of set.context.config.ownership) assert.ok(paths.includes(entry.owner));
    }
  });

  it('핵심 개념도 선언을 따라간다', () => {
    assert.deepEqual(a.context.config.concepts, ['타일', '기능블록', '호스트']);
    assert.deepEqual(b.context.config.concepts, ['규칙', '예외']);
  });

  it('두 집합 모두 같은 축 목록을 같은 상태로 얻는다 — 갈아끼운 것은 선언뿐이다', () => {
    const names = (set) => set.axes.map((axis) => axis.name);
    assert.deepEqual(names(a), names(b));
    assert.ok(a.axes.every((axis) => axis.state === 'active'));
    assert.ok(b.axes.every((axis) => axis.state === 'active'));
  });

  it('산출 디렉토리도 선언을 따른다', () => {
    assert.equal(a.context.outDir, fixture('corpus-a', '.dck'));
    assert.equal(b.context.outDir, fixture('corpus-b', 'build', 'dck'));
  });

  it('소유 선언을 뺀 집합에서는 그 축만 사유와 함께 빠진다', () => {
    const coreOnly = attach(fixture('config', 'core-only.json'));
    const ownership = coreOnly.axes.find((axis) => axis.name === 'ownership');
    assert.equal(ownership.state, 'skipped');
    assert.match(ownership.reason, /"ownership"/);
    assert.equal(coreOnly.axes.filter((axis) => axis.state === 'active').length, 3);
  });
});
