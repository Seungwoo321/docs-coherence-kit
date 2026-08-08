// 합성 결정 축. 실행 계약(인자·stdout 봉투·exit)만 재현하고 판정 로직은 없다.
if (!process.argv.includes('--config')) {
  process.stderr.write('[alpha] --config 인자가 필요하다\n');
  process.exit(2);
}

process.stdout.write(
  JSON.stringify({
    axis: 'alpha',
    findings: [
      {
        axis: 'alpha',
        severity: 'warn',
        code: 'alpha.shared-defect',
        message: '공유 문서 3줄이 다른 문서와 어긋난다',
        locations: [{ file: 'docs/shared.md', line: 3, quote: '| 합계 | 10 |' }],
      },
    ],
    stats: { files_scanned: 2, excluded: [], skipped: false },
  }),
);
