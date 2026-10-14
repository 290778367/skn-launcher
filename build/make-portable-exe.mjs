/**
 * Builds the single-file exe:
 *
 *   [ 外壳 exe ][ tar.xz payload ][ "SKNPKG02" ][ int64 payload length ]
 *
 * 外壳由 make-single-exe.mjs 用 csc 编成 build/out/SKN 键盘驱动.exe（名字会写进
 * PE 的 OriginalFilename，用户属性页里看到的就是它）。
 *
 * The payload is compressed with the xz encoder built into Windows' own bsdtar
 * (tar -cJf) and unpacked on first run by that same tar.exe, so no third-party
 * archiver ships with the app or has to be dropped on the user's disk. xz costs
 * ~30% less space than the deflate zip this replaced: 133 MB -> ~92 MB.
 *
 * Usage:
 *   node build/make-portable-exe.mjs [payloadDir] [outExe] [stubExe]
 *
 * Env:
 *   SKN_XZ_LEVEL=6   xz compression level 0-9 (higher = smaller and slower)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const payloadDir = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'SKN Launcher-win32-x64'));
const outExe = path.resolve(process.argv[3] || path.join(ROOT, 'dist', 'SKN 键盘驱动 便携版.exe'));
const stubExe = path.resolve(process.argv[4] || path.join(import.meta.dirname, 'out', 'SKN 键盘驱动.exe'));

// Kept out of the delivery folder on purpose: it lives in the build scratch area
// and is deleted even if the build throws.
const archivePath = path.join(import.meta.dirname, 'out', 'payload.tar.xz');
const MAGIC = Buffer.from('SKNPKG02', 'ascii');
const XZ_LEVEL = process.env.SKN_XZ_LEVEL || '6';

/** User data must never travel inside the package. */
const ROOT_EXCLUDES = new Set(['data']);

const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
if (!fs.existsSync(tarExe)) {
  throw new Error(`找不到 Windows 自带的 tar.exe：${tarExe}（需要 Windows 10 1803 或更新的系统来构建与解压）`);
}

function collect(dir, prefix, items) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (prefix === '' && ROOT_EXCLUDES.has(entry.name.toLowerCase())) {
      console.log('excluded:', entry.name);
      continue;
    }
    const name = prefix === '' ? entry.name : prefix + '\\' + entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      items.push({ name: name + '\\', dir: true });
      collect(full, name, items);
    } else if (entry.isFile()) {
      items.push({ name, dir: false, size: fs.statSync(full).size });
    }
  }
}

function compress() {
  const args = ['-cJf', archivePath, '--exclude=./data', '-C', payloadDir, '.'];
  const withLevel = [
    '-cJf',
    archivePath,
    `--options=xz:compression-level=${XZ_LEVEL}`,
    '--exclude=./data',
    '-C',
    payloadDir,
    '.',
  ];

  let result = spawnSync(tarExe, withLevel, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.log(`tar 不接受 compression-level=${XZ_LEVEL}，改用默认压缩级别重试。`);
    result = spawnSync(tarExe, args, { stdio: 'inherit' });
  }
  if (result.status !== 0) {
    throw new Error(`tar -cJf 失败，退出码 ${result.status}`);
  }
  if (!fs.existsSync(archivePath)) throw new Error('tar 没有产出归档文件');
}

// --- payload -------------------------------------------------------------
console.log('payload dir :', payloadDir);
console.log('stub        :', stubExe);
console.log('output      :', outExe);
console.log('tar         :', tarExe);

const items = [];
collect(payloadDir, '', items);
const files = items.filter((i) => !i.dir).length;
const dirs = items.filter((i) => i.dir).length;
const rawBytes = items.reduce((sum, i) => sum + (i.size || 0), 0);
console.log(`collecting  : ${files} 个文件 + ${dirs} 个目录，原始 ${(rawBytes / 1048576).toFixed(1)} MB`);

try {
  compress();
  const archiveBytes = fs.statSync(archivePath).size;
  console.log(
    `payload     : tar.xz ${(archiveBytes / 1048576).toFixed(1)} MB ` +
      `(${((archiveBytes / rawBytes) * 100).toFixed(1)}%，xz level ${XZ_LEVEL})`,
  );
  if (files === 0) throw new Error('负载目录里一个文件都没有，中止构建');
  // Sanity check relative to the payload, not an absolute size, so small test
  // payloads build too: a truncated archive is always far below 5% of the input.
  const minBytes = Math.max(64 * 1024, Math.floor(rawBytes * 0.05));
  if (archiveBytes < minBytes) {
    throw new Error(
      `归档只有 ${(archiveBytes / 1024).toFixed(0)} KB，原始负载 ${(rawBytes / 1048576).toFixed(1)} MB，` +
        '明显不完整，中止构建',
    );
  }

  // --- concatenate -------------------------------------------------------
  const stub = fs.readFileSync(stubExe);
  const footer = Buffer.alloc(16);
  MAGIC.copy(footer, 0);
  footer.writeBigInt64LE(BigInt(archiveBytes), 8);

  const out = fs.openSync(outExe, 'w');
  fs.writeSync(out, stub);

  const inFd = fs.openSync(archivePath, 'r');
  const chunk = Buffer.alloc(4 << 20);
  let copied = 0;
  while (copied < archiveBytes) {
    const want = Math.min(chunk.length, archiveBytes - copied);
    const got = fs.readSync(inFd, chunk, 0, want, copied);
    if (got <= 0) throw new Error('读取归档时提前结束');
    fs.writeSync(out, chunk, 0, got);
    copied += got;
  }
  fs.closeSync(inFd);
  fs.writeSync(out, footer);
  fs.closeSync(out);

  const finalSize = fs.statSync(outExe).size;
  const expected = stub.length + archiveBytes + 16;
  console.log(`stub        : ${(stub.length / 1024).toFixed(1)} KB`);
  console.log(
    `result      : ${(finalSize / 1048576).toFixed(1)} MB (expected ${(expected / 1048576).toFixed(1)} MB)`,
  );
  if (finalSize !== expected) throw new Error(`size mismatch: ${finalSize} != ${expected}`);
  console.log('OK');
} finally {
  fs.rmSync(archivePath, { force: true });
}