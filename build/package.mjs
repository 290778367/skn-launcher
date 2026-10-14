/**
 * Unpacks the app into a folder. This is the intermediate step of the
 * single-file build (build/make-single-exe.mjs); the folder is not a deliverable
 * and is deleted again once the exe has been assembled.
 *
 * Nothing but the app and its uninstaller goes in: no readme, no helper scripts, no
 * marker files. Documentation lives in the stub's --help dialog, and where data goes
 * is decided in code (src/paths.js) instead of by a marker file - so the payload
 * holds Electron plus the app plus "卸载.exe" and nothing else. The guard below
 * enforces that.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const packager = require('@electron/packager');

const projectDir = path.resolve(import.meta.dirname, '..');
const outRoot = process.env.SKN_OUT || path.resolve(projectDir, '..', 'dist');
// 全新克隆里 dist/ 与 build/out/ 都不存在（都不进仓库），先建出来，别指望打包器替我们建
fs.mkdirSync(outRoot, { recursive: true });

const appPaths = await packager({
  dir: projectDir,
  out: outRoot,
  name: 'SKN Launcher',
  executableName: 'SKN Launcher',
  platform: 'win32',
  arch: 'x64',
  icon: path.join(projectDir, 'build', 'icon.ico'),
  asar: true,
  overwrite: true,
  prune: true,
  // The app uses only Electron/Node built-ins, so nothing from node_modules,
  // the build helpers, the test tools, the docs or a dev data folder belongs in
  // the shipped bundle.
  ignore: [
    /^\/dist/,
    /^\/tools($|\/)/,
    /^\/build($|\/)/,
    /^\/node_modules($|\/)/,
    /^\/\.dev($|\/)/,
    /^\/package-lock\.json$/,
    /^\/README\.md$/,
  ],
  win32metadata: {
    CompanyName: 'SKN',
    FileDescription: 'SKN 键盘驱动 — 官方网页驱动的桌面版',
    ProductName: 'SKN Launcher',
    InternalName: 'SKN Launcher',
    OriginalFilename: 'SKN Launcher.exe',
  },
});

console.log('packaged:', appPaths);
const appDir = appPaths[0];

// The uninstaller ships inside the payload: an install folder needs a way out, and
// the "Apps & features" route would require registry keys this program never writes.
// It is compiled by build/make-single-exe.mjs; a folder build can compile it with the
// same csc command line if it is missing.
const uninstaller = path.join(projectDir, 'build', 'out', 'uninstall.exe');
if (fs.existsSync(uninstaller)) {
  fs.copyFileSync(uninstaller, path.join(appDir, '卸载.exe'));
  console.log('卸载.exe:', path.join(appDir, '卸载.exe'));
} else {
  console.log('提示：build/out/uninstall.exe 不存在，负载里没有卸载程序（先运行 make-single-exe.mjs）');
}

// The payload may only ever contain Electron, the app and that uninstaller: a stray
// document or script would end up inside the install folder on the user's disk.
const stray = fs.readdirSync(appDir).filter((name) => /\.(cmd|bat|ps1|txt|md|log|ini)$/i.test(name));
if (stray.length > 0) {
  throw new Error(`负载根目录出现了多余文件：${stray.join(', ')}`);
}

console.log('payload root:', fs.readdirSync(appDir).sort().join(', '));
console.log('exe:', path.join(appDir, 'SKN Launcher.exe'));