# Bluebird 데모 코퍼스

이 킷이 무엇을 잡는지 보려고 만든 **가상 문서 집합**이다. Bluebird 는 실재하지 않는 회의실
예약 포털이고, 여기 적힌 수·패키지·결정은 모두 지어낸 것이다.

문서 집합에는 축마다 결함이 **일부러** 심어져 있다. 검사를 돌리면 게이트가 막히는 것이
정상이다 — 통과하면 오히려 킷이 고장 난 것이다.

## 돌려 보기

```bash
node core/scan.mjs --config examples/bluebird-docs/dck.config.json --run-id demo
```

`--repo` 를 주지 않으면 config 가 있는 디렉토리가 레포 루트가 된다. 이 데모는 문서·데이터·
측정 스크립트·스키마를 모두 자기 디렉토리 안에 갖고 있어 다른 준비물이 필요 없다.

## 구성

| 자리 | 내용 |
| --- | --- |
| `docs/` | 설계 문서 일곱 편 + 결정 본문(`decisions/accepted.md`, 동결) |
| `docs/index.json` | 문서 매니페스트. 문서 간 링크는 `#design/<id>` 로 여기를 가리킨다 |
| `docs/decisions.json` | 결정 카드 목록. 본문의 요약 메타만 갖는다 |
| `docs/issues/` | `docs.exclude` 에 걸려 검사하지 않는 자리 |
| `data/` | 측정 대상 데이터 — 타일 48 건, 배포단위 6 건 |
| `tools/` | 그 데이터를 세는 스크립트. `measurements` 가 실제로 실행한다 |
| `schema/` | 타일 산출물 스키마. 개념 축이 필드명의 정본으로 읽는다 |

## 심어 둔 결함

| 축 | 코드 | 자리 | 무엇이 어긋났나 |
| --- | --- | --- | --- |
| 수치 | `numbers.table-sum` | `scope-table.md` §2.1 | 부분 합 26+14+8=48 인데 합계 행이 46 |
| 수치 | `numbers.data-mismatch` | `scope-table.md` §2 | 문서는 등록 타일 46 개, `tiles.json` 실측은 48 |
| 소유 | `ownership.drifted-copy` | `phase-notes.md` §2 | 1차 전환 수를 정본 밖에서 31 로 다시 적었다 (정본 26) |
| 개념 | `concepts.ghost-field` | `field-spec.md` §2 | 스키마에 없는 `usedBy` 를 필드처럼 적었다 |
| 링크 | `links.dead-target` | `phase-notes.md` §2 | 없는 앵커 `wiring-spec.md#슬롯-주입-규칙` |
| 링크 | `links.dead-section` | `phase-notes.md` §4 | 검증 전략에 없는 §9 를 가리킨다 |
| 결정 | `decisions.citation-missing` | `phase-notes.md` | ADR-003 이 지목했는데 그 번호를 인용하지 않는다 |
| 결정 | `decisions.card-missing` | `docs/decisions.json` | 본문에 있는 ADR-004 가 카드 목록에 없다 |

## 판단 축이 넘기는 후보

스크립트가 혼자 정하지 못하는 것은 결함이 아니라 **후보**로 나가 판정 계약이 받는다.
이 데모에서는 다음이 나온다.

- 개념 — `booking-cores` 가 한 번, `booking-core` 가 세 번. 오타인지 다른 것인지는 판정이 정한다.
- 소유 — 용어집이 소유한 "슬롯" 의 뜻을 조립 계약이 링크 없이 다시 적었다.
- 결정 — 채택된 결정이 문서에 실제로 반영됐는지(반영 여부는 글을 읽어야 안다).

`docs/issues/parking-lot.md` 에도 어긋난 수가 있지만 `docs.exclude` 에 걸려 보고되지 않는다 —
검사 범위를 좁히는 설정이 실제로 작동하는지 보여 주는 자리다.
