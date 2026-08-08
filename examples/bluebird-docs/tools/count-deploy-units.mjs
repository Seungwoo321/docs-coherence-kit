/** 한 파이프라인에서 함께 나가는 배포단위 수. 문서의 수치가 이 값과 같아야 한다. */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const units = JSON.parse(readFileSync(resolve(here, '../data/deploy-units.json'), 'utf8'));

console.log(units.length);
