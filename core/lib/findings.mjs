/**
 * findings 봉투 — 모든 축이 같은 형식으로 결과를 낸다.
 * 형식 정본: schemas/findings.schema.json
 */

export const SEVERITIES = ['info', 'warn', 'block'];

/** 축 이름이 아닌 code 접두를 쓸 수 있는 네임스페이스. 병합기가 주입한다. */
export const RESERVED_CODE_NAMESPACES = ['coverage'];

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** schemas/findings.schema.json 의 $defs.finding / $defs.location properties 와 같아야 한다. */
export const FINDING_KEYS = ['axis', 'severity', 'code', 'message', 'locations', 'payload', 'found_by'];
export const LOCATION_KEYS = ['file', 'line', 'quote'];

export class FindingError extends Error {
  constructor(message, problems = []) {
    super(problems.length ? `${message}\n- ${problems.join('\n- ')}` : message);
    this.name = 'FindingError';
    this.problems = problems;
  }
}

export function severityRank(severity) {
  const rank = SEVERITIES.indexOf(severity);
  if (rank === -1) throw new FindingError(`알 수 없는 severity: ${severity}`);
  return rank;
}

/** severity_cap 을 넘는 심각도를 cap 으로 낮춘다. */
export function capSeverity(severity, cap) {
  if (!cap) return severity;
  return severityRank(severity) > severityRank(cap) ? cap : severity;
}

export function validateLocation(location, path = 'locations[0]') {
  const problems = [];
  if (location === null || typeof location !== 'object' || Array.isArray(location)) {
    return [`${path}: 객체여야 한다`];
  }
  if (typeof location.file !== 'string' || location.file.length === 0) {
    problems.push(`${path}.file: 비어 있지 않은 문자열이어야 한다`);
  }
  if (location.line !== undefined) {
    if (!Number.isInteger(location.line) || location.line < 1) {
      problems.push(`${path}.line: 1 이상의 정수여야 한다`);
    }
  }
  if (location.quote !== undefined && typeof location.quote !== 'string') {
    problems.push(`${path}.quote: 문자열이어야 한다`);
  }
  for (const key of Object.keys(location)) {
    if (!LOCATION_KEYS.includes(key)) problems.push(`${path}.${key}: 알 수 없는 키`);
  }
  return problems;
}

/**
 * 위반 목록을 돌려준다. 빈 배열이면 유효하다.
 *
 * codeNamespaces 는 자기 축 이름 외에 이 finding 이 쓸 수 있는 code 네임스페이스다.
 * 생산자(축 스크립트)는 이 옵션을 쓰지 않는다 — 자기 코드만 낸다. 등록된 축 목록을 아는
 * 병합기만 넘긴다: 한 결함을 두 축이 각자 발견해 같은 code 로 보고할 수 있어야
 * found_by 가 신뢰도 신호가 된다 — 여러 축이 같은 결함에 각자 도달했다는 사실이 곧 그 지적의 근거다.
 */
export function validateFinding(finding, { codeNamespaces = [] } = {}) {
  if (finding === null || typeof finding !== 'object' || Array.isArray(finding)) {
    return ['finding: 객체여야 한다'];
  }
  const problems = [];

  if (typeof finding.axis !== 'string' || !NAME_RE.test(finding.axis)) {
    problems.push('axis: kebab-case 축 이름이어야 한다');
  }
  if (!SEVERITIES.includes(finding.severity)) {
    problems.push(`severity: ${SEVERITIES.join('|')} 중 하나여야 한다`);
  }
  if (typeof finding.code !== 'string') {
    problems.push('code: 문자열이어야 한다');
  } else {
    const [namespace, ...rest] = finding.code.split('.');
    if (rest.length !== 1 || !NAME_RE.test(namespace) || !NAME_RE.test(rest[0])) {
      problems.push('code: "<axis>.<kebab>" 형식이어야 한다');
    } else if (
      namespace !== finding.axis &&
      !RESERVED_CODE_NAMESPACES.includes(namespace) &&
      !codeNamespaces.includes(namespace)
    ) {
      problems.push(`code: 네임스페이스가 축 이름과 다르다 (${namespace} ≠ ${finding.axis})`);
    }
  }
  if (typeof finding.message !== 'string' || finding.message.length === 0) {
    problems.push('message: 비어 있지 않은 문자열이어야 한다');
  }
  if (!Array.isArray(finding.locations) || finding.locations.length === 0) {
    problems.push('locations: 최소 1개 항목이 있어야 한다');
  } else {
    finding.locations.forEach((location, i) => {
      problems.push(...validateLocation(location, `locations[${i}]`));
    });
  }
  if (finding.payload !== undefined) {
    if (finding.payload === null || typeof finding.payload !== 'object' || Array.isArray(finding.payload)) {
      problems.push('payload: 객체여야 한다');
    }
  }
  if (finding.found_by !== undefined) {
    if (!Array.isArray(finding.found_by) || finding.found_by.some((v) => typeof v !== 'string')) {
      problems.push('found_by: 문자열 배열이어야 한다');
    }
  }
  for (const key of Object.keys(finding)) {
    if (!FINDING_KEYS.includes(key)) problems.push(`${key}: 알 수 없는 키`);
  }
  return problems;
}

/** 검증된 finding 을 만든다. 형식이 어긋나면 throw. */
export function createFinding({ axis, severity, code, message, locations, payload, severityCap } = {}) {
  const finding = {
    axis,
    severity: severityCap && SEVERITIES.includes(severity) ? capSeverity(severity, severityCap) : severity,
    code,
    message,
    locations: Array.isArray(locations) ? locations.map((l) => ({ ...l })) : locations,
  };
  if (payload !== undefined) finding.payload = payload;

  const problems = validateFinding(finding);
  if (problems.length) throw new FindingError('finding 형식 위반', problems);
  return finding;
}

/**
 * 중복 접기 키 = (code, locations[0].file, locations[0].line).
 * 구분자는 NUL — 파일 경로에 들어갈 수 없는 유일한 문자라 키가 겹치지 않는다.
 */
export const FOLD_KEY_SEPARATOR = '\u0000';

export function foldKey(finding, options = {}) {
  const problems = validateFinding(finding, options);
  if (problems.length) throw new FindingError('finding 형식 위반', problems);
  const first = finding.locations[0];
  return [finding.code, first.file, first.line ?? ''].join(FOLD_KEY_SEPARATOR);
}

/**
 * 같은 키의 finding 을 하나로 접고 found_by 에 원 축을 남긴다.
 * coverage.* 는 접지 않는다 — 축마다 별개 사실이다.
 */
export function foldFindings(findings, options = {}) {
  const folded = [];
  const byKey = new Map();

  for (const finding of findings) {
    const namespace = String(finding.code).split('.')[0];
    if (RESERVED_CODE_NAMESPACES.includes(namespace)) {
      folded.push({ ...finding, found_by: [finding.axis] });
      continue;
    }
    const key = foldKey(finding, options);
    const seen = byKey.get(key);
    if (!seen) {
      const entry = { ...finding, found_by: [finding.axis] };
      byKey.set(key, entry);
      folded.push(entry);
      continue;
    }
    if (!seen.found_by.includes(finding.axis)) seen.found_by.push(finding.axis);
    if (severityRank(finding.severity) > severityRank(seen.severity)) {
      seen.severity = finding.severity;
    }
    for (const location of finding.locations.slice(1)) {
      const duplicate = seen.locations.some((l) => l.file === location.file && l.line === location.line);
      if (!duplicate) seen.locations.push({ ...location });
    }
  }
  return folded;
}

/** 축 스크립트 stdout 봉투. */
export function createScanResult({ axis, findings = [], candidates, stats = {} } = {}) {
  const problems = [];
  if (typeof axis !== 'string' || !NAME_RE.test(axis)) problems.push('axis: kebab-case 축 이름이어야 한다');
  findings.forEach((finding, i) => {
    problems.push(...validateFinding(finding).map((p) => `findings[${i}].${p}`));
    if (finding.axis !== axis) problems.push(`findings[${i}].axis: 봉투의 축과 다르다`);
  });
  if (problems.length) throw new FindingError('scanResult 형식 위반', problems);

  const result = {
    axis,
    findings,
    stats: {
      files_scanned: stats.files_scanned ?? 0,
      excluded: (stats.excluded ?? []).map((e) => ({ path: e.path, reason: e.reason })),
      skipped: stats.skipped ?? false,
      ...(stats.skip_reason ? { skip_reason: stats.skip_reason } : {}),
    },
  };
  if (candidates !== undefined) result.candidates = candidates;
  return result;
}

/** scanResult 봉투가 받는 최상위 키 — schemas/findings.schema.json 의 $defs.scanResult 와 같아야 한다. */
export const SCAN_RESULT_KEYS = ['axis', 'findings', 'candidates', 'stats'];

/**
 * 남이 만든 봉투를 읽을 때 쓴다(스캐너가 자식 프로세스 stdout 을 검사하는 자리).
 * createScanResult 는 생산자용이라 형식을 강제하며 만들고, 이쪽은 판정만 한다.
 */
export function validateScanResult(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return ['scanResult: 객체여야 한다'];
  const problems = [];

  if (typeof raw.axis !== 'string' || !NAME_RE.test(raw.axis)) {
    problems.push('axis: kebab-case 축 이름이어야 한다');
  }
  if (!Array.isArray(raw.findings)) {
    problems.push('findings: 배열이어야 한다 (필수)');
  } else {
    raw.findings.forEach((finding, i) => {
      problems.push(...validateFinding(finding).map((p) => `findings[${i}].${p}`));
      if (finding?.axis !== raw.axis) problems.push(`findings[${i}].axis: 봉투의 축과 다르다`);
    });
  }
  if (raw.candidates !== undefined && !Array.isArray(raw.candidates)) {
    problems.push('candidates: 배열이어야 한다');
  }
  if (raw.stats === null || typeof raw.stats !== 'object' || Array.isArray(raw.stats)) {
    problems.push('stats: 객체여야 한다 (필수)');
  } else {
    if (!Number.isInteger(raw.stats.files_scanned) || raw.stats.files_scanned < 0) {
      problems.push('stats.files_scanned: 0 이상의 정수여야 한다');
    }
    if (!Array.isArray(raw.stats.excluded)) {
      problems.push('stats.excluded: 배열이어야 한다 — 무엇을 왜 뺐는지는 선택이 아니다');
    } else {
      raw.stats.excluded.forEach((entry, i) => {
        const path = `stats.excluded[${i}]`;
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          problems.push(`${path}: 객체여야 한다`);
          return;
        }
        if (typeof entry.path !== 'string') problems.push(`${path}.path: 문자열이어야 한다`);
        if (typeof entry.reason !== 'string' || entry.reason.length === 0) {
          problems.push(`${path}.reason: 비어 있지 않은 문자열이어야 한다`);
        }
      });
    }
    if (typeof raw.stats.skipped !== 'boolean') problems.push('stats.skipped: 불리언이어야 한다');
  }
  for (const key of Object.keys(raw)) {
    if (!SCAN_RESULT_KEYS.includes(key)) problems.push(`${key}: 알 수 없는 키`);
  }
  return problems;
}

/** when.requires 미충족 축의 봉투 — 사유 없이 조용히 빠지지 않는다. */
export function createSkippedScanResult({ axis, reason }) {
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new FindingError('skipped 축은 사유가 있어야 한다');
  }
  return createScanResult({
    axis,
    findings: [],
    stats: { files_scanned: 0, excluded: [], skipped: true, skip_reason: reason },
  });
}
