/**
 * 스키마는 이 키트가 대외에 내놓는 계약이고, lib 의 검증기는 그 계약의 런타임 구현이다.
 * 둘이 갈라지면 축 작성자가 읽는 형식과 실제로 통과하는 형식이 달라진다 — 그 드리프트를 여기서 막는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { DOCS_KEYS } from '../core/lib/config.mjs';
import { FINDING_KEYS, LOCATION_KEYS, SEVERITIES } from '../core/lib/findings.mjs';
import { AXIS_KEYS, AXIS_KINDS, KIT_ROOT, SEVERITY_CAPS } from '../core/lib/manifest.mjs';

const load = (name) => JSON.parse(readFileSync(resolve(KIT_ROOT, 'schemas', `${name}.schema.json`), 'utf8'));

const config = load('config');
const manifest = load('manifest');
const findings = load('findings');

const sorted = (keys) => [...keys].sort();

describe('스키마', () => {
  it('셋 다 draft 2020-12 이고 $id 를 갖는다', () => {
    for (const schema of [config, manifest, findings]) {
      assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
      assert.match(schema.$id, /schemas\/(config|manifest|findings)\.schema\.json$/);
    }
  });

  it('config 스키마의 docs 키가 로더가 받는 키와 같다', () => {
    assert.deepEqual(sorted(Object.keys(config.properties.docs.properties)), sorted(DOCS_KEYS));
    assert.deepEqual(config.required, ['docs']);
    assert.deepEqual(config.properties.docs.required, ['root']);
  });

  it('config 스키마는 플러그인 소유 최상위 키를 막지 않는다', () => {
    const patterns = Object.keys(config.patternProperties ?? {});
    assert.equal(patterns.length, 1);
    assert.equal(new RegExp(patterns[0]).test('adr'), true);
    assert.equal(new RegExp(patterns[0]).test('open_issues'), true);
    assert.equal(new RegExp(patterns[0]).test('Open Issues'), false);
  });

  it('매니페스트 스키마의 축 키·kind·severity_cap 이 로더와 같다', () => {
    const axis = manifest.$defs.axis;
    assert.deepEqual(sorted(Object.keys(axis.properties)), sorted(AXIS_KEYS));
    assert.deepEqual(sorted(axis.properties.kind.enum), sorted(AXIS_KINDS));
    assert.deepEqual(sorted(axis.properties.severity_cap.enum), sorted(SEVERITY_CAPS));
    assert.deepEqual(axis.required, ['name', 'kind', 'run']);
  });

  it('findings 스키마의 봉투 키·severity 가 로더와 같다', () => {
    assert.deepEqual(sorted(Object.keys(findings.$defs.finding.properties)), sorted(FINDING_KEYS));
    assert.deepEqual(sorted(Object.keys(findings.$defs.location.properties)), sorted(LOCATION_KEYS));
    assert.deepEqual(sorted(findings.$defs.finding.properties.severity.enum), sorted(SEVERITIES));
    assert.deepEqual(findings.$defs.finding.required, ['axis', 'severity', 'code', 'message', 'locations']);
  });

  it('scanResult 는 stats 3항을 필수로 둔다 — 제외 목록은 선택이 아니다', () => {
    const stats = findings.$defs.scanResult.properties.stats;
    assert.deepEqual(sorted(stats.required), sorted(['files_scanned', 'excluded', 'skipped']));
    assert.deepEqual(findings.$defs.exclusion.required, ['path', 'reason']);
  });

  it('코어 매니페스트가 자기 스키마를 $schema 로 가리킨다', () => {
    const core = JSON.parse(readFileSync(resolve(KIT_ROOT, 'core', 'manifest.json'), 'utf8'));
    assert.equal(core.$schema, '../schemas/manifest.schema.json');
  });
});
