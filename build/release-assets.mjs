/**
 * 把构建产物整理成「用户下载的那一个文件」：中文文件名 + 校验值 + Release 说明。
 *
 * 为什么要在签名之后单独做一步，而且用 node 而不是 PowerShell：
 *   - 签名服务与 CI 内部一律使用 ASCII 文件名 SKN-Launcher-setup.exe，避免
 *     Windows runner 上的代码页问题（GitHub 把 run 脚本写盘后由 powershell 读取，
 *     脚本里的非 ASCII 字面量会被搞坏）。本文件由 node 以 UTF-8 读取，没有这个风险。
 *   - Authenticode 是按文件内容校验的，改名不会让签名失效——所以脚本会在改名之后
 *     重新读一遍签名状态，把这件事证明出来，而不是假设。
 *
 * 用法：
 *   node build/release-assets.mjs                       # 自动挑 signed/ 或 dist/
 *   node build/release-assets.mjs --from <exe> --out-dir <dir>
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
/** 面向用户的文件名：与外壳安装出来的程序名、PE 的 OriginalFilename 一致 */
const ASSET_NAME = 'SKN 键盘驱动.exe';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const outDir = path.resolve(option('--out-dir') || path.join(root, 'release'));
// CI 里是 signed/（签名后）或 dist/（未签名）；本机按 README 构建时产物在 ../dist-v2/
const candidates = [
  'signed/SKN-Launcher-setup.exe',
  'dist/SKN-Launcher-setup.exe',
  '../dist-v2/SKN 键盘驱动.exe',
].map((p) => path.resolve(root, p));
const from = path.resolve(option('--from') || candidates.find((file) => fs.existsSync(file)) || candidates[1]);
if (!fs.existsSync(from)) {
  console.error(`[整理] 找不到构建产物：${from}`);
  console.error('[整理] 先跑 node build/make-single-exe.mjs（CI 里是 npm run build）。');
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
fs.mkdirSync(outDir, { recursive: true });

const target = path.join(outDir, ASSET_NAME);
fs.copyFileSync(from, target);
console.log(`[整理] ${path.relative(root, from)} -> ${path.relative(root, target)}`);

// 改名之后重新确认签名（签名按内容校验，改名不该影响它）
const stateFile = path.join(outDir, '.sigcheck.json');
spawnSync(process.execPath, [path.join(root, 'build', 'sign-exe.mjs'), target, '--report-only', `--state-file=${stateFile}`], {
  stdio: 'inherit',
});
let signature = { status: 'Unknown', subject: '', policy: '', timestamped: '' };
try {
  signature = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
} catch {
  /* 状态文件没写出来就按 Unknown 处理，下面会如实写进 Release 说明 */
}
fs.rmSync(stateFile, { force: true });

const size = fs.statSync(target).size;
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex').toUpperCase();
const mb = (size / 1024 / 1024).toFixed(1);
const signed = signature.status === 'Valid';

const notes = [
  `## SKN 键盘驱动 ${version}`,
  '',
  `- 文件：${ASSET_NAME}（单文件，双击是安装版；命令行加 \`--portable\` 是便携版）`,
  `- 大小：${mb} MB（${size.toLocaleString('en-US')} 字节）`,
  `- SHA256：\`${sha256}\``,
  `- 签名：${signed ? `有效（${signature.subject}${signature.policy ? `，${signature.policy}` : ''}${signature.timestamped === 'yes' ? '，带时间戳' : ''}）` : signature.status}`,
  '',
  '### 安装',
  '',
  '1. 双击运行，在弹窗里选择安装目录（默认是剩余空间最大的非系统盘，也可以在窗口里点「浏览」换）',
  '2. 程序本体、设置、缓存与 `卸载.exe` 全部只写在那一个目录里；不写注册表、不写 C 盘系统目录',
  '3. 卸载：运行安装目录里的 `卸载.exe`（它会先确认目录里确实有本程序，且程序没有在运行）',
  '',
  '### 便携',
  '',
  '把 exe 放在任意目录（U 盘、移动硬盘都行），用 `--portable` 启动，所有文件写在该 exe 旁边的隐藏目录里。',
  '',
  '### English',
  '',
  `- File: ${ASSET_NAME} (single exe; double-click installs, \`--portable\` runs portable).`,
  `- SHA256: \`${sha256}\``,
  `- Signature: ${signed ? `valid (${signature.subject})` : signature.status}.`,
  '- Install: run it and pick a folder; everything the app writes stays inside that folder.',
  '- Uninstall: run `卸载.exe` inside the install folder.',
  '',
];

if (!signed) {
  notes.push(
    '### 关于未签名版本',
    '',
    '这个构建**没有代码签名**，所以浏览器下载后首次运行会看到「Windows 已保护你的电脑」：',
    '点「更多信息」→「仍要运行」即可。程序启动时会自动清除自己的「来自网络」标记，同一份文件不会再提示第二次；',
    '用 U 盘或局域网共享拷贝这个文件则不会出现提示。',
    '',
    '如果系统开启了「智能应用控制」的强制模式，未签名程序会被直接拦下、没有「仍要运行」按钮——',
    '那一条只能靠签名解决，路线见仓库里的 `build/SIGNING.md`。',
    '',
  );
}

fs.writeFileSync(path.join(outDir, 'release-notes.md'), `${notes.join('\n')}\n`);
console.log(`[整理] 大小 ${mb} MB，SHA256 ${sha256}`);
console.log(`[整理] 签名状态 ${signature.status}${signature.subject ? `（${signature.subject}）` : ''}`);
console.log(`[整理] 说明文件 ${path.relative(root, path.join(outDir, 'release-notes.md'))}`);