#!/usr/bin/env node
/**
 * concepts 축 — 개념·용어 (hybrid 축의 결정 파트)
 *
 * 결정적으로 판정 가능한 것만 findings 로 낸다. 나머지는 candidates 로 넘겨
 * 판단 계약(contract.md)이 확정한다.
 *
 *   (a) 유령 식별자 → candidates. 소수 표기가 유령인지 정당한 별개 이름인지는 의미 판단이다.
 *   (b) 필드명 실재 대조 → config.schemas_complete 가 true 일 때만 findings. "스키마에 없다 =
 *       틀렸다"는 schemas[] 가 전집이라는 닫힌 세계 가정 위에서만 사실이다. 그 가정은 스크립트가
 *       검증할 수 없으므로 사용자 선언(schemas_complete)으로만 성립하고, 선언이 없으면(열린 세계,
 *       기본) 같은 대조 결과를 candidates(kind: ghost-field) 로 넘겨 판단 계약이 실재를 확인한다.
 *
 * 판단 계약이 재탐색 없이 일할 수 있도록 추적 개념(config.concepts)의 등장 위치도
 * candidates 로 함께 싣는다 — 판단 계약은 문서를 스스로 다시 훑지 않는 것이 규율이고,
 * 그 규율은 탐색 결과를 미리 줄 때만 성립한다.
 *
 * 백틱 코드스팬만 본다. fenced code block 안은 예시라 드리프트가 아니다.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ConfigError, loadConfig, parseCliArgs } from '../../lib/config.mjs';
import { loadCorpus } from '../../lib/corpus.mjs';
import { createFinding, createScanResult } from '../../lib/findings.mjs';
import { isInsideFence, lineText } from '../../lib/markdown.mjs';

export const AXIS = 'concepts';

/** 이 횟수 이하로 등장하면 "소수 표기". */
export const RARE_MAX = 2;
/** 정본 후보가 되려면 최소 이만큼 등장해야 한다. */
export const DOMINANT_MIN = 3;
/** 정본 후보는 소수 표기의 이 배수 이상이어야 한다 — 2 vs 3 같은 접전은 후보로 올리지 않는다. */
export const DOMINANCE_RATIO = 3;
/** 인용문 최대 길이. 후보 목록이 문서를 통째로 복제하지 않도록. */
const QUOTE_MAX = 200;

/** 코드 식별자로 볼 수 있는 형태 — 공백 없는 한 토큰. */
const IDENTIFIER_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[A-Za-z_$][A-Za-z0-9_$]*(?:[./-][A-Za-z0-9_$]+)*$/;
/** 사람 말이 아니라 코드 이름이라는 표식 — 스코프·점·하이픈·언더스코어·camel 혹. */
const CODE_SHAPED_RE = /^@|[./_-]|[a-z0-9][A-Z]/;
/** 필드명 대조 대상 — 경로·네임스페이스가 아닌 단일 토큰만 필드일 수 있다. */
const FIELD_SHAPED_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function truncate(text) {
  const trimmed = String(text).trim();
  return trimmed.length > QUOTE_MAX ? `${trimmed.slice(0, QUOTE_MAX - 1)}…` : trimmed;
}

/** 식별자를 비교 가능한 조각으로 가른다. `@repo/room-editor` → [repo, room, editor] */
export function segments(name) {
  return String(name)
    .replace(/^@/, '')
    .split(/[./\-_]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

/** 레벤슈타인 거리. 토큰 배열에도 문자열에도 쓴다. */
export function editDistance(a, b) {
  const source = Array.from(a);
  const target = Array.from(b);
  let previous = target.map((_, i) => i + 1);
  previous.unshift(0);

  for (let i = 0; i < source.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < target.length; j += 1) {
      const cost = source[i] === target[j] ? 0 : 1;
      current.push(Math.min(previous[j + 1] + 1, current[j] + 1, previous[j] + cost));
    }
    previous = current;
  }
  return previous[target.length];
}

/**
 * 두 식별자가 같은 이름의 변형인가.
 *
 * 조각 단위 편집 거리를 쓴다 — 문자 거리로는 `booking-authoring` ↔ `booking-core` 가
 * 7 이나 벌어져 같은 계열임을 못 잡는다. 조각으로 보면 한 조각 차이다.
 * 첫 조각이 같아야 한다는 조건이 `booking-core` ↔ `room-core` 같은 남을 걸러낸다.
 *
 * @returns {{reason: string} | null}
 */
export function similarity(a, b) {
  if (a === b) return null;
  const left = segments(a);
  const right = segments(b);

  if (left.join('|') === right.join('|')) return { reason: '표기만 다른 같은 조각 구성' };

  if (left.length === 1 && right.length === 1) {
    if (Math.min(a.length, b.length) < 5) return null;
    return editDistance(a.toLowerCase(), b.toLowerCase()) <= 1 ? { reason: '한 글자 차이' } : null;
  }

  if (left[0] !== right[0]) return null;
  return editDistance(left, right) === 1 ? { reason: '한 조각 차이' } : null;
}

/** 백틱 코드스팬에서 식별자를 모은다. fenced code block 안은 예시라 세지 않는다. */
export function collectIdentifiers(documents) {
  const index = new Map();

  for (const document of documents) {
    for (const span of document.parsed.codeSpans) {
      if (isInsideFence(document.parsed, span.line)) continue;
      const name = span.text;
      if (!IDENTIFIER_RE.test(name) || !CODE_SHAPED_RE.test(name)) continue;

      const entry = index.get(name) ?? { name, occurrences: 0, locations: [] };
      entry.occurrences += 1;
      entry.locations.push({
        file: document.path,
        line: span.line,
        quote: truncate(lineText(document.parsed, span.line)),
      });
      index.set(name, entry);
    }
  }

  return index;
}

/**
 * 유령 식별자 후보 — 소수 표기 + 압도적 다수의 유사 이름.
 * 확정하지 않는다. 두 이름이 정말 같은 것을 가리키는지는 문맥이 정한다.
 */
export function ghostCandidates(index) {
  const entries = [...index.values()];
  const candidates = [];

  for (const rare of entries) {
    if (rare.occurrences > RARE_MAX) continue;

    const alternatives = entries
      .filter((other) => other.occurrences >= DOMINANT_MIN)
      .filter((other) => other.occurrences >= rare.occurrences * DOMINANCE_RATIO)
      .map((other) => ({ entry: other, match: similarity(rare.name, other.name) }))
      .filter(({ match }) => match !== null)
      .sort((a, b) => b.entry.occurrences - a.entry.occurrences);

    if (alternatives.length === 0) continue;

    const [top, ...rest] = alternatives;
    candidates.push({
      kind: 'ghost',
      name: rare.name,
      occurrences: rare.occurrences,
      locations: rare.locations,
      dominant: {
        name: top.entry.name,
        occurrences: top.entry.occurrences,
        similarity: top.match.reason,
        locations: top.entry.locations,
      },
      other_candidates: rest.map(({ entry, match }) => ({
        name: entry.name,
        occurrences: entry.occurrences,
        similarity: match.reason,
      })),
      why: `${rare.name} 은 ${rare.occurrences}회, ${top.entry.name} 은 ${top.entry.occurrences}회 등장한다 (${top.match.reason}).`,
    });
  }

  return candidates.sort((a, b) => a.name.localeCompare(b.name));
}

/** JSON Schema 든 표본 JSON 이든 필드명 집합을 뽑는다. */
export function extractFieldNames(schema) {
  const fields = new Set();
  let sawProperties = false;

  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object') return;

    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        sawProperties = true;
        Object.keys(value).forEach((field) => fields.add(field));
      }
      if (key === 'required' && Array.isArray(value)) {
        value.filter((field) => typeof field === 'string').forEach((field) => fields.add(field));
      }
      walk(value);
    }
  };

  walk(schema);

  // JSON Schema 가 아니면(properties 노드가 없으면) 표본 데이터로 보고 모든 키를 필드로 읽는다.
  if (!sawProperties) {
    const collect = (node) => {
      if (Array.isArray(node)) {
        node.forEach(collect);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        fields.add(key);
        collect(value);
      }
    };
    collect(schema);
  }

  return fields;
}

/** config.schemas[] 를 읽는다. 못 읽은 파일은 통과가 아니라 차단이다. */
function loadSchemaFields(context) {
  const paths = context.config.schemas ?? [];
  const fields = new Set();
  const unreadable = [];

  for (const path of paths) {
    const absPath = resolve(context.repoRoot, path);
    try {
      const parsed = JSON.parse(readFileSync(absPath, 'utf8'));
      extractFieldNames(parsed).forEach((field) => fields.add(field));
    } catch (error) {
      unreadable.push({ path, reason: error.message });
    }
  }

  return { fields, unreadable, declared: paths.length > 0 };
}

/**
 * 필드명 실재 대조 — 결정적.
 *
 * 스키마에 없으면서 스키마의 어떤 필드와 근사한 백틱 인용만 잡는다.
 * "근사" 조건이 없으면 필드를 가리키지도 않은 코드 이름까지 전부 걸린다 — 확정 findings 라
 * 오탐이 곧 거짓 차단이므로, 정본 후보를 짚을 수 있을 때만 위반으로 본다.
 */
export function ghostFieldFindings(index, schemaFields, { severityCap } = {}) {
  if (schemaFields.size === 0) return [];
  const findings = [];

  for (const entry of [...index.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!FIELD_SHAPED_RE.test(entry.name)) continue;
    if (schemaFields.has(entry.name)) continue;

    const canonical = [...schemaFields]
      .map((field) => ({ field, match: similarity(entry.name, field) }))
      .filter(({ match }) => match !== null)
      .map(({ field }) => field)
      .sort();

    if (canonical.length === 0) continue;

    findings.push(
      createFinding({
        axis: AXIS,
        severity: 'block',
        severityCap,
        code: 'concepts.ghost-field',
        message: `\`${entry.name}\` 은 스키마에 없는 필드명이다. 스키마의 정본은 ${canonical.map((f) => `\`${f}\``).join(' · ')} 이다.`,
        locations: entry.locations,
        payload: {
          concept: entry.name,
          canonical_name: canonical.length === 1 ? canonical[0] : null,
          candidates: canonical,
          kind: 'ghost',
          misreading:
            canonical.length === 1
              ? `\`${entry.name}\` 를 실재하는 필드로 읽고 그 이름으로 코드를 짜면 스키마와 어긋난다. 정본은 \`${canonical[0]}\` 이다.`
              : `\`${entry.name}\` 하나로 부르면 스키마가 ${canonical.length}개로 나눠 둔 구분(${canonical.join(' · ')})이 사라진다.`,
        },
      }),
    );
  }

  return findings;
}

/** 그 줄이 언어를 밝힌 펜스(코드·도식 예시) 안인가. */
function exampleFenceInfo(parsed, line) {
  const fence = parsed.fences.find((item) => line >= item.start && line <= item.end);
  const info = (fence?.info ?? '').trim();
  return info === '' ? null : info;
}

/**
 * 추적 개념의 등장 위치 — 판단 계약이 재탐색하지 않도록 미리 훑어 준다.
 *
 * 여기서는 펜스를 건너뛰지 않는다. `collectIdentifiers` 가 펜스를 빼는 까닭은 그쪽이 **모양으로
 * 이름을 발견**하기 때문이다 — 예시 코드에는 이 문서 집합과 무관한 이름이 가득해, 세면 유령
 * 판정이 잡음에 묻힌다. 추적 개념은 반대다. 사용자가 `config.concepts[]` 에 이름을 적어 "이게
 * 어디 나오나"를 물었고, 예시 코드야말로 그 이름이 구현으로 복사돼 나가는 자리다. 여기서 펜스를
 * 빼면 유일한 등장이 예시 안에 있는 개념이 0건으로 보고돼, 묻지 않은 질문에 답하고 물은 질문을
 * 지운다. 대신 예시 안이라는 사실을 `in_code_example` 로 실어 판정자가 문맥을 알게 한다.
 */
export function conceptMentions(documents, concepts = []) {
  return concepts.map((concept) => {
    const locations = [];
    for (const document of documents) {
      document.parsed.lines.forEach((raw, offset) => {
        const line = offset + 1;
        if (!raw.includes(concept)) return;
        const fenceInfo = exampleFenceInfo(document.parsed, line);
        const location = { file: document.path, line, quote: truncate(raw) };
        if (fenceInfo) location.in_code_example = fenceInfo;
        locations.push(location);
      });
    }
    return { kind: 'concept-usage', concept, occurrences: locations.length, locations };
  });
}

/** 축 본체. 테스트는 이걸 직접 부른다. */
export function runConceptsAxis(context, { severityCap } = {}) {
  const corpus = loadCorpus(context, { parse: true });
  const index = collectIdentifiers(corpus.documents);
  const { fields, unreadable, declared } = loadSchemaFields(context);

  // 닫힌 세계(schemas_complete: true)에서만 확정 차단. 열린 세계에서는 같은 대조 결과를
  // 후보로 강등한다 — 생산자(스크립트)가 검증 못 하는 가정을 확정의 근거로 쓰지 않는다.
  const closedWorld = context.config.schemas_complete === true;
  const fieldFindings = ghostFieldFindings(index, fields, { severityCap });
  const findings = closedWorld ? fieldFindings : [];
  const demoted = closedWorld
    ? []
    : fieldFindings.map((finding) => ({
        kind: 'ghost-field',
        name: finding.payload.concept,
        occurrences: finding.locations.length,
        locations: finding.locations,
        canonical_name: finding.payload.canonical_name,
        candidates: finding.payload.candidates,
        misreading: finding.payload.misreading,
        why: `스키마에 없는 필드명이지만 schemas_complete 미선언(열린 세계)이라 실재 확인이 필요하다.`,
      }));

  for (const entry of unreadable) {
    findings.push(
      createFinding({
        axis: AXIS,
        severity: 'block',
        severityCap,
        code: 'concepts.schema-unreadable',
        message: `config.schemas 가 가리키는 스키마를 읽을 수 없어 필드명 실재 대조를 못 했다 (${entry.reason}).`,
        locations: [{ file: entry.path }],
        payload: { kind: 'ghost', reason: entry.reason },
      }),
    );
  }

  // 필드 대조가 이름을 이미 다뤘으면(확정이든 강등 후보든) 유령 후보로 다시 내보내지 않는다 —
  // 같은 이름을 두 경로로 이중 보고하면 판단 계약이 같은 사실을 두 번 판정한다.
  const fieldNamed = new Set(fieldFindings.map((finding) => finding.payload?.concept).filter(Boolean));
  const candidates = [
    ...ghostCandidates(index).filter((candidate) => !fieldNamed.has(candidate.name)),
    ...demoted,
    ...conceptMentions(corpus.documents, context.config.concepts),
  ];

  const result = createScanResult({
    axis: AXIS,
    findings,
    candidates,
    stats: { files_scanned: corpus.filesScanned, excluded: corpus.excluded, skipped: false },
  });

  // createScanResult 는 공통 stats 키만 통과시킨다. 아래는 축 고유 진단 —
  // (b) 가 실제로 돌았는지를 산출만 보고 알 수 있어야 한다. config.schemas 가 없으면
  // 필드 대조는 아무것도 보장하지 못하며, 그 사실이 0건과 구분돼야 한다.
  result.stats.identifiers_indexed = index.size;
  result.stats.field_check = declared
    ? { ran: true, schemas: context.config.schemas.length, fields: fields.size, closed_world: closedWorld }
    : { ran: false, reason: 'config.schemas 미선언 — 대조할 스키마가 없다' };

  return result;
}

function main(argv) {
  const args = parseCliArgs(argv);
  const context = loadConfig(args.config, { repoRoot: args.repo });
  process.stdout.write(`${JSON.stringify(runConceptsAxis(context))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const detail = error instanceof ConfigError ? error.message : (error.stack ?? String(error));
    process.stderr.write(`[${AXIS}] ${detail}\n`);
    process.exit(1);
  }
}

export const CHECK_PATH = fileURLToPath(import.meta.url);
