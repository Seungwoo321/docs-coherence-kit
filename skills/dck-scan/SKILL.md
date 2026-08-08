---
name: dck-scan
description: 문서 정합 검사의 결정적 단계를 돌린다. 등록된 축 중 스크립트를 가진 것만 자식 프로세스로 실행해 scan.json 으로 모으고, 판정 계약이 필요한 축은 대기 목록에 올린다. /coherence 커맨드가 판단 단계보다 먼저 부른다.
---

# dck-scan — 결정적 단계

정규식·파싱·산술로 끝나는 판정을 먼저 끝낸다. 여기서 나온 차단급 지적은 판단 단계에 토큰을 쓰기 전에 걸러진다.

**이 스킬은 판정하지 않는다.** 판정은 축 스크립트가 하고, 이 스킬은 실행·집계·게이트만 한다. 축이 무엇을 어떻게 보는지 읽거나 흉내 내지 않는다.

## 실행

```bash
node <kit>/core/scan.mjs --config <dck.config.json> --repo <레포 루트> --run-id <id> [--out <디렉토리>]
```

`--run-id` 는 호출자가 준다 — head sha 또는 timestamp. 스크립트가 스스로 짓지 않는다. `--out` 기본값은 config 의 `out` (기본 `.dck`).

stdout 으로 `scan.json` 내용이 그대로 나오고, 같은 내용이 `<out>/<run-id>/scan.json` 에 남는다.

## 종료 코드

| 코드 | 뜻 | 다음 행동 |
|------|-----|-----------|
| 0 | 결정적 축 전부 완주, 차단급 없음 | 판단 단계로 넘어간다 |
| 1 | 차단급 지적이 있거나 축이 깨졌다 | **게이트 정지.** 판단 단계를 부르지 않고 보고한다 |
| 2 | 스캐너 자체가 못 돌았다 (설정 오류 등) | 도구 문제다. 검사 결과로 읽지 않는다 |

1 과 2 를 섞지 않는 이유: config 오타가 "게이트 차단" 으로 읽히면 문서에 없는 결함을 고치러 간다.

## 산출

```json
{
  "run_id": "...", "config": "...", "repo": "...", "run_dir": "<out>/<run-id>",
  "axes": { "<축>": { "status": "ok|crashed|skipped", "reason": "...", "findings": [], "candidates": [], "stats": {} } },
  "awaiting_verdicts": [
    { "axis": "...", "kind": "hybrid|judgment", "contract": "<계약 경로>",
      "candidates_file": "<후보 파일 경로|null>", "candidates": 3,
      "verdict_file": "<out>/<run-id>/verdicts/<축>.json" }
  ],
  "summary": { "block": 0, "warn": 0, "info": 0, "findings": 0, "ok": 0, "crashed": 0, "skipped": 0, "awaiting": 0 }
}
```

- **스크립트가 없는 판단 축은 `axes` 에 들어가지 않는다.** 안 돈 축을 "0건" 으로 적으면 통과로 읽힌다. 그 축은 `awaiting_verdicts` 에만 오르고, 결과 대조는 병합기가 매니페스트를 근거로 한다.
- 한 축이 깨져도 나머지는 완주한다. 깨진 축은 `status: "crashed"` + stderr 를 담은 `reason` 으로 남고, 후보가 없으니 대기 목록에도 오르지 않는다.
- `when.requires` 가 config 에서 충족되지 않은 축은 `status: "skipped"` + 어느 키가 없는지. skipped 는 fail 이 아니지만 pass 도 아니다.
- 축이 신고한 severity 는 매니페스트의 `severity_cap` 으로 잘린다. 축이 자기 심각도를 올려 부를 수 없다.
- 축이 `coverage.*` 코드를 내면 형식 위반으로 보고 그 축을 crashed 처리한다. 커버리지 판정은 병합기만 낸다.

## 다음 단계에 넘길 것

`awaiting_verdicts` 를 그대로 dck-judge 에 넘긴다. 계약 경로·후보 파일 경로·verdict 출력 경로는 **여기서 정해진 값**이다 — 판단 단계가 경로를 새로 짓지 않는다. 흩어진 경로는 병합기가 못 찾고, 못 찾은 축은 커버리지 미달로 차단된다.
