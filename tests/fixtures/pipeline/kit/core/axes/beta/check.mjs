// 합성 혼합 축. 스크립트는 후보만 내고 확정은 계약이 한다.
process.stdout.write(
  JSON.stringify({
    axis: 'beta',
    findings: [],
    candidates: [{ item: '재서술 후보', file: 'docs/shared.md', line: 7 }],
    stats: { files_scanned: 2, excluded: [{ path: 'docs/frozen.md', reason: 'frozen 선언' }], skipped: false },
  }),
);
