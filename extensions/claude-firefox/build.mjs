// Bundles the extension into dist/ (and the tests into .test-out/ with --test).
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, readdirSync } from 'node:fs';

const test = process.argv.includes('--test');
if (test) {
  rmSync('.test-out', { recursive: true, force: true });
  await esbuild.build({ entryPoints: readdirSync('test').filter((f) => f.endsWith('.ts')).map((f) => 'test/' + f), outdir: '.test-out', bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', outExtension: { '.js': '.mjs' } });
} else {
  rmSync('dist', { recursive: true, force: true }); mkdirSync('dist');
  // es2022 and no minification: the page functions are sent to tabs as source text and must stay self-contained
  await esbuild.build({ entryPoints: ['src/background.ts', 'src/chat.ts'], outdir: 'dist', bundle: true, format: 'iife', target: 'firefox140', minify: false, legalComments: 'none' });
  cpSync('static', 'dist', { recursive: true });
  console.log('built dist/');
}
