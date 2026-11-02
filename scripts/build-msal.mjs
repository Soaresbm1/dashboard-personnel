import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../vendor/', import.meta.url), { recursive: true });
for (const [entry, output] of [['scripts/msal-entry.mjs', 'vendor/msal.js'], ['scripts/auth-redirect-entry.mjs', 'vendor/msal-redirect.js']]) {
  await build({ absWorkingDir: root, entryPoints: [entry], outfile: output, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'eof', define: { 'process.env.NODE_ENV': '"production"' } });
}
await copyFile(new URL('../node_modules/@azure/msal-browser/LICENSE', import.meta.url), new URL('../vendor/MSAL-LICENSE.txt', import.meta.url));
console.log('Microsoft MSAL Browser bundled with its redirect bridge.');
