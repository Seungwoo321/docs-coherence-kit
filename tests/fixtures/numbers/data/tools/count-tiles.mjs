import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tiles = JSON.parse(readFileSync(resolve(here, '../data/tiles.json'), 'utf8'));

console.log(tiles.length);
