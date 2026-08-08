# 결정 반영 (decisions)

채택된 결정이 본문에 실제로 내려앉았는가를 판정한다. 번호 인용·카드 정합·대체 체인 같은 결정적
부분은 `check.mjs` 가 이미 끝냈다. 여기서 확정하는 것은 기계가 셀 수 없는 세 가지다 —
**반영 여부**, **소유 경계 역전**, **대체된 결정을 아직 따르는가**.

## 입력

| 무엇 | 어디 |
|------|------|
| 선언 | `dck.config.json` — `docs.root` 기준으로 아래 경로를 읽는다. `ownership` 이 소유 표다. |
| 후보 | 오케스트레이터가 넘긴 스캔 결과의 `candidates` |
| 결정 본문 | 후보의 `decision_heading.file` + `decision_range` |
| 대상 문서 | 후보의 `targets[].file` + `line_range` |

후보는 두 종류다.

**`kind: "reflection"`** — accepted 결정 하나와 그 결정이 지목한 자리들.

```json
{"kind":"reflection","decision_id":"ADR-001","decision_summary":"…","decision_status":"accepted",
 "decision_heading":{"file":"decisions/accepted.md","line":5},"decision_range":[9,9],
 "decision_text":"- **결정** …","designated_by":"decision",
 "targets":[{"file":"field-spec.md","section":"4.2","heading_line":5,"line_range":[5,9],
             "cites_decision":false,"ownership_declared":[{"what":"게이트 축·임계","owner":"…"}]}]}
```

- `designated_by` 가 `"decision"` 이면 지목이 결정 절에서 나왔고, `"body"` 면 결정 절을 못 찾아
  결정 전체에서 링크를 모은 것이다 — 후자는 지목이 아닐 수 있으니 반영 판정 전에 그것부터 본다.
- `heading_line` 이 `null` 인 대상은 그 절이 지금 문서에 없다는 뜻이다. 결정 본문은 동결이라
  절 번호를 고칠 수 없으므로 이것 자체는 결함이 아니다 — 문서 전체에서 그 내용을 찾는다.
- `cites_decision` 은 번호 인용 여부다. 이미 `decisions.citation-missing` 으로 보고됐으니
  여기서 다시 내지 않는다.
- `targets` 는 **이번 실행이 검사한 자리만** 담는다. 지목했으나 검사 대상 밖인 자리는 스크립트가
  `decisions.target-out-of-scope` 로 이미 보고했으니 여기서 다시 내지 않는다. `targets` 가 비어
  있어도 그 결정이 정상이라는 뜻은 아니다 — 후보에 없는 자리를 두고 반영 여부를 판정하지 않는다.

**`kind: "stale_supersede"`** — 대체된 결정을 인용하는 줄 하나.

```json
{"kind":"stale_supersede","decision_id":"ADR-003","superseded_by":"ADR-004","chain":["ADR-003","ADR-004"],
 "target":{"file":"field-spec.md","line":12,"current_text":"…"}}
```

## 판정 기준

### (b) 결정 ↔ 본문 반영 — `unreflected` · `contradicted`

결정문을 읽고 지목된 절을 읽어 **그 결정이 실제로 서술돼 있는가**를 판정한다.

- 문장이 같을 필요는 없다. 결정이 정한 규칙·값·경계가 그 절의 서술로 성립하면 반영된 것이다.
- 절에 그 규칙이 없으면 `unreflected`. 절이 결정과 **다른 규칙**을 말하고 있으면 `contradicted` —
  이쪽이 더 무겁다. 읽는 사람이 틀린 규칙을 따르게 된다.
- 결정이 그 절 말고 **다른 문서에** 반영돼 있으면 그 사실을 `payload.reflected_in` 에 적는다.
  "어디에도 없다"와 "엉뚱한 곳에 있다"는 고치는 방법이 다르다.
- 판정 근거는 항상 대상 문서의 실제 줄을 인용해 남긴다.

### (c) 소유 경계 역전 — `ownership_inverted`

(b) 의 특수 케이스인데 심각도가 가장 높다. 다음 둘이 겹치면 역전이다.

1. 대상 문서가 그 규칙의 **단일 소유처**다 — `ownership_declared` 에 선언돼 있거나, 문서가 스스로
   "이 규칙의 단일 소유처" 라고 서술한다.
2. 그 규칙이 그 문서에는 없고 **다른 문서에만** 서술돼 있다.

그 문서만 읽는 사람은 규칙의 존재 자체를 모른 채 "전 항목 통과" 로 읽는다. 이것이 이 축이 잡는
결함 중 가장 비싼 것이라 `unreflected` 로 접지 말고 `ownership_inverted` 로 따로 낸다.

### (d) stale supersede 확정

`stale_supersede` 후보의 줄을 읽고, 그 줄이 **대체된 결정을 여전히 따르는지** 판정한다.

- 옛 결정의 내용을 현재 규칙처럼 서술하면 `stale_supersede` 로 확정한다.
- 대체 이력을 기록하거나("ADR-003 은 ADR-004 가 대체했다") 대체 후 규칙을 서술하면서 옛 번호를
  참조만 하는 것은 정상이다 — 결함이 아니다.
- 판정에는 `chain` 의 마지막 결정(현재 유효한 결정)의 본문을 함께 읽는다.

### (e) 동결 규율

채택된 결정 본문(`docs.frozen` 에 선언된 파일)은 소급 편집 금지다. 그 파일의 드리프트 — 옛 링크
표시명, 지금은 없는 절 번호, 낡은 용어 — 는 **결함이 아니라 설계상 허용**이다. 결함은 언제나
결정을 반영해야 할 **대상 문서** 쪽에 있다. 동결 파일을 `locations[0]` 으로 하는 finding 을 내지
않는다. 코어 links 축의 frozen 처리와 같은 규율이다.

## 반드시 지킬 것

1. **탐색 범위 규율** — 후보가 준 파일만 읽는다. 반영처를 찾느라 문서 집합을 통째로 훑지 않고,
   `line_range` 가 있으면 그 범위부터 읽는다. 범위 밖을 읽어야 했다면 그 사유를 판정에 적는다.
2. **집합 성격 주입** — 판정 전에 `dck.config.json` 의 `docs`·`ownership` 을 읽어 이 문서 집합이
   무엇을 어디서 소유하는지부터 파악한다. 일반적인 마크다운 상식이 아니라 이 집합의 규율로 판정한다.
3. **기계 생성 파일 금독** — `out` 디렉토리(`.dck/` 기본) 아래 산출물, 이전 실행의 verdict·report 를
   읽지 않는다. 앞선 판정을 근거로 삼으면 틀린 판정이 스스로를 확증한다.
4. **verdict 파일 하나만 쓰기** — 오케스트레이터가 지정한 verdict 경로 하나에만 쓴다. 문서 집합의
   파일을 고치지 않는다. 이 축은 판정만 하고 수정은 사람이 한다.

## 출력

지정된 verdict 경로에 findings 봉투 배열을 쓴다. 확정할 결함이 없으면 빈 배열이다.

```json
[{"axis":"decisions","severity":"block","code":"decisions.unreflected",
  "message":"ADR-001 이 정한 타일 등록 규칙이 게이트 정책 §6 에 없다",
  "locations":[{"file":"gate-policy.md","line":5,"quote":"전 항목이 통과하면 PASS 다."},
               {"file":"decisions/accepted.md","line":5,"quote":"ADR-001 타일 등록은 …"}],
  "payload":{"decision_id":"ADR-001","decision_summary":"…",
             "target":{"file":"gate-policy.md","section":"6","current_text":"…"},
             "kind":"unreflected","reflected_in":["field-spec.md"]}}]
```

- `code` ↔ `payload.kind`: `decisions.unreflected` ↔ `unreflected` · `decisions.contradicted` ↔
  `contradicted` · `decisions.ownership-inverted` ↔ `ownership_inverted` ·
  `decisions.stale-supersede` ↔ `stale_supersede`.
- `severity`: `ownership_inverted`·`contradicted` = `block`, `unreflected`·`stale_supersede` = `block`,
  판정이 갈리는 경계 사례만 `warn` 으로 낮추고 사유를 `message` 에 적는다.
- `locations[0]` 은 항상 고쳐야 할 대상 문서다(동결 파일이 아니다). `locations[1]` 로 근거가 된
  결정 본문 자리를 함께 싣는다.
- 후보 하나에 결함이 없으면 아무것도 쓰지 않는다. "검토했으나 정상" 을 finding 으로 내지 않는다.
