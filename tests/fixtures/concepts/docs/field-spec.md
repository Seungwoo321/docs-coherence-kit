# 필드 규격

## §5 역참조 필드

역참조는 두 눈금이다 — `usedByTiles` 는 타일에서, `usedByBlocks` 는 기능블록에서 온 참조다.
두 값이 갈릴 수 있어야 하므로 `usedByTiles` 와 `usedByBlocks` 를 합치지 않는다.

## §6 출처 필드

`derivedFrom` 는 필수 필드다. 조각이 어느 코드에서 나왔는지 여기 남는다.
`derivedFrom` 가 비면 조립기가 원본을 찾지 못한다.
`authorNote` 는 정식 필드이며, `authorNote` 에는 사람이 읽을 보충 설명이 들어간다.

## §7 기능블록 참조

산출은 `booking-core` 를 소비자로 기록한다. `booking-core` 밖의 이름은 쓰지 않는다.
