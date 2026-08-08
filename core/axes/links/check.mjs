#!/usr/bin/env node
/**
 * links 축 — 링크·앵커. 가리키는 것이 실재하지 않는 참조를 찾는다.
 *
 * 네 판정기:
 *   1. 내부 문서 링크   `links.dead-target`      — 매니페스트 id · 상대 경로 · 헤딩 앵커 실재
 *   2. 절 번호 참조     `links.dead-section`     — `§N` 이 가리키는 절이 대상 문서에 실재
 *   3. 표시명 ↔ 대상    `links.display-mismatch` — 표시명이 대상의 제목·헤딩·정의 항목에 실재
 *   4. 표시명 일관성    `links.display-variant`  — 같은 앵커를 여러 이름으로 부르는 소수파
 *
 * 전부 결정적이다. 네트워크를 타지 않으므로 외부 URL 은 검사 대상이 아니고,
 * fenced code block 과 코드스팬 안의 참조는 인용이지 링크가 아니라 보지 않는다.
 *
 * 동결 문서(config docs.frozen)는 3·4번(표시명 드리프트)에서 빠진다 — 소급 편집 금지 대상이라
 * 옛 표시명이 위반이 아니다. 1·2번(죽은 참조)은 동결 문서에도 적용하되 warn 으로만 보고한다:
 * 죽은 참조를 고치는 것은 표현을 바꾸는 소급 편집이 아니라 사실 정정이다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, parseCliArgs } from '../../lib/config.mjs';
import { allDocuments, loadCorpus } from '../../lib/corpus.mjs';
import { createFinding, createScanResult } from '../../lib/findings.mjs';
import { SECTION_NUMBER_RE, findHeadingBySection, isInsideFence, slugify } from '../../lib/markdown.mjs';

export const AXIS = 'links';
export const SEVERITY_CAP = 'block';

/** 본문 절 참조 — "§3" · "§ 5.1" · "(§6)". */
const SECTION_REF_RE = /§\s*(\d+(?:\.\d+)*)/g;
/** 스킴이 붙은 대상 — http: · mailto: · tel: 전부 네트워크/외부라 검사하지 않는다. */
const SCHEME_RE = /^[a-z][a-z0-9+.\-]*:/i;
/** 문서명과 § 사이에 올 수 있는 연결 표현 — "용어집 의 §6" · "(§6)". */
const SECTION_GAP_RE = /^[\s의,([「]*$/u;
/** 앞 §참조와 이 §참조 사이가 나열 구분자뿐이면 둘은 같은 선행어를 공유한다 — "용어집 §2·§3". */
const SECTION_ENUM_GAP_RE = /^[\s·,、/및와과]*$/u;
/** 이름이 낱말 경계에서 끝나야 한다 — "마이크로아키텍처" 가 "아키텍처" 로 잡히면 안 된다. */
const NAME_BOUNDARY_RE = /[\s([「"'·,:/|>]/u;
/** 줄머리 굵은 글씨 정의 항목 — "- **타일**: …". */
const BOLD_TERM_RE = /^\s{0,3}(?:[-*+]|\d+[.)])?\s*\*\*([^*]+)\*\*/;

// ────────────────────────────────────────────────────────── 문자열 유틸

/** 표시명 비교용 정규화 — 인라인 마크업을 벗기고 공백을 접는다. 대소문자는 남긴다. */
function cleanInline(text) {
  return String(text ?? '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/\*\*|__|[*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(text) {
  return cleanInline(text).toLowerCase();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * 0~1 근접도. 포함 관계에 가산점을 준다 — "타일 레지스트리" 가 잘못 가리킨 실제 항목은
 * 보통 그 안에 들어 있는 짧은 이름("타일")이지 편집 거리상 가까운 이름이 아니다.
 */
function similarity(a, b) {
  if (!a || !b) return 0;
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  const ratio = 1 - levenshtein(a, b) / long.length;
  const contained = long.includes(short) ? 0.5 + 0.5 * (short.length / long.length) : 0;
  return Math.max(ratio, contained);
}

function closestNames(display, names, limit = 3) {
  const target = normalizeName(display);
  return [...names.entries()]
    .map(([key, raw]) => ({ name: raw, score: Number(similarity(target, key).toFixed(3)) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

// ────────────────────────────────────────────────────────── 문서 매니페스트

function manifestEntriesOf(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw === null || typeof raw !== 'object') return null;
  for (const key of ['docs', 'documents', 'entries', 'items']) {
    if (Array.isArray(raw[key])) return raw[key];
  }
  // id 를 키로 쓴 객체 맵.
  return Object.entries(raw).map(([id, value]) =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? { id, ...value } : { id },
  );
}

function normalizeManifestEntry(entry) {
  if (typeof entry === 'string') return { id: entry };
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;

  const id = entry.id ?? entry.docId ?? entry.slug ?? entry.anchor ?? entry.key ?? entry.name;
  if (typeof id !== 'string' || !id) return null;

  const ns = entry.ns ?? entry.namespace ?? entry.group;
  const full = typeof ns === 'string' && ns && !id.includes('/') ? `${ns}/${id}` : id;
  return {
    id: full,
    path: typeof entry.path === 'string' ? entry.path : typeof entry.file === 'string' ? entry.file : null,
    title: typeof entry.title === 'string' ? entry.title : typeof entry.name === 'string' ? entry.name : null,
  };
}

/**
 * config docs.manifest 를 읽어 내부 문서 id 집합을 만든다.
 * 선언되지 않았으면 declared:false — `#<ns>/<id>` 링크는 죽었다고 단정하지 않고 미검증으로 보고한다.
 */
function loadDocsManifest(context) {
  const declaredPath = context.config.docs.manifest;
  if (!declaredPath) return { declared: false, path: null, entries: new Map(), error: null };

  const absPath = resolve(context.repoRoot, declaredPath);
  let raw;
  try {
    raw = JSON.parse(readFileSync(absPath, 'utf8'));
  } catch (error) {
    return { declared: true, path: declaredPath, entries: new Map(), error: error.code ?? error.message };
  }

  const list = manifestEntriesOf(raw);
  if (!list) {
    return { declared: true, path: declaredPath, entries: new Map(), error: '배열도 객체도 아니다' };
  }

  const entries = new Map();
  for (const item of list) {
    const entry = normalizeManifestEntry(item);
    if (entry && !entries.has(entry.id)) entries.set(entry.id, entry);
  }
  return { declared: true, path: declaredPath, entries, error: null };
}

// ────────────────────────────────────────────────────────── 문서 색인

/** 대상 문서에서 "표시명이 될 수 있는 것" 전부 — 제목·헤딩·표 첫 열·굵은 정의 항목. */
function collectDocumentNames(document, manifestEntry) {
  const names = new Map();
  const add = (value) => {
    const raw = cleanInline(value);
    if (!raw) return;
    const key = normalizeName(raw);
    if (!key || names.has(key)) return;
    names.set(key, raw);
  };

  for (const heading of document.parsed.headings) {
    add(heading.text);
    if (heading.section) add(heading.text.replace(SECTION_NUMBER_RE, ''));
  }
  for (const table of document.parsed.tables) {
    for (const row of table.rows) add(row.cells[0]);
  }
  document.parsed.lines.forEach((raw, index) => {
    if (isInsideFence(document.parsed, index + 1)) return;
    const match = BOLD_TERM_RE.exec(raw);
    if (match) add(match[1]);
  });

  add(posix.basename(document.path).replace(/\.(md|markdown)$/i, ''));
  if (manifestEntry?.title) add(manifestEntry.title);
  if (manifestEntry?.id) add(manifestEntry.id);
  return names;
}

/** 문서 하나의 제목 — 첫 h1, 없으면 첫 헤딩. §N 참조의 "용어집 §3" 대상 추론에 쓴다. */
function documentTitle(document) {
  const headings = document.parsed.headings;
  return (headings.find((heading) => heading.level === 1) ?? headings[0])?.text ?? null;
}

function buildIndex(context, corpus, manifest) {
  const documents = allDocuments(corpus).map((document) => ({ ...document, frozen: Boolean(document.frozen) }));
  const byPath = new Map(documents.map((document) => [document.path, document]));

  // 매니페스트 id → 문서. path 선언이 우선이고, 없으면 `<id>.md` 관례로 찾는다.
  // path 는 docs.root 기준이되, 레포 루트 기준으로 쓴 경로도 앞머리를 떼고 한 번 더 본다.
  const rootPrefix = `${posix.normalize(context.config.docs.root).replace(/\/$/, '')}/`;
  const byId = new Map();
  for (const [id, entry] of manifest.entries) {
    let resolved = null;
    for (const candidate of [entry.path, `${id}.md`, `${id}.markdown`].filter(Boolean)) {
      const normalized = posix.normalize(candidate.replace(/^\.?\//, ''));
      const variants = normalized.startsWith(rootPrefix)
        ? [normalized, normalized.slice(rootPrefix.length)]
        : [normalized];
      resolved = variants.map((path) => byPath.get(path)).find(Boolean) ?? null;
      if (resolved) break;
    }
    byId.set(id, { entry, document: resolved });
  }

  const manifestByPath = new Map();
  for (const [, value] of byId) {
    if (value.document && !manifestByPath.has(value.document.path)) manifestByPath.set(value.document.path, value.entry);
  }

  for (const document of documents) {
    document.title = documentTitle(document);
    document.anchors = new Set(document.parsed.headings.map((heading) => heading.anchor));
    document.names = collectDocumentNames(document, manifestByPath.get(document.path));
  }

  // §N 참조의 대상 문서 추론용 이름 색인. 이름이 겹치면 그 이름은 버린다 — 잘못 짚느니 자기 문서 기준이 낫다.
  const nameToDocument = new Map();
  const seen = new Set();
  const register = (name, document) => {
    const key = normalizeName(name);
    if (!key) return;
    if (seen.has(key) && nameToDocument.get(key) !== document) {
      nameToDocument.delete(key);
      return;
    }
    seen.add(key);
    nameToDocument.set(key, document);
  };
  for (const document of documents) {
    register(posix.basename(document.path).replace(/\.(md|markdown)$/i, ''), document);
    register(document.path.replace(/\.(md|markdown)$/i, ''), document);
    if (document.title) register(document.title, document);
    const entry = manifestByPath.get(document.path);
    if (entry?.title) register(entry.title, document);
    if (entry?.id) register(entry.id, document);
  }

  return { documents, byPath, byId, manifestByPath, nameToDocument };
}

// ────────────────────────────────────────────────────────── 링크 해석

function splitTarget(target) {
  const hash = target.indexOf('#');
  if (hash === -1) return { path: target, fragment: null };
  return { path: target.slice(0, hash), fragment: target.slice(hash + 1) };
}

/**
 * 링크 하나를 해석한다.
 * kind: external | manifest-id | unverified-id | anchor | path | empty
 * resolved 가 false 면 dead-target 후보다.
 */
function resolveLink(link, document, index, manifest) {
  const target = link.target.trim();
  if (!target) return { kind: 'empty', resolved: true, checkable: false };
  if (SCHEME_RE.test(target) || target.startsWith('//')) {
    return { kind: 'external', resolved: true, checkable: false };
  }

  const { path, fragment } = splitTarget(target);

  // (1) 문서 매니페스트 id — `#<ns>/<id>`.
  if (!path && fragment && fragment.includes('/')) {
    const id = decodeFragment(fragment);
    if (!manifest.declared) {
      return { kind: 'unverified-id', id, resolved: true, checkable: false };
    }
    if (manifest.error) {
      return { kind: 'unverified-id', id, resolved: true, checkable: false };
    }
    // `<ns>/<id>` 의 ns 는 사이트 라우팅 규약이라 매니페스트가 담지 않는 경우가 많다.
    // 전체 문자열이 없으면 마지막 조각으로 한 번 더 본다 — 그래야 매니페스트가 bare id 만
    // 나열해도 네임스페이스 링크가 통째로 죽었다고 오판되지 않는다.
    const hit = index.byId.get(id) ?? index.byId.get(id.slice(id.lastIndexOf('/') + 1));
    if (!hit) {
      return { kind: 'manifest-id', id, resolved: false, reason: `매니페스트에 없는 문서 id "${id}"` };
    }
    return {
      kind: 'manifest-id',
      id,
      resolved: true,
      checkable: Boolean(hit.document),
      targetDocument: hit.document,
      manifestEntry: hit.entry,
      key: hit.document ? hit.document.path : `id:${id}`,
    };
  }

  // (2) 같은 문서 안 헤딩 앵커.
  if (!path && fragment) {
    const anchor = slugify(decodeFragment(fragment));
    if (!document.anchors.has(anchor)) {
      return { kind: 'anchor', anchor, resolved: false, reason: `이 문서에 "#${fragment}" 헤딩이 없다` };
    }
    return {
      kind: 'anchor',
      anchor,
      resolved: true,
      checkable: true,
      targetDocument: document,
      fragment: decodeFragment(fragment),
      key: `${document.path}#${anchor}`,
    };
  }

  if (!path) return { kind: 'empty', resolved: true, checkable: false };

  // (3) 상대 경로.
  const base = posix.dirname(document.path);
  const cleaned = path.startsWith('/') ? path.slice(1) : posix.join(base === '.' ? '' : base, path);
  const normalized = posix.normalize(cleaned);

  const targetDocument = index.byPath.get(normalized);
  if (!targetDocument) {
    // 코퍼스 밖(검사 제외 문서·이미지·코드 등)이라도 디스크에 있으면 죽은 링크가 아니다.
    const onDisk = resolve(dirname(document.absPath), path);
    if (existsSync(onDisk)) {
      return { kind: 'path', path: normalized, resolved: true, checkable: false };
    }
    return { kind: 'path', path: normalized, resolved: false, reason: `대상 파일이 없다 (${path})` };
  }

  if (fragment) {
    const anchor = slugify(decodeFragment(fragment));
    if (!targetDocument.anchors.has(anchor)) {
      return {
        kind: 'path',
        path: normalized,
        resolved: false,
        reason: `${normalized} 에 "#${fragment}" 헤딩이 없다`,
      };
    }
    return {
      kind: 'path',
      path: normalized,
      resolved: true,
      checkable: true,
      targetDocument,
      fragment: decodeFragment(fragment),
      key: `${normalized}#${anchor}`,
    };
  }

  return { kind: 'path', path: normalized, resolved: true, checkable: true, targetDocument, key: normalized };
}

// ────────────────────────────────────────────────────────── §N 참조

function linkSpan(link) {
  const start = link.column - 1;
  return { start, end: start + link.raw.length };
}

function insideCodeSpan(parsed, line, start, end) {
  return parsed.codeSpans.some((span) => span.line === line && start < span.endColumn && end > span.column - 1);
}

/**
 * "§N" 이 어느 문서를 가리키는가.
 * 바로 앞 링크 → 바로 앞 문서명 → 자기 문서 순. 추론이 안 되면 자기 문서 기준이다 —
 * 절 참조는 대개 지금 읽고 있는 문서를 가리키기 때문이다.
 *
 * 다만 바로 앞 링크가 있는데 그 대상 문서를 모르는 경우(매니페스트 미선언·외부 링크 등)에는
 * 자기 문서로 떨어지지 않고 document:null 을 돌려준다 — "대상을 모른다"는 "대상이 이 문서다"가
 * 아니다. 여기서 자기 문서로 대조하면 남의 절 번호를 이 문서에 없다고 지적하게 된다.
 */
function resolveSectionTarget(raw, line, matchIndex, document, resolvedLinks, index, previous) {
  // 나열("§2·§3")의 뒷 항목은 앞 항목과 선행어를 공유한다. 사이에 낀 것이 구분자뿐이면 그렇다.
  if (previous && SECTION_ENUM_GAP_RE.test(raw.slice(previous.end, matchIndex))) return previous.target;

  for (const { link, resolution } of resolvedLinks) {
    if (link.line !== line) continue;
    const { end } = linkSpan(link);
    if (end > matchIndex) continue;
    if (!SECTION_GAP_RE.test(raw.slice(end, matchIndex))) continue;
    if (resolution.targetDocument) return { document: resolution.targetDocument, via: 'link' };
    return { document: null, via: 'unresolved-link', target: link.target };
  }

  const before = raw.slice(0, matchIndex);
  for (const candidate of [before.replace(/[\s,([「'"]*$/u, ''), before.replace(/[\s,([「'"]*의?[\s,([「'"]*$/u, '')]) {
    const lowered = candidate.toLowerCase();
    let best = null;
    for (const [name, target] of index.nameToDocument) {
      if (!lowered.endsWith(name)) continue;
      const at = lowered.length - name.length;
      if (at > 0 && !NAME_BOUNDARY_RE.test(candidate[at - 1])) continue;
      if (!best || name.length > best.name.length) best = { name, target };
    }
    if (best) return { document: best.target, via: 'name', name: best.name };
  }

  return { document, via: 'self' };
}

// ────────────────────────────────────────────────────────── 판정

function locationOf(document, line) {
  return { file: document.path, line, quote: (document.parsed.lines[line - 1] ?? '').trim() };
}

function severityFor(document, base) {
  return document.frozen ? 'warn' : base;
}

function frozenNote(document) {
  return document.frozen ? ' (동결 문서 — 보고만 한다)' : '';
}

/** 판정기 1·2 — 죽은 참조. 동결 문서에도 적용하되 warn 으로 낮춘다. */
function checkDeadReferences(document, resolvedLinks, index, manifest, findings, unverified, unresolvedSections) {
  for (const { link, resolution } of resolvedLinks) {
    if (resolution.kind === 'unverified-id') {
      unverified.push({ document, link, id: resolution.id });
      continue;
    }
    if (resolution.resolved !== false) continue;

    findings.push(
      createFinding({
        axis: AXIS,
        severity: severityFor(document, 'block'),
        code: 'links.dead-target',
        message: `가리키는 대상이 없는 링크: [${cleanInline(link.text) || '(표시명 없음)'}](${link.target}) — ${resolution.reason}${frozenNote(document)}`,
        locations: [locationOf(document, link.line)],
        payload: {
          link_type: resolution.kind,
          display: cleanInline(link.text),
          target: { raw: link.target, resolved: false, reason: resolution.reason },
          frozen: document.frozen,
        },
        severityCap: SEVERITY_CAP,
      }),
    );
  }

  const parsed = document.parsed;
  const headingByLine = new Map(parsed.headings.map((heading) => [heading.line, heading]));

  parsed.lines.forEach((raw, lineIndex) => {
    const line = lineIndex + 1;
    if (isInsideFence(parsed, line)) return;

    SECTION_REF_RE.lastIndex = 0;
    let match;
    let first = true;
    let previous = null;
    while ((match = SECTION_REF_RE.exec(raw)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const wasFirst = first;
      first = false;

      if (insideCodeSpan(parsed, line, start, end)) continue;
      // 헤딩 스스로의 절 번호는 참조가 아니라 선언이다.
      const heading = headingByLine.get(line);
      if (wasFirst && heading && heading.section === match[1]) continue;

      const target = resolveSectionTarget(raw, line, start, document, resolvedLinks, index, previous);
      previous = { end, target };
      const targetDocument = target.document;
      if (!targetDocument) {
        unresolvedSections.push({ document, line, section: match[1], target: target.target });
        continue;
      }
      if (findHeadingBySection(targetDocument.parsed, match[1])) continue;

      const available = targetDocument.parsed.headings
        .filter((item) => item.section)
        .map((item) => item.section);

      // 대상 문서를 본문이 명시한 경우(앞 링크·앞 문서명)만 차단급이다. 선행어가 없어 자기
      // 문서로 가정한 경우는 축이 추론한 전제라, 그 위에 차단을 걸면 게이트가 자기 추측으로
      // 머지를 막는다 — 외부 표준 인용("arc42 §10")이 대표적이다. 보고는 하되 경고로 낮춘다.
      const assumed = target.via === 'self';
      findings.push(
        createFinding({
          axis: AXIS,
          severity: severityFor(document, assumed ? 'warn' : 'block'),
          code: 'links.dead-section',
          message:
            available.length === 0
              ? `§${match[1]} 를 가리키지만 ${targetDocument.path} 에는 번호 절이 없다${assumed ? ' (가리키는 문서를 밝히지 않아 자기 문서로 봤다)' : ''}${frozenNote(document)}`
              : `§${match[1]} 절이 ${targetDocument.path} 에 없다 (있는 절: ${available.join(' · ')})${assumed ? ' — 가리키는 문서를 밝히지 않아 자기 문서로 봤다' : ''}${frozenNote(document)}`,
          locations: [locationOf(document, line)],
          payload: {
            link_type: 'section',
            section: match[1],
            resolved_via: target.via,
            ...(target.name ? { resolved_by_name: target.name } : {}),
            target: {
              raw: `§${match[1]}`,
              resolved: false,
              file: targetDocument.path,
              available_sections: available,
              reason: available.length === 0 ? '대상 문서에 번호 절이 없다' : '그 번호의 절이 없다',
            },
            frozen: document.frozen,
          },
          severityCap: SEVERITY_CAP,
        }),
      );
    }
  });

}

/** 표시명이 검사 대상인가 — 이미지 alt·빈 표시명·경로 그대로 쓴 표시명은 이름이 아니다. */
function isCheckableDisplay(link, resolution) {
  if (link.isImage) return false;
  const display = cleanInline(link.text);
  if (!display) return false;
  if (!/[\p{L}\p{N}]/u.test(display)) return false;
  if (normalizeName(display) === normalizeName(link.target)) return false;
  if (resolution.path && normalizeName(display) === normalizeName(resolution.path)) return false;
  return true;
}

/** 링크가 실제로 가리키는 이름 집합 — 헤딩 앵커면 그 헤딩, 문서 전체면 문서의 모든 이름. */
function targetNames(resolution) {
  const document = resolution.targetDocument;
  if (!document) return new Map();
  if (!resolution.fragment) return document.names;

  const names = new Map();
  const anchor = slugify(resolution.fragment);
  for (const heading of document.parsed.headings) {
    if (heading.anchor !== anchor) continue;
    for (const value of [heading.text, heading.section ? heading.text.replace(SECTION_NUMBER_RE, '') : null]) {
      const raw = cleanInline(value);
      if (raw) names.set(normalizeName(raw), raw);
    }
  }
  if (document.title) names.set(normalizeName(document.title), cleanInline(document.title));
  return names;
}

/** 판정기 3 — 표시명이 대상에 실재하는가. */
function checkDisplayNames(document, resolvedLinks, findings) {
  for (const { link, resolution } of resolvedLinks) {
    if (!resolution.checkable || !resolution.targetDocument) continue;
    if (!isCheckableDisplay(link, resolution)) continue;

    const names = targetNames(resolution);
    if (names.size === 0) continue;

    const display = cleanInline(link.text);
    if (names.has(normalizeName(display))) continue;

    const candidates = closestNames(display, names);
    findings.push(
      createFinding({
        axis: AXIS,
        severity: 'warn',
        code: 'links.display-mismatch',
        message: `표시명 "${display}" 이 ${resolution.targetDocument.path} 에 없는 항목이다${candidates[0] ? ` — 가장 가까운 실재 항목: "${candidates[0].name}"` : ''}`,
        locations: [locationOf(document, link.line)],
        payload: {
          link_type: resolution.kind,
          display,
          target: {
            raw: link.target,
            resolved: true,
            file: resolution.targetDocument.path,
            ...(resolution.fragment ? { anchor: resolution.fragment } : {}),
            reason: '표시명이 대상의 제목·헤딩·정의 항목에 없다',
          },
          closest: candidates[0]?.name ?? null,
          candidates,
        },
        severityCap: SEVERITY_CAP,
      }),
    );
  }
}

/**
 * 판정기 4 — 같은 앵커를 여러 표시명으로 부르는 곳.
 * 다수파가 하나로 정해지면 소수파를 보고하고, 최다가 동률이면 어느 쪽이 정본인지 말할 수 없으니
 * 전체를 하나로 묶어 보고한다. 다만 총 2회(1:1)는 드리프트라 부를 표본이 아니라 넘긴다 —
 * 그 경우는 판정기 3 이 이미 본다.
 */
function checkDisplayConsistency(groups, findings) {
  for (const [key, occurrences] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const byDisplay = new Map();
    for (const occurrence of occurrences) {
      const normalized = normalizeName(occurrence.display);
      if (!byDisplay.has(normalized)) byDisplay.set(normalized, { display: occurrence.display, items: [] });
      byDisplay.get(normalized).items.push(occurrence);
    }
    if (byDisplay.size < 2) continue;

    const ranked = [...byDisplay.values()].sort(
      (a, b) => b.items.length - a.items.length || a.display.localeCompare(b.display),
    );
    const targetFile = occurrences[0].targetFile;

    if (ranked[0].items.length === ranked[1].items.length) {
      if (occurrences.length < 3) continue;
      findings.push(
        createFinding({
          axis: AXIS,
          severity: 'warn',
          code: 'links.display-variant',
          message: `${targetFile} 를 부르는 이름이 ${ranked.map((v) => `"${v.display}" ${v.items.length}회`).join(' · ')} 로 갈리는데 다수파가 없다`,
          locations: occurrences.map((occurrence) => locationOf(occurrence.document, occurrence.line)),
          payload: {
            link_type: 'display-consistency',
            target: { raw: key, resolved: true, file: targetFile },
            tie: true,
            variants: ranked.map((variant) => ({ display: variant.display, count: variant.items.length })),
          },
          severityCap: SEVERITY_CAP,
        }),
      );
      continue;
    }

    const majority = ranked[0];
    for (const variant of ranked.slice(1)) {
      findings.push(
        createFinding({
          axis: AXIS,
          severity: 'warn',
          code: 'links.display-variant',
          message: `${targetFile} 를 다수는 "${majority.display}"(${majority.items.length}회) 로 부르는데 여기서는 "${variant.display}"(${variant.items.length}회) 로 부른다`,
          locations: variant.items.map((occurrence) => locationOf(occurrence.document, occurrence.line)),
          payload: {
            link_type: 'display-consistency',
            target: { raw: key, resolved: true, file: targetFile },
            tie: false,
            majority: majority.display,
            majority_count: majority.items.length,
            variant: variant.display,
            variant_count: variant.items.length,
          },
          severityCap: SEVERITY_CAP,
        }),
      );
    }
  }
}

// ────────────────────────────────────────────────────────── 축 실행

/**
 * @param {ReturnType<import('../../lib/config.mjs').loadConfig>} context
 * @param {{corpus?: object}} options 테스트가 미리 만든 코퍼스를 넣을 수 있다
 * @returns {object} 스크립트 축 실행 계약의 stdout 봉투
 */
export function runLinksAxis(context, { corpus: given } = {}) {
  const corpus = given ?? loadCorpus(context, { parse: true });
  const manifest = loadDocsManifest(context);
  const index = buildIndex(context, corpus, manifest);

  const findings = [];
  const unverified = [];
  const unresolvedSections = [];

  if (manifest.declared && manifest.error) {
    findings.push(
      createFinding({
        axis: AXIS,
        severity: 'warn',
        code: 'links.manifest-unreadable',
        message: `docs.manifest "${manifest.path}" 를 읽을 수 없어 내부 문서 id 링크를 대조하지 못했다 (${manifest.error})`,
        locations: [{ file: manifest.path }],
        payload: { link_type: 'manifest', target: { raw: manifest.path, resolved: false, reason: manifest.error } },
        severityCap: SEVERITY_CAP,
      }),
    );
  }

  // 표시명 일관성(판정기 4)의 모집단 — 동결 문서는 표를 던지지 않는다.
  const groups = new Map();

  for (const document of index.documents) {
    const resolvedLinks = document.parsed.links.map((link) => ({
      link,
      resolution: resolveLink(link, document, index, manifest),
    }));

    checkDeadReferences(document, resolvedLinks, index, manifest, findings, unverified, unresolvedSections);
    if (document.frozen) continue;

    checkDisplayNames(document, resolvedLinks, findings);

    for (const { link, resolution } of resolvedLinks) {
      if (!resolution.checkable || !resolution.key || !resolution.targetDocument) continue;
      if (!isCheckableDisplay(link, resolution)) continue;
      if (!groups.has(resolution.key)) groups.set(resolution.key, []);
      groups.get(resolution.key).push({
        document,
        line: link.line,
        display: cleanInline(link.text),
        targetFile: resolution.targetDocument.path,
      });
    }
  }

  checkDisplayConsistency(groups, findings);

  if (unverified.length) {
    findings.push(
      createFinding({
        axis: AXIS,
        severity: 'info',
        code: 'links.unverified-anchor',
        message: manifest.declared
          ? `문서 매니페스트를 읽지 못해 내부 문서 id 링크 ${unverified.length}건을 대조하지 못했다`
          : `config 에 docs.manifest 가 없어 내부 문서 id 링크 ${unverified.length}건을 대조하지 못했다`,
        locations: unverified.map((item) => locationOf(item.document, item.link.line)),
        payload: {
          link_type: 'manifest-id',
          ids: [...new Set(unverified.map((item) => item.id))].sort(),
          target: { raw: 'docs.manifest', resolved: false, reason: '문서 id 집합을 얻을 수 없다' },
        },
        severityCap: SEVERITY_CAP,
      }),
    );
  }

  if (unresolvedSections.length) {
    findings.push(
      createFinding({
        axis: AXIS,
        severity: 'info',
        code: 'links.unverified-section',
        message: `바로 앞 링크의 대상 문서를 알 수 없어 §N 참조 ${unresolvedSections.length}건을 대조하지 못했다`,
        locations: unresolvedSections.map((item) => locationOf(item.document, item.line)),
        payload: {
          link_type: 'section',
          targets: [...new Set(unresolvedSections.map((item) => item.target).filter(Boolean))].sort(),
          target: { raw: '§N', resolved: false, reason: '앞 링크의 대상 문서를 해석하지 못했다' },
        },
        severityCap: SEVERITY_CAP,
      }),
    );
  }

  findings.sort(
    (a, b) =>
      a.locations[0].file.localeCompare(b.locations[0].file) ||
      (a.locations[0].line ?? 0) - (b.locations[0].line ?? 0) ||
      a.code.localeCompare(b.code),
  );

  return createScanResult({
    axis: AXIS,
    findings,
    stats: {
      files_scanned: index.documents.length,
      excluded: corpus.excluded,
      skipped: false,
    },
  });
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseCliArgs(argv);
    const context = loadConfig(args.config, { repoRoot: args.repo });
    process.stdout.write(`${JSON.stringify(runLinksAxis(context))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`[${AXIS}] ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
