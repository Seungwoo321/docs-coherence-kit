/**
 * 검사 대상 문서 집합 로드.
 *
 * 후보 집합 = docs.root 아래의 모든 마크다운 파일. 거기서 빠진 것은 전부 사유와 함께
 * excluded 로 남는다 — 검사하지 않은 문서가 통과로 읽히면 안 된다.
 * frozen 문서는 검사 대상에서는 빠지되 링크 대상 해석용으로 함께 로드된다.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { parseMarkdown } from './markdown.mjs';

export const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];
export const DEFAULT_SKIP_DIRS = ['node_modules', '.git'];

export class CorpusError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorpusError';
  }
}

function escapeRegExp(char) {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `{a,b}` 를 여러 글롭으로 편다. 중첩은 바깥부터 한 겹씩 풀린다. */
export function expandBraces(glob) {
  const open = glob.indexOf('{');
  if (open === -1) return [glob];

  let depth = 0;
  let close = -1;
  for (let i = open; i < glob.length; i += 1) {
    if (glob[i] === '{') depth += 1;
    else if (glob[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [glob];

  const head = glob.slice(0, open);
  const tail = glob.slice(close + 1);
  const body = glob.slice(open + 1, close);

  const alternatives = [];
  let current = '';
  let nested = 0;
  for (const char of body) {
    if (char === '{') nested += 1;
    else if (char === '}') nested -= 1;
    if (char === ',' && nested === 0) {
      alternatives.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  alternatives.push(current);

  return alternatives.flatMap((alternative) => expandBraces(`${head}${alternative}${tail}`));
}

/** POSIX 상대 경로용 글롭 → 정규식. `**` 만 디렉토리 경계를 넘는다. */
export function globToRegExp(glob) {
  const sources = expandBraces(glob).map((pattern) => {
    let source = '';
    for (let i = 0; i < pattern.length; i += 1) {
      const char = pattern[i];
      if (char === '*') {
        if (pattern[i + 1] === '*') {
          if (pattern[i + 2] === '/') {
            source += '(?:[^/]+/)*';
            i += 2;
          } else {
            source += '.*';
            i += 1;
          }
        } else {
          source += '[^/]*';
        }
        continue;
      }
      if (char === '?') {
        source += '[^/]';
        continue;
      }
      if (char === '[') {
        const close = pattern.indexOf(']', i + 1);
        if (close !== -1) {
          source += `[${pattern.slice(i + 1, close).replace(/\\/g, '\\\\')}]`;
          i = close;
          continue;
        }
      }
      source += escapeRegExp(char);
    }
    return source;
  });

  return new RegExp(`^(?:${sources.join('|')})$`);
}

/** 어느 글롭에 걸렸는지 돌려준다. 안 걸리면 null — 사유 문구에 패턴을 그대로 싣는다. */
export function matchingGlob(path, globs = []) {
  for (const glob of globs) {
    if (globToRegExp(glob).test(path)) return glob;
  }
  return null;
}

function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}

function isMarkdown(path) {
  return MARKDOWN_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));
}

/** docs.root 아래 마크다운 후보를 모은다. 기본 제외 디렉토리는 통째로 사유와 함께 남는다. */
function collectCandidates(root, { skipDirs }) {
  const candidates = [];
  const excluded = [];

  const walk = (absDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (error) {
      excluded.push({
        path: toPosix(relative(root, absDir)) || '.',
        reason: `디렉토리를 읽을 수 없음 (${error.code ?? error.message})`,
      });
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absPath = resolve(absDir, entry.name);
      const path = toPosix(relative(root, absPath));

      if (entry.isSymbolicLink()) {
        if (isMarkdown(path)) excluded.push({ path, reason: '심볼릭 링크 — 순환을 피해 따라가지 않음' });
        continue;
      }
      if (entry.isDirectory()) {
        if (skipDirs.includes(entry.name)) {
          excluded.push({ path, reason: '기본 제외 디렉토리' });
          continue;
        }
        walk(absPath);
        continue;
      }
      if (!entry.isFile() || !isMarkdown(path)) continue;
      candidates.push({ path, absPath });
    }
  };

  walk(root);
  return { candidates, excluded };
}

/**
 * 문서 집합을 로드한다.
 *
 * @param {{config: object, repoRoot: string, docsRoot?: string}} context loadConfig 의 결과
 * @param {{parse?: boolean, skipDirs?: string[]}} options parse 를 켜면 각 문서에 parsed 가 붙는다
 * @returns {{root, documents, frozen, excluded, filesScanned}}
 */
export function loadCorpus(context, { parse = false, skipDirs = DEFAULT_SKIP_DIRS } = {}) {
  const { config, repoRoot } = context ?? {};
  if (!config?.docs?.root) throw new CorpusError('config.docs.root 가 없다');

  const root = context.docsRoot ?? resolve(repoRoot ?? process.cwd(), config.docs.root);
  try {
    if (!statSync(root).isDirectory()) throw new CorpusError(`docs.root 가 디렉토리가 아니다: ${root}`);
  } catch (error) {
    if (error instanceof CorpusError) throw error;
    throw new CorpusError(`docs.root 를 찾을 수 없다: ${root} (${error.code ?? error.message})`);
  }

  const { include, exclude, frozen } = config.docs;
  const { candidates, excluded } = collectCandidates(root, { skipDirs });

  const documents = [];
  const frozenDocuments = [];

  const read = (candidate) => {
    const text = readFileSync(candidate.absPath, 'utf8');
    const document = { path: candidate.path, absPath: candidate.absPath, text };
    if (parse) document.parsed = parseMarkdown(text, { file: candidate.path });
    return document;
  };

  for (const candidate of candidates) {
    const includedBy = matchingGlob(candidate.path, include);
    if (!includedBy) {
      excluded.push({ path: candidate.path, reason: `include 글롭에 걸리지 않음 (${include.join(' · ')})` });
      continue;
    }
    const excludedBy = matchingGlob(candidate.path, exclude);
    if (excludedBy) {
      excluded.push({ path: candidate.path, reason: `exclude 글롭 "${excludedBy}" 에 걸림` });
      continue;
    }

    const frozenBy = matchingGlob(candidate.path, frozen);
    let document;
    try {
      document = read(candidate);
    } catch (error) {
      excluded.push({ path: candidate.path, reason: `파일을 읽을 수 없음 (${error.code ?? error.message})` });
      continue;
    }

    if (frozenBy) {
      excluded.push({
        path: candidate.path,
        reason: `frozen "${frozenBy}" — 소급 편집 금지 문서라 드리프트 검사 대상이 아님`,
      });
      frozenDocuments.push({ ...document, frozen: true, frozenBy });
      continue;
    }
    documents.push(document);
  }

  excluded.sort((a, b) => a.path.localeCompare(b.path));

  return {
    root,
    documents,
    frozen: frozenDocuments,
    excluded,
    filesScanned: documents.length,
  };
}

/** 검사 대상 + 동결 문서 — 링크·앵커 대상 해석은 동결 문서도 봐야 한다. */
export function allDocuments(corpus) {
  return [...corpus.documents, ...corpus.frozen].sort((a, b) => a.path.localeCompare(b.path));
}
