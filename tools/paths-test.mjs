/**
 * Proves the one rule that matters for on-disk hygiene: the app writes only
 * inside its own runtime folder, on the volume the executable lives on, and
 * never in %APPDATA% / %LOCALAPPDATA% / %TEMP%.
 *
 * Pure logic, no Electron and no I/O, so it runs anywhere.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  layout,
  devLayout,
  RUNTIME_FOLDER,
  volumeOf,
  staysOnAppVolume,
  avoidsSystemLocations,
} = require('../src/paths.js');

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

const packagedExe = 'D:\\#Edge下载\\SKN\\dist-v2\\SKN 键盘驱动\\SKN Launcher.exe';
const dirs = layout(packagedExe);
const root = path.dirname(packagedExe);

check('运行根目录就是应用 exe 所在目录', dirs.root === root, dirs.root);
check(`根目录名是 ${RUNTIME_FOLDER}`, path.basename(dirs.root) === RUNTIME_FOLDER, path.basename(dirs.root));

for (const key of ['data', 'temp', 'crashDumps', 'logs']) {
  const dir = dirs[key];
  check(`${key} 位于运行根目录内`, dir.startsWith(root + path.sep), dir);
}
check('data 路径为 <root>\\data', dirs.data === path.join(root, 'data'), dirs.data);

check('全部目录与 exe 同盘（D:）', staysOnAppVolume(dirs, packagedExe), JSON.stringify(dirs));
check('不落在 AppData / Application Data 里', avoidsSystemLocations(dirs), JSON.stringify(dirs));
check('盘符解析正确', volumeOf(dirs.data) === 'd:\\', volumeOf(dirs.data));

// An exe on C: still keeps the app out of AppData - the folder sits next to it.
const onC = layout('C:\\Tools\\SKN 键盘驱动\\SKN Launcher.exe');
check('exe 在 C 盘时依然不进 AppData', avoidsSystemLocations(onC), onC.data);
check('exe 在 C 盘时目录跟随 exe 所在目录', onC.data === 'C:\\Tools\\SKN 键盘驱动\\data', onC.data);

// Negative controls: the shapes we deliberately removed must now fail.
const oldShape = layout('C:\\Users\\someone\\AppData\\Local\\SKN 键盘驱动\\SKN Launcher.exe');
check('负例：旧方案（LOCALAPPDATA）会被判为不合规', !avoidsSystemLocations(oldShape), oldShape.data);
check(
  '负例：跨盘布局会被判为不合规',
  !staysOnAppVolume(layout('D:\\app\\x\\SKN Launcher.exe'), 'C:\\other\\SKN Launcher.exe'),
  '',
);

// Dev checkout must not litter the project root either.
const dev = devLayout('D:\\#Edge下载\\SKN\\skn-launcher');
check('开发模式使用 <项目>\\.dev', dev.root === 'D:\\#Edge下载\\SKN\\skn-launcher\\.dev', dev.root);
check('开发模式同样不进 AppData', avoidsSystemLocations(dev), dev.data);

// Wiring check: the rule only holds if main.js really applies every path. Text
// based on purpose, because starting Electron is not possible everywhere.
const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
for (const call of [
  "app.setPath('userData'",
  "app.setPath('temp'",
  "app.setPath('crashDumps'",
  'app.setAppLogsPath(',
]) {
  check(`main.js 确实调用 ${call}…)`, mainSource.includes(call));
}
check('main.js 已不再依赖 portable.txt 标记', !mainSource.includes('portable.txt'));

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  -> ${c.detail}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed === 0 ? 0 : 1);