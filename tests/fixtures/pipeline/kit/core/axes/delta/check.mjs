// 합성 결정 축. config 에 "delta" 선언이 있을 때만 돈다 — 없으면 스캐너가 부르지도 않는다.
process.stdout.write(
  JSON.stringify({
    axis: 'delta',
    findings: [],
    stats: { files_scanned: 2, excluded: [], skipped: false },
  }),
);
