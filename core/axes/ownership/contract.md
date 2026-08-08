# 소유 중복

소유 문서 밖에서 같은 사실이 **재서술**된 곳을 확정한다. 인용(링크)은 정상이고 재서술이 위반이다.

스크립트(`check.mjs`)가 이미 확정한 것은 하나다 — 소유 문서와 **다른 값**이 적힌 곳(`ownership.drifted-copy`). 남은 후보는 값이 같거나 일부만 겹쳐서 "복제인지 정당한 언급인지"를 문맥 없이 가를 수 없는 것들이고, 그 판정이 이 계약의 일이다.

## 입력

| 이름 | 내용 |
|------|------|
| 후보 파일 | `check.mjs` 가 낸 `candidates[]`. 오케스트레이터가 경로를 준다. |
| config | `dck.config.json` 의 `ownership[]` — `{what, owner, hint}`. `what` 이 소유 대상의 이름, `owner` 가 소유 문서, `hint` 가 범위를 좁히는 자유 서술. |

후보 하나의 형태:

| 필드 | 내용 |
|------|------|
| `owner_doc` · `what` · `hint` | 이 항목을 누가 소유하는가 (config 그대로) |
| `item` | 소유 문서에서 뽑은 항목 — `name` · `value` · `kind`(`table-row`/`definition`) · `line` · `quote` |
| `duplicate_locations[]` | 링크 없이 값을 다시 적은 줄. `value_match` 가 `same`(값·문장 전부 일치) 또는 `partial`(일부만 일치), `partial` 이면 `coverage` 와 `missing_tokens[]` 가 붙는다 |
| `already_drifted_locations[]` | 같은 항목에서 스크립트가 이미 위반으로 확정한 줄. 판정 대상이 아니라 문맥이다 |

## 판정 기준

후보마다 순서대로 답한다.

**1. 이 줄이 값을 다시 적었는가, 값의 형태만 언급했는가.**
소유 문서를 안 보고도 이 줄만으로 그 사실을 알 수 있으면 재서술이다. 값이 예시·형식 설명·질문·부정문의 일부로 등장하면(`"커버리지 64% 같은 수치는 여기 적지 않는다"`) 재서술이 아니다 — 위반이 아니므로 아무것도 내지 않는다.

**2. 재서술이면, 소유자가 config 가 말한 그 문서가 맞는가.**
`hint` 와 어긋나면(그 값이 사실은 다른 문서의 소유 대상이면) 위반으로 올리지 말고 `payload.owner_dispute` 에 근거를 적어 낸다. 소유 표를 고치는 것이 답인 경우가 있고, 그 결정은 사람이 한다.

**3. 재서술이 맞으면 `ownership.duplicate`.**
`value_match: "same"` 인 줄들이 여기 해당한다. 심각도는 그 값이 바뀔 때 같이 바뀌지 않으면 무엇이 깨지는가로 정한다 — 판정·게이트·규칙의 근거로 쓰이는 값이면 `block`, 설명 맥락이면 `warn`.

**4. 같은 항목의 재서술이 2곳 이상이고 그중 일부만 최신이면 `ownership.partial-update`.**
`value_match: "partial"` 과 `same` 이 한 후보에 섞여 있는 상태가 이 신호다. `missing_tokens` 가 빠진 조건을 그대로 보여준다. 판정 순서:

- `same` 쪽 문장을 정본으로 놓고, `partial` 쪽에 빠진 것이 **조건·예외·단서**인지 단순 축약·의역인지 본다.
- 조건이 빠졌으면 이미 갈라진 복제다. 축약이면 `ownership.duplicate` 로 내린다.
- 갈라졌으면 **항상 `block`**. 이 축에서 최고 심각도는 "복제가 있다"가 아니라 "복제가 이미 서로 다른 말을 한다"이다 — 읽는 사람마다 다른 규칙을 적용하게 되고, 어느 쪽이 옳은지는 문서만 봐서는 알 수 없다.
- finding 하나에 **그 항목의 재서술을 전부** 담는다. 최신 2곳과 낡은 3곳이 각각 어디인지가 이 finding 의 값이다. `already_drifted_locations` 도 같이 싣는다.

**판정하지 않는 것.** 스크립트는 한 줄 단위로만 본다. 여러 줄에 걸친 복제, 의역된 복제, 이름 없이 옮겨 적은 값은 후보에 아예 오르지 않는다. 후보 밖을 스스로 찾아 나서지 않는다(아래 첫 항).

## 반드시 지킬 것

1. **탐색 범위** — 후보 파일에 실린 파일·줄만 연다. 소유 문서와 후보에 적힌 문서 외의 파일을 열지 않고, 후보에 없는 위반을 새로 찾지 않는다. 이 계약은 주어진 후보를 확정하는 일만 한다.
2. **집합 성격** — 판정 전에 이 문서 집합이 무엇인지(설계 문서인지 운영 절차서인지, 어느 절이 규범이고 어느 절이 배경인지) `config.docs` 와 소유 문서 상단에서 확인하고, 그 성격에 맞춰 심각도를 정한다. 규범 문서의 복제와 배경 설명의 중복은 같은 무게가 아니다.
3. **기계 생성 파일을 읽지 않는다** — `<out>/` 아래 산출물, 잠금 파일, 빌드 결과는 열지 않는다. 그것들을 근거로 삼으면 이전 실행의 판정을 되풀이하게 된다.
4. **verdict 파일 하나만 쓴다** — 오케스트레이터가 지정한 `<out>/<run-id>/verdicts/ownership.json` 외에 어떤 파일도 만들거나 고치지 않는다. 문서 자체를 고치는 것은 이 계약의 일이 아니다.

## 출력

지정된 verdict 경로에 findings 봉투 배열 하나만 쓴다.

```json
[
  {
    "axis": "ownership",
    "severity": "block",
    "code": "ownership.partial-update",
    "message": "전환 게이트 규칙이 5곳에 복제됐고 그중 2곳만 면제신청 예외 조건을 반영했다",
    "locations": [
      { "file": "gates/c.md", "line": 5, "quote": "…" },
      { "file": "rules/transition-gate.md", "line": 7, "quote": "…" }
    ],
    "payload": {
      "what": "전환 게이트 판정 규칙",
      "owner_doc": "rules/transition-gate.md",
      "already_drifted": true,
      "duplicate_locations": [{ "file": "gates/c.md", "line": 5, "quote": "…", "state": "stale" }],
      "drift_detail": "면제신청 라벨 예외가 c·d·e 에 없다"
    }
  }
]
```

- `code` 는 `ownership.duplicate` 또는 `ownership.partial-update` 둘 중 하나다. `ownership.drifted-copy` 는 스크립트가 소유하므로 여기서 다시 내지 않는다.
- `locations[0]` 은 **고쳐야 할 곳**(복제된 줄)이고, 소유 문서 위치는 마지막에 둔다. 병합기가 `locations[0]` 로 중복을 접는다.
- `payload.duplicate_locations[].state` 는 `stale`(낡음) · `current`(최신) · `mention`(언급) 중 하나로 각 줄의 처지를 밝힌다.
- 위반이 아니라고 판정한 후보는 아무것도 내지 않는다. 빈 배열이 정상 산출이다.
