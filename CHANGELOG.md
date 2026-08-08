# Changelog

이 프로젝트의 주목할 만한 변경을 기록한다.

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/) 를,
버저닝은 [Semantic Versioning](https://semver.org/lang/ko/) 을 따른다.

## [Unreleased]

## [1.2.0] - 2026-08-08

### Added

- Codex CLI 지원 — 스킬이 오픈 에이전트 스킬 표준([agentskills.io](https://agentskills.io)) 탐색 경로 `.agents/skills/` 로도 노출되고(심링크), README 에 Codex 설치·실행 절이 붙는다
- `dck-coherence` 오케스트레이션 스킬 — `/coherence` 커맨드가 소유하던 순서·게이트·보고 절차가 스킬로 승격돼 에이전트와 무관하게 재사용된다

### Changed

- `/coherence` 커맨드는 `dck-coherence` 스킬로 위임하는 얇은 진입점이 된다
- dck-judge 판정자 격리 규율의 환경 중립화 — 격리 요건은 그대로 두고, 수단을 환경이 가진 것으로 매핑한다(병렬 서브에이전트 또는 `codex exec` 헤드리스 자식 실행)

## [1.1.0] - 2026-08-08

### Added

- `schemas_complete` config 키 — `schemas[]` 가 필드 전집이라는 닫힌 세계 선언. `true` 일 때만 links 축과 별개로 concepts 축이 스키마 밖 필드명을 결정적으로 차단한다
- links 축 외부 문서 인용 인식 — 숫자를 품은 코퍼스 밖 이름 뒤의 `§N` 참조(예: `arc42 §10`)는 자기 문서 가정 대신 외부 인용으로 분류하고 `links.external-section` info 로 보고한다
- links 축 자기 문서 가정의 기각(`links.discredited-self`) — 문서를 밝히지 않은 `§N` 참조의 어긋남이 3건 이상이고 맞은 것보다 많으면, 건별 경고 대신 가정 자체가 성립하지 않는다는 info 하나로 접는다
- links 축 표 용어 색인 확장 — 첫 칸이 아니어도 셀 전체가 굵은 글씨(`**용어**`)인 셀을 용어 선언으로 색인한다

### Changed

- concepts 축 스키마 밖 필드명(`concepts.ghost-field`)의 기본 동작 — `schemas_complete` 미선언(열린 세계)이면 확정 차단 대신 판정 계약이 실재를 확인하는 `ghost-field` 후보로 강등된다. 기존의 결정적 차단을 유지하려면 config 에 `"schemas_complete": true` 를 선언한다

## [1.0.0] - 2026-08-08

첫 공개 배포.

### Added

- Claude 플러그인 매니페스트 (`.claude-plugin/plugin.json`) 와 마켓플레이스 매니페스트 (`.claude-plugin/marketplace.json`)
- 형식 정본 스키마 3종 (JSON Schema draft 2020-12) — `schemas/config.schema.json` · `schemas/manifest.schema.json` · `schemas/findings.schema.json`
- 런타임 의존성 없는 코어 라이브러리 5종 (`core/lib/`)
  - `config.mjs` — `dck.config.json` 로드·검증·기본값, 축 스크립트 공통 인자 파싱
  - `manifest.mjs` — 축 매니페스트 로드·병합(이름 전역 유일)·`when.requires` 대조 활성 판정
  - `markdown.mjs` — 줄 번호를 보존하는 헤딩·표·링크·코드스팬·앵커 파서
  - `findings.mjs` — findings 봉투 생성·검증, 중복 접기, 스캔 결과 봉투
  - `corpus.mjs` — include/exclude/frozen 글롭 기반 검사 대상 수집과 제외 사유 기록
- 코어 4축 등록 (`core/manifest.json`) — `numbers` · `ownership` · `concepts` · `links`
- `adr` 플러그인 축 (`plugins/adr/`) — 결정 기록의 인용 추적과 카드 대조
- 3층 오케스트레이션 — `commands/coherence.md` (순서·게이트) + `skills/dck-{scan,judge,merge}/SKILL.md`
- `dck-scan` · `dck-merge` 스킬 엔트리 (`core/scan.mjs` · `core/merge.mjs`) — 결정적 축 실행·게이트, 전수 대조·중복 접기·리포트
- 축 선택 인자 `--axes` — 선택 밖 축은 목록에서 사라지지 않고 사유와 함께 skipped 로 남는다
- 자기완결 데모 코퍼스 (`examples/bluebird-docs/`) — 축마다 심어 둔 결함 8건으로 게이트 동작을 재현한다
- 자기완결 SVG 로고 (`assets/`) — 외부 폰트·이미지 참조 없이 라이트/다크에 대응한다
- 합성 픽스처 기반 `node:test` 스위트 (`tests/`)

[Unreleased]: https://github.com/Seungwoo321/docs-coherence-kit/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/Seungwoo321/docs-coherence-kit/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Seungwoo321/docs-coherence-kit/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Seungwoo321/docs-coherence-kit/releases/tag/v1.0.0
