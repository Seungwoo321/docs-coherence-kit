import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const routes = readFileSync(resolve(here, '../data/routes.txt'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '');

console.log(routes.length);
