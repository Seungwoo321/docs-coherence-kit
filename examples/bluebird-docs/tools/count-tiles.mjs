/** 레지스트리에 올라 있는 타일 수. numbers 축의 measurements 가 이 값을 문서와 대조한다. */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tiles = JSON.parse(readFileSync(resolve(here, '../data/tiles.json'), 'utf8'));

console.log(tiles.length);
