<p align="center">
  <img src="assets/logo-wordmark.svg" alt="docs coherence kit" width="420">
</p>

<p align="center">
  문서 집합이 스스로와 어긋나지 않는지 검사하는 에이전트 킷 — Claude Code 플러그인이자 오픈 표준(SKILL.md) 스킬 세트.
</p>

---

한 문서의 표가 합계와 안 맞거나, 두 문서가 같은 수를 다르게 적거나, 정본이 정해진 사실을 다른 문서가 몰래 다시 쓰거나, 링크가 사라진 앵커를 가리키는 것 — 사람이 리뷰로 잡기엔 지루하고 놓치기 쉬운 어긋남을 기계가 먼저 잡는다.

규율은 하나다. **검사하지 않은 것은 통과가 아니다.** 설정이 없어 못 돈 축, 범위에서 빠진 파일, 크래시한 축은 전부 사유와 함께 결과에 남는다.

## 무엇을 검사하나

코어 4축은 어떤 문서 집합에나 해당한다.

| 축 | 종류 | 잡는 것 | 대표 코드 |
|----|------|---------|-----------|
| `numbers` | script | 표 산술 불일치, 문서 간 수치 불일치, 실측과의 차이 | `numbers.table-sum` · `numbers.cross-doc` · `numbers.data-mismatch` |
| `ownership` | hybrid | 정본이 정해진 사실을 다른 문서가 재서술해 갈라진 것 | `ownership.drifted-copy` · `ownership.owner-missing` |
| `concepts` | hybrid | 표기 분열, 어디에도 정의가 없는 유령 식별자 | `concepts.ghost-field` |
| `links` | script | 죽은 링크·절 번호, 표시명과 대상 불일치 | `links.dead-target` · `links.dead-section` · `links.display-mismatch` |

집합 고유의 규율은 플러그인 축으로 붙인다. 함께 담긴 `adr` 플러그인의 `decisions` 축은 결정 기록을 본다 — 결정이 지목한 문서가 그 번호를 인용하는지, 본문과 카드 목록이 맞는지, 대체 관계에 끊김·순환이 없는지.

축은 세 종류다.

- **script** — 정규식·파싱·산술로 끝난다. 재현 가능하고 토큰을 쓰지 않는다.
- **judgment** — 사람 언어의 의미를 읽어야 판정된다. 계약 문서(`contract.md`)를 읽은 격리 판정자가 맡는다.
- **hybrid** — 스크립트가 후보를 좁히고, 계약이 그 후보만 확정한다.

## 3단계로 나눠 도는 이유

```
dck-coherence  (오케스트레이션 — 순서와 게이트만 소유. Claude 는 /coherence, Codex 는 $dck-coherence 로 진입)
   ├─ 1. dck-scan   결정적 축 실행                  → scan.json
   ├─ 2. dck-judge  계약 축 격리 팬아웃              → verdicts/<축>.json
   └─ 3. dck-merge  전수 대조·중복 접기·통과 판정    → report.json · report.md
```

역할을 나누는 이유는 셋 다 다르다.

결정적 판정을 먼저 끝내 **게이트**를 세운다. 스캔에서 차단급이 나오면 거기서 멈추고 판단 단계를 부르지 않는다 — 이미 결정적으로 틀린 것이 있는데 의미 판정에 토큰을 쓰지 않는다.

의미 판정은 **계약이 소유**한다. 판정 기준이 프롬프트가 아니라 문서로 남아야 다음 실행에서도 같은 기준이 적용된다.

통과 판정은 **만들지 않은 쪽**이 한다. 병합기는 문서를 읽지 않고 축의 기준을 다시 적용하지도 않는다. 생산자가 자기 산출을 채점하면 같은 맹점이 검증을 그대로 통과한다.

## 설치

```
/plugin marketplace add Seungwoo321/docs-coherence-kit
/plugin install docs-coherence-kit@dck
```

마켓플레이스 이름은 `dck`, 플러그인 이름은 `docs-coherence-kit` 이다. 설치하면 `/coherence` 커맨드와 `dck-coherence` · `dck-scan` · `dck-judge` · `dck-merge` 스킬이 함께 들어온다.

Node.js 20 이상이면 되고, 런타임 의존성은 없다. 설치 후 별도 빌드나 `install` 단계가 없다.

### Codex CLI 에서

스킬 4종은 [오픈 에이전트 스킬 표준](https://agentskills.io)(SKILL.md) 형식이라 Codex 에서도 그대로 돈다. 킷을 받아 Codex 의 스킬 탐색 경로에 링크한다.

```bash
git clone https://github.com/Seungwoo321/docs-coherence-kit.git ~/docs-coherence-kit
mkdir -p ~/.agents/skills
ln -s ~/docs-coherence-kit/skills/dck-* ~/.agents/skills/
```

유저 전역(`~/.agents/skills`) 대신 검사할 레포의 `.agents/skills/` 에 걸면 그 레포에서만 보인다. 실행은 `$dck-coherence` 를 부르거나 "문서 정합성 검사해줘" 로 충분하다 — 오케스트레이션·게이트·격리 실행 규율은 스킬 문서가 소유하므로 에이전트가 달라도 절차는 같다. 판정 축의 격리 수단만 환경에 따라 갈린다(Claude Code = 병렬 서브에이전트, Codex = `codex exec` 자식 실행 — `skills/dck-judge/SKILL.md`).

## 데모 — 심어 둔 결함 8건 잡기

`examples/bluebird-docs/` 는 이 킷이 무엇을 잡는지 보려고 만든 가상 문서 집합이다. Bluebird 는 실재하지 않는 회의실 예약 포털이고, 문서·데이터·측정 스크립트·스키마를 자기 디렉토리 안에 모두 갖고 있어 다른 준비물이 필요 없다. 축마다 결함이 일부러 심어져 있다.

레포를 받아 그대로 돌린다.

```bash
git clone https://github.com/Seungwoo321/docs-coherence-kit.git
cd docs-coherence-kit
node core/scan.mjs --config examples/bluebird-docs/dck.config.json --run-id demo
```

종료 코드는 **1**, 차단급 지적 **8건**이 나온다. 게이트가 막히는 것이 정상이다 — 통과하면 오히려 킷이 고장 난 것이다.

| 축 | 코드 | 어긋난 것 |
|----|------|-----------|
| `numbers` | `numbers.table-sum` | 부분 합 26+14+8=48 인데 합계 행이 46 |
| `numbers` | `numbers.data-mismatch` | 문서는 등록 타일 46, `tiles.json` 실측은 48 |
| `ownership` | `ownership.drifted-copy` | 1차 전환 수를 정본 밖에서 31 로 다시 적었다 (정본 26) |
| `concepts` | `concepts.ghost-field` | 스키마에 없는 `usedBy` 를 필드처럼 적었다 |
| `links` | `links.dead-target` | 없는 앵커 `wiring-spec.md#슬롯-주입-규칙` |
| `links` | `links.dead-section` | 검증 전략에 없는 §9 를 가리킨다 |
| `decisions` | `decisions.citation-missing` | ADR-003 이 지목한 문서가 그 번호를 인용하지 않는다 |
| `decisions` | `decisions.card-missing` | 본문에 있는 ADR-004 가 카드 목록에 없다 |

스크립트가 혼자 정하지 못한 것은 결함이 아니라 **후보**로 남아 판정 계약이 받는다. 이 데모에서는 `ownership` 1건 · `concepts` 6건 · `decisions` 3건이 대기 목록에 오른다.

여기서 병합기를 바로 부르면 커버리지 게이트가 무엇을 하는지 보인다.

```bash
node core/merge.mjs --config examples/bluebird-docs/dck.config.json --run-id demo
```

차단이 8건이 아니라 **11건**이다. 판단 단계를 건너뛰어 verdict 파일이 없는 축 셋에 `coverage.missing` 이 하나씩 주입됐다. 판정이 없는 축은 조용히 사라지지 않고 차단으로 남는다.

산출은 `examples/bluebird-docs/.dck/demo/` 아래에 쌓인다.

## 내 문서 집합에 붙이기

검사할 레포 루트에 `dck.config.json` 을 둔다. 코드를 고칠 일은 없다 — 새 문서 집합은 선언만으로 붙는다.

```json
{
  "docs": { "root": "docs", "exclude": ["issues/**"], "frozen": ["decisions/accepted.md"] },
  "ownership": [
    { "what": "현행 실측 수치", "owner": "scope-table.md" }
  ],
  "measurements": [
    { "label": "등록 타일", "cmd": "node tools/count-tiles.mjs", "expect_in": ["scope-table.md"] }
  ],
  "concepts": ["타일", "배포단위"],
  "plugins": ["adr"],
  "adr": { "bodies": "decisions/accepted.md", "cards": "decisions.json" }
}
```

| 키 | 뜻 |
|----|-----|
| `docs.root` | 검사 대상 루트 (필수) |
| `docs.manifest` | 문서 매니페스트 파일. 링크 축이 내부 문서 id 집합을 여기서 얻는다 |
| `docs.include` / `docs.exclude` | 검사 범위 글롭 (기본 `**/*.md`) |
| `docs.frozen` | 소급 편집이 금지된 문서. 드리프트 검사에서 빠지되 링크 대상으로는 계속 해석된다 |
| `out` | 산출 디렉토리 (기본 `.dck`) |
| `ownership` | 무엇의 정본이 어느 문서인가 — `what` · `owner` · `hint` |
| `numbers` | 산문 수치 마커 정규식, 교차 대조할 라벨, 합계 행으로 볼 라벨 |
| `measurements` | 문서 수치를 실측 명령에 묶는다. stdout 마지막 줄이 실측값 |
| `concepts` | 표기가 갈리면 안 되는 개념 |
| `schemas` | 개념 축이 필드명의 정본으로 읽는 스키마 파일 |
| `schemas_complete` | `schemas` 가 문서가 언급하는 필드의 전집이라는 선언(닫힌 세계). `true` 면 스키마 밖 필드명을 결정적으로 차단하고, 없으면(기본) 판정 단계가 실재를 확인할 후보로 넘긴다 |
| `plugins` | 붙일 플러그인 이름 |

플러그인은 자기 이름의 최상위 키를 소유한다 (`adr` 플러그인 → `"adr": {...}`). 축의 `when.requires` 가 그 키를 가리키고, **키가 없으면 축은 사유와 함께 skipped 로 보고된다.** 형식 정본은 [`schemas/config.schema.json`](schemas/config.schema.json).

## 실행

```
/coherence                          # 전체 검사 (Claude Code)
/coherence --axes numbers,links     # 축 선택
/coherence --waive links.display-variant

$dck-coherence                      # Codex CLI — 같은 인자를 그대로 붙인다
```

`--axes` 로 고른 축 밖의 축은 목록에서 사라지지 않고 사유와 함께 skipped 로 남는다. `--waive` 는 명시적 강등이고 리포트에 적용 건수가 찍힌다 — `coverage.*` 강등은 거부된다.

축 스크립트는 단독으로도 돈다.

```bash
node core/axes/numbers/check.mjs --config dck.config.json [--repo <루트>]
```

stdout 으로 결과 JSON 한 덩어리, 로그는 stderr 로 나간다. `--repo` 를 주지 않으면 config 가 있는 디렉토리가 레포 루트가 된다.

종료 코드는 "정상 완주" 여부이지 "문제 없음" 이 아니다.

| 코드 | scan | merge |
|------|------|-------|
| 0 | 결정적 축 전부 완주, 차단급 없음 | pass — 차단급 없음 |
| 1 | 차단급이 있거나 축이 깨졌다 → 게이트 정지 | fail — 차단급이 하나라도 있음 |
| 2 | 스캐너 자체가 못 돌았다 (설정 오류 등) | 병합기 자체가 못 돌았다 |

1 과 2 를 섞지 않는 이유: config 오타가 "게이트 차단" 으로 읽히면 문서에 없는 결함을 고치러 간다.

산출은 실행 단위로 쌓인다. `run-id` 는 오케스트레이터가 준다(head sha 또는 timestamp) — 스크립트가 스스로 짓지 않는다. 같은 커밋의 두 실행이 다른 이름으로 흩어지면 대조가 안 되기 때문이다.

```
<out>/<run-id>/scan.json            # 스크립트 축 집계
<out>/<run-id>/verdicts/<axis>.json # 계약 축 판정
<out>/<run-id>/report.json + .md    # 병합 결과
```

## 결과 형식

모든 축이 같은 봉투로 낸다.

```json
{ "axis": "numbers", "severity": "block", "code": "numbers.table-sum",
  "message": "표 산술 불일치 — \"타일 수\" 열의 부분 합은 48 인데 합계 행은 46 이다",
  "locations": [{ "file": "docs/scope-table.md", "line": 23, "quote": "| 합계 | 46 |" }],
  "payload": {} }
```

- `code` 는 `<축>.<kebab>` — 어느 축이 낸 지적인지 코드만 봐도 안다.
- 같은 `(code, 첫 위치의 파일, 줄)` 은 한 건으로 접히고, 어느 축들이 같이 잡았는지 `found_by` 에 남는다. 결정 축과 판단 축이 같은 줄을 독립적으로 잡았다면 그것은 중복이 아니라 확신도 신호다.
- `severity` 는 매니페스트의 `severity_cap` 을 넘지 못한다. 축이 자기 심각도를 올려 부를 수 없다.
- 축이 붙인 `_demoted` · `waived` · `found_by` 같은 자기 신고 키는 병합기가 떼어내고, 뗀 건수를 리포트에 적는다.

형식 정본은 [`schemas/findings.schema.json`](schemas/findings.schema.json).

## 조용한 통과를 막는 장치

| 상황 | 리포트에 남는 것 |
|------|------------------|
| 설정 키가 없어 축이 안 돔 | `skipped` + 어느 키가 없는지 |
| 파일이 범위에서 빠짐 | `excluded[]` + 어느 글롭에 걸렸는지 |
| 축이 크래시하거나 결과가 없음 | `coverage.missing` (block) |
| verdict 가 형식 위반 / 축 이름 불일치 | `coverage.invalid-verdict` (block) — 그 축의 판정은 통째로 버린다 |
| 등록되지 않은 축의 verdict 파일이 있음 | `coverage.unexpected-verdict` — 내용을 반영하지 않는다 |

기대 축 목록은 스캔 결과가 아니라 **config 와 매니페스트에서 다시 읽는다.** 스캔 결과를 기준으로 삼으면 "스캔에 아예 안 뜬 축" 이 애초에 기대되지 않아, 축이 통째로 빠진 것을 영원히 못 잡는다.

`coverage.*` 는 접히지 않는다. "이 축은 판정 자체가 없었다" 는 축마다 별개 사실이라 한 건으로 뭉치면 몇 개 축이 빠졌는지 사라진다.

skipped 는 fail 이 아니지만 pass 도 아니다. 축 표에 그대로 보인다.

## 축을 직접 추가하기

`plugins/<이름>/manifest.json` 에 축을 등록하고, config 에 `"plugins": ["<이름>"]` 을 더한다. 코어를 고치지 않는다.

```json
{
  "axes": [{
    "name": "decisions",
    "title": "결정 반영",
    "kind": "hybrid",
    "run": { "script": "axes/decisions/check.mjs", "contract": "axes/decisions/contract.md" },
    "when": { "requires": ["adr"] },
    "severity_cap": "block"
  }]
}
```

- `name` 은 전역 유일하고 findings code 의 네임스페이스가 된다. 이름이 겹치면 로드 시점에 막힌다.
- `run` 의 경로는 매니페스트 파일 기준 상대 경로다. `kind` 에 따라 `script` · `contract` 필수 항목이 갈린다.
- `when.requires` 에 적은 config 최상위 키가 없으면 축은 사유와 함께 skipped 로 보고된다.

축 스크립트는 `--config` · `--repo` 를 받아 stdout 으로 스캔 봉투 JSON 을 쓰고, 정상 완주면 0 을 반환한다. `core/lib/` 의 config · corpus · markdown · findings 를 그대로 쓰면 검사 범위·제외 사유·줄 번호 처리가 코어와 같아진다. 형식 정본은 [`schemas/manifest.schema.json`](schemas/manifest.schema.json).

계약(`contract.md`)은 판정 기준을 사람 언어로 적은 문서다. 무엇이 위반이고 무엇이 정상인지, 어떤 입력을 보는지를 여기에 적는다 — 판정자는 이 문서만 읽고 판정한다.

## 레포 구조

```
.claude-plugin/              # 플러그인 · 마켓플레이스 매니페스트 (Claude Code)
.agents/skills/              # 스킬 심링크 — Codex 등 오픈 표준 탐색 경로
commands/coherence.md        # /coherence 진입점 (dck-coherence 스킬로 위임)
skills/dck-{coherence,scan,judge,merge}/SKILL.md
core/manifest.json           # 코어 축 등록
core/lib/*.mjs               # config · manifest · markdown · findings · corpus
core/axes/<축>/              # check.mjs · contract.md
core/{scan,merge}.mjs        # dck-scan · dck-merge 엔트리
plugins/<이름>/              # manifest.json · axes/
schemas/*.schema.json        # config · manifest · findings 형식 정본
examples/bluebird-docs/      # 자기완결 데모 코퍼스
assets/                      # 로고
tests/                       # node:test + 합성 픽스처
```

## 개발

```bash
pnpm test
```

**런타임 의존성 0** 이 제약이다. 플러그인 디렉토리로 배포되므로 소비자 머신에 `node_modules` 를 전제할 수 없다. 새 축을 만들 때도 이 제약은 그대로다.

`core/lib/markdown.mjs` 는 범용 CommonMark 파서가 아니다. 줄 번호를 보존한 채 펜스·헤딩·표·링크·코드스팬·앵커만 본다 — 지적에 줄 번호를 달아야 하고, 코드 블록 안의 것을 문서 내용으로 오인하면 안 되기 때문이다.

## 라이선스

[MIT](LICENSE)
