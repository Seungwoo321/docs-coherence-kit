/**
 * 축 매니페스트 로드·병합·활성 판정.
 * 형식 정본: schemas/manifest.schema.json
 *
 * 축 이름은 코어·플러그인을 합쳐 전역 유일하다. when.requires 를 config 에 대조해
 * 못 채운 축은 조용히 빠지지 않고 사유와 함께 skipped 로 보고된다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasConfigKey } from './config.mjs';

export const AXIS_KINDS = ['script', 'judgment', 'hybrid'];
export const SEVERITY_CAPS = ['block', 'warn', 'info'];

/** 축 항목이 받는 키 — schemas/manifest.schema.json 의 $defs.axis.properties 와 같아야 한다. */
export const AXIS_KEYS = ['name', 'title', 'kind', 'run', 'when', 'severity_cap'];

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** 이 파일 기준 키트 루트 (core/lib/manifest.mjs → ../..). */
export const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export class ManifestError extends Error {
  constructor(message, problems = []) {
    super(problems.length ? `${message}\n- ${problems.join('\n- ')}` : message);
    this.name = 'ManifestError';
    this.problems = problems;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 위반 목록을 돌려준다. 빈 배열이면 유효하다. */
export function validateManifest(raw) {
  if (!isPlainObject(raw)) return ['manifest: 객체여야 한다'];
  if (!Array.isArray(raw.axes)) return ['axes: 배열이어야 한다 (필수)'];

  const problems = [];
  const seen = new Set();

  raw.axes.forEach((axis, i) => {
    const path = `axes[${i}]`;
    if (!isPlainObject(axis)) {
      problems.push(`${path}: 객체여야 한다`);
      return;
    }
    if (typeof axis.name !== 'string' || !NAME_RE.test(axis.name)) {
      problems.push(`${path}.name: kebab-case 이름이어야 한다`);
    } else if (seen.has(axis.name)) {
      problems.push(`${path}.name: 같은 매니페스트 안에서 중복된 축 이름 "${axis.name}"`);
    } else {
      seen.add(axis.name);
    }
    if (axis.title !== undefined && typeof axis.title !== 'string') {
      problems.push(`${path}.title: 문자열이어야 한다`);
    }
    if (!AXIS_KINDS.includes(axis.kind)) {
      problems.push(`${path}.kind: ${AXIS_KINDS.join('|')} 중 하나여야 한다`);
    }
    if (!isPlainObject(axis.run)) {
      problems.push(`${path}.run: 객체여야 한다 (필수)`);
    } else {
      for (const key of Object.keys(axis.run)) {
        if (!['script', 'contract'].includes(key)) problems.push(`${path}.run.${key}: 알 수 없는 키`);
      }
      const needsScript = axis.kind === 'script' || axis.kind === 'hybrid';
      const needsContract = axis.kind === 'judgment' || axis.kind === 'hybrid';
      if (needsScript && typeof axis.run.script !== 'string') {
        problems.push(`${path}.run.script: kind=${axis.kind} 축에는 필수다`);
      }
      if (needsContract && typeof axis.run.contract !== 'string') {
        problems.push(`${path}.run.contract: kind=${axis.kind} 축에는 필수다`);
      }
      if (!needsScript && axis.run.script !== undefined) {
        problems.push(`${path}.run.script: kind=${axis.kind} 축은 스크립트를 갖지 않는다`);
      }
      if (!needsContract && axis.run.contract !== undefined) {
        problems.push(`${path}.run.contract: kind=${axis.kind} 축은 계약을 갖지 않는다`);
      }
    }
    if (axis.when !== undefined) {
      if (!isPlainObject(axis.when)) {
        problems.push(`${path}.when: 객체여야 한다`);
      } else {
        for (const key of Object.keys(axis.when)) {
          if (key !== 'requires') problems.push(`${path}.when.${key}: 알 수 없는 키`);
        }
        if (axis.when.requires !== undefined) {
          if (
            !Array.isArray(axis.when.requires) ||
            axis.when.requires.some((v) => typeof v !== 'string' || v.length === 0)
          ) {
            problems.push(`${path}.when.requires: 문자열 배열이어야 한다`);
          }
        }
      }
    }
    if (axis.severity_cap !== undefined && !SEVERITY_CAPS.includes(axis.severity_cap)) {
      problems.push(`${path}.severity_cap: ${SEVERITY_CAPS.join('|')} 중 하나여야 한다`);
    }
    for (const key of Object.keys(axis)) {
      if (!AXIS_KEYS.includes(key)) problems.push(`${path}.${key}: 알 수 없는 키`);
    }
  });

  return problems;
}

/**
 * 매니페스트 파일 하나를 읽는다. run 경로는 매니페스트 파일 기준 상대 경로로 해석한다.
 * checkExists 는 축 스크립트·계약 파일의 실재를 함께 검사한다.
 */
export function loadManifest(manifestPath, { checkExists = false } = {}) {
  const absPath = isAbsolute(manifestPath) ? manifestPath : resolve(process.cwd(), manifestPath);

  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch (error) {
    throw new ManifestError(`매니페스트를 읽을 수 없다: ${absPath} (${error.code ?? error.message})`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(`매니페스트가 JSON 이 아니다: ${absPath} (${error.message})`);
  }

  const problems = validateManifest(raw);
  if (problems.length) throw new ManifestError(`매니페스트 형식 위반 (${absPath})`, problems);

  const base = dirname(absPath);
  const axes = raw.axes.map((axis) => {
    const resolved = {
      name: axis.name,
      title: axis.title ?? axis.name,
      kind: axis.kind,
      run: { ...axis.run },
      when: { requires: axis.when?.requires ?? [] },
      severity_cap: axis.severity_cap ?? 'block',
      source: absPath,
    };
    if (axis.run.script) resolved.scriptPath = resolve(base, axis.run.script);
    if (axis.run.contract) resolved.contractPath = resolve(base, axis.run.contract);
    return resolved;
  });

  if (checkExists) {
    const missing = [];
    for (const axis of axes) {
      if (axis.scriptPath && !existsSync(axis.scriptPath)) missing.push(`${axis.name}: ${axis.scriptPath}`);
      if (axis.contractPath && !existsSync(axis.contractPath)) missing.push(`${axis.name}: ${axis.contractPath}`);
    }
    if (missing.length) throw new ManifestError(`등록된 축의 파일이 없다 (${absPath})`, missing);
  }

  return { path: absPath, axes };
}

/** 여러 매니페스트의 축을 합친다. 이름이 겹치면 throw — 축 이름은 전역 유일하다. */
export function mergeManifests(manifests) {
  const merged = [];
  const byName = new Map();

  for (const manifest of manifests) {
    for (const axis of manifest.axes) {
      const previous = byName.get(axis.name);
      if (previous) {
        throw new ManifestError(
          `축 이름 충돌: "${axis.name}" 이 두 매니페스트에 등록됐다 (${previous.source} · ${axis.source})`,
        );
      }
      byName.set(axis.name, axis);
      merged.push(axis);
    }
  }
  return merged;
}

/**
 * config 를 대조해 각 축을 active / skipped 로 판정한다.
 * skipped 는 반드시 사유를 갖는다 — 검사하지 않은 축이 통과로 읽히면 안 된다.
 */
export function resolveAxes(axes, config, { only = null } = {}) {
  // 이름을 좁혀 부르는 것은 축을 지우는 것이 아니라 "이번엔 안 본다" 를 남기는 것이다.
  // 빠진 축이 목록에서 사라지면 그게 조용한 통과다.
  if (only) {
    const known = new Set(axes.map((axis) => axis.name));
    const unknown = only.filter((name) => !known.has(name));
    if (unknown.length) {
      throw new ManifestError(
        `--axes 가 등록되지 않은 축을 가리킨다: ${unknown.map((n) => `"${n}"`).join(' · ')}`,
        [`등록된 축: ${[...known].join(' · ')}`],
      );
    }
  }
  const selected = only ? new Set(only) : null;

  return axes.map((entry) => {
    // 앞선 판정의 사유가 남지 않도록 떼고 다시 붙인다 — 재판정이 안전해야 한다.
    const { state: _state, reason: _reason, ...axis } = entry;
    if (selected && !selected.has(axis.name)) {
      return { ...axis, state: 'skipped', reason: '--axes 로 선택되지 않아 건너뜀' };
    }
    const missing = axis.when.requires.filter((key) => !hasConfigKey(config, key));
    if (missing.length === 0) return { ...axis, state: 'active' };
    return {
      ...axis,
      state: 'skipped',
      reason: `config 에 ${missing.map((k) => `"${k}"`).join(' · ')} 선언이 없어 건너뜀`,
    };
  });
}

/**
 * `--axes numbers,links` 를 축 이름 목록으로 바꾼다. 인자가 없으면 null — 전체 실행이다.
 * 스캔과 병합이 같은 방식으로 좁혀야 기대 축 목록이 어긋나지 않는다.
 */
export function parseAxisSelection(value) {
  if (value === undefined || value === null) return null;
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) throw new ManifestError('--axes 에 축 이름이 없다');
  return [...new Set(names)];
}

/** config.plugins 를 플러그인 매니페스트 경로로 바꾼다. */
export function resolvePluginManifestPaths(config, { kitRoot = KIT_ROOT } = {}) {
  return (config.plugins ?? []).map((name) => {
    if (!NAME_RE.test(name)) {
      throw new ManifestError(`플러그인 이름이 kebab-case 가 아니다: "${name}"`);
    }
    const path = resolve(kitRoot, 'plugins', name, 'manifest.json');
    if (!existsSync(path)) {
      throw new ManifestError(`config 가 선언한 플러그인이 설치돼 있지 않다: "${name}" (${path})`);
    }
    return path;
  });
}

/**
 * 코어 + config 가 선언한 플러그인의 축 전부를 로드·병합·판정한다.
 * 코어만 설치돼 있으면 플러그인 축은 목록에 아예 오르지 않는다.
 */
export function loadAxes(config, { kitRoot = KIT_ROOT, checkExists = false, only = null } = {}) {
  const paths = [resolve(kitRoot, 'core', 'manifest.json'), ...resolvePluginManifestPaths(config, { kitRoot })];
  const manifests = paths.map((path) => loadManifest(path, { checkExists }));
  return resolveAxes(mergeManifests(manifests), config, { only });
}
