import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.join(repositoryRoot, 'build', 'test');
const files = (await readdir(testRoot))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(testRoot, name));

if (files.length === 0) {
  console.error(`No compiled tests found below ${testRoot}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
