import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConfigError,
  DEFAULTS,
  hasConfigKey,
  loadConfig,
  normalizeConfig,
  parseCliArgs,
  validateConfig,
} from '../core/lib/config.mjs';
import { fixture } from './helpers.mjs';

describe('config 로더', () => {
  it('docs.root 가 없으면 사유와 함께 거절한다', () => {
    assert.deepEqual(validateConfig({ docs: {} }), ['docs.root: 필수 항목이다']);
    assert.deepEqual(validateConfig({}), ['docs: 객체여야 한다 (필수)']);
  });

  it('위반을 하나만 보고하지 않고 전부 모아 보고한다', () => {
    const problems = validateConfig({
      docs: { root: 'docs', typo: 1 },
      concepts: 'menu',
      ownership: [{ what: '용어' }],
    });
    assert.equal(problems.length, 3);
    assert.ok(problems.some((p) => p === 'docs.typo: 알 수 없는 키'));
    assert.ok(problems.some((p) => p.startsWith('concepts:')));
    assert.ok(problems.some((p) => p === 'ownership[0].owner: 필수 항목이다'));
  });

  it('schemas_complete 는 불리언만 받는다 — 닫힌 세계 선언은 명시적이어야 한다', () => {
    assert.deepEqual(validateConfig({ docs: { root: 'docs' }, schemas_complete: true }), []);
    assert.deepEqual(validateConfig({ docs: { root: 'docs' }, schemas_complete: false }), []);
    assert.deepEqual(validateConfig({ docs: { root: 'docs' }, schemas_complete: 'yes' }), [
      'schemas_complete: 불리언이어야 한다',
    ]);
  });

  it('컴파일되지 않는 marker_pattern 을 거절한다', () => {
    const problems = validateConfig({ docs: { root: 'docs' }, numbers: { marker_pattern: '([' } });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /정규식으로 컴파일되지 않는다/);
  });

  it('플러그인이 소유하는 최상위 키는 형식만 보고 통과시킨다', () => {
    assert.deepEqual(validateConfig({ docs: { root: 'docs' }, adr: { bodies: 'x.md' } }), []);
    assert.deepEqual(validateConfig({ docs: { root: 'docs' }, 'Open Issues': {} }), [
      'Open Issues: 최상위 키는 소문자 snake_case 여야 한다',
    ]);
  });

  it('기본값 out=.dck · include=**/*.md 를 채운다', () => {
    const config = normalizeConfig({ docs: { root: 'docs' } });
    assert.equal(config.out, DEFAULTS.out);
    assert.deepEqual(config.docs.include, ['**/*.md']);
    assert.deepEqual(config.docs.exclude, []);
    assert.deepEqual(config.docs.frozen, []);
    assert.deepEqual(config.plugins, []);
  });

  it('선언된 값은 기본값이 덮어쓰지 않는다', () => {
    const config = normalizeConfig({ docs: { root: 'docs', include: ['spec/*.md'] }, out: 'build/dck' });
    assert.deepEqual(config.docs.include, ['spec/*.md']);
    assert.equal(config.out, 'build/dck');
  });

  it('파일을 읽어 repoRoot·docsRoot·outDir 을 절대경로로 준다', () => {
    const context = loadConfig(fixture('corpus-a', 'dck.config.json'));
    assert.equal(context.repoRoot, fixture('corpus-a'));
    assert.equal(context.docsRoot, fixture('corpus-a', 'docs'));
    assert.equal(context.outDir, fixture('corpus-a', '.dck'));
    assert.equal(context.config.docs.frozen[0], 'decisions/accepted.md');
  });

  it('--repo 로 기준 루트를 바꿀 수 있다', () => {
    const context = loadConfig(fixture('config', 'core-only.json'), { repoRoot: fixture('config') });
    assert.equal(context.docsRoot, fixture('corpus-a', 'docs'));
  });

  it('JSON 이 깨졌거나 파일이 없으면 경로를 담은 ConfigError 를 낸다', () => {
    assert.throws(() => loadConfig(fixture('config', 'not-json.json')), ConfigError);
    assert.throws(() => loadConfig(fixture('config', 'no-such-file.json')), /읽을 수 없다/);
  });

  it('빈 배열·빈 객체 선언은 없는 것으로 본다 — 빈 선언으로 도는 축은 아무것도 보장하지 못한다', () => {
    assert.equal(hasConfigKey({ ownership: [{ what: 'a', owner: 'b.md' }] }, 'ownership'), true);
    assert.equal(hasConfigKey({ ownership: [] }, 'ownership'), false);
    assert.equal(hasConfigKey({ adr: {} }, 'adr'), false);
    assert.equal(hasConfigKey({ adr: { bodies: 'x.md' } }, 'adr'), true);
    assert.equal(hasConfigKey({}, 'ownership'), false);
  });

  it('축 실행 계약의 --config / --repo 인자를 판다', () => {
    assert.deepEqual(parseCliArgs(['--config', 'dck.config.json']), {
      config: 'dck.config.json',
      repo: undefined,
    });
    assert.deepEqual(parseCliArgs(['--config=a.json', '--repo=/tmp/x']), { config: 'a.json', repo: '/tmp/x' });
    assert.throws(() => parseCliArgs([]), /--config/);
    assert.throws(() => parseCliArgs(['--config']), /값이 없다/);
    assert.throws(() => parseCliArgs(['--verbose']), /알 수 없는 인자/);
  });
});
