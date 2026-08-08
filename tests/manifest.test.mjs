import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

import { normalizeConfig } from '../core/lib/config.mjs';
import {
  KIT_ROOT,
  ManifestError,
  loadAxes,
  loadManifest,
  mergeManifests,
  resolveAxes,
  resolvePluginManifestPaths,
  validateManifest,
} from '../core/lib/manifest.mjs';
import { fixture } from './helpers.mjs';

const coreOnly = normalizeConfig({ docs: { root: 'docs' } });
const withOwnership = normalizeConfig({
  docs: { root: 'docs' },
  ownership: [{ what: '용어 정의', owner: 'glossary.md' }],
});

describe('축 매니페스트', () => {
  it('코어 매니페스트는 4축을 선등록한다', () => {
    const { axes } = loadManifest(resolve(KIT_ROOT, 'core', 'manifest.json'));
    assert.deepEqual(
      axes.map((axis) => axis.name),
      ['numbers', 'ownership', 'concepts', 'links'],
    );
    assert.deepEqual(
      axes.map((axis) => axis.kind),
      ['script', 'hybrid', 'hybrid', 'script'],
    );
  });

  it('run 경로를 매니페스트 파일 기준으로 해석한다', () => {
    const { axes } = loadManifest(resolve(KIT_ROOT, 'core', 'manifest.json'));
    const ownership = axes.find((axis) => axis.name === 'ownership');
    assert.equal(ownership.scriptPath, resolve(KIT_ROOT, 'core/axes/ownership/check.mjs'));
    assert.equal(ownership.contractPath, resolve(KIT_ROOT, 'core/axes/ownership/contract.md'));
  });

  it('kind 별로 필요한 run 항목을 강제한다', () => {
    const problems = validateManifest({
      axes: [
        { name: 'a', kind: 'script', run: {} },
        { name: 'b', kind: 'hybrid', run: { script: 'x.mjs' } },
        { name: 'c', kind: 'judgment', run: { script: 'x.mjs', contract: 'c.md' } },
      ],
    });
    assert.ok(problems.some((p) => p === 'axes[0].run.script: kind=script 축에는 필수다'));
    assert.ok(problems.some((p) => p === 'axes[1].run.contract: kind=hybrid 축에는 필수다'));
    assert.ok(problems.some((p) => p === 'axes[2].run.script: kind=judgment 축은 스크립트를 갖지 않는다'));
  });

  it('이름 형식·kind·알 수 없는 키를 거절한다', () => {
    assert.throws(() => loadManifest(fixture('manifests', 'invalid-kind.json')), (error) => {
      assert.ok(error instanceof ManifestError);
      assert.ok(error.problems.some((p) => p.startsWith('axes[0].name:')));
      assert.ok(error.problems.some((p) => p.startsWith('axes[0].kind:')));
      assert.ok(error.problems.some((p) => p === 'axes[0].cadence: 알 수 없는 키'));
      return true;
    });
  });

  it('축 이름이 겹치면 두 출처를 밝히고 throw 한다 — 이름은 전역 유일하다', () => {
    const core = loadManifest(resolve(KIT_ROOT, 'core', 'manifest.json'));
    const collision = loadManifest(fixture('manifests', 'collision.json'));
    assert.throws(() => mergeManifests([core, collision]), (error) => {
      assert.ok(error instanceof ManifestError);
      assert.match(error.message, /축 이름 충돌: "numbers"/);
      assert.match(error.message, /collision\.json/);
      return true;
    });
  });

  it('when.requires 를 못 채운 축은 조용히 빠지지 않고 사유와 함께 skipped 로 보고된다', () => {
    const axes = loadAxes(coreOnly);
    const ownership = axes.find((axis) => axis.name === 'ownership');

    assert.equal(ownership.state, 'skipped');
    assert.match(ownership.reason, /"ownership"/);
    assert.match(ownership.reason, /건너뜀/);

    // 나머지 3축은 선언 없이도 돈다.
    assert.deepEqual(
      axes.filter((axis) => axis.state === 'active').map((axis) => axis.name),
      ['numbers', 'concepts', 'links'],
    );
    assert.ok(axes.every((axis) => axis.state === 'active' || typeof axis.reason === 'string'));
  });

  it('코어만 설치하면 플러그인 축은 목록에 오르지도 않는다', () => {
    const axes = loadAxes(coreOnly);
    assert.deepEqual(
      axes.map((axis) => axis.name),
      ['numbers', 'ownership', 'concepts', 'links'],
    );
    assert.equal(axes.find((axis) => axis.name === 'decisions'), undefined);
  });

  it('플러그인을 설치해도 그 설정 키가 없으면 축은 사유와 함께 skipped 다', () => {
    const kitRoot = fixture('kit');
    const declared = normalizeConfig({ docs: { root: 'docs' }, plugins: ['adr'] });
    const configured = normalizeConfig({
      docs: { root: 'docs' },
      plugins: ['adr'],
      adr: { bodies: 'decisions/accepted.md' },
    });

    const skipped = loadAxes(declared, { kitRoot }).find((axis) => axis.name === 'decisions');
    assert.equal(skipped.state, 'skipped');
    assert.match(skipped.reason, /"adr"/);

    const active = loadAxes(configured, { kitRoot }).find((axis) => axis.name === 'decisions');
    assert.equal(active.state, 'active');
    assert.equal(active.severity_cap, 'block');
  });

  it('config 가 선언한 플러그인이 설치돼 있지 않으면 조용히 넘기지 않고 throw 한다', () => {
    const config = normalizeConfig({ docs: { root: 'docs' }, plugins: ['does-not-exist'] });
    assert.throws(() => resolvePluginManifestPaths(config, { kitRoot: fixture('kit') }), /설치돼 있지 않다/);
  });

  it('선언이 채워지면 같은 축이 사유 없이 active 로 바뀐다 — 코드는 그대로다', () => {
    const { axes } = loadManifest(resolve(KIT_ROOT, 'core', 'manifest.json'));
    const ownership = resolveAxes(axes, withOwnership).find((axis) => axis.name === 'ownership');
    assert.equal(ownership.state, 'active');
    assert.equal(ownership.reason, undefined);

    // 판정을 다시 돌려도 앞선 사유가 남지 않는다.
    const twice = resolveAxes(resolveAxes(axes, coreOnly), withOwnership);
    assert.equal(twice.find((axis) => axis.name === 'ownership').reason, undefined);
  });

  it('등록된 축의 파일 실재는 checkExists 로 따로 확인한다', () => {
    assert.throws(
      () => loadManifest(fixture('kit', 'core', 'manifest.json'), { checkExists: true }),
      /등록된 축의 파일이 없다/,
    );
  });
});
