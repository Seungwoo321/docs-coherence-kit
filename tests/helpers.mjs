import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = resolve(TESTS_DIR, 'fixtures');

export function fixture(...segments) {
  return resolve(FIXTURES, ...segments);
}
