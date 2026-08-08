#!/usr/bin/env node
/**
 * ownership 축 — 소유 중복 (결정적 후보 추출).
 *
 * 같은 사실이 소유 문서 밖에서 재서술된 곳을 찾는다. 인용(링크)은 정상이고 재서술이 위반이다.
 *
 * 결정적으로 확정할 수 있는 것은 하나뿐이다 — **이미 갈라진 복제**. 소유 문서의 값과 다른 값이
 * 같은 항목 이름 옆에 적혀 있으면 둘 중 하나는 반드시 틀렸으므로 findings 로 확정한다.
 * 값이 같은 재서술은 "복제"인지 "값 형태만 언급"인지 정규식이 가를 수 없어 candidates 로만 낸다.
 * 그 갈림이 이 축의 하이브리드 성격이고, 판정 기준은 contract.md 가 소유한다.
 *
 * 소유 대상 추출은 두 형태만 본다:
 *   표 행       — `| 항목 | 값 |` 의 첫 셀이 이름, 나머지 셀이 값
 *   정의 항목   — `- **이름**: 값` 처럼 이름이 강조·코드스팬으로 표시된 줄
 * 이름 표시가 없는 산문은 "무엇이 항목인지"가 결정적이지 않아 대상이 아니다.
 *
 * 값 대조는 두 갈래다:
 *   수치값(유의 토큰 3개 이하 + 숫자 포함) — 이름 주변 ±30자 창 안의 숫자와 대조. 다르면 확정 위반.
 *                                             창은 이름이 선 문장을 넘지 않는다 — 다음 문장의 수는
 *                                             다른 주장의 수다.
 *   서술값                                  — 유의 토큰 포함률. 전부 있으면 전문 복제, 절반 이상이면
 *                                             부분 반영 후보(같은 규칙이 여러 곳에 복제된 뒤 일부만
 *                                             갱신된 상태 — 이 축이 잡아야 할 최악의 경우다).
 * 서술값의 숫자 변화를 확정 위반으로 올리지 않는 이유: 산문은 정당한 의역과 낡은 복제를 값만 보고
 * 가를 수 없다. 그 판정은 계약이 한다.
 */

import { relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ConfigError, DEFAULTS, hasConfigKey, loadConfig, parseCliArgs } from '../../lib/config.mjs';
import { allDocuments, loadCorpus } from '../../lib/corpus.mjs';
import { createFinding, createScanResult, createSkippedScanResult } from '../../lib/findings.mjs';
export const AXIS = 'ownership';

/** 이름 옆 "값 자리"로 볼 문자 반경. 이보다 먼 숫자는 다른 절의 수로 본다. */
export const VALUE_RADIUS = 30;
/** 이 개수 이하의 유의 토큰 + 숫자 = 수치값. 그보다 길면 서술값으로 본다. */
export const NUMERIC_MAX_TOKENS = 3;
/** 서술값 재서술로 볼 최소 토큰 포함률. */
export const PARTIAL_COVERAGE_MIN = 0.5;

const MIN_NAME_LENGTH = 2;
/** 첫 열 대신 이름 열로 삼을 수 있는 최대 길이. 이보다 길면 이름이 아니라 서술이다. */
const MAX_KEY_LENGTH = 40;
const MAX_VALUE_LENGTH = 200;
const MAX_QUOTE_LENGTH = 200;

const DEFINITION_RE = /^\s{0,3}(?:[-*+]|\d+[.)])?\s*(\*\*|__|`)([^\n]{2,80}?)\1\s*(?:[:：]|—|–|-)\s+(\S.*)$/;
const ASCII_NAME_RE = /^[a-z0-9][a-z0-9 ._/-]*$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 링크 문법은 표시명만 남기고, 강조·코드스팬 표시는 지운다. */
export function stripMarkup(text) {
  return String(text)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .trim();
}

/** 대조용 정규형 — 표시 마크업·공백·대소문자 차이를 없앤다. */
export function normalizeText(text) {
  return stripMarkup(String(text).normalize('NFC'))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 숫자가 이름의 일부인지 가르는 토큰 경계. 식별자는 `-._/`, 비율은 `:` 로 이어지므로 거기서 끊지 않는다. */
const NUMBER_TOKEN_SPLIT_RE = /[^\p{L}\p{N}.,_/:-]+/u;
/** 글자가 섞였으면 이름이고, `:` 로 이어졌으면 비율(`1:1`)이다. 둘 다 세어진 수가 아니다. */
const NOT_A_COUNT_RE = /[\p{L}:]/u;

/**
 * 제목 번호와 번호 목록 표시는 값이 아니라 문서의 뼈대다. `### 5.2 조각은 …` 의 5.2 는 절의 이름
 * 이고 `6. **RoomPanel 해체**` 의 6 은 몇 번째 항목인가일 뿐이다. 이름이 그 줄에 함께 있으면
 * 값 자리 창에 딸려 들어오므로, 대조 전에 뼈대를 걷어낸다.
 */
export function withoutStructuralMarkers(rawLine) {
  return String(rawLine)
    .replace(/^(\s*#{1,6}\s+)\d+(?:\.\d+)*\.?\s*/, '$1')
    .replace(/^(\s*)\d+[.)]\s+/, '$1');
}

/** "1,200" 은 1200, "3.5" 는 3.5. 그 외 구두점 섞인 토큰은 값이 아니다. */
export function toNumber(token) {
  const value = Number(token.replace(/,(?=\d{3}(?!\d))/g, ''));
  return Number.isFinite(value) ? value : null;
}

/**
 * 홀로 선 수만 값이다. 글자가 섞인 토큰의 숫자는 세어진 수가 아니라 이름의 일부라 — `i18n` 의 18,
 * `r121` 의 121, `ADR-021` 의 21, "214개" 의 214 — 그것을 값으로 읽으면 이름만 같은 항목의 수치와
 * 아무 관계 없이 "갈라졌다"고 보게 된다. 소유 문서 쪽 값과 대조 대상 줄이 **같은 규칙**을 쓴다.
 * 한쪽만 걸러내면 걸러지지 않은 쪽의 숫자가 그대로 상대값이 된다.
 */
export function extractNumbers(text) {
  const numbers = [];
  for (const token of String(text).split(NUMBER_TOKEN_SPLIT_RE)) {
    if (!token || NOT_A_COUNT_RE.test(token)) continue;
    for (const match of token.match(/-?\d+(?:[.,]\d+)*/g) ?? []) {
      const value = toNumber(match);
      if (value !== null && !numbers.includes(value)) numbers.push(value);
    }
  }
  return numbers;
}

/** 길이 2 이상의 문자·숫자 덩어리. 값이 재서술됐는지를 이 집합의 포함률로 본다. */
export function significantTokens(text) {
  const tokens = normalizeText(text)
    .split(/[^\p{L}\p{N}%]+/u)
    .filter((token) => token.length >= MIN_NAME_LENGTH);
  return [...new Set(tokens)];
}

/**
 * 정규형 줄에 항목 이름이 있는가.
 * ASCII 이름은 단어 경계를 요구한다 — "age" 가 "manage" 에 걸리면 안 된다.
 * 한국어는 어절 경계가 표기되지 않아 부분 문자열 포함으로 본다.
 */
export function containsName(normalizedLine, name) {
  const needle = normalizeText(name);
  if (needle.length < MIN_NAME_LENGTH) return false;
  if (ASCII_NAME_RE.test(needle)) {
    // 경계는 식별자 문자 전부다. `bluebird-portal-web` 은 하나의 이름이지 "portal" 을 부른 자리가 아니고,
    // `room-registry.json` 도 마찬가지다 — 이름 자체가 `-._/` 를 담으므로 그 문자에서 끊으면
    // 부분 일치가 이름 언급으로 둔갑한다.
    return new RegExp(`(?<![a-z0-9._/-])${escapeRegExp(needle)}(?![a-z0-9._/-])`).test(normalizedLine);
  }
  return normalizedLine.includes(needle);
}

const TOKEN_CHAR_RE = /[\p{L}\p{N}._/-]/u;

/**
 * 반경이 토큰 한가운데를 자르면 잘린 조각이 홀로 선 수로 둔갑한다 — `r121` 의 꼬리가 `21` 이 되고
 * `adr-021` 의 꼬리가 `21` 이 된다. 온전한 토큰이면 글자에 붙었다는 이유로 걸러질 것들이라, 자른
 * 자리에서 남은 조각을 버려 창을 토큰 경계에 맞춘다.
 */
function trimHead(text, cut) {
  if (!cut || !TOKEN_CHAR_RE.test(text[0] ?? '')) return text;
  let index = 0;
  while (index < text.length && TOKEN_CHAR_RE.test(text[index])) index += 1;
  return text.slice(index);
}

function trimTail(text, cut) {
  if (!cut || !TOKEN_CHAR_RE.test(text.at(-1) ?? '')) return text;
  let index = text.length;
  while (index > 0 && TOKEN_CHAR_RE.test(text[index - 1])) index -= 1;
  return text.slice(0, index);
}

/**
 * 이름이 나온 자리마다 앞뒤 반경을 떼어 붙인다 — 이름과 무관한 절의 숫자를 값으로 읽지 않으려고.
 * 반경 안이라도 문장을 넘어간 자리는 다른 주장이므로 `withinSentence` 로 끊는다.
 */
export function valueWindow(normalizedLine, name, radius = VALUE_RADIUS) {
  const needle = normalizeText(name);
  const parts = [];
  let from = 0;
  for (;;) {
    const index = normalizedLine.indexOf(needle, from);
    if (index === -1) break;
    const end = index + needle.length;
    const head = Math.max(0, index - radius);
    const tail = Math.min(normalizedLine.length, end + radius);
    parts.push(withinSentence(trimHead(normalizedLine.slice(head, index), head > 0), 'head'));
    parts.push(withinSentence(trimTail(normalizedLine.slice(end, tail), tail < normalizedLine.length), 'tail'));
    from = end;
  }
  return parts.join(' ');
}

/**
 * 문장 끝 표시. 소수점(`3.5`)·파일명(`baseline.json`)의 마침표는 뒤에 공백이 없어 걸리지 않는다.
 */
const SENTENCE_END_RE = /[.!?。](?=\s|$)/g;

/**
 * 값 자리 창을 문장 안으로 가둔다.
 *
 * 창은 거리만 볼 뿐 그 수가 **무엇의 수인지**는 묻지 않는다. 그래서 반경 안에 든 다음 문장의 수가
 * 이 항목의 값으로 둔갑한다 — `배포단위 6에 속하지 않으므로, 그 유래 기능블록에서 나온 조각은 소유를
 * 비운다. 없는 주인을 6 중에서 골라 채우지 않는다.` 의 뒤쪽 `6` 은 앞 문장이 말한 배포단위 수를 다시
 * 부른 자리인데, 기능블록(214)의 값으로 읽혀 "이미 갈라진 복제"로 **확정**됐다. 이 축의 확정은
 * 차단이라 사람 검토를 거치지 않으므로, 오검출 하나가 그대로 게이트를 막는다.
 *
 * 하나의 사실을 주장하는 단위는 문장이다. 문장을 넘어간 수는 다른 주장의 수이므로, 이름에서 뻗은
 * 창을 그 이름이 선 문장 안에서 끊는다. 표의 칸은 마침표로 끝나지 않아 `| 기능블록 | 214 |` 은
 * 그대로 한 자리로 남는다.
 */
function withinSentence(text, side) {
  SENTENCE_END_RE.lastIndex = 0;
  const ends = [...text.matchAll(SENTENCE_END_RE)];
  if (ends.length === 0) return text;
  return side === 'head' ? text.slice(ends.at(-1).index + 1) : text.slice(0, ends[0].index);
}

/** `§7.1` 은 값이 아니라 자리 참조다. 절 번호를 값으로 읽으면 절 번호끼리 "갈라졌다"고 본다. */
function withoutSectionRefs(value) {
  return String(value).replace(/§\s*\d+(?:\.\d+)*/g, ' ');
}

function isNumericValue(value) {
  const measurable = withoutSectionRefs(value);
  return extractNumbers(measurable).length > 0 && significantTokens(value).length <= NUMERIC_MAX_TOKENS;
}

/**
 * 그 숫자를 이 항목의 값으로 볼 수 있는 자리인가.
 *
 * 표 칸의 값은 (행 이름, 열 이름) 쌍이 정한다. 두 제약이 여기서 나온다:
 *   상대 줄도 표의 칸이면 그 표가 같은 열을 가져야 한다 — 이름만 같은 다른 열의 값은 다른 사실이다.
 *   소유 표가 교차표(측정 열이 둘 이상)면 행 이름만으로는 사실이 지목되지 않는다. `| portal | 20 |
 *   17 | 3 |` 의 20 은 "portal 의 값"이 아니라 "portal × 등록 타일"의 값이라, 열 이름을 밝히지 않은
 *   자리의 숫자와 대조하면 옆 열의 값을 드리프트로 읽는다. 측정 열이 하나인 표는 행 이름이 곧 사실
 *   이름이라 이 제약을 받지 않는다.
 */
function comparableColumn(item, lineColumns, normalizedLine) {
  if (!item.column) return true;
  if (lineColumns) return lineColumns.has(normalizeText(item.column));
  return !item.cross_tab || containsName(normalizedLine, item.column);
}

/**
 * 값이 데리고 다니는 말이 그 수가 **무엇의 수인지**를 밝힌다. 소유 값이 `배포단위 6` 이면 "배포단위"
 * 가 그 6 의 주어라, 그 말이 없는 자리의 숫자는 같은 이름 옆에 있어도 다른 사실의 수다 — `전환 게이트`
 * 옆의 `배포단위 6` 과 `타일 4` 가 그렇게 드리프트로 둔갑한다. 값이 숫자뿐이면 (`214`) 주어를 밝힐
 * 말이 없으므로 이 제약을 걸지 않는다.
 */
function statesSameSubject(value, window) {
  const qualifiers = significantTokens(withoutSectionRefs(value)).filter((token) => /\p{L}/u.test(token));
  if (qualifiers.length === 0) return true;
  return qualifiers.some((token) => window.includes(token));
}

/**
 * 한 줄이 이 소유 항목의 재서술인가.
 * lineColumns 는 그 줄이 표의 본문 행일 때 그 표의 열 이름 집합(정규형) — 표 밖이면 null.
 * @returns {null|{match:'same'|'partial'|'different', ...}} null 이면 재서술이 아니다.
 */
export function classifyLine(item, rawLine, lineColumns = null) {
  const normalized = normalizeText(withoutStructuralMarkers(rawLine));
  if (!normalized) return null;
  const named = containsName(normalized, item.name);

  if (isNumericValue(item.value)) {
    if (!named) return null;
    if (!comparableColumn(item, lineColumns, normalized)) return null;
    const ownerValues = extractNumbers(withoutSectionRefs(item.value));
    const window = withoutSectionRefs(valueWindow(normalized, item.name));
    if (!statesSameSubject(item.value, window)) return null;
    const foundValues = extractNumbers(window);
    if (foundValues.length === 0) return null;
    if (ownerValues.every((value) => foundValues.includes(value))) {
      return { match: 'same', found_values: foundValues, owner_values: ownerValues };
    }
    return { match: 'different', found_values: foundValues, owner_values: ownerValues };
  }

  const tokens = significantTokens(item.value);
  if (tokens.length === 0) return null;
  const missing = tokens.filter((token) => !normalized.includes(token));
  const coverage = (tokens.length - missing.length) / tokens.length;
  if (missing.length === 0) return { match: 'same', coverage: 1, missing_tokens: [] };
  if (named && coverage >= PARTIAL_COVERAGE_MIN) {
    return { match: 'partial', coverage: Number(coverage.toFixed(2)), missing_tokens: missing };
  }
  return null;
}

/**
 * 그 줄이 예시 코드 자리인가.
 *
 * 언어를 밝힌 펜스(```tsx·```mermaid)는 코드·도식 예시라, 거기 적힌 값은 사실 서술이 아니라 예시다.
 * 언어 없는 펜스는 다르다 — 설계 문서는 트리와 계약식을 단조 폰트로 적을 뿐이고, 그 안의 값은 산문에
 * 적었을 때와 똑같이 사실을 주장한다. 그래서 이 축은 언어 없는 펜스를 산문으로 본다. 표시 형식이
 * 아니라 그 줄이 사실을 주장하느냐가 재서술 여부를 가른다.
 */
export function isExampleFence(parsed, line) {
  return parsed.fences.some(
    (fence) => line >= fence.start && line <= fence.end && (fence.info ?? '').trim() !== '',
  );
}

/** 이 줄이 속한 가장 안쪽 절의 범위. 인용 링크는 같은 절 안에 있어야 그 줄을 가려준다. */
export function sectionRange(parsed, line) {
  const headings = parsed.headings;
  let start = 1;
  for (const heading of headings) {
    if (heading.line > line) break;
    start = heading.line;
  }
  const next = headings.find((heading) => heading.line > start);
  return { start, end: next ? next.line - 1 : parsed.lines.length };
}

function resolveLinkPath(target, fromFile) {
  const [pathPart] = target.split('#');
  if (!pathPart || SCHEME_RE.test(pathPart)) return null;
  const base = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const segments = [];
  for (const segment of `${base ? `${base}/` : ''}${pathPart}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

function documentKey(path) {
  return (path.split('/').pop() ?? '').replace(/\.(md|markdown)$/i, '').toLowerCase();
}

/**
 * 이 링크가 소유 문서를 가리키는가.
 * 상대 경로는 그대로 해석하고, `#<ns>/<id>` 형태의 매니페스트 id 참조는 마지막 마디로 문서를 짚는다
 * (id 집합의 정본은 링크 축이 소유한다 — 여기서 매니페스트를 다시 읽지 않는다).
 */
export function linksToOwner(target, fromFile, ownerPath) {
  if (!target) return false;
  const resolved = resolveLinkPath(target, fromFile);
  if (resolved && resolved.toLowerCase() === ownerPath.toLowerCase()) return true;

  const [before, ...fragments] = target.split('#');
  const reference = before === '' ? fragments.join('#') : resolved;
  if (!reference || !reference.includes('/')) {
    if (before !== '' && reference) return documentKey(reference) === documentKey(ownerPath);
    return false;
  }
  return documentKey(reference) === documentKey(ownerPath);
}

/** 그 줄 또는 그 줄이 속한 절이 소유 문서를 인용하는가. */
export function citesOwner(doc, line, ownerPath) {
  const { start, end } = sectionRange(doc.parsed, line);
  return doc.parsed.links.some(
    (link) => link.line >= start && link.line <= end && linksToOwner(link.target, doc.path, ownerPath),
  );
}

function quoteOf(raw) {
  return raw.trim().slice(0, MAX_QUOTE_LENGTH);
}

/**
 * 표 본문 행마다 그 표의 열 이름 집합(정규형). 표 밖의 줄은 이 지도에 없다.
 * 칸의 값을 비교할 때 "같은 열인가"를 물으려면 상대 줄의 열 문맥이 필요하다.
 */
export function tableColumnsByLine(doc) {
  const map = new Map();
  for (const table of doc.parsed.tables) {
    const columns = new Set(table.header.map((cell) => normalizeText(cell)).filter(Boolean));
    for (const row of table.rows) map.set(row.line, columns);
  }
  return map;
}

/**
 * 그 표에서 행을 지목하는 열은 어디인가.
 *
 * 첫 열이 늘 이름인 것은 아니다. 용어집처럼 첫 열이 **분류**인 표에서는 같은 값이 여러 행에 반복되므로
 * 그 열로는 행이 지목되지 않는다 — `| 코드 구조 | 호스트 | … |` 을 "코드 구조의 값" 으로 읽으면 같은
 * 분류의 행들이 서로의 값을 덮어쓴다(뒤 행이 앞 행을 밀어내 표의 대부분이 소유 항목에서 사라진다).
 *
 * 그래서 첫 열이 행을 지목하지 못할 때만 다음 열을 본다. 지목하는 열의 조건은 빈 칸이 없고 값이 행마다
 * 다른 것이고, 대체 열은 **짧아야** 한다 — 설명 열도 행마다 다르지만 그것은 이름이 아니라 서술이다.
 */
export function keyColumnIndex(table) {
  const columnValues = (index) => table.rows.map((row) => normalizeText(stripMarkup(row.cells[index] ?? '')));
  const identifies = (values) => values.every(Boolean) && new Set(values).size === values.length;

  if (identifies(columnValues(0))) return 0;
  for (let index = 1; index < table.header.length; index += 1) {
    const values = columnValues(index);
    if (!identifies(values)) continue;
    if (values.some((value) => value.length > MAX_KEY_LENGTH)) continue;
    return index;
  }
  return 0;
}

/**
 * 소유 문서 하나에서 소유 대상 항목을 뽑는다.
 * 합계 행은 뽑지 않는다 — "합계"는 그 표 안의 자리를 가리키는 말이지 문서 집합 전체에서 같은 것을
 * 가리키는 이름이 아니라, 다른 표의 합계와 대조하면 무관한 두 총계를 같은 사실로 읽는다.
 * 어떤 라벨이 합계인지는 config 의 numbers.total_row_labels 가 이미 정본으로 갖고 있다.
 */
export function ownedItemsIn(doc, { totalRowLabels = [] } = {}) {
  const parsed = doc.parsed;
  const items = [];
  const tableLines = new Set();
  const totals = new Set(totalRowLabels.map((label) => normalizeText(label)));

  for (const table of parsed.tables) {
    for (let line = table.line; line <= table.endLine; line += 1) tableLines.add(line);
    const keyIndex = keyColumnIndex(table);
    // 측정 열이 둘 이상이면 교차표다 — 칸을 지목하려면 행 이름만으로는 모자란다.
    const measures = table.header.filter(
      (_, index) =>
        index !== keyIndex && table.rows.some((row) => isNumericValue(stripMarkup(row.cells[index] ?? ''))),
    );
    const crossTab = measures.length >= 2;

    for (const row of table.rows) {
      const name = stripMarkup(row.cells[keyIndex] ?? '');
      if (normalizeText(name).length < MIN_NAME_LENGTH) continue;
      if (totals.has(normalizeText(name))) continue;
      row.cells.forEach((cell, index) => {
        if (index === keyIndex) return;
        const value = stripMarkup(cell);
        if (!value || value.length > MAX_VALUE_LENGTH) return;
        if (!/[\p{L}\p{N}]/u.test(value)) return;
        if (normalizeText(value) === normalizeText(name)) return;
        items.push({
          kind: 'table-row',
          name,
          value,
          column: stripMarkup(table.header[index] ?? '') || null,
          cross_tab: crossTab,
          line: row.line,
          quote: quoteOf(row.raw),
        });
      });
    }
  }

  parsed.lines.forEach((raw, index) => {
    const line = index + 1;
    if (tableLines.has(line) || isExampleFence(parsed, line)) return;
    const match = DEFINITION_RE.exec(raw);
    if (!match) return;
    const name = stripMarkup(match[2]);
    const value = stripMarkup(match[3]);
    if (normalizeText(name).length < MIN_NAME_LENGTH) return;
    if (!value || value.length > MAX_VALUE_LENGTH) return;
    items.push({ kind: 'definition', name, value, column: null, line, quote: quoteOf(raw) });
  });

  return items.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

/** config 의 소유 선언마다 소유 문서를 열어 항목을 모은다. 같은 (문서·열·이름) 은 한 번만. */
export function extractOwnedItems(ownership, documentsByPath, options = {}) {
  const items = [];
  const missingOwners = [];
  const seen = new Set();

  for (const entry of ownership) {
    const doc = documentsByPath.get(entry.owner);
    if (!doc) {
      missingOwners.push(entry);
      continue;
    }
    for (const item of ownedItemsIn(doc, options)) {
      const key = [entry.owner, item.column ?? '', normalizeText(item.name)].join('\0');
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ ...item, what: entry.what, owner: entry.owner, hint: entry.hint ?? null });
    }
  }

  return { items, missingOwners };
}

function scanItem(item, targets) {
  const drifted = [];
  const restated = [];

  for (const doc of targets) {
    if (doc.path === item.owner) continue;
    const columnsByLine = tableColumnsByLine(doc);
    doc.parsed.lines.forEach((raw, index) => {
      const line = index + 1;
      if (isExampleFence(doc.parsed, line)) return;
      const verdict = classifyLine(item, raw, columnsByLine.get(line) ?? null);
      if (!verdict) return;

      const location = { file: doc.path, line, quote: quoteOf(raw) };
      if (verdict.match === 'different') {
        drifted.push({ ...location, found_values: verdict.found_values, owner_values: verdict.owner_values });
        return;
      }
      // 인용은 **전문 일치**만 가려준다. 부분 일치는 값의 일부가 빠진 복제라, 소유 문서를 가리키면서도
      // 그 값과 다른 것을 적고 있는 자리다 — 인용이 있다는 사실이 빠진 토큰을 되돌려주지 않는다.
      if (verdict.match === 'same' && citesOwner(doc, line, item.owner)) return;
      restated.push({
        ...location,
        value_match: verdict.match,
        ...(verdict.coverage !== undefined ? { coverage: verdict.coverage } : {}),
        ...(verdict.missing_tokens?.length ? { missing_tokens: verdict.missing_tokens } : {}),
      });
    });
  }

  return { drifted, restated };
}

function ownerLocation(item) {
  return { file: item.owner, line: item.line, quote: item.quote };
}

function driftedCopyFinding(item, drifted, restated) {
  const first = drifted[0];
  const message =
    `"${item.name}" 을(를) 소유 문서 ${item.owner}:${item.line} 는 ${item.value} 로 적는데 ` +
    `${first.file}:${first.line} 는 ${first.found_values.join(' · ')} 로 재서술했다 ` +
    `(재서술 ${drifted.length + restated.length}곳 중 ${drifted.length}곳이 이미 갈라졌다).`;

  return createFinding({
    axis: AXIS,
    severity: 'block',
    code: 'ownership.drifted-copy',
    message,
    locations: [...drifted.map(({ file, line, quote }) => ({ file, line, quote })), ownerLocation(item)],
    payload: {
      what: item.what,
      owner_doc: item.owner,
      item: { name: item.name, value: item.value, kind: item.kind, column: item.column, line: item.line },
      already_drifted: true,
      duplicate_locations: [...drifted, ...restated],
      drift_detail: drifted.map((location) => ({
        file: location.file,
        line: location.line,
        owner_values: location.owner_values,
        found_values: location.found_values,
      })),
    },
  });
}

function candidateFor(item, restated, drifted) {
  return {
    axis: AXIS,
    what: item.what,
    owner_doc: item.owner,
    hint: item.hint,
    item: {
      name: item.name,
      value: item.value,
      kind: item.kind,
      column: item.column,
      line: item.line,
      quote: item.quote,
    },
    duplicate_locations: restated,
    already_drifted_locations: drifted,
    why: '소유 문서로 가는 링크 없이 소유 항목의 값을 다시 적은 줄 — 복제인지 값 형태만 언급한 것인지는 계약이 판정한다',
  };
}

function ownerMissingFinding(entry, configRef) {
  return createFinding({
    axis: AXIS,
    severity: 'block',
    code: 'ownership.owner-missing',
    message:
      `소유 선언이 가리키는 문서 "${entry.owner}" 가 검사 대상 문서 집합에 없다 — ` +
      `"${entry.what}" 의 소유 위반을 아무것도 검사하지 못한다.`,
    locations: [{ file: configRef, quote: `"what": "${entry.what}", "owner": "${entry.owner}"` }],
    payload: { what: entry.what, owner_doc: entry.owner },
  });
}

/** 축 본체. context 는 loadConfig 의 결과. */
export function runOwnershipCheck(context) {
  const { config } = context;
  if (!hasConfigKey(config, 'ownership')) {
    return createSkippedScanResult({
      axis: AXIS,
      reason: 'config 에 ownership 선언이 없다 — 무엇을 어느 문서가 소유하는지 알 수 없다',
    });
  }

  const corpus = loadCorpus(context, { parse: true });
  const documentsByPath = new Map(allDocuments(corpus).map((doc) => [doc.path, doc]));
  const { items, missingOwners } = extractOwnedItems(config.ownership, documentsByPath, {
    totalRowLabels: config.numbers?.total_row_labels ?? DEFAULTS.total_row_labels,
  });

  const configRef = toPosix(relative(context.repoRoot, context.configPath)) || 'dck.config.json';
  const findings = missingOwners.map((entry) => ownerMissingFinding(entry, configRef));
  const candidates = [];

  for (const item of items) {
    const { drifted, restated } = scanItem(item, corpus.documents);
    if (drifted.length > 0) findings.push(driftedCopyFinding(item, drifted, restated));
    if (restated.length > 0) candidates.push(candidateFor(item, restated, drifted));
  }

  return createScanResult({
    axis: AXIS,
    findings,
    candidates,
    stats: { files_scanned: corpus.filesScanned, excluded: corpus.excluded, skipped: false },
  });
}

function main(argv) {
  const args = parseCliArgs(argv);
  const context = loadConfig(args.config, { repoRoot: args.repo });
  process.stdout.write(`${JSON.stringify(runOwnershipCheck(context), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof ConfigError ? error.message : (error?.stack ?? String(error))}\n`);
    process.exitCode = 1;
  }
}
