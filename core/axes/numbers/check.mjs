#!/usr/bin/env node
/**
 * numbers 축 — 수치 교차.
 *
 * 세 판정기가 한 봉투로 나간다.
 *  (a) 표 산술    — 완전 결정적. 합계 행과 같은 열 부분 행들의 합을 대조한다.
 *  (b) 문서 간 교차 — 계층형. marker_pattern 이 선언된 수치는 findings 로 확정하고,
 *                    선언이 없으면 candidates 로 내려 판단 계약(LLM)이 "같은 모집단인가"를 확정한다.
 *  (c) 데이터 대조 — 완전 결정적. measurements[] 의 명령을 실행해 실측하고 문서 표기와 대조한다.
 *
 * 실행 계약: node check.mjs --config <dck.config.json> [--repo <root>]
 * stdout = scanResult JSON 한 덩어리 · 로그 = stderr · 완주하면 exit 0.
 */

import { execSync } from 'node:child_process';
import { relative, sep } from 'node:path';

import { DEFAULTS, loadConfig, parseCliArgs } from '../../lib/config.mjs';
import { loadCorpus, matchingGlob } from '../../lib/corpus.mjs';
import { createFinding, createScanResult } from '../../lib/findings.mjs';

export const AXIS = 'numbers';

/**
 * 표 산술에서 합계 행으로 볼 라벨.
 * config 에 numbers 블록이 있든 없든 같은 기본값이어야 하므로 lib 의 정본을 그대로 쓴다.
 */
export const TOTAL_ROW_LABELS = DEFAULTS.total_row_labels;

/** 수치 뒤에 붙는 단위 — 라벨 추출에서 "46개" 를 라벨로 오인하지 않게 쓴다. */
const UNIT_WORDS = ['개', '건', '곳', '명', '종', '가지', '회', '줄', '쪽', '항목'];
const UNIT_ALTERNATION = UNIT_WORDS.join('|');

/** 합이 총계보다 커지는 것이 정상이라고 선언한 각주. */
const MULTI_ASSIGNMENT_RE =
  /(다중\s*배정|중복\s*배정|중복\s*집계|중복\s*계상|복수\s*배정|중복\s*포함|multiple\s+assignment|double[-\s]?count|overlap)/i;
/** 행을 덜어냈다고 선언한 각주 — 부분 합이 작은 것이 정상이다. */
const ELISION_RE = /(발췌|일부만|주요\s*항목만|생략(?!\s*없)|excerpt|abridged|partial\s+list)/i;

const NUMBER_RE = /\d+(?:,\d{3})*(?:\.\d+)?/g;
const NUMERIC_CELL_RE = new RegExp(
  `^[*_\`~\\s]*(-?\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(?:%|${UNIT_ALTERNATION})?[*_\`~\\s]*$`,
);
const EMPTY_CELL_RE = /^[-–—*_`~\s.]*$/;
const NOT_APPLICABLE_RE = /^[*_`\s]*(N\/A|n\/a|없음|해당\s*없음|미정|TBD)[*_`\s]*$/;
const HEADING_LINE_RE = /^\s{0,3}#{1,6}(\s|$)/;
const UNIT_ONLY_TOKEN_RE = new RegExp(`^\\d+(?:,\\d{3})*(?:${UNIT_ALTERNATION}|%)?$`);
/** 라벨 토큰 — 최소 한 글자의 letter 를 포함한다("1차" 는 라벨, "46개" 는 아니다). */
const LABEL_TOKEN_RE = /^[\p{L}\p{N}]*\p{L}[\p{L}\p{N}]*$/u;
const TRAILING_PARTICLE_RE = /(은|는|이|가|을|를|의|에|로|으로|와|과|도|만|까지|부터)$/u;

/**
 * 절을 닫는 연결어미 — 뒤따르는 서술은 앞 절과 다른 것을 말한다.
 * 뒤에 글자가 붙으면 어미가 아니라 다른 단어의 일부다("이고" vs "이고객").
 */
const CLAUSE_CONNECTIVE_RE = /(?:이|이었|였|하|했|되|됐|있|없)(?:고|며|지만|거나)(?![\p{L}])|이나(?![\p{L}])/u;
/**
 * 라벨과 수치 사이의 절 경계. 이 너머의 수치는 그 라벨이 세는 값이 아니다 —
 * "56개가 전환 대상이고 9개는 범위 밖" 에서 "전환 대상" 의 값은 연결어미 앞의 56 이다.
 * 문장 부호와 나열 부호도 같은 이유로 경계다. 표 칸 구분자(`|`)와 화살표는 경계가 아니다 —
 * `| 합계 | 48 |` 처럼 라벨과 값을 잇는 정상 표기다.
 */
const CLAUSE_BREAK_RE = new RegExp(`[.!?;,·、]|${CLAUSE_CONNECTIVE_RE.source}`, 'u');

const QUOTE_MAX = 200;
const LABEL_MAX_TOKENS = 3;
const LABEL_MAX_LENGTH = 40;
/** 한 글자 라벨은 모집단을 지목하지 못한다 — "…46개 중 3개" 의 "중" 같은 의존 명사다. */
const LABEL_MIN_LENGTH = 2;
const MEASUREMENT_TIMEOUT_MS = 15_000;

// ─────────────────────────────────────────────────────────────── 공통 유틸

function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}

export function quoteOf(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed.length > QUOTE_MAX ? `${trimmed.slice(0, QUOTE_MAX - 1)}…` : trimmed;
}

function stripFormatting(text) {
  return String(text ?? '')
    .replace(/[*_`~]/g, '')
    .trim();
}

export function parseNumber(text) {
  const cleaned = String(text).replace(/,/g, '');
  if (!/\d/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** 소수 자리를 맞춰 정수로 비교한다 — 0.1+0.2 로 위반을 만들지 않는다. */
function decimalsOf(value) {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

export function equalNumbers(a, b) {
  const scale = 10 ** Math.max(decimalsOf(a), decimalsOf(b));
  return Math.round(a * scale) === Math.round(b * scale);
}

function sumNumbers(values) {
  const scale = 10 ** Math.max(0, ...values.map(decimalsOf));
  const total = values.reduce((acc, value) => acc + Math.round(value * scale), 0);
  return total / scale;
}

function lineOf(document, line) {
  return document.parsed.lines[line - 1] ?? '';
}

function fenceMaskOf(document) {
  const mask = new Set();
  for (const fence of document.parsed.fences) {
    for (let line = fence.start; line <= fence.end; line += 1) mask.add(line);
  }
  return mask;
}

function tableMaskOf(document) {
  const mask = new Set();
  for (const table of document.parsed.tables) {
    for (let line = table.line; line <= table.endLine; line += 1) mask.add(line);
  }
  return mask;
}

/** 표의 헤더·구분 줄. 그 줄의 칸은 값이 아니라 열 이름이다. */
function tableHeaderMaskOf(document) {
  const mask = new Set();
  for (const table of document.parsed.tables) {
    mask.add(table.line);
    mask.add(table.delimiterLine);
  }
  return mask;
}

function insideCodeSpan(document, line, start, end) {
  return document.parsed.codeSpans.some(
    (span) => span.line === line && start < span.endColumn && end > span.column - 1,
  );
}

// ────────────────────────────────────────────────────── (a) 표 산술

export function isTotalLabel(cell, labels) {
  const text = stripFormatting(cell).toLowerCase();
  if (!text) return false;
  return labels.some((label) => {
    const wanted = String(label).toLowerCase();
    if (text === wanted) return true;
    if (!text.startsWith(wanted)) return false;
    const next = text[wanted.length];
    return next === undefined || !/[\p{L}\p{N}]/u.test(next);
  });
}

function parseNumericCell(cell) {
  const match = NUMERIC_CELL_RE.exec(stripFormatting(cell));
  return match ? parseNumber(match[1]) : null;
}

function isSkippableCell(cell) {
  const text = stripFormatting(cell);
  return text === '' || EMPTY_CELL_RE.test(text) || NOT_APPLICABLE_RE.test(text);
}

/**
 * 표에 붙은 각주를 분류한다. 표 바로 위 캡션 1줄과 표 아래 3줄까지 본다.
 * 'multi-assignment' 는 합이 커지는 것을, 'elision' 은 합이 작아지는 것을 정상으로 만든다.
 */
export function classifyTableNote(document, table) {
  const notes = [];
  const fences = fenceMaskOf(document);

  for (let line = table.line - 1; line >= Math.max(1, table.line - 2); line -= 1) {
    const text = lineOf(document, line).trim();
    if (text === '') continue;
    if (HEADING_LINE_RE.test(text) || text.includes('|')) break;
    notes.push({ line, text });
    break;
  }

  let collected = 0;
  for (let line = table.endLine + 1; line <= table.endLine + 5 && collected < 3; line += 1) {
    if (fences.has(line)) break;
    const text = lineOf(document, line).trim();
    if (text === '') continue;
    if (HEADING_LINE_RE.test(text) || text.includes('|')) break;
    notes.push({ line, text });
    collected += 1;
  }

  for (const note of notes) {
    if (MULTI_ASSIGNMENT_RE.test(note.text)) {
      return { kind: 'multi-assignment', line: note.line, quote: quoteOf(note.text) };
    }
  }
  for (const note of notes) {
    if (ELISION_RE.test(note.text)) {
      return { kind: 'elision', line: note.line, quote: quoteOf(note.text) };
    }
  }
  if (notes.length > 0) {
    return { kind: 'other-note', line: notes[0].line, quote: quoteOf(notes[0].text) };
  }
  return { kind: 'none', line: null, quote: null };
}

/**
 * 합계 행이 있는 표를 열 단위로 대조한다.
 *
 * 각주가 설명하는 방향의 불일치는 위반이 아니다(다중 배정 표는 합이 커지는 것이 정상).
 * 설명이 아닌 각주가 붙어 있으면 초과 방향만 warn 으로 낮춘다 — 무근거로 block 을 지우지 않는다.
 */
export function checkTableSums(document, { totalRowLabels = TOTAL_ROW_LABELS } = {}) {
  const findings = [];

  for (const table of document.parsed.tables) {
    const totalRows = [];
    const partRows = [];
    for (const row of table.rows) {
      const labelIndex = row.cells.findIndex((cell) => isTotalLabel(cell, totalRowLabels));
      if (labelIndex === -1) partRows.push(row);
      else totalRows.push({ row, labelIndex });
    }
    if (totalRows.length === 0 || partRows.length < 2) continue;

    const note = classifyTableNote(document, table);

    for (const { row: totalRow, labelIndex } of totalRows) {
      for (let column = 0; column < table.columns; column += 1) {
        if (column === labelIndex) continue;

        const declared = parseNumericCell(totalRow.cells[column] ?? '');
        if (declared === null) continue;

        const parts = [];
        let unparsable = false;
        for (const row of partRows) {
          const cell = row.cells[column] ?? '';
          if (isSkippableCell(cell)) continue;
          const value = parseNumericCell(cell);
          if (value === null) {
            unparsable = true;
            break;
          }
          parts.push({
            label: stripFormatting(row.cells[labelIndex] ?? row.cells[0] ?? ''),
            value,
            line: row.line,
          });
        }
        // 숫자가 아닌 칸이 섞인 열은 판정하지 않는다 — 산술이 성립하는지 알 수 없다.
        if (unparsable || parts.length < 2) continue;

        const partsSum = sumNumbers(parts.map((part) => part.value));
        if (equalNumbers(partsSum, declared)) continue;

        const direction = partsSum > declared ? 'over' : 'under';
        if (direction === 'over' && note.kind === 'multi-assignment') continue;
        if (direction === 'under' && note.kind === 'elision') continue;

        const severity = direction === 'over' && note.kind === 'other-note' ? 'warn' : 'block';
        const columnLabel = stripFormatting(table.header[column] ?? `열 ${column + 1}`) || `열 ${column + 1}`;

        findings.push(
          createFinding({
            axis: AXIS,
            severity,
            code: 'numbers.table-sum',
            message:
              `표 산술 불일치 — "${columnLabel}" 열의 부분 합은 ${partsSum} 인데 합계 행은 ${declared} 이다` +
              ` (${parts.map((part) => part.value).join(' + ')} = ${partsSum} ≠ ${declared})`,
            locations: [
              {
                file: document.path,
                line: totalRow.line,
                quote: quoteOf(totalRow.raw),
              },
              ...parts.map((part) => ({
                file: document.path,
                line: part.line,
                quote: quoteOf(lineOf(document, part.line)),
              })),
            ],
            payload: {
              column: columnLabel,
              table_line: table.line,
              parts: parts.map((part) => ({ label: part.label, value: part.value, line: part.line })),
              parts_sum: partsSum,
              declared_total: declared,
              direction,
              note: note.kind === 'none' ? null : note,
            },
          }),
        );
      }
    }
  }

  return findings;
}

// ───────────────────────────────────────────────── (b) 문서 간 교차

function normalizeToken(token) {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%]+$/gu, '');
}

/** 숫자 바로 앞 토큰 1~3개를 라벨 후보로 만든다. 좁은 라벨일수록 다른 문장과 잘 맞는다. */
export function labelVariantsBefore(text) {
  const tokens = [];
  for (const raw of text.split(/[\s|>]+/).reverse()) {
    const token = normalizeToken(raw);
    if (token === '') {
      if (tokens.length > 0) break;
      continue;
    }
    if (UNIT_ONLY_TOKEN_RE.test(token) || !LABEL_TOKEN_RE.test(token)) break;
    tokens.unshift(token);
    if (tokens.length === LABEL_MAX_TOKENS) break;
  }

  const variants = [];
  for (let width = 1; width <= tokens.length; width += 1) {
    const slice = tokens.slice(tokens.length - width);
    const last = slice[slice.length - 1].replace(TRAILING_PARTICLE_RE, '') || slice[slice.length - 1];
    const label = [...slice.slice(0, -1), last].join(' ');
    if (label.length >= LABEL_MIN_LENGTH && label.length <= LABEL_MAX_LENGTH) variants.push(label);
  }
  return variants;
}

function isReferenceNumber(raw, start, end) {
  const before = raw.slice(0, start);
  const after = raw.slice(end);
  if (/[§#v/\-.:]\s*$/.test(before)) return true; // 절 번호 · 앵커 · 버전 · 날짜 · 시각
  if (/^[./\-:]\d/.test(after)) return true;
  if (/^\s*$/.test(before)) return true; // 줄 첫머리 — 목록 마커거나 라벨이 없다
  return false;
}

/**
 * 산문에서 `<라벨><숫자>` 를 뽑는다. fenced code block · 코드스팬 · 표 안은 보지 않는다
 * (표는 (a) 가 소유한다).
 */
export function extractProseNumbers(document) {
  const fences = fenceMaskOf(document);
  const tables = tableMaskOf(document);
  const occurrences = [];

  document.parsed.lines.forEach((raw, index) => {
    const line = index + 1;
    if (fences.has(line) || tables.has(line)) return;

    NUMBER_RE.lastIndex = 0;
    let match;
    while ((match = NUMBER_RE.exec(raw)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (insideCodeSpan(document, line, start, end)) continue;
      if (isReferenceNumber(raw, start, end)) continue;

      const variants = labelVariantsBefore(raw.slice(0, start));
      if (variants.length === 0) continue;

      occurrences.push({
        file: document.path,
        line,
        value: parseNumber(match[0]),
        raw: match[0],
        variants,
        quote: quoteOf(raw),
      });
    }
  });

  return occurrences;
}

/** config 의 marker_pattern 으로 표시된 수치 — 캡처 1 = 라벨, 2 = 값. */
export function extractMarkedNumbers(document, markerPattern) {
  const source = markerPattern instanceof RegExp ? markerPattern.source : String(markerPattern);
  const regex = new RegExp(source, 'g');
  const fences = fenceMaskOf(document);
  const marked = [];

  document.parsed.lines.forEach((raw, index) => {
    const line = index + 1;
    if (fences.has(line)) return;

    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(raw)) !== null) {
      const label = (match[1] ?? '').trim();
      const value = parseNumber(match[2] ?? '');
      if (label === '' || value === null) continue;
      marked.push({ file: document.path, line, label, value, quote: quoteOf(raw) });
      if (match[0] === '') regex.lastIndex += 1;
    }
  });

  return marked;
}

function byLocation(a, b) {
  return a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file);
}

function distinctValues(entries) {
  return [...new Set(entries.map((entry) => entry.value))].sort((a, b) => a - b);
}

function locationKeys(entries) {
  return entries.map((entry) => `${entry.file}:${entry.line}:${entry.value}`);
}

/** 마커된 수치의 라벨별 대조 — 마커가 모집단을 선언했으므로 갈리면 후보가 아니라 결정적 위반이다. */
export function crossDocumentFindings(marked) {
  const groups = new Map();
  for (const entry of marked) {
    const key = entry.label.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const findings = [];
  for (const entries of groups.values()) {
    const values = distinctValues(entries);
    if (values.length < 2) continue;
    const sorted = [...entries].sort(byLocation);

    findings.push(
      createFinding({
        axis: AXIS,
        severity: 'block',
        code: 'numbers.cross-doc',
        message:
          `"${sorted[0].label}" 로 마커된 수치가 갈린다 — ${values.join(' vs ')}` +
          ` (${sorted.map((entry) => `${entry.file}:${entry.line}=${entry.value}`).join(', ')})`,
        locations: sorted.map((entry) => ({ file: entry.file, line: entry.line, quote: entry.quote })),
        payload: {
          label: sorted[0].label,
          mode: 'marker',
          distinct_values: values,
          values: sorted.map((entry) => ({ file: entry.file, line: entry.line, value: entry.value })),
        },
      }),
    );
  }

  return findings.sort((a, b) => byLocation(a.locations[0], b.locations[0]));
}

/**
 * 마커가 없는 수치는 후보까지만 결정적이다 — "같은 모집단을 세는가" 는 판단 계약이 답한다.
 *
 * config numbers.labels[] 로 선언된 라벨을 먼저 묶고, 남은 것은 라벨 폭(1~3 토큰)이 넓은
 * 묶음부터 채택한다. 이미 채택된 묶음에 담긴 위치만으로 이뤄진 좁은 묶음은 버린다.
 */
export function crossDocumentCandidates(occurrences, { declaredLabels = [], skipLabels = [] } = {}) {
  const skip = new Set(skipLabels.map((label) => label.toLowerCase()));
  const candidates = [];
  const covered = new Set();

  const emit = (label, entries, { declared }) => {
    const sorted = [...entries].sort(byLocation);
    const keys = locationKeys(sorted);
    if (keys.every((key) => covered.has(key))) return;
    for (const key of keys) covered.add(key);

    candidates.push({
      kind: 'cross-doc',
      label,
      declared,
      distinct_values: distinctValues(sorted),
      occurrences: sorted.map((entry) => ({
        file: entry.file,
        line: entry.line,
        value: entry.value,
        quote: entry.quote,
      })),
      question: '같은 모집단을 세는 수치인가 — 다른 것을 세는 두 수는 위반이 아니다',
    });
  };

  for (const declaredLabel of declaredLabels) {
    const wanted = declaredLabel.toLowerCase();
    const entries = occurrences.filter((entry) =>
      entry.variants.some((variant) => variant.toLowerCase() === wanted),
    );
    if (distinctValues(entries).length < 2) continue;
    emit(declaredLabel, entries, { declared: true });
  }

  for (let width = LABEL_MAX_TOKENS; width >= 1; width -= 1) {
    const groups = new Map();
    for (const entry of occurrences) {
      const variant = entry.variants[width - 1];
      if (variant === undefined) continue;
      const key = variant.toLowerCase();
      if (skip.has(key)) continue;
      if (!groups.has(key)) groups.set(key, { label: variant, entries: [] });
      groups.get(key).entries.push(entry);
    }
    for (const { label, entries } of [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))) {
      if (distinctValues(entries).length < 2) continue;
      emit(label, entries, { declared: false });
    }
  }

  return candidates;
}

// ───────────────────────────────────────────────────── (c) 데이터 대조

export function defaultExec(cmd, { cwd }) {
  return execSync(cmd, {
    cwd,
    encoding: 'utf8',
    timeout: MEASUREMENT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/** stdout 의 마지막 비어 있지 않은 줄이 실측값이다. 그 줄에 수치가 없으면 실측 실패다. */
export function parseMeasuredValue(stdout) {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return null;
  const match = /-?\d+(?:,\d{3})*(?:\.\d+)?/.exec(lines[lines.length - 1]);
  return match ? parseNumber(match[0]) : null;
}

/**
 * 한 문서에서 그 라벨에 붙은 수치를 찾는다. 표 본문 행도 본다 — 실측 대조는 산문 한정이 아니다.
 * 다만 표의 헤더 줄은 보지 않는다: 거기 붙은 숫자는 그 라벨의 값이 아니라 옆 열 이름의 일부다
 * (`| 등록 타일 | 매핑 범위 밖(§6) |` 의 6). 절 번호·버전·코드스팬도 값이 아니라 참조라 뺀다 —
 * 산문 수치 추출(extractProseNumbers)이 이미 쓰는 것과 같은 기준이다.
 *
 * 라벨과 수치의 결합은 방향이 아니라 두 가지가 정한다.
 *  1. 같은 절 안일 것 — 사이에 절 경계가 있으면 그 수치는 다른 절의 것이다(CLAUSE_BREAK_RE).
 *  2. 더 가까울 것 — 양쪽 다 같은 절이면 사이 간격이 짧은 쪽이 그 라벨의 값이다.
 * 한 줄에서 한 값만 남긴다. 같은 거리면 뒤에 오는 수치를 택한다 — "라벨 N" 이 기본 표기다.
 */
export function findLabelledValues(document, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const number = '\\d+(?:,\\d{3})*(?:\\.\\d+)?';
  const directions = [
    // 라벨 뒤 수치 — 간격 캡처 1, 값 캡처 2. 값은 매치 끝에 붙어 있다.
    {
      regex: new RegExp(`${escaped}([^\\d\\n]{0,12})(${number})`, 'g'),
      gapAt: 1,
      valueAt: 2,
      startOf: (match) => match.index + label.length + match[1].length,
    },
    // 라벨 앞 수치 — 값 캡처 1, 간격 캡처 2. 값이 매치 첫머리다.
    {
      regex: new RegExp(`(${number})([^\\d\\n]{0,8})${escaped}`, 'g'),
      gapAt: 2,
      valueAt: 1,
      startOf: (match) => match.index,
    },
  ];
  const fences = fenceMaskOf(document);
  const headers = tableHeaderMaskOf(document);
  const hits = [];

  document.parsed.lines.forEach((raw, index) => {
    const line = index + 1;
    if (fences.has(line) || headers.has(line)) return;

    let best = null;
    for (const { regex, gapAt, valueAt, startOf } of directions) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(raw)) !== null) {
        const value = parseNumber(match[valueAt]);
        if (value === null) continue;

        const gap = match[gapAt];
        // 절 경계 너머의 수치는 이 라벨이 세는 값이 아니다 — 다음 라벨 등장으로 넘어간다.
        if (CLAUSE_BREAK_RE.test(gap)) continue;

        const start = startOf(match);
        const end = start + match[valueAt].length;
        if (insideCodeSpan(document, line, start, end)) continue;
        if (isReferenceNumber(raw, start, end)) continue;

        if (best === null || gap.length < best.gap) best = { value, gap: gap.length };
        break;
      }
    }
    if (best !== null) hits.push({ file: document.path, line, value: best.value, quote: quoteOf(raw) });
  });

  return hits;
}

function unverifiable({ measurement, reason, location }) {
  return createFinding({
    axis: AXIS,
    severity: 'warn',
    code: 'numbers.unverifiable',
    message: `"${measurement.label}" 실측 대조를 할 수 없다 — ${reason}`,
    locations: [location],
    payload: {
      label: measurement.label,
      measured: { value: null, method: measurement.cmd },
      verdict: 'unverifiable',
      reason,
    },
  });
}

/**
 * measurements[] 를 실행해 문서 표기와 대조한다.
 * 명령이 실패하거나 값이 숫자가 아니면 그 항목만 unverifiable 로 보고한다 — 축은 완주한다.
 */
export function runMeasurements(context, corpus, { exec = defaultExec, log = () => {} } = {}) {
  const measurements = context.config.measurements ?? [];
  if (measurements.length === 0) return [];

  const configLocation = {
    file: toPosix(relative(context.repoRoot, context.configPath)) || 'dck.config.json',
  };
  const findings = [];

  for (const measurement of measurements) {
    let stdout;
    try {
      stdout = exec(measurement.cmd, { cwd: context.repoRoot });
    } catch (error) {
      const reason =
        error?.signal === 'SIGTERM'
          ? `명령이 ${MEASUREMENT_TIMEOUT_MS}ms 안에 끝나지 않았다: ${measurement.cmd}`
          : `명령이 실패했다: ${measurement.cmd} (${error?.status ?? error?.code ?? error?.message})`;
      log(`measurement "${measurement.label}": ${reason}`);
      findings.push(unverifiable({ measurement, reason, location: { ...configLocation, quote: measurement.cmd } }));
      continue;
    }

    const measured = parseMeasuredValue(stdout);
    if (measured === null) {
      const reason = `명령 출력의 마지막 줄이 수치가 아니다: ${measurement.cmd}`;
      log(`measurement "${measurement.label}": ${reason}`);
      findings.push(unverifiable({ measurement, reason, location: { ...configLocation, quote: measurement.cmd } }));
      continue;
    }

    const scope = measurement.expect_in
      ? corpus.documents.filter((document) => matchingGlob(document.path, measurement.expect_in))
      : corpus.documents;

    const hits = scope.flatMap((document) => findLabelledValues(document, measurement.label));
    if (hits.length === 0) {
      const reason = measurement.expect_in
        ? `expect_in (${measurement.expect_in.join(' · ')}) 문서에서 "${measurement.label}" 수치를 찾지 못했다`
        : `문서에서 "${measurement.label}" 수치를 찾지 못했다`;
      log(`measurement "${measurement.label}": ${reason}`);
      findings.push(unverifiable({ measurement, reason, location: { ...configLocation, quote: measurement.cmd } }));
      continue;
    }

    const wrong = hits.filter((hit) => !equalNumbers(hit.value, measured));
    if (wrong.length === 0) continue;

    findings.push(
      createFinding({
        axis: AXIS,
        severity: 'block',
        code: 'numbers.data-mismatch',
        message:
          `"${measurement.label}" — 문서는 ${[...new Set(wrong.map((hit) => hit.value))].join(' · ')} 이라 적었는데` +
          ` 실측은 ${measured} 다 (세는 법: ${measurement.cmd})`,
        locations: wrong.sort(byLocation).map((hit) => ({ file: hit.file, line: hit.line, quote: hit.quote })),
        payload: {
          label: measurement.label,
          documented: wrong.map((hit) => ({ file: hit.file, line: hit.line, value: hit.value })),
          measured: { value: measured, method: measurement.cmd },
          verdict: 'doc_wrong',
        },
      }),
    );
  }

  return findings;
}

// ────────────────────────────────────────────────────────── 축 실행

/**
 * 축 전체를 돌려 scanResult 봉투를 만든다.
 * marker_pattern 이 선언된 라벨은 findings 로 확정되고, 그 라벨은 candidates 에서 빠진다.
 */
export function runNumbersAxis(context, { exec = defaultExec, log = () => {} } = {}) {
  const corpus = loadCorpus(context, { parse: true });
  const numbers = context.config.numbers ?? {};
  const totalRowLabels = numbers.total_row_labels ?? TOTAL_ROW_LABELS;

  const findings = [];
  for (const document of corpus.documents) {
    findings.push(...checkTableSums(document, { totalRowLabels }));
  }
  log(`표 산술: ${findings.length}건`);

  let marked = [];
  if (numbers.marker_pattern) {
    marked = corpus.documents.flatMap((document) => extractMarkedNumbers(document, numbers.marker_pattern));
    const crossFindings = crossDocumentFindings(marked);
    findings.push(...crossFindings);
    log(`마커 교차: 마커 ${marked.length}건 → 위반 ${crossFindings.length}건`);
  }

  const occurrences = corpus.documents.flatMap((document) => extractProseNumbers(document));
  const markedLines = new Set(marked.map((entry) => `${entry.file}:${entry.line}`));
  const candidates = crossDocumentCandidates(
    occurrences.filter((entry) => !markedLines.has(`${entry.file}:${entry.line}`)),
    {
      declaredLabels: numbers.labels ?? [],
      skipLabels: [...new Set(marked.map((entry) => entry.label))],
    },
  );
  log(`산문 수치: ${occurrences.length}건 → 교차 후보 ${candidates.length}건`);

  const measurementFindings = runMeasurements(context, corpus, { exec, log });
  findings.push(...measurementFindings);
  log(`데이터 대조: ${measurementFindings.length}건`);

  return createScanResult({
    axis: AXIS,
    findings,
    candidates,
    stats: {
      files_scanned: corpus.filesScanned,
      excluded: corpus.excluded,
      skipped: false,
    },
  });
}

export function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  const context = loadConfig(args.config, { repoRoot: args.repo });
  const result = runNumbersAxis(context, { log: (message) => process.stderr.write(`[numbers] ${message}\n`) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[numbers] ${error?.stack ?? error}\n`);
    process.exit(1);
  }
}
