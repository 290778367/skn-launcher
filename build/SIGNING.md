# 解决 SmartScreen「Windows 已保护你的电脑」

先给结论：**这一条只能靠公共 CA 签发的代码签名证书解决**，程序内部没有任何办法绕过——它不是"文件可疑"，而是"这个文件（或签它的证书）在微软那边还没有信誉"。程序能做的只有三件事：把"拿到证书之后要干的事"压成一条命令、在没有证书时把提示降到最低、以及没签名时拒绝交付。

## 一、先分清是哪一种拦截

| 机制 | 触发条件 | 唯一解法 | 本项目的现状 |
| --- | --- | --- | --- |
| SmartScreen「Windows 已保护你的电脑」 | 文件带 Mark of the Web（浏览器下载、ZIP 解压），且**文件与签名证书都没有信誉** | 代码签名（信誉按文件/证书积累）；或换一种不带标记的交付方式 | 无证书 → 仍会提示一次，程序会自动清除标记，之后不再提示 |
| 智能应用控制（SAC）强制模式 | 系统开了 SAC，程序未知且未签名 | 只能代码签名（公共 CA），没有「仍要运行」 | 无证书 → 会被直接拦下 |
| 杀软 / SmartScreen 误报 | 「自解压 + 释放大文件 + 拉起子进程」这类行为特征 | 提交误报复核；签名有助于建立信誉 | 已选最温和的实现（系统自带 tar、不释放第三方工具），但仍可能被敏感杀软盯上 |

微软文档的原文依据：SmartScreen 判定下载文件时，会「检查下载的文件是否在**广为人知且被频繁下载**的列表里；如果不在，就给出警告」，并且「对 URL、文件、应用以及**用于签名的数字证书**做信誉检查；如果某项已有信誉，用户就不会看到警告」。来源：[Microsoft Defender SmartScreen 概述](https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/)。同一页还明确写了 SmartScreen **不检查内部位置与网络共享（UNC / SMB）**——这就是下面"降级方案 3"的依据。

关键推论：**未签名文件的信誉是按文件哈希算的**，所以每重新构建一次就从头再来；签名之后信誉挂在证书上，这才是耐用的解法。

## 二、四条候选路线（含资格限制）

### 路线 1：公共 CA 的 OV / EV 代码签名证书 —— 中国大陆唯一现实的选择

- 自 2023 年 6 月起，CA/B Forum 要求代码签名证书的私钥必须存放在 **FIPS 140-2 Level 2 / Common Criteria EAL4+ 的硬件令牌**里，或者使用 CA 提供的**云签名服务**（两者都是为了让私钥不可导出）。所以"买一张 .pfx 文件"的时代已经过去了。
- **EV 证书**历来被认为能让 SmartScreen 立刻放行（不靠信誉积累），**OV 证书**则要靠下载量/时间积累信誉。这条"EV 立即生效"我这次没能抓到微软当前 FAQ 的原文（`fb.smartscreen.microsoft.com` 抓取失败），**办理前请直接问 CA 要书面说明**。
- 花费差异很大：境外 CA（Sectigo、DigiCert、GlobalSign、Certum 等）与国内 CA（如 TrustAsia、CFCA 等）的 OV 报价通常在每年数百到数千元人民币，EV 更高。**务必确认对方的根证书在 Microsoft Trusted Root Program 里**（不在就完全没用），并确认他们提供 Windows 上的签名工具或云签名 API。
- 拿到之后在本项目里的用法见下面第三节，不需要改任何代码。

### 路线 2：Artifact Signing（微软的服务，原 Azure Trusted Signing）——**不面向中国大陆**

官方 Quickstart（2026-05-21 更新）原文：

> Public Trust certificates are available to organizations in the United States, Canada, the European Union, the United Kingdom, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway, and Israel. **Individual developers must be located in the United States or Canada.** These geographic restrictions do not apply to Private Trust certificates.

也就是说：**组织必须位于上面这些国家/地区，个人开发者仅限美国或加拿大**；签署端点也只部署在 Brazil South、Central US、East US、Japan East、Korea Central、North Central US、North Europe、Poland Central、South Central US、Switzerland North、West Central US、West Europe、West US、West US 2、West US 3。**中国大陆的实体与个人都不符合 Public Trust 资格**，Private Trust 虽然不受地域限制，但对 SmartScreen 完全无用（不是公共信任链）。

- 如果你有海外实体或符合资格的个人身份，这条路依然是最省事的：不用买证书、不用硬件令牌，私钥在 FIPS 140-3 Level 3 HSM 里，按 SKU 月费（官方发布时为 Basic 每月约 10 美元、Premium 每月约 100 美元；定价页由脚本渲染，本次未能读到，**以官网为准**）。流程：Entra 租户 + 付费 Azure 订阅 → 创建 Artifact Signing 账户 → 身份验证（组织 1～20 个工作日、需要营业执照/域名发票等；个人用政府证件）→ 建证书配置文件 → 用 dlib 签名。本项目已经支持这条路线（见第三节）。
- 来源：[Artifact Signing 概览](https://learn.microsoft.com/en-us/azure/artifact-signing/overview)、[Quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)、[定价页](https://azure.microsoft.com/pricing/details/artifact-signing/)。

### 路线 3：开源 + SignPath Foundation（**本项目的选择**，免费）

[SignPath Foundation](https://signpath.org/) 给开源项目免费提供代码签名：证书由他们签发（主体是 SignPath Foundation），私钥存在他们的 HSM 里。他们验证的是「这个二进制确实是由你的公开仓库的 CI 构建出来的」，并用自己的名义为此背书——所以**不需要你的个人或公司身份验证，也不需要买硬件令牌**。代价是：项目必须真开源，构建必须走 CI，签名主体显示的是 SignPath Foundation 而不是你。

| 事项 | 谁负责 |
| --- | --- |
| 签发证书、保管私钥、加盖时间戳 | SignPath（免费，HSM 内） |
| 保证二进制由公开仓库的 CI 构建 | 本仓库的 GitHub Actions：必须用 **GitHub 托管 runner**，且产物必须先上传成 workflow artifact |
| 说明要签文件里的哪几个文件 | 本仓库的 [`build/signpath/artifact-configuration.xml`](signpath/artifact-configuration.xml) |

**申请步骤**

1. 先把仓库推成公开仓库（SignPath 要审阅代码与构建过程），并确认 [LICENSE](../LICENSE) 是 OSI 认可的开源许可（本仓库用 MIT）。
2. 到 <https://signpath.org/apply> 填表，先读一下他们的 [Terms](https://signpath.org/terms)。需要准备的信息：
   - 仓库地址、项目名、英文一句话说明、开源许可名称
   - 构建方式：`npm ci` → `npm test` → `npm run build`，Windows GitHub 托管 runner，CI 文件路径 `.github/workflows/build.yml`
   **可以直接粘贴的英文说明**（SignPath 的审阅人读这个，按自己情况删改）：

   > SKN Launcher is a small Electron shell that runs the official SKN keyboard web driver
   > (launcher.skn.net.cn) as a Windows application. It talks to the keyboard directly over
   > WebHID (VIA/QMK) and never re-implements the protocol: the UI and the key-mapping logic are
   > the vendor's official web app running inside a bundled Chromium. MIT licensed, built only
   > in public CI, and it writes nothing outside the folder the user installs it into.
   >
   > Why we need signing: the release is one self-contained .exe that users download from GitHub
   > Releases. Because it is unsigned, Windows SmartScreen shows "Windows protected your PC" on
   > the first run and some users stop there. A publicly trusted signature is the only real fix,
   > and this is a non-commercial open-source utility, which is why we are applying to the
   > SignPath Foundation.
   >
   > Build (all on GitHub-hosted windows-latest runners, .github/workflows/build.yml):
   > npm ci -> npm test (three headless suites) -> npm run build (compiles the C# shell with the
   > .NET Framework csc shipped with Windows, packs the Electron payload with the system
   > tar.exe/xz) -> actions/upload-artifact -> signing request. No prebuilt binaries are
   > committed to the repository; the whole payload is produced by the workflow.
   >
   > Artifact to sign: the single file SKN-Launcher-setup.exe inside the uploaded artifact
   > (artifact configuration: build/signpath/artifact-configuration.xml, authenticode). After
   > signing, CI renames it to the user-facing name and re-reads the signature state to prove the
   > rename did not break the signature.
3. 通过后，在 SignPath 控制台拿到 **organization id**、**project slug**、**signing policy slug**、**artifact configuration slug**，并把 [`build/signpath/artifact-configuration.xml`](signpath/artifact-configuration.xml) 的内容建成 artifact configuration（注意根元素是 `<zip-file>`：GitHub 的 `actions/upload-artifact` 默认把产物打成 ZIP）。
4. 在本仓库 **Settings → Secrets and variables → Actions** 里配置六个值：

   | 类型 | 名称 | 值 |
   | --- | --- | --- |
   | Secret | `SIGNPATH_API_TOKEN` | SignPath 控制台生成的 API token（需要有提交签名请求的权限） |
   | Variable | `SIGNPATH_ORGANIZATION_ID` | 组织 ID |
   | Variable | `SIGNPATH_PROJECT_SLUG` | 项目 slug |
   | Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | 签名政策 slug（开源项目用他们给的那条） |
   | Variable | `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` | 产物配置 slug |
   | Variable | `SKN_REQUIRE_SIGNED` | 设为 `1` 就会**拒绝**发布未签名版本（没证书时别开） |

5. 之后每次推 `v*` 标签：CI 构建 → 上传未签名产物 → 提交签名请求 → 复核 → 发 Release。上面任何一项缺失都只是跳过签名，并在日志与 Release 说明里明确写「未签名」，绝不假装签过。

**本仓库已经写好的部分**：workflow 的全部步骤、产物配置、签名后的强制复核（`node build/sign-exe.mjs <文件> --require-signed`：跑 `signtool verify /pa /all`、检查时间戳、识别 EV/OV）。剩下要做的只有「推仓库 + 申请 + 填六个值」。

**文件名是怎么安排的（别改错）**：签名服务从始至终只见到 ASCII 名 `SKN-Launcher-setup.exe`（产物配置里 `path` 就是它），因为 GitHub 在 Windows runner 上把 `run` 脚本写盘后由 `powershell` 按代码页读取，脚本里的非 ASCII 字面量会被搞坏。面向 Release 的资产名在**签名之后**由 `build/release-assets.mjs`（node，UTF-8 安全）定为 `SKN-Launcher-Setup-<版本>.exe`，并顺带生成 Release 说明。**发布资产名不能用中文**：实测 GitHub 服务端会删掉资产名里的非 ASCII 字符（`SKN 键盘驱动.exe` → `SKN.exe`），所以中文只保留在程序内部——安装后的程序名与 PE 元数据里的「原始文件名」都是 `SKN 键盘驱动.exe`。Authenticode 按文件内容校验，签名后改名不会让签名失效——脚本会在改名后重新读一遍签名状态来证明这点。

**一个必须知道的边界（智能应用控制）**：程序运行时会把 Electron 解压到安装目录，而 **Electron 官方发布的二进制本身就没有签名**（实测 `electron.exe` 状态 `NotSigned`），所以外壳即使签了名，安装目录里的 `SKN 键盘驱动.exe` 仍然是未签名的。微软文档的口径是：强制模式下「应用和**二进制文件**只有被应用智能服务识别、或用信任根列表里的 CA 签过名才能运行」，因此**开了 SAC 强制模式的机器仍可能拦下内部那个 Electron 进程**。要彻底覆盖，需要两段式流水线：先把负载里的 exe 交给 SignPath 签好，再打包、再签外层（SignPath 的产物配置支持 ZIP 内嵌套 PE 文件）。这属于后续可选工作，不影响 SmartScreen 这条主线。

### 路线 4：微软商店（MSIX）

由商店重签名的包不触发 SmartScreen，但商店对"只是把网页包一层"的应用有额外审核要求，还需要开发者账号（一次性费用）与提交认证——比买证书更重，一般不作首选。

## 三、拿到证书之后：本项目里的一条命令

签名步骤已经内置在构建里，配好环境变量后重建即出签名版，并且签完会自动复核。

```powershell
# 路线 A：证书已经装进 Windows 证书存储（硬件令牌插好、或 CA 的云签名客户端已登录）
$env:SKN_SIGN_THUMBPRINT = '<证书指纹 SHA1>'

# 路线 B：有 .pfx（注意：现制证书的私钥大多不可导出，这条路常用于自建 CA 的测试）
$env:SKN_SIGN_PFX          = 'D:\certs\codesign.pfx'
$env:SKN_SIGN_PFX_PASSWORD = '<口令>'

# 路线 C：Artifact Signing（需要海外资格）
$env:SKN_SIGN_DLIB     = '<dlib 目录>\x64\Azure.CodeSigning.Dlib.dll'
$env:SKN_SIGN_METADATA = '<metadata.json 路径>'

# 时间戳（可选；默认按路线取 DigiCert / 微软 ACS）
$env:SKN_SIGN_TIMESTAMP = 'http://timestamp.digicert.com'
# 非标准路径的 signtool
$env:SIGNTOOL = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe'

# 出交付物 + 上闸门：没有有效签名就让构建失败
$env:SKN_REQUIRE_SIGNED = '1'
node build\make-single-exe.mjs ..\dist-v2\SKN 键盘驱动.exe
```

构建脚本会做这些事（都已实现并可单独调用）：

| 动作 | 命令 | 说明 |
| --- | --- | --- |
| 只报告签名状态 | `node build/sign-exe.mjs <exe> --report-only` | 打印状态、主体、颁发者、有效期、是否带时间戳、证书类型（EV/OV） |
| 强制要求已签名 | `node build/sign-exe.mjs <exe> --report-only --require-signed` | 不满足则以退出码 1 失败（构建里的 `SKN_REQUIRE_SIGNED=1` 就是这个） |
| 第三方复核 | 签名后自动跑 `signtool verify /pa /all /v <exe>` | 证书链、时间戳、文件摘要都验一遍，和 Windows 属性页「数字签名」用的是同一套判断 |
| 时间戳检查 | 自动 | 短周期证书（Artifact Signing 只有 3 天）没有时间戳就报警：证书一过期签名即失效 |

三条路线实际下发的命令行（用 `build/tools/fake-signtool.cs` 记录，已实测）：

```
sign /v /debug /fd SHA256 /tr http://timestamp.acs.microsoft.com/ /td SHA256 /dlib <dlib> /dmdf <metadata.json> <exe>
sign /v /fd SHA256 /f <pfx> /p <password> /tr <时间戳> /td SHA256 <exe>
sign /v /fd SHA256 /sha1 <thumbprint> /tr <时间戳> /td SHA256 <exe>
```

**不要用自签名证书充数**：签名能写进去，但证书链不在公共信任里，SmartScreen 与 SAC 都不认。脚本会明确打印这个判断，不会让人误以为问题已解决。

## 四、还没有证书时的降级方案（都已内置）

1. **运行即自动解除锁定**：程序每次启动都会清掉自己文件上的 `Zone.Identifier`（就是 exe 属性页里「解除锁定」那个标记，背后是同一个 Win32 `DeleteFileW` 调用）。所以**同一份文件只会提示一次**。
2. **`SKN 键盘驱动.exe --unblock`**：手动清除 exe 自身 + 安装目录整棵树的标记；等价于 PowerShell 的 `Unblock-File .\SKN 键盘驱动.exe`。
3. **换一种交付方式，根本不带标记**：U 盘 / 移动硬盘拷贝、局域网共享（UNC/SMB）、云盘客户端同步到本地——这些路径写出来的文件没有 Mark of the Web，SmartScreen 不会提示（微软文档明确说明不检查内部位置与网络共享）。
4. **提交复核**：认为被误判，可提交到 <https://www.microsoft.com/wdsi/filesubmission>，产品菜单里选 **Microsoft Defender SmartScreen**。
5. **告诉使用者怎么点**：首次提示时「更多信息」→「仍要运行」。装完就不再提示（因为标记已被清除）。

## 五、边界（别期待签名能带来什么）

- 签名**不会**改变程序行为：安装目录、`data` 位置、"只写一个目录"这些性质都不变。
- 签名**不会**免除首次提示（除 EV 证书外，OV 仍要积累信誉），也**不会**让行为特征敏感的杀软立刻安静。
- SAC 强制模式下，未签名程序无法运行；关掉 SAC 需要重置或重装系统才能再打开，别把它当临时开关用。
- 每次重新构建的 exe 都是新哈希：未签名时信誉清零重来；签名后信誉跟着证书走。

## 参考

- [Microsoft Defender SmartScreen 概述](https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/)（信誉机制、不检查网络共享、提交入口）
- [提交文件分析](https://learn.microsoft.com/en-us/microsoft-365/security/intelligence/submission-guide)
- [Artifact Signing 概览](https://learn.microsoft.com/en-us/azure/artifact-signing/overview) / [Quickstart（含资格与地区）](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart) / [SignTool 集成](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations) / [定价](https://azure.microsoft.com/pricing/details/artifact-signing/)
- [Smart App Control 概述](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)（强制模式只放行"被应用智能服务识别或有受信任签名"的应用与二进制文件）
- [Unblock-File](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/unblock-file)
- [SignPath Foundation（开源免费签名）](https://signpath.org/) / [申请入口](https://signpath.org/apply) / [条款](https://signpath.org/terms)
- [SignPath 的 GitHub 接入](https://docs.signpath.io/trusted-build-systems/github)（托管 runner、产物必须先成为 workflow artifact 等硬性要求）/ [产物配置语法](https://docs.signpath.io/artifact-configuration/syntax)