/**
 * 发布 Release：打 tag 时由 CI 调用（自己调 GitHub API，不用第三方 action）。
 *
 * 为什么不用 softprops/action-gh-release（实测踩到的两个坑）：
 *   1. 它读取 body_path 失败时不报错，Release 说明会静默变成空；
 *   2. 资产名交给它上传时也可能被 GitHub 服务端清洗（非 ASCII 字符被删掉）。
 * 自己调 API 才能保证「说明不为空」「资产名与预期一致」这两件事失败即报错。
 *
 * 用法（CI 里不需要参数，读环境变量即可）：
 *   node build/publish-release.mjs
 *   node build/publish-release.mjs --tag v1.1.1 --dry-run
 *
 * 环境变量：GITHUB_TOKEN、GITHUB_REPOSITORY(owner/repo)；tag 模式下用 GITHUB_REF_NAME/GITHUB_REF_TYPE
 * 可选参数：--tag <tag>、--assets <目录>、--notes <文件>、--prerelease、--dry-run
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const assetsDir = path.resolve(option('--assets') || path.join(root, 'release'));
const notesFile = path.resolve(option('--notes') || path.join(assetsDir, 'release-notes.md'));
const dryRun = has('--dry-run');
const prerelease = has('--prerelease');

const refType = process.env.GITHUB_REF_TYPE || '';
const tag = option('--tag') || (refType === 'tag' ? process.env.GITHUB_REF_NAME : null);

if (!tag) {
  console.log('[发布] 这次不是 tag 构建，跳过发布（分支推送只跑测试与构建）。');
  process.exit(0);
}
if (!/^v\d/.test(tag)) {
  console.error(`[发布] 标签名不像版本号，拒绝发布：${tag}`);
  process.exit(1);
}
if (!fs.existsSync(notesFile)) {
  console.error(`[发布] 缺少说明文件：${path.relative(root, notesFile)}`);
  process.exit(1);
}
const notes = fs.readFileSync(notesFile, 'utf8');
if (notes.trim().length < 50) {
  console.error('[发布] 说明文件太短，拒绝发布一个没有说明的 Release。');
  process.exit(1);
}
const files = fs.existsSync(assetsDir)
  ? fs.readdirSync(assetsDir).filter((file) => file.toLowerCase().endsWith('.exe')).sort()
  : [];
if (files.length === 0) {
  console.error(`[发布] ${path.relative(root, assetsDir)} 里没有 .exe 资产。`);
  process.exit(1);
}
// 资产名必须是 ASCII：GitHub 会把非 ASCII 字符从名字里删掉（实测 `SKN 键盘驱动.exe` -> `SKN.exe`）
for (const file of files) {
  if (!/^[\x20-\x7e]+$/.test(file)) {
    console.error(`[发布] 资产名含非 ASCII 字符，GitHub 会改写它：${file}`);
    process.exit(1);
  }
}

const repository = option('--repo') || process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!dryRun && (!repository || !token)) {
  console.error('[发布] 需要 GITHUB_REPOSITORY 与 GITHUB_TOKEN 环境变量。');
  process.exit(1);
}
const api = `https://api.github.com/repos/${repository}`;
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'skn-launcher-release',
};

console.log(`[发布] 标签 ${tag}`);
for (const file of files) console.log(`[发布] 资产 ${file}（${(fs.statSync(path.join(assetsDir, file)).size / 1024 / 1024).toFixed(1)} MB）`);
console.log(`[发布] 说明 ${notes.trim().split('\n').length} 行`);

if (dryRun) {
  console.log('[发布] --dry-run：只检查本地文件，不碰 GitHub。');
  process.exit(0);
}

async function call(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${init.method || 'GET'} ${url} -> HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  return body;
}

// 1. 已有 Release 就更新，没有就新建
let release = null;
try {
  release = await call(`${api}/releases/tags/${encodeURIComponent(tag)}`);
  release = await call(`${api}/releases/${release.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: tag, body: notes, prerelease, draft: false }),
  });
  console.log(`[发布] 更新已有 Release #${release.id}`);
} catch (error) {
  if (!String(error.message).includes('HTTP 404')) throw error;
  release = await call(`${api}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: tag, body: notes, draft: false, prerelease }),
  });
  console.log(`[发布] 新建 Release #${release.id}`);
}

// 2. 同名旧资产先删掉，重跑不会出现 `xxx.1.exe` 这种副本
const existing = await call(`${api}/releases/${release.id}/assets`);
for (const asset of existing) {
  if (files.includes(asset.name)) {
    await call(`${api}/releases/assets/${asset.id}`, { method: 'DELETE' });
    console.log(`[发布] 删除同名旧资产 ${asset.name}`);
  }
}

// 3. 上传。整块读进来是为了给出确定的 Content-Length（流式上传走 chunked，上传接口不吃）
for (const file of files) {
  const full = path.join(assetsDir, file);
  const uploaded = await call(
    `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(file)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fs.statSync(full).size) },
      body: fs.readFileSync(full),
    },
  );
  if (uploaded.name !== file) {
    console.error(`[发布] 资产名被 GitHub 改写：期望 ${file}，实际 ${uploaded.name}`);
    process.exit(1);
  }
  console.log(`[发布] 已上传 ${uploaded.name} -> ${uploaded.browser_download_url}`);
}
console.log(`[发布] Release ${release.html_url}`);