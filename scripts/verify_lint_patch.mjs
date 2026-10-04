// Verify the patched Next lint glob boundary without weakening rule coverage.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const configRequire = createRequire(webRequire.resolve('eslint-config-next'));
const pluginPath = configRequire.resolve('@next/eslint-plugin-next');
const { getRootDirs } = configRequire(join(dirname(pluginPath), 'utils/get-root-dirs.js'));
const root = mkdtempSync(join(tmpdir(), 'needware-lint-'));
try {
  for (const name of ['one', 'two']) mkdirSync(join(root, name));
  const resolve = (rootDir) => getRootDirs({ cwd: root, settings: { next: { rootDir } } }).sort();
  const expected = ['one', 'two'].map((name) => join(root, name)).sort();
  assert.deepEqual(resolve(`${root}/*`), expected);
  assert.deepEqual(resolve(`${relative(process.cwd(), root)}/*`), expected.map((dir) => relative(process.cwd(), dir)).sort());
  assert.deepEqual(resolve([`${root}/one`, `${root}/two`]), expected);
  assert.deepEqual(resolve(`${root}/absent*`), []);
  assert.deepEqual(resolve(`${root.replaceAll('/', '\\')}/*`), expected);
  assert.deepEqual(getRootDirs({ cwd: root, settings: {} }), [root]);
  const { ESLint } = webRequire('eslint');
  const lint = new ESLint();
  const [result] = await lint.lintText('export default function Test(){ return <img src="/x.png" alt="x"/>; }', { filePath: 'apps/web/app/lint-probe.tsx' });
  assert(result.messages.some((message) => message.ruleId === '@next/next/no-img-element'));
  console.log('PASS Next root globs and active lint rules');
} finally {
  rmSync(root, { recursive: true, force: true });
}
