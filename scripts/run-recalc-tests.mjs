// 用 esbuild（vite 已内置）把 TS 测试打包为 Node ESM 后运行。
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const outfile = 'node_modules/.tmp/recalc-test.mjs';

await build({
  entryPoints: ['scripts/recalc-engine.test.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'silent'
});

await import(pathToFileURL(resolve(outfile)).href);

process.on('exit', () => {
  try {
    rmSync(outfile, { force: true });
  } catch {
    // ignore
  }
});
