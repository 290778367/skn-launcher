/**
 * 发布 Release：打 tag 时由 CI 调用。
 *
 * 为什么不直接用 softprops/action-gh-release（实测踩到的两个坑）：
 *   1. 它会把非 ASCII 的资产名「清理」掉：`SKN 键盘驱动.exe` 上传后变成 `SKN.exe`，
 *      而用户在下载列表里看到的就是这个名字。
 *   2. 它的 `body_path` 找不到文件时不报错，Release 说明会静默变成空。
 * 自己调 GitHub API，名字、正文、重复资产的处理都是确定的，出问题会直接失败。
 *
 * 用法（CI 里不需要参数，读环境变量即可）：
 *   node build/publish-release.mjs
 *   node build/publish-release.mjs --tag v1.1.1 --dry-run
 *
 * 环境变量：GITHUB_TOKEN、GITHUB_REPOSITORY(owner/repo)；tag 模式下用 GITHUB_REF_NAME/GITHUB_REF_TYPE
 * 可选参数：--tag <tag>、--asset <path>、--notes <path>、--prerelease、--dry-run
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

const ASSET = path.resolve(root, option('--asset') || path.join('release', 'SKN 键盘驱动.exe'));
const NOTES = path.resolve(root, option('--notes') || path.join('release', 'release-notes.md'));
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
for (const file of [ASSET, NOTES]) {
  if (!fs.existsSync(file)) {
    console.error(`[发布] 缺少文件：${path.relative(root, file)}`);
    process.exit(1);
  }
}
const assetName = path.basename(ASSET);
const notes = fs.readFileSync(NOTES, 'utf8');
if (notes.trim().length < 20) {
  console.error('[发布] 说明文件是空的，拒绝发布一个没有说明的 Release。');
  process.exit(1);
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
console.log(`[发布] 资产 ${assetName}（${(fs.statSync(ASSET).size / 1024 / 1024).toFixed(1)} MB）`);
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

// 1. 已有 Release 就更新，没有就新建（tag 是刚推上来的，通常需要新建）
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

// 2. 同名资产先删掉，避免重跑时出现 SKN 键盘驱动.exe 与 SKN 键盘驱动.1.exe 这种重名副本
const assets = await call(`${api}/releases/${release.id}/assets`);
for (const existing of assets) {
  if (existing.name === assetName) {
    await call(`${api}/releases/assets/${existing.id}`, { method: 'DELETE' });
    console.log(`[发布] 删除同名旧资产 ${existing.name}（#${existing.id}）`);
  }
}

// 3. 上传。整块读进来是为了给出确定的 Content-Length（流式上传会走 chunked，上传接口不吃）
const uploaded = await call(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fs.statSync(ASSET).size) },
  body: fs.readFileSync(ASSET),
});

console.log(`[发布] 资产名 ${uploaded.name}`);
console.log(`[发布] 下载地址 ${uploaded.browser_download_url}`);
console.log(`[发布] Release ${release.html_url}`);
if (uploaded.name !== assetName) {
  console.error(`[发布] 资产名被改写了：期望 ${assetName}，实际 ${uploaded.name}`);
  process.exit(1);
}