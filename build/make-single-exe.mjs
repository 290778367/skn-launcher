/**
 * One-command build of the single-file exe.
 *
 * Packaging happens entirely in a scratch directory: the unpacked app is
 * produced there, compressed into the exe, and that directory is deleted again.
 * The deliverable is therefore exactly one file - no folder is ever produced
 * next to it, and nothing is left over in the output directory.
 *
 * At run time the exe stays just as self-contained. Double-clicking it installs:
 * a small dialog asks for one folder (default: the non-system drive with the most
 * free space), the payload is unpacked there and everything the app writes - its
 * profile, temp, crash dumps and logs (see src/paths.js) - stays inside that same
 * folder. Uninstalling is the "卸载.exe" that ships in the payload; it removes the
 * folder without touching the registry. --portable (automatic on removable drives)
 * keeps the older hidden "SKN 键盘驱动" folder beside the exe for USB sticks.
 * Nothing is written to %APPDATA%, %LOCALAPPDATA% or %TEMP%, and no readme, helper
 * script or note file is ever created.
 *
 * Usage:
 *   node build/make-single-exe.mjs [outExe] [--keep-scratch]
 *
 * Compiles build/stub.cs and build/uninstall.cs itself with the .NET Framework csc
 * that ships with Windows, so no other tooling is needed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const scratch = path.join(root, 'build', '.scratch');
// 外壳编译成这个名字，不只是为了好找：csc 会把 /out 的文件名写进 PE 的
// OriginalFilename 字段，而这个文件就是交付物本体（后面直接接上负载）。
// 所以要让用户在 exe 属性里看到「原始文件名 = SKN 键盘驱动.exe」，
// 就得在这里就用中文名；名字与 stub.cs 里的 InstalledExeName 保持一致。
const stub = path.join(root, 'build', 'out', 'SKN 键盘驱动.exe');
const keepScratch = process.argv.includes('--keep-scratch');
const outArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const outExe = outArg ? path.resolve(outArg) : path.resolve(root, '..', 'dist-v2', 'SKN 键盘驱动.exe');
const outDir = path.dirname(outExe);
fs.mkdirSync(outDir, { recursive: true });
// build/out 不进仓库（.gitignore），所以全新克隆里它并不存在：
// csc 会把 Win32 资源临时文件写在 /out 的目录里，目录不存在就会以 CS1567 失败。
fs.mkdirSync(path.join(root, 'build', 'out'), { recursive: true });
// Snapshot first: the check at the end may only complain about directories that
// *this* build creates, never about leftovers from an earlier delivery.
const preExisting = new Set(fs.readdirSync(outDir));

function run(args, env) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${args[0]} 退出代码 ${result.status}`);
}

function stage(title) {
  console.log(`\n=== ${title} ===`);
}

// Both C# programs are compiled here so the whole build is one command: the stub
// (which unpacks and installs) and the uninstaller that travels in the payload.
function findCsc() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error(`找不到 csc.exe（试过：${candidates.join(', ')}）`);
  return found;
}

function compile(csc, source, outExe, references) {
  const framework = path.dirname(csc);
  const args = [
    '/nologo',
    '/target:winexe',
    '/codepage:65001',
    '/optimize+',
    '/platform:anycpu',
    `/out:${outExe}`,
    `/win32icon:${path.join(root, 'build', 'icon.ico')}`,
    ...references.map((name) => `/reference:${path.join(framework, name)}`),
    path.join(root, 'build', source),
  ];
  const result = spawnSync(csc, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`编译 ${source} 失败（csc 退出代码 ${result.status}）`);
  console.log(`编译完成：${path.basename(outExe)}  ${(fs.statSync(outExe).size / 1024).toFixed(1)} KB`);
}

stage('1/6 编译外壳与卸载程序（.NET Framework 自带的 csc，无需额外工具链）');
const csc = findCsc();
console.log(`csc：${csc}`);
compile(csc, 'stub.cs', stub, [
  'System.IO.Compression.dll',
  'System.Drawing.dll',
  'System.Windows.Forms.dll',
]);
compile(csc, 'uninstall.cs', path.join(root, 'build', 'out', 'uninstall.exe'), [
  'System.Drawing.dll',
  'System.Windows.Forms.dll',
]);

stage('2/6 在临时目录里打包应用（不落在交付目录）');
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
run(['build/package.mjs'], { SKN_OUT: scratch });

const payloads = fs.readdirSync(scratch).filter((name) => name.endsWith('-win32-x64'));
if (payloads.length !== 1) {
  throw new Error(`临时目录里的负载目录不是恰好一个：${payloads.join(', ') || '(空)'}`);
}
const payloadDir = path.join(scratch, payloads[0]);
console.log(`负载目录：${payloadDir}`);

stage('3/6 交给外壳前，记录负载校验值');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
const asarPath = path.join(payloadDir, 'resources', 'app.asar');
const asarHash = sha256(asarPath);
const payloadFiles = fs.readdirSync(payloadDir).sort();
const KEY_FILES = ['SKN Launcher.exe', '卸载.exe', 'resources/app.asar', 'version', 'LICENSE'];
const payloadHashes = {};
for (const relative of KEY_FILES) {
  const file = path.join(payloadDir, relative);
  payloadHashes[relative] = fs.existsSync(file) ? sha256(file) : null;
}
console.log(`app.asar SHA256：${asarHash}`);
console.log(`负载根目录文件：${payloadFiles.join(', ')}`);

stage('4/6 压缩负载 + 拼接外壳 → 单个 exe');
run(['build/make-portable-exe.mjs', payloadDir, outExe, stub]);

stage('5/6 删除临时目录，确认交付目录里只有 exe');
if (keepScratch) {
  console.log(`--keep-scratch：保留 ${scratch}`);
} else {
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`临时目录已删除：${scratch} -> 存在? ${fs.existsSync(scratch)}`);
}

// Signing is part of the build, not an afterthought: with credentials in the
// environment the delivered file comes out signed, and either way the exact
// signature state is printed and recorded. SKN_REQUIRE_SIGNED=1 turns that into a
// release gate: the build fails rather than deliver an unsigned file.
stage('6/6 签名（配置了 SKN_SIGN_* 时）与签名状态');
const signatureStatePath = path.join(root, 'build', 'out', 'last-signature.json');
run(['build/sign-exe.mjs', outExe, `--state-file=${signatureStatePath}`]);
let signatureState = null;
try {
  signatureState = JSON.parse(fs.readFileSync(signatureStatePath, 'utf8'));
} catch {
  signatureState = null;
}
fs.rmSync(signatureStatePath, { force: true });

const size = fs.statSync(outExe).size;
const exeHash = sha256(outExe);
const stubHash = sha256(stub);
const stubSource = fs.readFileSync(path.join(root, 'build', 'stub.cs'), 'utf8');
const buildId = (stubSource.match(/BuildId\s*=\s*"([^"]+)"/) || [, 'unknown'])[1];

// Manifest for the verification runs (kept in build/out, never in the deliverable dir).
fs.writeFileSync(
  path.join(root, 'build', 'out', 'last-build.json'),
  `${JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      outExe,
      size,
      sha256: exeHash,
      asarSha256: asarHash,
      payloadHashes,
      stubSha256: stubHash,
      buildId,
      payloadFiles,
      signature: signatureState,
      signingConfigured: Boolean(
        process.env.SKN_SIGN_DLIB || process.env.SKN_SIGN_PFX || process.env.SKN_SIGN_THUMBPRINT,
      ),
    },
    null,
    2,
  )}\n`,
);

// Only entries this build added may fail the run; leftovers from an earlier
// delivery are reported, never deleted.
const added = fs.readdirSync(outDir).filter((name) => !preExisting.has(name));
const addedFolders = added.filter((name) => fs.statSync(path.join(outDir, name)).isDirectory());
const addedFiles = added.filter((name) => name !== path.basename(outExe));
if (addedFolders.length > 0) {
  throw new Error(`本次构建在交付目录里产生了文件夹：${addedFolders.join(', ')}`);
}

console.log('\n=== 交付结果 ===');
console.log(`exe        : ${outExe}`);
console.log(`大小       : ${size} 字节 (${(size / 1048576).toFixed(1)} MB)`);
console.log(`SHA256     : ${exeHash}`);
console.log(`外壳 BuildId：${buildId}`);
console.log(`签名状态   ：${signatureState ? signatureState.status : '未知'}${
  signatureState && signatureState.policy ? `（${signatureState.policy}）` : ''
}${signatureState && signatureState.timestamped === 'yes' ? '，带时间戳' : ''}`);
if (!signatureState || signatureState.status !== 'Valid') {
  console.log('提示：交付的是未签名（或不受信任）版本。解决 SmartScreen 需要公共 CA 证书，');
  console.log('  路线、花费与资格限制见 build/SIGNING.md；有证书后用 SKN_REQUIRE_SIGNED=1 上闸门。');
}
console.log('默认（双击）= 安装版：弹窗选择安装目录，程序本体、设置、缓存与');
console.log('  卸载.exe 全部只写在那一个目录里；--portable = 便携版（exe 旁边');
console.log('  的隐藏目录，可移动盘上自动使用）。');
console.log('写入范围：安装目录（或便携目录）之内；不写 C 盘系统目录、不写注册表。');
console.log(`本次新增   : ${added.length ? added.join(', ') : '(无)'}`);
console.log(`交付目录内容：${fs.readdirSync(outDir).join(', ')}`);
if (addedFiles.length > 0) console.log(`注意：除 exe 之外还新增了 ${addedFiles.join(', ')}`);
const leftovers = [...preExisting].filter((name) => fs.statSync(path.join(outDir, name)).isDirectory());
if (leftovers.length > 0) {
  console.log(`提示：交付目录里原有的文件夹 ${leftovers.join(', ')} 与本次构建无关（本次没产生任何文件夹）。`);
}
console.log('\n交付目录里没有产生任何文件夹，exe 旁边运行时也不会产生。');