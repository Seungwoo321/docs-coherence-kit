#!/usr/bin/env node
/**
 * decisions 축 (adr 플러그인) — 결정(ADR) 반영. 결정적 부분.
 *
 * 채택된 결정이 본문에 내려앉았는가를 판정하되, 여기서 끝낼 수 있는 것만 findings 로 낸다.
 *  - (a) 인용 그래프: 결정이 지목한 문서가 그 결정 번호를 인용하는가 → decisions.citation-missing
 *  - (a') 지목 집합 대조: 지목한 반영처가 문서 집합에 실재하는데 이번 실행이 검사하지 않았으면
 *        → decisions.target-out-of-scope. 검사하지 않은 자리가 통과로 읽히면 안 된다.
 *  - (d) supersede 체인: 상태의 `superseded by <번호>` 로 체인을 세우고, 대체된 결정을 여전히
 *        인용하는 줄을 후보로 넘긴다. 끊긴 체인(대상 없음·순환)은 그 자체가 결함이다.
 *  - 카드 대조: adr.cards 가 선언돼 있으면 본문 ↔ 카드의 상태·집합을 대조한다.
 * 의미 판정 — (b) 결정↔본문 반영, (c) 소유 경계 역전, (d) 의 "여전히 따르는가" — 는
 * contract.md 가 소유한다. 이 스크립트는 그 입력이 될 candidates 만 만든다.
 *
 * (e) 동결 규율: 채택된 결정 본문의 드리프트는 결함이 아니다. 그래서 findings 의 첫 location 은
 * 결정 본문 파일·frozen 문서를 가리키지 않는다 — 예외는 결함이 "결정 본문이 든 포인터" 자체라
 * 코퍼스 안에 고칠 자리가 아예 없는 코드(POINTER_CODES)뿐이다. 상태 필드의 대체 대상도 지목
 * 링크도 동결 대상인 "결정 내용"이 아니라 다른 문서를 가리키는 포인터이고, 그 포인터가 끊기거나
 * 검사 밖을 가리키는 것은 어느 대상 문서를 고쳐도 사라지지 않는다.
 *
 * 실행: node check.mjs --config <dck.config.json> [--repo <root>]
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ConfigError, loadConfig, parseCliArgs } from '../../../../core/lib/config.mjs';
import { allDocuments, loadCorpus } from '../../../../core/lib/corpus.mjs';
import { createFinding, createScanResult, createSkippedScanResult } from '../../../../core/lib/findings.mjs';
import { findHeadingBySection, isInsideFence, parseMarkdown } from '../../../../core/lib/markdown.mjs';

export const AXIS = 'decisions';

/** config.adr 의 기본값 — schemas/config.schema.json 의 adr 블록과 같아야 한다. */
export const ADR_DEFAULTS = Object.freeze({
  id_pattern: 'ADR-\\d{3}',
  status_field: '상태',
  decision_field: '결정',
});

export const ADR_KEYS = ['bodies', 'cards', 'id_pattern', 'status_field', 'decision_field'];

/** 동결 문서를 첫 자리로 가리켜도 되는 코드 — 헤더 주석의 (e) 예외. */
export const POINTER_CODES = [
  'decisions.supersede-dangling',
  'decisions.supersede-cycle',
  'decisions.target-out-of-scope',
];

/** 결정 인용을 셀 때 코드 펜스 안은 인용으로 보지 않는다 — 예시이지 추적이 아니다. */
const QUOTE_LIMIT = 200;

const SECTION_REF_RE = /^\s*§\s*(\d+(?:\.\d+)*)((?:\s*[·,]\s*§\s*\d+(?:\.\d+)*)*)/;
const EXTERNAL_TARGET_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const SUPERSEDE_RE = /supersed/i;

export class DecisionsAxisError extends Error {
  constructor(message, problems = []) {
    super(problems.length ? `${message}\n- ${problems.join('\n- ')}` : message);
    this.name = 'DecisionsAxisError';
    this.problems = problems;
  }
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}

function clip(text, limit = QUOTE_LIMIT) {
  const normalized = String(text).trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

/* ------------------------------------------------------------------ config */

/** config.adr 를 읽어 기본값을 채운다. 플러그인 키는 플러그인이 검증한다. */
export function parseAdrSettings(config) {
  const raw = config?.adr;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DecisionsAxisError('adr: 객체여야 한다');
  }

  const problems = [];
  for (const key of Object.keys(raw)) {
    if (!ADR_KEYS.includes(key)) problems.push(`adr.${key}: 알 수 없는 키`);
  }
  for (const key of ['bodies', 'cards', 'id_pattern', 'status_field', 'decision_field']) {
    const value = raw[key];
    if (value === undefined) {
      if (key === 'bodies') problems.push('adr.bodies: 필수 항목이다');
      continue;
    }
    if (typeof value !== 'string' || value.length === 0) {
      problems.push(`adr.${key}: 비어 있지 않은 문자열이어야 한다`);
    }
  }

  const idPattern = raw.id_pattern ?? ADR_DEFAULTS.id_pattern;
  if (typeof idPattern === 'string') {
    try {
      new RegExp(idPattern);
    } catch (error) {
      problems.push(`adr.id_pattern: 정규식으로 컴파일되지 않는다 (${error.message})`);
    }
  }
  if (problems.length) throw new DecisionsAxisError('config.adr 형식 위반', problems);

  return {
    bodies: raw.bodies,
    cards: raw.cards ?? null,
    idPattern,
    statusField: raw.status_field ?? ADR_DEFAULTS.status_field,
    decisionField: raw.decision_field ?? ADR_DEFAULTS.decision_field,
  };
}

/**
 * config 의 파일 경로를 절대 경로로 만든다.
 * docs.root 기준을 먼저 보고 없으면 레포 루트 기준 — 두 표기가 다 쓰인다.
 */
function resolveDeclaredPath(value, { docsRoot, repoRoot }, label) {
  const candidates = [resolve(docsRoot, value), resolve(repoRoot, value)];
  const hit = candidates.find((path) => existsSync(path));
  if (!hit) {
    throw new DecisionsAxisError(`${label} 파일이 없다: ${value} (찾은 곳: ${candidates.join(' · ')})`);
  }
  return hit;
}

/** findings·candidates 에 싣는 경로 — 문서는 docs.root 기준, 그 밖은 레포 루트 기준. */
function displayPath(absPath, { docsRoot, repoRoot }) {
  const fromDocs = toPosix(relative(docsRoot, absPath));
  if (fromDocs && !fromDocs.startsWith('..')) return fromDocs;
  return toPosix(relative(repoRoot, absPath)) || absPath;
}

/* ---------------------------------------------------------------- 본문 파싱 */

function compileIdRegExps(idPattern) {
  return {
    scan: new RegExp(idPattern, 'g'),
    atStart: new RegExp(`^(?:${idPattern})`),
    exact: new RegExp(`^(?:${idPattern})$`),
  };
}

/** `- **상태** accepted` · `상태: accepted` · `**상태**: accepted` 를 모두 받는다. */
function labelledLineRegExp(field) {
  const name = escapeRegExp(field);
  return new RegExp(
    `^\\s*(?:[-*+]\\s+)?(?:(?:\\*\\*|__)\\s*${name}\\s*(?:\\*\\*|__)|${name})\\s*(?:[:：]\\s*|\\s+)(.+?)\\s*$`,
  );
}

/** 라벨 줄에서 시작해 다음 항목·빈 줄·헤딩 전까지 — 감싸 쓴 한 항목을 통째로 본다. */
function labelledBlockEnd(lines, startIndex) {
  let end = startIndex;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') break;
    if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) break;
    if (/^\s{0,3}#{1,6}(?:\s|$)/.test(line)) break;
    if (/^\s{0,3}(?:`{3,}|~{3,})/.test(line)) break;
    end = i;
  }
  return end;
}

function findLabelledBlock(parsed, range, field) {
  const regexp = labelledLineRegExp(field);
  for (let line = range[0]; line <= range[1]; line += 1) {
    if (isInsideFence(parsed, line)) continue;
    const match = regexp.exec(parsed.lines[line - 1] ?? '');
    if (!match) continue;
    const endIndex = Math.min(labelledBlockEnd(parsed.lines, line - 1), range[1] - 1);
    return { line, endLine: endIndex + 1, value: match[1].trim() };
  }
  return null;
}

function statusOf(value, idRe) {
  if (value === null) return { status: null, statusRaw: null, supersededBy: null };
  const raw = value.trim();
  if (!SUPERSEDE_RE.test(raw)) {
    return { status: raw.toLowerCase(), statusRaw: raw, supersededBy: null };
  }
  idRe.scan.lastIndex = 0;
  const match = idRe.scan.exec(raw);
  return { status: 'superseded', statusRaw: raw, supersededBy: match ? match[0] : null };
}

/**
 * 결정 본문 파일을 결정 단위로 가른다.
 * 결정 하나 = 제목이 결정 번호로 시작하는 헤딩 + 다음 동급 이상 헤딩 직전까지.
 */
export function parseDecisionBodies(parsed, settings) {
  const idRe = compileIdRegExps(settings.idPattern);
  const decisions = [];

  parsed.headings.forEach((heading, index) => {
    const match = idRe.atStart.exec(heading.text);
    if (!match) return;
    const rest = heading.text.slice(match[0].length);
    if (rest && !/^[\s:：.,)\]·—-]/.test(rest)) return; // ADR-0071 같은 이웃 번호를 배제한다

    const next = parsed.headings.slice(index + 1).find((h) => h.level <= heading.level);
    const range = [heading.line, (next ? next.line : parsed.lines.length + 1) - 1];

    const status = findLabelledBlock(parsed, range, settings.statusField);
    const decision = findLabelledBlock(parsed, range, settings.decisionField);

    decisions.push({
      id: match[0],
      title: rest.replace(/^[\s:：.,)\]·—-]+/, '').trim(),
      headingLine: heading.line,
      level: heading.level,
      range,
      statusLine: status ? status.line : null,
      ...statusOf(status ? status.value : null, idRe),
      decisionRange: decision ? [decision.line, decision.endLine] : null,
      decisionText: decision
        ? parsed.lines
            .slice(decision.line - 1, decision.endLine)
            .join('\n')
            .trim()
        : null,
    });
  });

  return decisions;
}

/* --------------------------------------------------------------- 대상 해석 */

/** docs.manifest 가 문서 id 를 선언하면 그 매핑을 먼저 쓴다. 형식이 다르면 조용히 포기한다. */
function loadManifestIds(context) {
  const declared = context.config.docs.manifest;
  if (!declared) return new Map();

  const absPath = resolve(context.repoRoot, declared);
  if (!existsSync(absPath)) return new Map();

  let raw;
  try {
    raw = JSON.parse(readFileSync(absPath, 'utf8'));
  } catch {
    return new Map();
  }

  const entries = Array.isArray(raw) ? raw : Array.isArray(raw?.docs) ? raw.docs : [];
  const base = dirname(absPath);
  const map = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const id = entry.id;
    const file = entry.file ?? entry.path;
    if (typeof id !== 'string' || typeof file !== 'string') continue;
    map.set(id, toPosix(relative(context.docsRoot, resolve(base, file))));
  }
  return map;
}

/**
 * 링크 대상을 문서 집합의 문서로 해석한다.
 * 1) 상대 경로 → 2) 문서 매니페스트의 id → 3) 경로/파일명 꼬리 일치.
 * 하나로 좁혀지지 않으면 해석 실패로 남긴다 — 억지로 고르지 않는다.
 *
 * 결과는 세 갈래다.
 *  - `in-corpus`     이번 실행이 검사한 문서. `file` 이 그 경로다.
 *  - `out-of-scope`  문서 집합에 실재하나 이번 실행이 검사하지 않은 자리(제외 글롭·include 밖·
 *                    읽기 실패·docs.root 밖). `reason` 이 코퍼스가 남긴 사유다.
 *  - `not-a-document` 문서 지목이 아니거나(외부 URL·같은 문서 앵커) 어디에도 해석되지 않는 이름.
 *
 * 셋을 하나의 null 로 접으면 "검사하지 않은 자리"가 "지목한 적 없는 자리"와 구별되지 않아,
 * 제외된 반영처를 가진 결정이 후보 0건으로 조용히 통과한다. 실재하지 않는 대상을 여기서 `null`
 * 쪽에 두는 것은 (e) 동결 규율이다 — 동결된 결정 본문의 낡은 링크는 설계상 허용이고, 그것과
 * "실재하지만 이번에 안 본 문서"는 고치는 방법이 다르다.
 */
export function classifyDesignation(rawTarget, resolver) {
  const { bodiesDir, docsRoot, docPaths } = resolver;
  const target = String(rawTarget).trim();
  if (!target || EXTERNAL_TARGET_RE.test(target)) return NOT_A_DOCUMENT;

  if (target.startsWith('#')) {
    const id = target.slice(1);
    if (!id || !id.includes('/')) return NOT_A_DOCUMENT; // 같은 문서 안의 앵커
    return classifyDocumentId(id, resolver);
  }

  const [pathPart] = target.split('#');
  if (!pathPart) return NOT_A_DOCUMENT;

  if (/\.(md|markdown)$/i.test(pathPart)) {
    const absPath = resolve(bodiesDir, decodeURIComponent(pathPart));
    const path = toPosix(relative(docsRoot, absPath));
    if (docPaths.has(path)) return { status: 'in-corpus', file: path };

    const reason = resolver.outOfCorpus?.get(path);
    if (reason) return { status: 'out-of-scope', file: path, reason };
    // docs.root 안인데 검사 대상에도 제외 기록에도 없다 = 그런 파일이 없다.
    if (!path.startsWith('..')) return NOT_A_DOCUMENT;
    if (!existsSync(absPath)) return NOT_A_DOCUMENT;
    return { status: 'out-of-scope', file: path, reason: 'docs.root 밖의 파일이라 문서 집합에 없다' };
  }
  return classifyDocumentId(decodeURIComponent(pathPart), resolver);
}

/** 해석된 검사 대상 문서 경로. 그 밖은 null. */
export function resolveDocumentTarget(rawTarget, resolver) {
  const designation = classifyDesignation(rawTarget, resolver);
  return designation.status === 'in-corpus' ? designation.file : null;
}

const NOT_A_DOCUMENT = Object.freeze({ status: 'not-a-document' });

/** `<ns>/<id>` 든 확장자 없는 경로든, 마지막 마디가 문서 이름이라는 규약으로 맞춰 본다. */
function matchesDocumentName(path, id, tail) {
  const withoutExtension = path.replace(/\.(md|markdown)$/i, '');
  return withoutExtension === id || withoutExtension === tail || withoutExtension.split('/').pop() === tail;
}

/**
 * 문서 id 지목. 검사 대상에서 못 찾으면 제외 기록을 같은 규약으로 한 번 더 본다 —
 * 코퍼스가 "무엇을 왜 빼놨나"를 이미 사유와 함께 들고 있으므로 그 기록을 다시 유도하지 않는다.
 */
function classifyDocumentId(rawId, { docPaths, manifestIds, outOfCorpus }) {
  const id = String(rawId);
  const tail = id.split('/').pop();
  if (!tail) return NOT_A_DOCUMENT;

  const declared = manifestIds.get(id) ?? manifestIds.get(tail);
  if (declared && docPaths.has(declared)) return { status: 'in-corpus', file: declared };

  const hits = [...docPaths].filter((path) => matchesDocumentName(path, id, tail));
  if (hits.length === 1) return { status: 'in-corpus', file: hits[0] };
  if (hits.length > 1) return NOT_A_DOCUMENT;

  if (declared && outOfCorpus?.has(declared)) {
    return { status: 'out-of-scope', file: declared, reason: outOfCorpus.get(declared) };
  }
  const unscanned = [...(outOfCorpus?.keys() ?? [])].filter((path) => matchesDocumentName(path, id, tail));
  if (unscanned.length === 1) {
    return { status: 'out-of-scope', file: unscanned[0], reason: outOfCorpus.get(unscanned[0]) };
  }
  return NOT_A_DOCUMENT;
}

function sectionsAfterLink(parsed, link) {
  const line = parsed.lines[link.line - 1] ?? '';
  const match = SECTION_REF_RE.exec(line.slice(link.column - 1 + link.raw.length));
  if (!match) return [];
  const sections = [match[1]];
  for (const extra of match[2].matchAll(/§\s*(\d+(?:\.\d+)*)/g)) sections.push(extra[1]);
  return sections;
}

/**
 * 결정이 지목한 반영 대상 — 결정 절 안의 링크 중 문서로 해석되는 것.
 *
 * 검사 대상 밖으로 해석된 지목은 버리지 않고 `unscanned` 로 따로 들려 보낸다. 그걸 조용히 떨구면
 * 후보가 0건인 결정과 "지목한 자리를 못 본" 결정이 보고에서 구별되지 않는다.
 */
function extractTargets(parsed, range, resolver, { idRe, bodiesPath }) {
  const targets = new Map();
  const unscanned = new Map();

  for (const link of parsed.links) {
    if (link.isImage || link.line < range[0] || link.line > range[1]) continue;
    if (idRe.exact.test(link.text.trim())) continue; // 다른 결정을 가리키는 상호 참조

    const designation = classifyDesignation(link.target, resolver);
    const where = { link_line: link.line, link_text: link.text.trim() };

    if (designation.status === 'out-of-scope') {
      if (!unscanned.has(designation.file)) {
        unscanned.set(designation.file, { file: designation.file, reason: designation.reason, ...where });
      }
      continue;
    }
    if (designation.status !== 'in-corpus' || designation.file === bodiesPath) continue;

    const sections = sectionsAfterLink(parsed, link);
    for (const section of sections.length ? sections : [null]) {
      const key = `${designation.file}\0${section ?? ''}`;
      if (targets.has(key)) continue;
      targets.set(key, { file: designation.file, section, ...where });
    }
  }

  return { targets: [...targets.values()], unscanned: [...unscanned.values()] };
}

/** 같은 문서를 여러 절로 지목한 것을 문서 하나로 접는다 — 인용은 문서 단위 사실이다. */
function groupByFile(targets) {
  const byFile = new Map();
  for (const target of targets) {
    const entry = byFile.get(target.file);
    if (!entry) {
      byFile.set(target.file, { ...target, sections: [target.section] });
      continue;
    }
    entry.sections.push(target.section);
    entry.heading_line = entry.heading_line ?? target.heading_line;
  }
  return [...byFile.values()];
}

/** 대상 절의 헤딩 줄과 범위. 절을 못 찾으면 문서 단위로 내려앉는다 — (e) 동결 규율. */
function locateSection(doc, section) {
  if (!doc?.parsed) return { heading_line: null, line_range: null };
  if (!section) return { heading_line: null, line_range: [1, doc.parsed.lines.length] };

  const heading = findHeadingBySection(doc.parsed, section);
  if (!heading) return { heading_line: null, line_range: null };

  const next = doc.parsed.headings.find((h) => h.line > heading.line && h.level <= heading.level);
  return {
    heading_line: heading.line,
    line_range: [heading.line, (next ? next.line : doc.parsed.lines.length + 1) - 1],
  };
}

/* --------------------------------------------------------------- 인용 그래프 */

/** 전 문서에서 결정 번호가 인용된 자리. 코드 펜스 안은 인용이 아니라 예시로 센다. */
export function buildCitationIndex(documents, idPattern) {
  const idRe = new RegExp(idPattern, 'g');
  const index = new Map();

  for (const doc of documents) {
    doc.parsed.lines.forEach((text, offset) => {
      const line = offset + 1;
      idRe.lastIndex = 0;
      const seen = new Set();
      let match;
      while ((match = idRe.exec(text)) !== null) {
        if (seen.has(match[0])) continue;
        seen.add(match[0]);
        const occurrences = index.get(match[0]) ?? [];
        occurrences.push({
          file: doc.path,
          line,
          quote: clip(text),
          in_code: isInsideFence(doc.parsed, line),
        });
        index.set(match[0], occurrences);
      }
    });
  }

  return index;
}

function citationsIn(index, id, file) {
  return (index.get(id) ?? []).filter((entry) => entry.file === file && !entry.in_code);
}

/* ------------------------------------------------------------------- 카드 */

/** 결정 카드(JSON)를 읽는다. 루트 배열이거나, 카드 배열을 가진 속성 하나를 찾는다. */
export function loadCards(absPath, idRe) {
  const text = readFileSync(absPath, 'utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new DecisionsAxisError(`adr.cards 가 JSON 이 아니다: ${absPath} (${error.message})`);
  }

  const isCardList = (value) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => item && typeof item === 'object' && typeof item.id === 'string') &&
    value.some((item) => idRe.exact.test(item.id));

  let list = null;
  if (isCardList(raw)) list = raw;
  else if (raw && typeof raw === 'object') {
    list = Object.values(raw).find((value) => isCardList(value)) ?? null;
  }
  if (!list) {
    throw new DecisionsAxisError(`adr.cards 에서 결정 카드 배열을 찾지 못했다: ${absPath}`);
  }

  const lines = text.split(/\r\n|\r|\n/);
  const cards = new Map();
  for (const item of list) {
    if (!idRe.exact.test(item.id)) continue;
    const offset = lines.findIndex((line) => line.includes(`"${item.id}"`));
    cards.set(item.id, {
      id: item.id,
      status: typeof item.status === 'string' ? item.status : null,
      line: offset === -1 ? null : offset + 1,
    });
  }
  return cards;
}

function sameStatus(a, b) {
  const normalize = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return normalize(a) === normalize(b);
}

/* ------------------------------------------------------------ supersede 체인 */

/** 상태의 대체 포인터를 따라간다. 끝나는 곳(또는 끊기는 이유)까지가 체인이다. */
export function buildChain(id, byId) {
  const chain = [id];
  const seen = new Set([id]);
  let current = byId.get(id);

  while (current?.supersededBy) {
    const next = current.supersededBy;
    chain.push(next);
    if (seen.has(next)) return { chain, terminal: 'cycle' };
    seen.add(next);
    current = byId.get(next);
    if (!current) return { chain, terminal: 'missing' };
  }
  return { chain, terminal: current?.status ?? 'unknown' };
}

/* ------------------------------------------------------------------- 실행 */

/** 축 본체. 스캔 결과 봉투를 돌려준다. */
export function runDecisionsAxis(context) {
  const { config } = context;
  if (!config.adr) {
    return createSkippedScanResult({
      axis: AXIS,
      reason: 'config 에 "adr" 선언이 없어 건너뜀',
    });
  }

  const settings = parseAdrSettings(config);
  const idRe = compileIdRegExps(settings.idPattern);
  const bodiesAbs = resolveDeclaredPath(settings.bodies, context, 'adr.bodies');
  const bodiesPath = displayPath(bodiesAbs, context);

  const corpus = loadCorpus(context, { parse: true });
  const documents = allDocuments(corpus).filter((doc) => doc.absPath !== bodiesAbs);
  const docPaths = new Set(documents.map((doc) => doc.path));
  const byPath = new Map(documents.map((doc) => [doc.path, doc]));
  const frozenPaths = new Set(corpus.frozen.map((doc) => doc.path));

  const bodiesParsed = parseMarkdown(readFileSync(bodiesAbs, 'utf8'), { file: bodiesPath });
  const decisions = parseDecisionBodies(bodiesParsed, settings);
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  const citations = buildCitationIndex(documents, settings.idPattern);

  // 코퍼스가 남긴 "무엇을 왜 안 봤나" 를 지목 해석에 그대로 쓴다. 검사 대상으로 해석되는 문서
  // (동결 포함)와 결정 본문 자신은 빼 — 그쪽은 못 본 자리가 아니라 본 자리다.
  const outOfCorpus = new Map();
  for (const entry of corpus.excluded) {
    if (!/\.(md|markdown)$/i.test(entry.path)) continue;
    if (docPaths.has(entry.path) || entry.path === bodiesPath) continue;
    outOfCorpus.set(entry.path, entry.reason);
  }

  const resolver = {
    bodiesDir: dirname(bodiesAbs),
    docsRoot: context.docsRoot,
    docPaths,
    manifestIds: loadManifestIds(context),
    outOfCorpus,
  };

  const findings = [];
  const candidates = [];
  const suppressed = [];

  const emit = (finding) => {
    const file = finding.locations[0].file;
    const frozen = file === bodiesPath || frozenPaths.has(file);
    if (frozen && !POINTER_CODES.includes(finding.code)) {
      suppressed.push({ path: file, reason: `동결 문서라 "${finding.code}" 를 결함으로 보고하지 않음` });
      return;
    }
    findings.push(createFinding({ axis: AXIS, ...finding }));
  };

  const ownershipOf = (file) => (config.ownership ?? []).filter((entry) => entry.owner === file);

  for (const decision of decisions) {
    const { targets, unscanned } = extractTargets(
      bodiesParsed,
      decision.decisionRange ?? decision.range,
      resolver,
      { idRe, bodiesPath },
    );
    const scope = decision.decisionRange ? 'decision' : 'body';

    if (decision.status === 'superseded') {
      const { chain, terminal } = buildChain(decision.id, byId);
      const location = {
        file: bodiesPath,
        line: decision.statusLine ?? decision.headingLine,
        quote: clip(bodiesParsed.lines[(decision.statusLine ?? decision.headingLine) - 1] ?? ''),
      };

      if (!decision.supersededBy || terminal === 'missing') {
        emit({
          severity: 'block',
          code: 'decisions.supersede-dangling',
          message: decision.supersededBy
            ? `${decision.id} 을 대체한다는 ${decision.supersededBy} 이 결정 본문에 없다 — 죽은 참조다`
            : `${decision.id} 의 상태가 대체됨인데 대체 결정 번호가 없다`,
          locations: [location],
          payload: {
            decision_id: decision.id,
            decision_summary: decision.title,
            kind: 'stale_supersede',
            chain,
            superseded_by: decision.supersededBy,
          },
        });
      } else if (terminal === 'cycle') {
        emit({
          severity: 'block',
          code: 'decisions.supersede-cycle',
          message: `대체 체인이 순환한다: ${chain.join(' → ')}`,
          locations: [location],
          payload: {
            decision_id: decision.id,
            decision_summary: decision.title,
            kind: 'stale_supersede',
            chain,
            superseded_by: decision.supersededBy,
          },
        });
      }

      for (const entry of citations.get(decision.id) ?? []) {
        if (entry.in_code) continue;
        candidates.push({
          kind: 'stale_supersede',
          decision_id: decision.id,
          decision_summary: decision.title,
          decision_status: decision.statusRaw,
          superseded_by: decision.supersededBy,
          chain,
          decision_heading: { file: bodiesPath, line: decision.headingLine },
          target: { file: entry.file, section: null, current_text: entry.quote, line: entry.line },
        });
      }
      continue;
    }

    if (decision.status !== 'accepted') continue;

    const enrich = (list) =>
      list.map((target) => {
        const doc = byPath.get(target.file);
        const cited = citationsIn(citations, decision.id, target.file);
        return {
          ...target,
          ...locateSection(doc, target.section),
          cites_decision: cited.length > 0,
          cited_at: cited.map((entry) => ({ line: entry.line, quote: entry.quote })),
          ownership_declared: ownershipOf(target.file),
        };
      });

    const enriched = enrich(targets);

    // (a') 지목했는데 이번 실행이 검사하지 않은 자리. 후보가 0건이 되는 바로 그 이유이므로 여기서
    // 말하지 않으면 그 결정은 "지적 없음" 으로 읽힌다 — 제외는 통과가 아니다. 심각도가 `warn` 인 것은
    // 이 지적이 확정된 불일치가 아니라 **확인하지 못했다는 사실**이기 때문이다. 사용자가 선언한
    // `docs.exclude` 를 차단으로 되돌리면 제외 선언 자체를 쓸 수 없게 되고, 이 축의 `block` 은
    // 계약(contract.md)이 확정한 결함에 남겨 둔다. 첫 자리는 결정 본문의 그 링크 줄이다 — 코퍼스
    // 안에는 가리킬 자리가 없고(그것이 이 지적의 내용이다), 고칠 곳은 그 지목이거나 검사 범위다.
    for (const target of unscanned) {
      emit({
        severity: 'warn',
        code: 'decisions.target-out-of-scope',
        message:
          `${decision.id} 이 지목한 ${target.file} 이 이번 실행의 검사 대상이 아니다 ` +
          `(${target.reason}) — 그 결정이 반영됐는지 확인하지 못했다`,
        locations: [{ file: bodiesPath, line: target.link_line, quote: clip(target.link_text) }],
        payload: {
          decision_id: decision.id,
          decision_summary: decision.title,
          kind: 'target_out_of_scope',
          target: { file: target.file, section: null, current_text: target.link_text },
          designated_by: scope,
          scope_reason: target.reason,
        },
      });
    }

    // 결정 절이 아무 문서도 지목하지 않았으면 결정 전체의 링크가 후보의 출발점이다. 지목을 적지 않은
    // 결정이야말로 반영 여부를 아무도 묻지 않은 채 남는 쪽이라, 후보가 없으면 그 결정은 검사 밖에 선다.
    // 맥락·결과의 링크는 지목이 아니므로 인용 추적(아래 citation-missing)에는 쓰지 않는다 — 지목하지
    // 않은 자리를 두고 "결정 번호를 인용하지 않았다"고 말할 근거가 없다. 후보에만 싣고 `designated_by`
    // 를 `body` 로 밝혀, 계약이 지목 여부부터 판정하게 한다.
    const candidateTargets = enriched.length
      ? enriched
      : enrich(extractTargets(bodiesParsed, decision.range, resolver, { idRe, bodiesPath }).targets);
    const candidateScope = enriched.length ? scope : 'body';

    // (a) 지목한 자리에 번호가 없으면 추적이 끊긴 것이다. 내용 반영 여부는 계약이 본다.
    // 인용은 문서 단위 사실이라 한 문서의 여러 절을 지목했어도 보고는 문서마다 하나다.
    const uncited = groupByFile(enriched.filter((target) => !target.cites_decision));
    const wholeTraceBroken = uncited.length > 0 && uncited.length === groupByFile(enriched).length;
    const elsewhere = (citations.get(decision.id) ?? []).filter((entry) => !entry.in_code);

    for (const target of uncited) {
      const sections = target.sections.filter(Boolean);
      const where = sections.length ? ` ${sections.map((s) => `§${s}`).join('·')}` : '';
      emit({
        // 지목이 결정 절에서 나왔고 어느 대상도 인용하지 않을 때만 확정된 추적 끊김이다.
        severity: scope === 'decision' && wholeTraceBroken ? 'block' : 'warn',
        code: 'decisions.citation-missing',
        message:
          `${decision.id} 이 지목한 ${target.file}${where} 이 그 결정 번호를 인용하지 않는다 — ` +
          `내용 반영 여부와 무관한 추적 끊김이다` +
          (elsewhere.length ? ` (다른 문서 ${elsewhere.length}곳에는 인용돼 있다)` : ''),
        locations: [
          {
            file: target.file,
            ...(target.heading_line ? { line: target.heading_line } : {}),
            quote: target.link_text,
          },
          { file: bodiesPath, line: decision.headingLine, quote: clip(decision.title) },
        ],
        payload: {
          decision_id: decision.id,
          decision_summary: decision.title,
          kind: 'citation_missing',
          target: {
            file: target.file,
            section: sections[0] ?? null,
            current_text: target.link_text,
          },
          sections,
          designated_by: scope,
          cited_elsewhere: elsewhere.map((entry) => ({ file: entry.file, line: entry.line })),
        },
      });
    }

    // (b)(c) — 반영 여부와 소유 경계 역전은 계약이 확정한다.
    if (candidateTargets.length > 0) {
      candidates.push({
        kind: 'reflection',
        decision_id: decision.id,
        decision_summary: decision.title,
        decision_status: decision.statusRaw,
        decision_heading: { file: bodiesPath, line: decision.headingLine },
        decision_range: decision.decisionRange ?? decision.range,
        decision_text: decision.decisionText,
        designated_by: candidateScope,
        targets: candidateTargets.map((target) => ({
          file: target.file,
          section: target.section,
          heading_line: target.heading_line,
          line_range: target.line_range,
          cites_decision: target.cites_decision,
          ownership_declared: target.ownership_declared,
        })),
      });
    }
  }

  // 카드 대조 — 같은 사실의 두 기록이 어긋나면 어느 쪽을 읽느냐로 답이 갈린다.
  if (settings.cards) {
    const cardsAbs = resolveDeclaredPath(settings.cards, context, 'adr.cards');
    const cardsPath = displayPath(cardsAbs, context);
    const cards = loadCards(cardsAbs, idRe);

    for (const decision of decisions) {
      const card = cards.get(decision.id);
      if (!card) {
        emit({
          severity: 'block',
          code: 'decisions.card-missing',
          message: `${decision.id} 이 결정 본문에 있는데 카드 목록에 없다`,
          locations: [{ file: cardsPath, quote: decision.id }],
          payload: {
            decision_id: decision.id,
            decision_summary: decision.title,
            kind: 'card_missing',
            body_status: decision.statusRaw,
          },
        });
        continue;
      }
      if (!sameStatus(card.status, decision.statusRaw)) {
        emit({
          severity: 'block',
          code: 'decisions.card-mismatch',
          message:
            `${decision.id} 의 상태가 본문과 카드에서 다르다 — 본문 "${decision.statusRaw ?? '(없음)'}" · ` +
            `카드 "${card.status ?? '(없음)'}"`,
          locations: [
            { file: cardsPath, ...(card.line ? { line: card.line } : {}), quote: card.status ?? decision.id },
            { file: bodiesPath, line: decision.statusLine ?? decision.headingLine, quote: decision.statusRaw ?? '' },
          ],
          payload: {
            decision_id: decision.id,
            decision_summary: decision.title,
            kind: 'card_mismatch',
            body_status: decision.statusRaw,
            card_status: card.status,
          },
        });
      }
    }

    for (const card of cards.values()) {
      if (byId.has(card.id)) continue;
      emit({
        severity: 'block',
        code: 'decisions.card-orphan',
        message: `카드 목록의 ${card.id} 에 해당하는 결정 본문이 없다`,
        locations: [{ file: cardsPath, ...(card.line ? { line: card.line } : {}), quote: card.id }],
        payload: { decision_id: card.id, kind: 'card_orphan', card_status: card.status },
      });
    }
  }

  const result = createScanResult({
    axis: AXIS,
    findings,
    candidates,
    stats: {
      files_scanned: corpus.documents.length,
      excluded: [...corpus.excluded, ...suppressed],
      skipped: false,
    },
  });
  result.stats.decisions_parsed = decisions.length;
  result.stats.accepted = decisions.filter((decision) => decision.status === 'accepted').length;
  return result;
}

/* --------------------------------------------------------------------- CLI */

export function main(argv) {
  const args = parseCliArgs(argv);
  const context = loadConfig(args.config, { repoRoot: args.repo });
  return runDecisionsAxis(context);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url || invokedPath === pathToFileURL(fileURLToPath(import.meta.url)).href) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    const known = error instanceof DecisionsAxisError || error instanceof ConfigError;
    process.stderr.write(`${known ? error.message : (error.stack ?? String(error))}\n`);
    process.exitCode = 1;
  }
}
