/**
 * Signs a built exe when signing credentials are configured, and always reports
 * the exe's real signature state.
 *
 * Why this exists: SmartScreen only stops warning once the file (or the
 * certificate that signed it) has reputation, and Smart App Control in
 * enforcement mode refuses unknown unsigned code outright. Neither can be fixed
 * from inside the program - they need a publicly trusted code-signing
 * certificate. So the build does the signing, in one step, once credentials are
 * available.
 *
 * Routes, first match wins:
 *   1. Artifact Signing (Microsoft's service, formerly "Azure Trusted Signing")
 *        SKN_SIGN_DLIB=<...>\Azure.CodeSigning.Dlib.dll
 *        SKN_SIGN_METADATA=<...>\metadata.json
 *      Requires signtool from the Windows SDK plus the .NET 8 runtime.
 *   2. Certificate file
 *        SKN_SIGN_PFX=<file.pfx>   SKN_SIGN_PFX_PASSWORD=<password>
 *      signtool when present, otherwise PowerShell's Set-AuthenticodeSignature.
 *   3. Certificate already in the Windows store
 *        SKN_SIGN_THUMBPRINT=<sha1 thumbprint>
 *
 * Optional: SKN_SIGN_TIMESTAMP=<rfc3161 url>, SIGNTOOL=<path to signtool.exe>
 *
 * Release gate: SKN_REQUIRE_SIGNED=1 (or --require-signed) makes the build fail
 * unless the delivered file ends up with a valid, publicly trusted signature.
 *
 * Usage:
 *   node build/sign-exe.mjs <exe>                  sign (if configured) and verify
 *   node build/sign-exe.mjs <exe> --report-only    only report the state
 *   node build/sign-exe.mjs <exe> --require-signed fail unless the signature is valid
 *   node build/sign-exe.mjs <exe> --state-file=<f> also write the result as JSON
 *
 * Exit code 0 when nothing to do or the signing attempt succeeded; 1 when a
 * configured route failed or the release gate is not satisfied.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PS = 'powershell.exe';
const DEFAULT_TIMESTAMP = 'http://timestamp.digicert.com';
const ACS_TIMESTAMP = 'http://timestamp.acs.microsoft.com/';

/** Locate signtool.exe: explicit env first, then the usual Windows SDK spots. */
function findSigntool() {
  const explicit = process.env.SIGNTOOL;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const roots = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin',
    'C:\\Program Files\\Windows Kits\\10\\bin',
  ];
  const found = [];
  for (const root of roots) {
    let versions;
    try {
      versions = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const version of versions) {
      for (const arch of ['x64', 'x86']) {
        const candidate = path.join(root, version, arch, 'signtool.exe');
        if (fs.existsSync(candidate)) found.push({ version, candidate });
      }
    }
  }
  found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return found.length > 0 ? found[0].candidate : null;
}

/** PowerShell that writes its result to a file: no pipes, works everywhere. */
function runPowerShell(script) {
  return spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: 'inherit',
  }).status;
}

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** What the file's signature really is right now. */
function inspect(exe) {
  // The result comes back through a file, not a pipe: that works in every
  // environment (some sandboxes forbid piped stdio) and leaves nothing behind.
  const jsonPath = path.join(path.dirname(exe), '.sigcheck.json');
  const script = `
$sig = Get-AuthenticodeSignature -LiteralPath ${quote(exe)}
$policy = ''
if ($sig.SignerCertificate) {
  foreach ($ext in $sig.SignerCertificate.Extensions) {
    $oid = [string]$ext.Oid.Value
    if ($oid -like '2.23.140.1.3*') { $policy = 'EV' }
    elseif ($oid -like '2.23.140.1.4*') { if ($policy -ne 'EV') { $policy = 'OV' } }
  }
}
$out = [ordered]@{
  status        = [string]$sig.Status
  statusMessage = [string]$sig.StatusMessage
  subject       = $(if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { '' })
  issuer        = $(if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Issuer } else { '' })
  thumbprint    = $(if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Thumbprint } else { '' })
  notAfter      = $(if ($sig.SignerCertificate) { $sig.SignerCertificate.NotAfter.ToString('s') } else { '' })
  timestamped   = $(if ($sig.TimeStamperCertificate) { 'yes' } else { 'no' })
  policy        = $policy
}
$out | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(jsonPath)} -Encoding utf8
`;
  const code = runPowerShell(script);
  if (code !== 0) return { status: 'Unknown', statusMessage: `检查失败（PowerShell 退出代码 ${code}）` };
  try {
    const raw = fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (error) {
    return { status: 'Unknown', statusMessage: `无法读取检查结果：${error.message}` };
  } finally {
    fs.rmSync(jsonPath, { force: true });
  }
}

function printInspection(exe, label) {
  const sig = inspect(exe);
  console.log(`[签名] ${label}`);
  console.log(`[签名]   状态    ：${sig.status}${sig.statusMessage ? `（${sig.statusMessage}）` : ''}`);
  if (sig.subject) {
    console.log(`[签名]   主体    ：${sig.subject}`);
    console.log(`[签名]   颁发者  ：${sig.issuer}`);
    console.log(`[签名]   有效期至：${sig.notAfter}   时间戳：${sig.timestamped}`);
    if (sig.policy) {
      console.log(`[签名]   证书类型：${sig.policy}${sig.policy === 'EV' ? '（扩展验证）' : '（组织验证）'}`);
    }
  }
  if (sig.status === 'Valid' && sig.timestamped !== 'yes') {
    console.log('[签名]   警告    ：签名没有时间戳。证书一到期该签名就失效——');
    console.log('[签名]             短周期证书（Artifact Signing 只有 3 天）必须带时间戳。');
  }
  return sig;
}

/**
 * Second opinion from signtool, which is what Windows itself uses for the
 * "Digital Signatures" tab: /pa checks the chain against the default policy,
 * /all checks every signature, /v prints the trust chain it validated.
 */
function verifyWithSigntool(exe) {
  const signtool = findSigntool();
  if (!signtool) return null;
  console.log(`[签名] signtool verify（${signtool}）`);
  const result = spawnSync(signtool, ['verify', '/pa', '/all', '/v', exe], { stdio: 'inherit' });
  return result.status;
}

/**
 * The release gate: with SKN_REQUIRE_SIGNED=1 (or --require-signed) the build
 * refuses to deliver anything whose signature is not valid and trusted, so an
 * unsigned file cannot be shipped by accident once a certificate exists.
 */
function gate(sig, state) {
  if (!requireSigned) return;
  if (sig.status === 'Valid') {
    console.log('[签名] SKN_REQUIRE_SIGNED 已满足：交付物是受公共信任的有效签名。');
    return;
  }
  console.error(`[签名] SKN_REQUIRE_SIGNED 已开启，但${state}（当前状态：${sig.status}）。构建失败。`);
  console.error('[签名]   没有证书时不要打开这个开关；证书不可用时应让构建失败，而不是交付未签名文件。');
  process.exit(1);
}

const args = process.argv.slice(2);
const reportOnly = args.includes('--report-only');
const requireSigned = args.includes('--require-signed') || process.env.SKN_REQUIRE_SIGNED === '1';
const stateArg = args.find((a) => a.startsWith('--state-file='));
const stateFile = stateArg ? path.resolve(stateArg.slice('--state-file='.length)) : null;
const exe = args.find((a) => !a.startsWith('--'));

/** Hands the build manifest the real signature state instead of a guess. */
function dumpState(sig) {
  if (!stateFile) return;
  try {
    fs.writeFileSync(
      stateFile,
      `${JSON.stringify(
        {
          status: sig.status,
          statusMessage: sig.statusMessage || '',
          subject: sig.subject || '',
          issuer: sig.issuer || '',
          policy: sig.policy || '',
          notAfter: sig.notAfter || '',
          timestamped: sig.timestamped || '',
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    console.error(`[签名] 无法写出状态文件 ${stateFile}：${error.message}`);
  }
}

if (!exe || !fs.existsSync(exe)) {
  console.error('用法：node build/sign-exe.mjs <exe> [--report-only]');
  process.exit(1);
}

const dlib = process.env.SKN_SIGN_DLIB;
const metadata = process.env.SKN_SIGN_METADATA;
const pfx = process.env.SKN_SIGN_PFX;
const pfxPassword = process.env.SKN_SIGN_PFX_PASSWORD || '';
const thumbprint = process.env.SKN_SIGN_THUMBPRINT;
const timestamp = process.env.SKN_SIGN_TIMESTAMP || null;

if (reportOnly || (!dlib && !pfx && !thumbprint)) {
  const sig = printInspection(exe, path.basename(exe));
  dumpState(sig);
  if (!reportOnly) {
    if (sig.status === 'NotSigned') {
      console.log('[签名] 未配置签名（SKN_SIGN_* 均为空）：交付的就是未签名版本。');
      console.log('[签名]   影响：浏览器下载后首次运行会有 SmartScreen 提示（可点“更多信息→仍要运行”）；');
      console.log('[签名]   若系统开启了“智能应用控制（强制模式）”，未签名程序会被直接拦下。');
      console.log('[签名]   说明：程序运行时会自动清除“来自网络”标记，因此同一份文件只会问一次；');
      console.log('[签名]   用 U 盘或局域网共享拷贝不带该标记，本来就不会提示。');
      console.log('[签名]   路线与花费见 build/SIGNING.md。');
    } else if (sig.status === 'Valid') {
      console.log('[签名] 已有有效签名。若仍出现 SmartScreen 提示，属信誉尚未积累：');
      console.log('[签名]   可把该文件提交到 https://www.microsoft.com/wdsi/filesubmission 选择');
      console.log('[签名]   “Microsoft Defender SmartScreen”申请复核。');
      if (sig.policy === 'EV') {
        console.log('[签名]   这是 EV 证书，通常不需要等信誉。');
      }
    } else {
      console.log('[签名] 签名存在但不受信任（自签名 / 私有 CA）。');
      console.log('[签名]   这不会让 SmartScreen 或智能应用控制放行，只是证明构建流程可用。');
    }
  }
  gate(sig, '交付物没有有效签名');
  process.exit(0);
}

// ---- sign ----------------------------------------------------------------

let signed = false;

if (dlib || metadata) {
  if (!dlib || !metadata) {
    console.error('[签名] 路线 1 需要同时设置 SKN_SIGN_DLIB 与 SKN_SIGN_METADATA。');
    process.exit(1);
  }
  const signtool = findSigntool();
  if (!signtool) {
    console.error('[签名] 未找到 signtool.exe：Artifact Signing 需要 Windows SDK 的 SignTool（10.0.2261.755 或更新）。');
    console.error('[签名]   可用 SIGNTOOL=<路径> 指定，例如 C:\\Program Files (x86)\\Windows Kits\\10\\bin\\<版本>\\x64\\signtool.exe');
    process.exit(1);
  }
  const result = spawnSync(
    signtool,
    [
      'sign', '/v', '/debug', '/fd', 'SHA256',
      '/tr', timestamp || ACS_TIMESTAMP, '/td', 'SHA256',
      '/dlib', dlib, '/dmdf', metadata, exe,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.error(`[签名] signtool 退出代码 ${result.status}，签名失败。`);
    process.exit(1);
  }
  signed = true;
} else if (pfx) {
  if (!fs.existsSync(pfx)) {
    console.error(`[签名] 找不到证书文件：${pfx}`);
    process.exit(1);
  }
  const signtool = findSigntool();
  const server = timestamp || DEFAULT_TIMESTAMP;
  let status;
  if (signtool) {
    status = spawnSync(
      signtool,
      ['sign', '/v', '/fd', 'SHA256', '/f', pfx, '/p', pfxPassword, '/tr', server, '/td', 'SHA256', exe],
      { stdio: 'inherit' },
    ).status;
  } else {
    console.log('[签名] 未找到 signtool，改用 PowerShell Set-AuthenticodeSignature。');
    status = runPowerShell(`
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(${quote(pfx)}, ${quote(pfxPassword)})
if (-not $cert.HasPrivateKey) { Write-Error '证书不含私钥'; exit 2 }
$r = Set-AuthenticodeSignature -FilePath ${quote(exe)} -Certificate $cert -HashAlgorithm SHA256 -TimestampServer ${quote(server)}
"Set-AuthenticodeSignature：$($r.Status) $($r.StatusMessage)"
`);
  }
  if (status !== 0) {
    console.error(`[签名] 签名失败（退出代码 ${status}）。`);
    process.exit(1);
  }
  signed = true;
} else if (thumbprint) {
  const signtool = findSigntool();
  if (!signtool) {
    console.error('[签名] 路线 3 需要 signtool.exe（可用 SIGNTOOL=<路径> 指定）。');
    process.exit(1);
  }
  const status = spawnSync(
    signtool,
    ['sign', '/v', '/fd', 'SHA256', '/sha1', thumbprint, '/tr', timestamp || DEFAULT_TIMESTAMP, '/td', 'SHA256', exe],
    { stdio: 'inherit' },
  ).status;
  if (status !== 0) {
    console.error(`[签名] 签名失败（退出代码 ${status}）。请确认指纹存在于证书存储中且含私钥。`);
    process.exit(1);
  }
  signed = true;
}

if (signed) {
  const sig = printInspection(exe, `${path.basename(exe)}（签名后）`);
  dumpState(sig);
  if (sig.status === 'Valid') {
    const verified = verifyWithSigntool(exe);
    if (verified !== null) {
      console.log(verified === 0
        ? '[签名] signtool verify 通过：证书链、时间戳与文件摘要都有效。'
        : `[签名] signtool verify 返回 ${verified}：Windows 可能仍不信任这个签名，请核对证书链。`);
    }
    console.log('[签名] 完成：证书链受信任。SmartScreen 首次仍可能提示（信誉按文件/证书积累），');
    console.log('[签名]   必要时应把文件提交到 wdsi 申请复核；智能应用控制将认可该签名。');
  } else if (sig.status === 'NotSigned') {
    console.log('[签名] 注意：签名工具报了成功，但文件仍然显示未签名。');
    console.log('[签名]   常见原因：签名工具是替身/未真正执行、写入被拦、或签名被后面覆盖。');
    console.log('[签名]   这时不要交付——SKN_REQUIRE_SIGNED=1 会让构建直接失败。');
  } else if (sig.status !== 'NotSigned') {
    console.log('[签名] 注意：签名已写入，但证书链不受公共信任 —— 自签名或私有 CA 不会让');
    console.log('[签名]   SmartScreen / 智能应用控制放行。要真正解决，必须使用公共 CA 签发的证书。');
  }
  gate(sig, '签名后仍然不是受信任的有效签名');
}