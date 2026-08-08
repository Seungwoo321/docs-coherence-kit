// 합성 결정 축. 결과를 내기 전에 죽는다 — 크래시한 축이 조용한 0건으로 읽히지 않는지 본다.
process.stderr.write('[broken] 문서 인덱스를 만들다 죽었다: TypeError\n');
process.exit(1);
