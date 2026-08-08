# Changelog

이 프로젝트의 주목할 만한 변경을 기록한다.

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/) 를,
버저닝은 [Semantic Versioning](https://semver.org/lang/ko/) 을 따른다.

## [Unreleased]

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

[Unreleased]: https://github.com/Seungwoo321/docs-coherence-kit/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Seungwoo321/docs-coherence-kit/releases/tag/v1.0.0
