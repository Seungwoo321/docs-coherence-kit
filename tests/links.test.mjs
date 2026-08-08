import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { before, describe, test } from 'node:test';

import { loadConfig } from '../core/lib/config.mjs';
import { runLinksAxis } from '../core/axes/links/check.mjs';
import { TESTS_DIR, fixture } from './helpers.mjs';

const CHECK = resolve(TESTS_DIR, '..', 'core/axes/links/check.mjs');

function run(configName = 'dck.config.json') {
  return runLinksAxis(loadConfig(fixture('links', configName)));
}

function byCode(result, code) {
  return result.findings.filter((finding) => finding.code === code);
}

function inFile(result, code, file) {
  return byCode(result, code).filter((finding) => finding.locations[0].file === file);
}

function at(result, code, file, line) {
  return inFile(result, code, file).find((finding) => finding.locations[0].line === line);
}

describe('links 축 — 실행 계약', () => {
  let result;
  before(() => {
    result = run();
  });

  test('봉투가 axis·findings·stats 를 갖는다', () => {
    assert.equal(result.axis, 'links');
    assert.ok(Array.isArray(result.findings));
    assert.equal(result.stats.skipped, false);
    // guide · glossary · architecture · access-policy · naming/uses · decisions/accepted(동결)
    assert.equal(result.stats.files_scanned, 6);
  });

  test('모든 finding 의 code 네임스페이스가 축 이름이다', () => {
    for (const finding of result.findings) {
      assert.equal(finding.axis, 'links');
      assert.match(finding.code, /^links\.[a-z][a-z0-9-]*$/);
      assert.ok(finding.locations.length > 0);
    }
  });

  test('CLI 로 돌리면 stdout 한 덩어리 JSON 과 exit 0 을 낸다', () => {
    const stdout = execFileSync(process.execPath, [CHECK, '--config', fixture('links', 'dck.config.json')], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.axis, 'links');
    assert.deepEqual(parsed, result);
  });
});

describe('links 축 — 죽은 참조 (판정기 1·2)', () => {
  let result;
  before(() => {
    result = run();
  });

  test('(a) 번호 절 없는 용어집을 "§3" 으로 참조하면 dead-section 이다', () => {
    const finding = at(result, 'links.dead-section', 'guide.md', 3);
    assert.ok(finding, 'guide.md:3 의 "용어집 §3" 이 dead-section 으로 잡혀야 한다');
    assert.equal(finding.severity, 'block');
    assert.equal(finding.payload.section, '3');
    assert.equal(finding.payload.target.file, 'glossary.md');
    assert.equal(finding.payload.resolved_via, 'name');
    assert.deepEqual(finding.payload.target.available_sections, []);
    assert.match(finding.message, /번호 절이 없다/);
  });

  test('대상 문서에 실재하는 절 참조는 통과한다', () => {
    // guide.md:7 "아키텍처 §7" (문서명 추론) · guide.md:9 "[아키텍처](…) 의 §6" (링크 추론)
    const lines = inFile(result, 'links.dead-section', 'guide.md').map((finding) => finding.locations[0].line);
    assert.deepEqual(lines, [3], 'guide.md 에서 해석되지 않는 절 참조는 3행 하나뿐이다');
  });

  test('헤딩 스스로의 절 번호는 참조가 아니다', () => {
    assert.equal(
      byCode(result, 'links.dead-section').filter((finding) => finding.locations[0].file === 'architecture.md').length,
      0,
    );
  });

  test('없는 파일·없는 앵커는 dead-target 이다', () => {
    const missingFile = at(result, 'links.dead-target', 'guide.md', 13);
    assert.ok(missingFile);
    assert.equal(missingFile.severity, 'block');
    assert.equal(missingFile.payload.link_type, 'path');
    assert.equal(missingFile.payload.target.resolved, false);

    const missingAnchor = at(result, 'links.dead-target', 'guide.md', 15);
    assert.ok(missingAnchor);
    assert.match(missingAnchor.payload.target.reason, /헤딩이 없다/);
  });

  test('코드스팬·코드블록 안의 참조는 보지 않는다', () => {
    const lines = result.findings.flatMap((finding) =>
      finding.locations.filter((location) => location.file === 'guide.md').map((location) => location.line),
    );
    assert.ok(!lines.includes(17), '코드스팬 안의 "용어집 §9"');
    assert.ok(!lines.includes(20), '코드블록 안의 죽은 링크와 "용어집 §8"');
  });
});

describe('links 축 — 표시명 (판정기 3·4)', () => {
  let result;
  before(() => {
    result = run();
  });

  test('(b) 대상에 없는 표시명은 display-mismatch 이고 가장 가까운 실재 항목을 낸다', () => {
    const finding = at(result, 'links.display-mismatch', 'guide.md', 5);
    assert.ok(finding, 'guide.md:5 의 "타일 레지스트리" 가 display-mismatch 로 잡혀야 한다');
    assert.equal(finding.severity, 'warn');
    assert.equal(finding.payload.display, '타일 레지스트리');
    assert.equal(finding.payload.target.file, 'glossary.md');
    assert.equal(finding.payload.closest, '타일');
  });

  test('(d) 제목·헤딩과 일치하는 표시명은 통과한다', () => {
    // 3행 [용어집](glossary.md) 대상 제목 · 9행 [아키텍처](#doc/architecture) 매니페스트 제목
    // · 11행 [표기 규칙](glossary.md#표기-규칙) 대상 헤딩 — 어느 것도 위반이 아니다.
    const lines = inFile(result, 'links.display-mismatch', 'guide.md').map((finding) => finding.locations[0].line);
    assert.deepEqual(lines, [5], 'guide.md 에서 대상에 없는 표시명은 5행 하나뿐이다');
  });

  test('(e) 같은 앵커를 7:2 로 부르면 소수파만 display-variant 다', () => {
    const variants = byCode(result, 'links.display-variant');
    assert.equal(variants.length, 1);

    const [finding] = variants;
    assert.equal(finding.severity, 'warn');
    assert.equal(finding.payload.majority, 'ACL');
    assert.equal(finding.payload.majority_count, 7);
    assert.equal(finding.payload.variant, '접근 정책');
    assert.equal(finding.payload.variant_count, 2);
    assert.deepEqual(
      finding.locations.map((location) => [location.file, location.line]),
      [
        ['naming/uses.md', 10],
        ['naming/uses.md', 11],
      ],
    );
  });

  test('표본이 1:1 인 앵커는 다수파를 말할 수 없어 variant 로 보고하지 않는다', () => {
    // guide.md 의 glossary.md 전체 링크는 "용어집" 1회 · "타일 레지스트리" 1회다.
    const targets = byCode(result, 'links.display-variant').map((finding) => finding.payload.target.file);
    assert.ok(!targets.includes('glossary.md'));
  });
});

describe('links 축 — 동결 문서', () => {
  let result;
  before(() => {
    result = run();
  });

  test('(c) 동결 문서의 옛 표시명은 위반이 아니고 다수파 집계에도 들어가지 않는다', () => {
    const frozen = result.findings.filter((finding) => finding.locations[0].file === 'decisions/accepted.md');
    assert.deepEqual(
      frozen.map((finding) => finding.code).sort(),
      ['links.dead-section', 'links.dead-target'],
      '표시명 축(display-mismatch · display-variant)은 동결 문서에 적용되지 않는다',
    );
    assert.equal(byCode(result, 'links.display-variant')[0].payload.majority_count, 7, '동결 문서의 표는 세지 않는다');
  });

  test('(c) 동결 문서는 excluded 에 사유와 함께 남는다', () => {
    const entry = result.stats.excluded.find((item) => item.path === 'decisions/accepted.md');
    assert.ok(entry, '동결 문서가 excluded 에 없다');
    assert.match(entry.reason, /frozen/);
  });

  test('동결 문서의 죽은 참조는 block 이 아니라 warn 으로 보고한다', () => {
    const deadTarget = at(result, 'links.dead-target', 'decisions/accepted.md', 7);
    const deadSection = at(result, 'links.dead-section', 'decisions/accepted.md', 9);
    assert.ok(deadTarget && deadSection);
    assert.equal(deadTarget.severity, 'warn');
    assert.equal(deadSection.severity, 'warn');
    assert.equal(deadTarget.payload.frozen, true);
  });
});

describe('links 축 — 문서 매니페스트', () => {
  test('docs.manifest 가 없으면 내부 문서 id 링크를 죽었다고 단정하지 않고 미검증으로 보고한다', () => {
    const result = run('no-manifest.config.json');
    assert.equal(byCode(result, 'links.dead-target').filter((f) => f.payload.link_type === 'manifest-id').length, 0);

    const [unverified] = byCode(result, 'links.unverified-anchor');
    assert.ok(unverified);
    assert.equal(unverified.severity, 'info');
    assert.deepEqual(unverified.payload.ids, ['doc/access-policy', 'doc/architecture', 'doc/glossary']);
    assert.match(unverified.message, /docs\.manifest 가 없어/);
  });

  test('docs.manifest 를 읽을 수 없으면 조용히 통과하지 않고 warn 으로 보고한다', () => {
    const result = run('bad-manifest.config.json');
    const [unreadable] = byCode(result, 'links.manifest-unreadable');
    assert.ok(unreadable);
    assert.equal(unreadable.severity, 'warn');
    assert.equal(unreadable.locations[0].file, 'docs/gone.json');
    assert.equal(byCode(result, 'links.unverified-anchor').length, 1);
  });
});

describe('links 축 — 절 참조가 가리키는 문서 (회귀)', () => {
  let result;
  before(() => {
    result = run('enum.config.json');
  });

  test('매니페스트 항목의 id 키는 docId 로도 적을 수 있고, id 는 마지막 마디로도 찾는다', () => {
    // 매니페스트는 { docId: "glossary" } 하나뿐인데 링크는 #doc/glossary 다.
    // 링크가 해석됐다는 증거는 §3 이 guide.md 가 아니라 glossary.md 를 상대로 판정된 것.
    const finding = at(result, 'links.dead-section', 'guide.md', 3);
    assert.ok(finding);
    assert.equal(finding.payload.target.file, 'glossary.md');
    assert.equal(byCode(result, 'links.dead-target').filter((f) => f.payload.target.raw === '#doc/glossary').length, 0);
  });

  test('"§2·§3" 의 뒤 절은 앞 절이 가리킨 문서를 그대로 가리킨다', () => {
    const finding = at(result, 'links.dead-section', 'guide.md', 3);
    assert.equal(finding.payload.section, '3');
    assert.equal(finding.payload.resolved_via, 'link');
    assert.deepEqual(finding.payload.target.available_sections, ['1', '2'], '§2 는 실재하므로 통과한다');
  });

  test('가리키는 문서를 밝히지 않은 절 참조는 자기 문서로 보되 block 이 아니라 warn 이다', () => {
    const finding = at(result, 'links.dead-section', 'guide.md', 7);
    assert.ok(finding, '"부록 §10" — 부록 은 문서 집합에 없는 이름이다');
    assert.equal(finding.severity, 'warn');
    assert.equal(finding.payload.resolved_via, 'self');
    assert.match(finding.message, /자기 문서로 봤다/);
  });

  test('숫자를 품은 코퍼스 밖 이름 뒤의 절 참조는 외부 문서 인용이라 대조하지 않는다', () => {
    assert.equal(at(result, 'links.dead-section', 'guide.md', 5), undefined, '"arc42 §10" 을 자기 문서 상대로 판정하지 않는다');

    const [external] = byCode(result, 'links.external-section');
    assert.ok(external);
    assert.equal(external.severity, 'info');
    assert.deepEqual(external.payload.names, ['arc42']);
    assert.deepEqual(
      external.locations.map((location) => [location.file, location.line]),
      [['guide.md', 5]],
    );
  });

  test('앞 링크를 해석하지 못했으면 그 뒤 절은 자기 문서가 아니라 미검증이다', () => {
    assert.equal(at(result, 'links.dead-section', 'guide.md', 9), undefined, '§4 를 guide.md 상대로 판정하지 않는다');

    const unverified = at(result, 'links.unverified-section', 'guide.md', 9);
    assert.ok(unverified);
    assert.equal(unverified.severity, 'info');
    assert.deepEqual(unverified.payload.targets, ['#doc/nowhere']);
  });
});

describe('links 축 — 자기 문서 가정의 기각', () => {
  test('자기 문서로 본 절 참조가 문서 전체에서 어긋나면 건별 경고 대신 가정 기각 하나로 접는다', () => {
    const result = run('selfref.config.json');
    assert.equal(byCode(result, 'links.dead-section').length, 0, '건별 경고를 내지 않는다');

    const [discredited] = byCode(result, 'links.discredited-self');
    assert.ok(discredited);
    assert.equal(discredited.severity, 'info');
    assert.equal(discredited.payload.self_hits, 2, '§1 참조 둘은 실재해 가정이 맞았다');
    assert.deepEqual(discredited.payload.sections, ['6', '7', '8']);
    assert.deepEqual(
      discredited.locations.map((location) => location.line),
      [7, 9, 11],
    );
  });

  test('여는 괄호가 이름과 절 사이를 끊으면 외부 인용이 아니라 자기 문서 가정이다', () => {
    // "정원은 20(§1 기준)" — 괄호 밖의 20 은 수치이지 문서명이 아니다. § 는 괄호 주석의
    // 시작이라 자기 문서 가정으로 남고, §1 이 실재해 hit 으로 잡힌다.
    const result = run('selfref.config.json');
    assert.equal(byCode(result, 'links.external-section').length, 0, '20 을 외부 문서명으로 오인하지 않는다');
  });

  test('어긋남이 소수면 가정이 유효해 건별 경고를 유지한다', () => {
    const result = run('enum.config.json');
    assert.equal(byCode(result, 'links.discredited-self').length, 0);
    const selfMisses = byCode(result, 'links.dead-section').filter((f) => f.payload.resolved_via === 'self');
    assert.equal(selfMisses.length, 1, '"부록 §10" 은 건별 warn 으로 남는다');
    assert.equal(selfMisses[0].severity, 'warn');
  });
});

describe('links 축 — 표 용어 색인', () => {
  test('셀 전체가 굵은 글씨면 첫 열이 아니라도 표시명 후보다', () => {
    const result = run('terms.config.json');
    const lines = inFile(result, 'links.display-mismatch', 'guide.md').map((finding) => finding.locations[0].line);
    assert.deepEqual(lines, [5], '굵은 둘째 열의 "블록"(3행)은 실재 항목이고, 굵지 않은 "슬롯"(5행)만 mismatch 다');
  });
});

describe('links 축 — 크래시 계약', () => {
  test('config 가 없으면 exit != 0 이고 로그는 stderr 로 간다', () => {
    assert.throws(
      () => execFileSync(process.execPath, [CHECK, '--config', fixture('links', 'nope.json')], { stdio: 'pipe' }),
      (error) => {
        assert.notEqual(error.status, 0);
        assert.equal(error.stdout.toString(), '');
        assert.match(error.stderr.toString(), /\[links\]/);
        return true;
      },
    );
  });
});
