// 합성 결정 축. 등록된 severity_cap(warn)보다 높은 심각도를 스스로 신고한다.
process.stdout.write(
  JSON.stringify({
    axis: 'capped',
    findings: [
      {
        axis: 'capped',
        severity: 'block',
        code: 'capped.over-reported',
        message: '축이 자기 상한을 넘겨 신고한 지적',
        locations: [{ file: 'docs/shared.md', line: 9 }],
      },
    ],
    stats: { files_scanned: 2, excluded: [], skipped: false },
  }),
);
