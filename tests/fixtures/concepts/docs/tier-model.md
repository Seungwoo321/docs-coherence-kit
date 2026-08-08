# 계층 모델

## §6 층 구조

층 구조의 아래층은 두 요소다 — 호스트와 `widgets-shared`.
`widgets-shared` 는 공용 자산을 담고, 기능블록 패키지가 그 위에 얹힌다.

| 층 | 구성 요소 |
| --- | --- |
| 아래 | 호스트 · `widgets-shared` |
| 위 | 기능블록 패키지 |

`widgets-shared` 안에는 기능블록이 없다. 기능블록별 폴더를 두지 않는다.

## §7 기능블록 패키지

예약 관련 기능블록은 `booking-core` 하나로 모은다.
`booking-core` 는 편집·실행·조회를 모두 담는다.
`booking-core` 를 쪼개는 결정은 아직 없다.
`booking-core` 의 공개 표면은 배선 규격이 정한다.
