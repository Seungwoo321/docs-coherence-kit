/**
 * 라인 보존 마크다운 파서.
 *
 * 범용 CommonMark 구현이 아니다 — 축들이 필요로 하는 것만 파싱하되, 모든 산출물이
 * 원본 줄 번호를 갖는다. findings 의 location.line 이 여기서 나온다.
 *
 * 파싱 대상: fenced code block 범위 · 헤딩(§절 번호·앵커) · 표 · 인라인 링크 · 코드스팬.
 * 헤딩·표·링크는 fenced code block 안을 보지 않는다. 코드스팬은 전 줄에서 수집한다.
 */

/** 헤딩 텍스트 앞머리의 절 번호 — "§5.1 …" · "5.1 …" · "§6" 를 "5.1" · "6" 으로. */
export const SECTION_NUMBER_RE = /^§?\s*(\d+(?:\.\d+)*)\.?(?:\s|$)/;

const ATX_RE = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/;
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const DELIMITER_CELL_RE = /^:?-+:?$/;
const INLINE_LINK_RE = /(!?)\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

/** GitHub 스타일 앵커 슬러그. 같은 슬러그가 반복되면 -1, -2 가 붙는다. */
export function slugify(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, '')
    .replace(/\s+/g, '-');
}

/** 헤딩 텍스트에서 절 번호만 뽑는다. 없으면 null. */
export function parseSectionNumber(text) {
  const match = SECTION_NUMBER_RE.exec(String(text).trim());
  return match ? match[1] : null;
}

function findFences(lines) {
  const fences = [];
  let open = null;

  lines.forEach((raw, index) => {
    const line = index + 1;
    const match = FENCE_RE.exec(raw);
    if (!open) {
      if (!match) return;
      const marker = match[2];
      const info = match[3].trim();
      // 백틱 펜스의 info string 에는 백틱이 올 수 없다 (코드스팬과의 구분).
      if (marker[0] === '`' && info.includes('`')) return;
      open = { start: line, marker, info };
      return;
    }
    if (match && match[2][0] === open.marker[0] && match[2].length >= open.marker.length && match[3].trim() === '') {
      fences.push({ start: open.start, end: line, marker: open.marker, info: open.info, closed: true });
      open = null;
    }
  });

  if (open) {
    fences.push({ start: open.start, end: lines.length, marker: open.marker, info: open.info, closed: false });
  }
  return fences;
}

function fenceMask(lines, fences) {
  const mask = new Uint8Array(lines.length + 2);
  for (const fence of fences) {
    for (let line = fence.start; line <= fence.end; line += 1) mask[line] = 1;
  }
  return mask;
}

function findCodeSpansInLine(raw, line) {
  const spans = [];
  const runs = [];
  const runRe = /`+/g;
  let match;
  while ((match = runRe.exec(raw)) !== null) runs.push({ index: match.index, length: match[0].length });

  let i = 0;
  while (i < runs.length) {
    const opener = runs[i];
    let j = i + 1;
    while (j < runs.length && runs[j].length !== opener.length) j += 1;
    if (j >= runs.length) {
      i += 1;
      continue;
    }
    const closer = runs[j];
    const start = opener.index;
    const end = closer.index + closer.length;
    spans.push({
      line,
      column: start + 1,
      endColumn: end,
      backticks: opener.length,
      text: raw.slice(opener.index + opener.length, closer.index).trim(),
      raw: raw.slice(start, end),
    });
    i = j + 1;
  }
  return spans;
}

function overlapsCodeSpan(spans, line, start, end) {
  return spans.some((span) => span.line === line && start < span.endColumn && end > span.column - 1);
}

/** 표 한 줄을 셀로 가른다. `\|` 는 셀 구분자가 아니다. */
export function splitTableCells(raw) {
  const trimmed = raw.trim();
  const cells = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (char === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (char === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);

  if (cells.length > 1 && trimmed.startsWith('|') && cells[0].trim() === '') cells.shift();
  if (cells.length > 1 && trimmed.endsWith('|') && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((cell) => cell.trim());
}

function parseAlignment(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function findHeadings(lines, mask) {
  const headings = [];
  const slugCounts = new Map();

  lines.forEach((raw, index) => {
    const line = index + 1;
    if (mask[line]) return;
    const match = ATX_RE.exec(raw);
    if (!match) return;

    const text = (match[2] ?? '').replace(/\s+#+\s*$/, '').trim();
    const base = slugify(text);
    const count = slugCounts.get(base) ?? 0;
    slugCounts.set(base, count + 1);

    headings.push({
      level: match[1].length,
      text,
      line,
      anchor: count === 0 ? base : `${base}-${count}`,
      section: parseSectionNumber(text),
      raw,
    });
  });

  return headings;
}

function findTables(lines, mask) {
  const tables = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerLine = index + 1;
    if (mask[headerLine] || mask[headerLine + 1]) continue;

    const headerRaw = lines[index];
    const delimiterRaw = lines[index + 1];
    if (!headerRaw.includes('|') || !delimiterRaw.includes('-')) continue;

    const header = splitTableCells(headerRaw);
    const delimiter = splitTableCells(delimiterRaw);
    if (delimiter.length !== header.length) continue;
    if (!delimiter.every((cell) => DELIMITER_CELL_RE.test(cell))) continue;

    const rows = [];
    let cursor = index + 2;
    while (cursor < lines.length) {
      const line = cursor + 1;
      const raw = lines[cursor];
      if (mask[line] || raw.trim() === '' || !raw.includes('|') || ATX_RE.test(raw)) break;
      rows.push({ cells: splitTableCells(raw), line, raw });
      cursor += 1;
    }

    tables.push({
      line: headerLine,
      delimiterLine: headerLine + 1,
      endLine: cursor,
      header,
      alignments: delimiter.map(parseAlignment),
      columns: header.length,
      rows,
    });

    index = cursor - 1;
  }

  return tables;
}

function findLinks(lines, mask, codeSpans) {
  const links = [];

  lines.forEach((raw, index) => {
    const line = index + 1;
    if (mask[line]) return;

    INLINE_LINK_RE.lastIndex = 0;
    let match;
    while ((match = INLINE_LINK_RE.exec(raw)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (overlapsCodeSpan(codeSpans, line, start, end)) continue;

      const target = match[3].startsWith('<') ? match[3].slice(1, -1) : match[3];
      links.push({
        text: match[2],
        target,
        line,
        column: start + 1,
        isImage: match[1] === '!',
        raw: match[0],
      });
    }
  });

  return links;
}

/** 문서 하나를 파싱한다. 모든 산출물은 1-based 줄 번호를 갖는다. */
export function parseMarkdown(text, { file = null } = {}) {
  const lines = String(text).split(/\r\n|\r|\n/);
  const fences = findFences(lines);
  const mask = fenceMask(lines, fences);

  const codeSpans = lines.flatMap((raw, index) => findCodeSpansInLine(raw, index + 1));

  return {
    file,
    lines,
    fences,
    headings: findHeadings(lines, mask),
    tables: findTables(lines, mask),
    links: findLinks(lines, mask, codeSpans),
    codeSpans,
  };
}

/** 그 줄이 fenced code block 안인가. */
export function isInsideFence(parsed, line) {
  return parsed.fences.some((fence) => line >= fence.start && line <= fence.end);
}

/** 1-based 줄 텍스트. findings 의 quote 를 만들 때 쓴다. */
export function lineText(parsed, line) {
  return parsed.lines[line - 1] ?? '';
}

/** 절 번호로 헤딩을 찾는다. 없으면 null — 링크 축의 §N 대조가 이걸 쓴다. */
export function findHeadingBySection(parsed, section) {
  const wanted = String(section).replace(/^§/, '').replace(/\.$/, '');
  return parsed.headings.find((heading) => heading.section === wanted) ?? null;
}
