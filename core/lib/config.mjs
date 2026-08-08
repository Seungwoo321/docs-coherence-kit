/**
 * dck.config.json 로드·검증·기본값.
 * 형식 정본: schemas/config.schema.json (여기서 같은 규칙을 의존성 없이 직접 검사한다)
 *
 * 여기 열거되지 않은 최상위 키는 플러그인이 소유한다 — 축의 when.requires 가 그 키를 가리킨다.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export const DEFAULTS = Object.freeze({
  out: '.dck',
  include: ['**/*.md'],
  exclude: [],
  frozen: [],
  routes: [],
  total_row_labels: ['합계', '총계', '계', 'total', 'Total'],
});

const KEY_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** docs 블록이 받는 키 — schemas/config.schema.json 의 docs.properties 와 같아야 한다. */
export const DOCS_KEYS = ['root', 'manifest', 'include', 'exclude', 'frozen', 'routes'];

const KNOWN_KEYS = [
  '$schema',
  'docs',
  'out',
  'ownership',
  'numbers',
  'measurements',
  'concepts',
  'schemas',
  'schemas_complete',
  'reuse_gates',
  'plugins',
];

export class ConfigError extends Error {
  constructor(message, problems = []) {
    super(problems.length ? `${message}\n- ${problems.join('\n- ')}` : message);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkStringArray(value, path, problems, { required = false } = {}) {
  if (value === undefined) {
    if (required) problems.push(`${path}: 필수 항목이다`);
    return;
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.length === 0)) {
    problems.push(`${path}: 비어 있지 않은 문자열의 배열이어야 한다`);
  }
}

function checkString(value, path, problems, { required = false } = {}) {
  if (value === undefined) {
    if (required) problems.push(`${path}: 필수 항목이다`);
    return;
  }
  if (typeof value !== 'string' || value.length === 0) {
    problems.push(`${path}: 비어 있지 않은 문자열이어야 한다`);
  }
}

function checkRegExp(value, path, problems) {
  if (value === undefined) return;
  checkString(value, path, problems);
  if (typeof value === 'string') {
    try {
      new RegExp(value);
    } catch (error) {
      problems.push(`${path}: 정규식으로 컴파일되지 않는다 (${error.message})`);
    }
  }
}

function checkKnownKeys(object, allowed, path, problems) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) problems.push(`${path}.${key}: 알 수 없는 키`);
  }
}

/** 위반 목록을 돌려준다. 빈 배열이면 유효하다. */
export function validateConfig(raw) {
  if (!isPlainObject(raw)) return ['config: 객체여야 한다'];
  const problems = [];

  // docs
  if (!isPlainObject(raw.docs)) {
    problems.push('docs: 객체여야 한다 (필수)');
  } else {
    checkString(raw.docs.root, 'docs.root', problems, { required: true });
    checkString(raw.docs.manifest, 'docs.manifest', problems);
    checkStringArray(raw.docs.include, 'docs.include', problems);
    checkStringArray(raw.docs.exclude, 'docs.exclude', problems);
    checkStringArray(raw.docs.frozen, 'docs.frozen', problems);
    checkStringArray(raw.docs.routes, 'docs.routes', problems);
    checkKnownKeys(raw.docs, DOCS_KEYS, 'docs', problems);
  }

  checkString(raw.out, 'out', problems);

  // ownership
  if (raw.ownership !== undefined) {
    if (!Array.isArray(raw.ownership)) {
      problems.push('ownership: 배열이어야 한다');
    } else {
      raw.ownership.forEach((entry, i) => {
        const path = `ownership[${i}]`;
        if (!isPlainObject(entry)) {
          problems.push(`${path}: 객체여야 한다`);
          return;
        }
        checkString(entry.what, `${path}.what`, problems, { required: true });
        checkString(entry.owner, `${path}.owner`, problems, { required: true });
        checkString(entry.hint, `${path}.hint`, problems);
        checkKnownKeys(entry, ['what', 'owner', 'hint'], path, problems);
      });
    }
  }

  // numbers
  if (raw.numbers !== undefined) {
    if (!isPlainObject(raw.numbers)) {
      problems.push('numbers: 객체여야 한다');
    } else {
      checkRegExp(raw.numbers.marker_pattern, 'numbers.marker_pattern', problems);
      checkStringArray(raw.numbers.labels, 'numbers.labels', problems);
      checkStringArray(raw.numbers.total_row_labels, 'numbers.total_row_labels', problems);
      checkKnownKeys(raw.numbers, ['marker_pattern', 'labels', 'total_row_labels'], 'numbers', problems);
    }
  }

  // measurements
  if (raw.measurements !== undefined) {
    if (!Array.isArray(raw.measurements)) {
      problems.push('measurements: 배열이어야 한다');
    } else {
      raw.measurements.forEach((entry, i) => {
        const path = `measurements[${i}]`;
        if (!isPlainObject(entry)) {
          problems.push(`${path}: 객체여야 한다`);
          return;
        }
        checkString(entry.label, `${path}.label`, problems, { required: true });
        checkString(entry.cmd, `${path}.cmd`, problems, { required: true });
        checkStringArray(entry.expect_in, `${path}.expect_in`, problems);
        checkKnownKeys(entry, ['label', 'cmd', 'expect_in'], path, problems);
      });
    }
  }

  checkStringArray(raw.concepts, 'concepts', problems);
  checkStringArray(raw.schemas, 'schemas', problems);
  if (raw.schemas_complete !== undefined && typeof raw.schemas_complete !== 'boolean') {
    problems.push('schemas_complete: 불리언이어야 한다');
  }
  checkStringArray(raw.reuse_gates, 'reuse_gates', problems);
  checkStringArray(raw.plugins, 'plugins', problems);

  // 플러그인 소유 키 — 이름 형식만 강제하고 내용은 플러그인이 소유한다.
  for (const key of Object.keys(raw)) {
    if (KNOWN_KEYS.includes(key)) continue;
    if (!KEY_RE.test(key)) {
      problems.push(`${key}: 최상위 키는 소문자 snake_case 여야 한다`);
    }
  }

  return problems;
}

/** 기본값을 채운 config 를 돌려준다. 형식이 어긋나면 throw. */
export function normalizeConfig(raw, { source = '<memory>' } = {}) {
  const problems = validateConfig(raw);
  if (problems.length) throw new ConfigError(`config 형식 위반 (${source})`, problems);

  const config = structuredClone(raw);
  config.out = config.out ?? DEFAULTS.out;
  config.docs = {
    ...config.docs,
    include: config.docs.include ?? [...DEFAULTS.include],
    exclude: config.docs.exclude ?? [...DEFAULTS.exclude],
    frozen: config.docs.frozen ?? [...DEFAULTS.frozen],
    routes: config.docs.routes ?? [...DEFAULTS.routes],
  };
  if (config.numbers) {
    config.numbers = {
      ...config.numbers,
      total_row_labels: config.numbers.total_row_labels ?? [...DEFAULTS.total_row_labels],
    };
  }
  config.plugins = config.plugins ?? [];
  return config;
}

/**
 * config 파일을 읽어 컨텍스트를 만든다.
 * repoRoot 기본값은 config 파일이 있는 디렉토리 — 모든 상대 경로의 기준이다.
 */
export function loadConfig(configPath, { repoRoot } = {}) {
  const absConfigPath = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);

  let text;
  try {
    text = readFileSync(absConfigPath, 'utf8');
  } catch (error) {
    throw new ConfigError(`config 파일을 읽을 수 없다: ${absConfigPath} (${error.code ?? error.message})`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`config 파일이 JSON 이 아니다: ${absConfigPath} (${error.message})`);
  }

  const config = normalizeConfig(raw, { source: absConfigPath });
  const root = repoRoot ? resolve(repoRoot) : dirname(absConfigPath);

  return Object.freeze({
    config,
    configPath: absConfigPath,
    repoRoot: root,
    docsRoot: resolve(root, config.docs.root),
    outDir: resolve(root, config.out),
  });
}

/**
 * when.requires 대조용 — config 에 그 키가 "실제로 채워져" 있는가.
 * 빈 배열·빈 객체는 없는 것으로 본다: 빈 선언으로 도는 축은 아무것도 보장하지 못한다.
 */
export function hasConfigKey(config, key) {
  const value = config?.[key];
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** `--run-id` → `runId`. 결과 키는 자바스크립트 쪽 표기를 따른다. */
function camelize(flag) {
  return flag.replace(/-(.)/g, (_, char) => char.toUpperCase());
}

/**
 * 축 스크립트 공통 실행 계약: node <check.mjs> --config <path> [--repo <root>]
 * 오케스트레이션 엔트리(scan/merge)는 flags 로 자기 인자를 더 받는다.
 * repeatable 로 선언한 플래그는 값이 배열로 쌓인다 — 여러 번 준 인자가 조용히 덮이지 않는다.
 */
export function parseCliArgs(argv, { flags = ['config', 'repo'], repeatable = [], required = ['config'] } = {}) {
  const known = [...new Set([...flags, ...repeatable])];
  const args = {};
  for (const flag of known) args[camelize(flag)] = repeatable.includes(flag) ? [] : undefined;

  const assign = (flag, value) => {
    const key = camelize(flag);
    if (repeatable.includes(flag)) args[key].push(value);
    else args[key] = value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf('=');
    const flag = token.startsWith('--') ? token.slice(2, eq === -1 ? undefined : eq) : null;
    if (!flag || !known.includes(flag)) throw new ConfigError(`알 수 없는 인자: ${token}`);

    if (eq !== -1) {
      assign(flag, token.slice(eq + 1));
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new ConfigError(`--${flag} 인자에 값이 없다`);
    assign(flag, value);
    i += 1;
  }

  for (const flag of required) {
    const value = args[camelize(flag)];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      throw new ConfigError(`--${flag} 인자가 필요하다`);
    }
  }
  return args;
}
