import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  CHECK_PATH,
  collectIdentifiers,
  editDistance,
  extractFieldNames,
  ghostCandidates,
  runConceptsAxis,
  segments,
  similarity,
} from '../core/axes/concepts/check.mjs';
import { loadConfig } from '../core/lib/config.mjs';
import { loadCorpus } from '../core/lib/corpus.mjs';
import { validateFinding } from '../core/lib/findings.mjs';
import { fixture } from './helpers.mjs';

const CONFIG = fixture('concepts', 'dck.config.json');
const context = loadConfig(CONFIG);
const result = runConceptsAxis(context);

const index = collectIdentifiers(loadCorpus(context, { parse: true }).documents);
const ghosts = result.candidates.filter((candidate) => candidate.kind === 'ghost');
const mentions = result.candidates.filter((candidate) => candidate.kind === 'concept-usage');
const contract = readFileSync(resolve(CHECK_PATH, '..', 'contract.md'), 'utf8');

describe('이름 유사도', () => {
  it('식별자를 비교 가능한 조각으로 가른다', () => {
    assert.deepEqual(segments('@repo/room-editor'), ['repo', 'room', 'editor']);
    assert.deepEqual(segments('usedByTiles'), ['used', 'by', 'tiles']);
    assert.deepEqual(segments('bluebird.room-schedules'), ['bluebird', 'room', 'schedules']);
  });

  it('조각 단위 편집 거리를 쓴다 — 문자 거리로는 같은 계열을 못 잡는다', () => {
    // 문자 거리 7 이라 문자 기준 임계로는 절대 안 걸린다. 조각으로 보면 한 조각 차이다.
    assert.ok(editDistance('booking-authoring', 'booking-core') > 6);
    assert.equal(editDistance(segments('booking-authoring'), segments('booking-core')), 1);
    assert.equal(similarity('booking-authoring', 'booking-core').reason, '한 조각 차이');
  });

  it('첫 조각이 다르면 남이다 — 뒤 조각이 같아도 같은 계열이 아니다', () => {
    assert.equal(similarity('booking-core', 'room-core'), null);
    assert.equal(similarity('booking-core', 'booking-core'), null);
  });

  it('조각 구성이 같고 표기만 다르면 별칭 후보다', () => {
    assert.equal(similarity('used-by', 'usedBy').reason, '표기만 다른 같은 조각 구성');
  });
});

describe('(a) 유령 식별자 후보', () => {
  it('1회 표기와 8회 표기가 갈리면 소수 쪽을 후보로, 다수 쪽을 정본 후보로 낸다', () => {
    assert.deepEqual(
      ghosts.map((candidate) => candidate.name),
      ['booking-authoring'],
    );

    const [ghost] = ghosts;
    assert.equal(ghost.occurrences, 1);
    assert.equal(ghost.dominant.name, 'booking-core');
    assert.equal(ghost.dominant.occurrences, 8);
    assert.deepEqual(ghost.locations, [
      { file: 'access-policy.md', line: 5, quote: '편집 권한은 `booking-authoring` 패키지가 소비한다.' },
    ]);
    assert.ok(ghost.dominant.locations.length === 8);
  });

  it('확정하지 않는다 — findings 가 아니라 candidates 로만 나간다', () => {
    assert.equal(
      result.findings.some((finding) => finding.message.includes('booking-authoring')),
      false,
    );
  });

  it('접전은 후보로 올리지 않는다 — 다수 쪽이 3배 이상이어야 한다', () => {
    const close = new Map([
      ['booking-core', { name: 'booking-core', occurrences: 3, locations: [] }],
      ['booking-authoring', { name: 'booking-authoring', occurrences: 2, locations: [] }],
    ]);
    assert.deepEqual(ghostCandidates(close), []);
  });
});

describe('(b) 필드명 실재 대조', () => {
  it('JSON Schema 에서 필드명 집합을 뽑는다', () => {
    const schema = JSON.parse(readFileSync(fixture('concepts', 'schema', 'field-spec.schema.json'), 'utf8'));
    const fields = extractFieldNames(schema);
    assert.ok(fields.has('usedByTiles'));
    assert.ok(fields.has('derivedFrom'));
    assert.equal(fields.has('properties'), false);
  });

  it('스키마에 없는 필드명 인용은 확정 findings 다', () => {
    const ghostFields = result.findings.filter((finding) => finding.code === 'concepts.ghost-field');
    assert.equal(ghostFields.length, 1);

    const [finding] = ghostFields;
    assert.equal(finding.severity, 'block');
    assert.equal(finding.payload.concept, 'usedBy');
    assert.deepEqual(finding.payload.candidates, ['usedByBlocks', 'usedByTiles']);
    assert.equal(finding.payload.canonical_name, null);
    assert.deepEqual(finding.locations, [
      { file: 'ownership-rationale.md', line: 3, quote: '조각이 어디서 쓰이는지는 `usedBy` 로 확인한다.' },
    ]);
  });

  it('두 눈금이 하나로 뭉개진다는 오해를 misreading 에 적는다', () => {
    const [finding] = result.findings.filter((finding) => finding.code === 'concepts.ghost-field');
    assert.match(finding.payload.misreading, /usedByBlocks/);
    assert.match(finding.payload.misreading, /usedByTiles/);
  });

  it('스키마에 있는 필드명은 통과한다', () => {
    for (const field of ['usedByTiles', 'usedByBlocks', 'derivedFrom', 'authorNote']) {
      assert.ok(index.has(field), `${field} 이 색인에 있어야 대조가 의미 있다`);
      assert.equal(
        result.findings.some((finding) => finding.payload?.concept === field),
        false,
        `${field} 은 스키마에 실재하므로 위반이 아니다`,
      );
    }
  });

  it('스키마의 어떤 필드와도 안 닮은 이름은 필드 인용이 아니라고 보고 넘어간다', () => {
    assert.ok(index.has('booking-core'));
    assert.equal(
      result.findings.some((finding) => finding.payload?.concept === 'booking-core'),
      false,
    );
  });

  it('확정된 이름은 후보로 다시 나가지 않는다', () => {
    assert.equal(
      ghosts.some((candidate) => candidate.name === 'usedBy'),
      false,
    );
  });

  it('스키마를 못 읽으면 통과가 아니라 차단이다', () => {
    const broken = {
      ...context,
      config: { ...context.config, schemas: ['schema/does-not-exist.json'] },
    };
    const crashed = runConceptsAxis(broken);
    const [finding] = crashed.findings.filter((f) => f.code === 'concepts.schema-unreadable');
    assert.equal(finding.severity, 'block');
    assert.equal(finding.locations[0].file, 'schema/does-not-exist.json');
  });

  it('스키마 미선언은 0건과 구분된다', () => {
    const bare = { ...context, config: { ...context.config, schemas: [] } };
    const scanned = runConceptsAxis(bare);
    assert.equal(scanned.stats.field_check.ran, false);
    assert.match(scanned.stats.field_check.reason, /미선언/);
    assert.equal(result.stats.field_check.ran, true);
  });
});

describe('(d) 코드블록 제외', () => {
  it('fenced code block 안의 식별자는 세지 않는다', () => {
    // 픽스처의 phase-notes.md 는 fenced block 안에서만 이 이름을 쓴다.
    assert.equal(index.has('fence-only-name'), false);
  });

  it('블록 안 등장이 세어졌다면 소수 표기가 아니게 되어 유령 식별자 후보 판정이 조용히 사라진다', () => {
    // booking-authoring 은 블록 밖 1회 + 블록 안 2회. 제외가 깨지면 3회가 되어 후보에서 빠진다.
    assert.equal(index.get('booking-authoring').occurrences, 1);
    assert.deepEqual(
      index.get('booking-authoring').locations.map((location) => location.file),
      ['access-policy.md'],
    );
  });

  it('추적 개념은 블록 안도 센다 — 사용자가 이름을 적어 물은 것이라 0건으로 지우면 안 된다', () => {
    // 회귀: `booking-authoring` 의 유일한 등장이 ```tsx 블록 안이라
    // 추적 개념 후보가 0건으로 나갔고, 판단 계약이 볼 것이 없어 유령 이름을 통째로 놓쳤다.
    const fenceOnly = mentions.find((mention) => mention.concept === 'fence-only-name');
    assert.deepEqual(fenceOnly.locations, [
      {
        file: 'phase-notes.md',
        line: 13,
        quote: '`booking-authoring` 과 `fence-only-name` 은 더 쓰지 않는다.',
        in_code_example: 'md',
      },
    ]);
  });

  it('같은 이름이라도 발견(식별자 색인)은 블록을 빼고 추적(개념 등장)은 뺀 적이 없다', () => {
    // 발견은 모양으로 이름을 줍는 일이라 예시 코드를 세면 잡음에 묻히고,
    // 추적은 사용자가 지목한 이름을 찾는 일이라 예시야말로 봐야 할 자리다.
    assert.equal(index.has('fence-only-name'), false);
    assert.equal(mentions.find((mention) => mention.concept === 'fence-only-name').occurrences, 1);
  });

  it('블록 밖 등장에는 예시 표시를 달지 않는다 — 판정자가 문맥을 구분할 수 있어야 한다', () => {
    const layers = mentions.find((mention) => mention.concept === '층 구조');
    assert.ok(layers.occurrences > 0);
    assert.equal(
      layers.locations.some((location) => 'in_code_example' in location),
      false,
    );
  });
});

describe('판단 계약으로 넘기는 입력', () => {
  it('경계가 갈린 문서들의 위치를 미리 훑어 넘긴다 — 계약이 재탐색하지 않도록', () => {
    const layers = mentions.find((mention) => mention.concept === '층 구조');
    const files = [...new Set(layers.locations.map((location) => location.file))].sort();
    assert.deepEqual(files, ['phase-notes.md', 'tier-model.md']);
    assert.ok(layers.occurrences >= files.length);
  });

  it('config.concepts 전부에 대해 후보를 낸다 — 등장 0건도 사실로 남는다', () => {
    assert.deepEqual(
      mentions.map((mention) => mention.concept),
      context.config.concepts,
    );
  });
});

describe('판단 계약 문서', () => {
  it('구현 계약 v1 의 고정 섹션을 갖춘다', () => {
    for (const heading of ['# 개념·용어', '## 입력', '## 판정 기준', '## 반드시 지킬 것', '## 출력']) {
      assert.ok(contract.includes(`\n${heading}\n`) || contract.startsWith(`${heading}\n`), `${heading} 누락`);
    }
  });

  it('규범 충돌 판정 기준과 스키마 실재 우선 규칙을 명시한다', () => {
    assert.match(contract, /규범 충돌/);
    assert.match(contract, /실재하는 쪽이 현행 규격이다/);
    assert.match(contract, /config\.schemas/);
  });

  it('경계 서술은 갈린 위치를 전부 나열하도록 규정한다', () => {
    assert.match(contract, /### 3\. 경계 서술 대조 \(boundary\)/);
    assert.match(contract, /모든 위치를 빠짐없이 나열한다/);
  });

  it('네 가지 kind 와 misreading 필수를 규정한다', () => {
    for (const kind of ['alias', 'overload', 'boundary', 'ghost']) {
      assert.match(contract, new RegExp(`\`${kind}\``));
    }
    assert.match(contract, /`payload\.misreading` 은 모든 finding 에 필수다/);
  });

  it('반드시 지킬 것 4항을 담는다', () => {
    assert.match(contract, /탐색 범위 규율/);
    assert.match(contract, /집합 성격/);
    assert.match(contract, /기계 생성 파일 금독/);
    assert.match(contract, /작업 트리 쓰기 금지/);
  });

  it('탐색 범위 규율이 검사에 필요한 추적까지 막지 않는다', () => {
    assert.match(contract, /낭비가 아니라 검사의 본체다/);
  });
});

describe('실행 계약', () => {
  it('stdout 에 봉투 JSON 한 덩어리를 내고 0 으로 끝난다', () => {
    const stdout = execFileSync(process.execPath, [CHECK_PATH, '--config', CONFIG], { encoding: 'utf8' });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.axis, 'concepts');
    assert.equal(parsed.stats.skipped, false);
    assert.equal(parsed.stats.files_scanned, 6);
    assert.ok(Array.isArray(parsed.candidates));
    assert.deepEqual(
      parsed.findings.map((finding) => finding.code),
      ['concepts.ghost-field'],
    );
  });

  it('모든 finding 이 봉투 형식을 지킨다', () => {
    for (const finding of result.findings) {
      assert.deepEqual(validateFinding(finding), []);
      assert.equal(finding.axis, 'concepts');
    }
  });

  it('config 없이 부르면 축이 크래시한다 — 조용히 0건으로 통과하지 않는다', () => {
    assert.throws(() => execFileSync(process.execPath, [CHECK_PATH], { encoding: 'utf8', stdio: 'pipe' }));
  });
});
