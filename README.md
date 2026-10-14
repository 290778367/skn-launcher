# SKN 键盘驱动（桌面版）

> **English summary** — A small Electron shell that runs the official SKN keyboard web driver (`launcher.skn.net.cn`) as a Windows app, talking to the keyboard directly over WebHID (VIA/QMK), with an offline cache and automatic device selection. One self-contained `.exe`; everything it writes stays inside its own folder — no registry, no `%APPDATA%`, no `%TEMP%`. MIT licensed. CI builds the release and, once the project is approved, signs it with the [SignPath Foundation](https://signpath.org/) OSS certificate, which is what removes the Windows SmartScreen warning. The details below are in Chinese.

把 SKN 官方的网页驱动 <https://launcher.skn.net.cn/#/keymap> 变成 Windows 上可双击运行的 `.exe` 程序。

程序不重新实现键盘协议，而是给官方网页驱动套一层桌面外壳：界面、改键逻辑、固件升级流程全部沿用官方最新版本，跑在应用内置的 Chromium 里，**通过 WebHID 直接和键盘通信**（VIA 协议），不需要安装任何额外驱动，键盘数据也不经过网络。

交付物只有一个 exe。**双击就是安装版**：弹窗选一个安装目录（默认是剩余空间最大的非系统盘），程序本体、设置、缓存、`卸载.exe` 全部只写在那个目录里；加 `--portable` 则退回「exe 旁边一个带隐藏属性的目录」的便携模式。两种模式都不写 `%APPDATA%` / `%LOCALAPPDATA%` / `%TEMP%`，也不写注册表——详见「[安装版 / 便携版与写入范围](#安装版--便携版与写入范围)」。它启动时还会自动清除自己的「来自网络」标记，所以 SmartScreen 最多只问一次——见「[签名与系统拦截](#签名与系统拦截)」。

## 下载

从本仓库的 **Releases** 下载 `SKN 键盘驱动.exe`（单文件，约 95 MB，SHA256 与签名状态都写在 Release 说明里）。

- **未签名版本**：浏览器下载后首次运行会出现「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」即可；程序会清掉自己的「来自网络」标记，同一份文件不会再问第二次。用 U 盘或局域网共享拷贝则完全不提示。
- **签名版本**：项目通过 [SignPath Foundation](https://signpath.org/) 的免费开源签名后，Release 里的文件就是已签名的，不再出现该提示。当前状态以 Release 说明里的 `signature:` 一行和构建日志为准。

## 开源与许可

- 许可：[MIT](LICENSE)。可以自由使用、修改、再分发，包括商用。
- 参与开发：[CONTRIBUTING.md](CONTRIBUTING.md)（不接受遥测、不接受第二个写盘位置、不接受重量级依赖）。
- 安全边界与报告方式：[SECURITY.md](SECURITY.md)。
- 持续集成：[`.github/workflows/build.yml`](.github/workflows/build.yml) —— 每次提交都跑测试 + 构建，打 `v*` 标签时自动发 Release。

**免责声明**：这是第三方桌面外壳，与 SKN / Keychron 官方无隶属关系。界面、键位数据与固件升级流程都来自官方站点，图标沿用官方站点的 favicon。改键与固件刷写本身有风险（刷写失败可能损坏键盘），请先阅读官方说明，风险自负。

## 为什么可以这样做

抓取官方前端 `main.*.js` 后确认，网页驱动与键盘的唯一通道是 WebHID：

| 位置 | 证据 |
| --- | --- |
| 设备请求 | `navigator.hid.requestDevice({filters:[{usage:97,usagePage:65376},{usage:1,usagePage:140},{usage:1,usagePage:65473},{usage:1,usagePage:65290}]})` |
| 主通道 | `usagePage 65376 / usage 97` = `0xFF60 / 0x61`，即 VIA / QMK 原始 HID 接口 |
| 其他接口 | `0xFFC1`、`0xFF0A`（无线接收器）、`0x8C`（厂商键盘页） |
| 现有设备 | `navigator.hid.getDevices()`，并按上述 usagePage 过滤 |

也就是说，浏览器里除了「选择设备」这个弹窗之外，没有什么是桌面程序做不到的。本程序补上的正是这部分：

- **自动选择设备**：`select-hid-device` 事件里按上述 usagePage 打分挑选，优先选已配对的键盘；只有同时插着不同型号键盘时才弹窗询问。
- **持久化授权**：`setDevicePermissionHandler` 记住已配对的键盘，重启程序后 `getDevices()` 仍能拿到它，插上就自动连。
- **放开 HID 屏蔽名单**：`disable-hid-blocklist`，避免厂商私有接口被 Chromium 的防键盘记录屏蔽名单挡住。
- **离线缓存**：`session.protocol.handle('https', …)` 做 stale-while-revalidate 缓存，断网也能打开界面改键。

> 顺带发现：这套前端是 Keychron Launcher 的多品牌版本，`assets/favicon/` 下有 `favicon-skn.ico`、`favicon-keychron.ico`、`favicon-lemokey.ico` 等一整套品牌图标；`launcher.skn.net.cn` 在它的站点配置里落到 `other` 档，数据来自 `launcher.keychron.cn` 的 `/static/` 与 `/vapi/`。

## 目录结构

```
skn-launcher/
├─ src/
│  ├─ main.js                 主进程：窗口、菜单、WebHID 选择与授权、自检钩子
│  ├─ paths.js                全部写盘位置的唯一来源（只写 exe 所在目录，见下）
│  ├─ cache.js                离线缓存（仅缓存官方首方域名，排除统计域名）
│  ├─ devices.js              HID 打分 + 已配对键盘记录
│  ├─ chooser.html            多把键盘时的选择窗口
│  ├─ chooser-preload.js      选择窗口的 IPC 桥
│  ├─ offline.html            首次启动且断网时的提示页
│  ├─ motion.css              覆盖官方键帽过渡：键帽直接落位，不再缓慢归位/淡入
│  └─ assets/                 程序图标（取自官网 favicon-skn.ico）
├─ build/
│  ├─ icon.ico                多尺寸图标 16→256
│  ├─ stub.cs                 单文件外壳（C#：安装/便携 + 解压 + 启动 + 沙箱自愈 + --help）
│  ├─ uninstall.cs            卸载程序（C#：装进负载里的 卸载.exe，只删自己所在目录）
│  ├─ package.mjs             解包应用（单文件构建的中间步骤，含「无多余文件」校验）
│  ├─ make-portable-exe.mjs   系统 tar 压成 tar.xz + 把负载拼到外壳后面
│  ├─ make-single-exe.mjs     一条命令出交付物：编译 C# → 临时目录构建 → exe → 签名 → 删临时目录
│  ├─ sign-exe.mjs            签名入口（SignPath / Artifact Signing / PFX / 证书指纹）+ 复核与交付闸门
│  ├─ release-assets.mjs      发布前整理：改名成 SKN 键盘驱动.exe + 校验值 + Release 说明（中文名交给 node，避开代码页陷阱）
│  ├─ publish-release.mjs     调 GitHub API 发 Release（自带 action 会把中文资产名压成 SKN.exe，只能用 API 自己传）
│  ├─ SIGNING.md              SmartScreen 的成因、四条证书路线的资格与花费、降级方案
│  ├─ signpath/
│  │  └─ artifact-configuration.xml  SignPath 产物配置：说明要签的是哪个文件
│  └─ tools/
│     ├─ probe-app.cs         仅测试用：模拟「启动即 0x80000003 退出」
│     ├─ sleeper.cs           仅测试用：一个赖着不退出的进程，验证卸载程序"程序仍在运行"的拒绝
│     └─ fake-signtool.cs     仅测试用：记录 signtool 收到的参数，验证签名命令拼装
├─ tools/
│  ├─ unit-test.mjs           纯逻辑单元测试（HID 打分、配对记录）
│  ├─ motion-test.mjs         motion.css 对官方键帽过渡的覆盖完整性
│  ├─ paths-test.mjs          「只写 exe 所在目录」规则的证明与回归
│  └─ cache-test.mjs          离线缓存行为（需要真实负载，按需运行）
├─ .github/workflows/build.yml  CI：测试 → 构建 → SignPath 签名 → 复核 → 发 Release
├─ LICENSE                    MIT
├─ CONTRIBUTING.md            参与开发的要求与自检清单
├─ SECURITY.md                安全边界与报告方式
└─ package.json / package-lock.json / .gitignore / .gitattributes
```

## 构建

```powershell
# 1. 安装依赖
npm ci

#    受限环境下 Electron 的 postinstall 会 spawn EPERM，那就分两步来：
#    npm install --ignore-scripts --no-audit --no-fund
#    $env:electron_config_cache = "$PWD\.electron-cache"   # 二进制落在这里，不写用户目录
#    $env:ELECTRON_MIRROR       = 'https://npmmirror.com/mirrors/electron/'
#    node node_modules/electron/install.js

# 2. 测试（三个都无界面，几十毫秒）
npm test

# 3. 一条命令产出唯一的交付物：单文件 exe
#    （外壳与卸载程序由脚本自己用 Windows 自带的 csc 编译，不需要别的工具链）
npm run build -- '..\dist-v2\SKN 键盘驱动.exe'
#    等价于 node build/make-single-exe.mjs ..\dist-v2\SKN 键盘驱动.exe
#    配好 SKN_SIGN_* 就会顺带签名，并打印 / 记录签名状态（见 build/SIGNING.md）

# 附：文件夹版（本地调试用，不是交付物）
npm run package                 # 产物默认写到 ..\dist，可用 $env:SKN_OUT 换成别的目录
```

产物：

- `dist-v2/SKN 键盘驱动.exe` —— 交付物，只有这一个文件（见下：双击是安装版，`--portable` 是便携版）

CI（[`.github/workflows/build.yml`](.github/workflows/build.yml)）在 `windows-latest` 上跑同一套命令：`npm ci` → `npm test` → 构建 → 配了 SignPath 就签名并复核 → 整理发布资产 → 打 `v*` 标签时发 Release。

**关于文件名**：仓库内部与签名服务全程只用 ASCII 名 `SKN-Launcher-setup.exe`（GitHub 会把 `run` 脚本写盘后由 `powershell` 按代码页读取，脚本里的非 ASCII 字面量会被搞坏），面向用户的文件在**签名之后**由 node 改名成 `SKN 键盘驱动.exe`（`npm run release-assets`，见 [`build/release-assets.mjs`](build/release-assets.mjs)）。Authenticode 是按文件内容校验的，改名不会让签名失效——脚本会在改名后重新读一遍签名状态来证明，而不是假设。另外外壳本身就以中文名编译（`csc /out` 的文件名会写进 PE 的 `OriginalFilename`），所以 exe 属性页里看到的「原始文件名」也是 `SKN 键盘驱动.exe`。

## 写入范围

规则只有一条，写在 `src/paths.js` 里：**只写应用 exe 所在的那个目录，别处一概不写**。

- 主进程启动时把 Electron 的 `userData`（整个 Chromium profile：Cache、GPUCache、IndexedDB、Local Storage…）、`temp`、`crashDumps`、`logs` 全部指到该目录下，所以 `%APPDATA%`、`%LOCALAPPDATA%`、`%TEMP%` 一律不碰；注册表也不写。
- 不再有 `portable.txt` 之类的开关：打包版与开发版都由代码直接决定路径（开发版写进项目的 `.dev\`，不污染用户目录）。
- `tools/paths-test.mjs` 把这条规则变成断言：所有目录必须与 exe 同盘、必须落在运行根目录内、不得出现 `AppData` / `Application Data` 字样，并回归检查 `main.js` 是否真的调用了那四个 `setPath`。

单文件版把这条规则平移到程序自己的目录：**安装版**把负载展开到用户选定的安装目录（程序本体、`data\`、`temp\`、`crash\`、`logs\` 全在里面）；**便携版**展开到 **exe 旁边的隐藏目录 `<exe 所在目录>\SKN 键盘驱动\`**。便携版目录可用 `SKN_RUNTIME_DIR=<目录>` 固定（例如指向 U 盘），安装版可用 `--install-dir=<目录>` 指定；目录不可写时不会退到系统目录，而是报错提示。

## Chromium 沙箱与 0x80000003

Chromium 的进程沙箱是 **fail-closed** 的：隔离建立不起来时它直接中止进程，而不是降级运行。在部分机器上（受限启动令牌、严格策略、虚拟机）沙箱无法初始化，表现为**双击后窗口永不出现**，Windows 应用程序日志里留下：

```
出错应用程序名称： SKN Launcher.exe
异常代码： 0x80000003    (STATUS_BREAKPOINT —— Chromium 内部断言主动下断点)
出错模块名称： SKN Launcher.exe
```

崩溃时机可以从产物目录反推：`data\` 下 Chromium 的 `Cache`、`GPUCache`、`Network`、`Local Storage` 都已建好，但应用自己的 `data\webcache` 是空的 —— 主进程、配置初始化、网络服务都跑过去了，倒在创建子进程这一步。

实测排除掉的常见原因：

| 怀疑对象 | 检查结果 |
| --- | --- |
| 系统级 Mandatory ASLR（Exploit Protection） | `Get-ProcessMitigation -System` 全部 `NOTSET` |
| UAC 关闭（管理员令牌下沙箱不受支持） | `EnableLUA = 1` |
| IFEO 强加缓解措施 | 无 `SKN Launcher.exe` / `electron.exe` 项 |
| 第三方杀软 / EDR 内核驱动 | 驱动目录只有微软自带（`kbdclass` 等），安全服务只有 `webthreatdef*` |

应对有两层：

- **自动**（单文件版）：外壳先正常启动，若 7 秒内异常退出则自动带 `--no-sandbox` 重启一次，静默完成，不写任何记录文件；
- **手动**：给 exe 加 `--no-sandbox` 参数启动，功能完全一致（建快捷方式时写在目标后面）。

## 安装版 / 便携版与写入范围

一个 exe 两种用法，**默认是安装版**：

```
node build/make-single-exe.mjs ..\dist-v2\SKN 键盘驱动.exe
        ↓ 内部：csc 编译外壳与卸载程序 → packager → build/.scratch
        → tar.xz 压缩 + 拼接 → 删除 .scratch
dist-v2/SKN 键盘驱动.exe   94.1 MB（98,685,196 字节）   ← 交付物只有这一个文件
   = 外壳 exe（106 KB，C#，编译成 SKN 键盘驱动.exe）+ tar.xz 负载 (94.0 MB) + "SKNPKG02" + int64 负载长度
```

**安装版（直接双击）**：先弹一个小窗口选安装位置，默认是**非系统盘中剩余空间最大的盘**（本机即 `D:\SKN 键盘驱动`），可以改路径或点「浏览」。确定后外壳把负载展开到那里、把应用改名成 `SKN 键盘驱动.exe`，随即启动。再次运行安装包并选同一个目录就是**更新**：程序文件覆盖，`data\` 里的设置与缓存保留。

```
D:\SKN 键盘驱动\              ← 安装目录（普通可见目录，不是隐藏目录）
├─ SKN 键盘驱动.exe           应用本体
├─ 卸载.exe                   卸载程序（删掉本目录，不写注册表）
├─ data\                      设置、离线缓存、已配对键盘（Chromium 整个 profile）
├─ temp\  crash\  logs\       Chromium 的临时文件、崩溃转储、日志
└─ .build-id                  内部标记，用来跳过重复展开
```

**便携版（`--portable`）**：不安装，仍在 exe 旁边建一个隐藏目录运行——U 盘等**可移动盘上会自动选这个模式**，不弹选择窗口。适合随身携带、即拷即用。

**tar.xz 负载，压缩解压都交给 Windows 自带的 `tar.exe`**（bsdtar，带 liblzma）：构建期 `tar -cJf`，首次运行 `tar -xf`。因此**不附带任何第三方打包器**，运行时也不会往磁盘上丢一个解压工具（那种"释放工具再执行"的行为正是杀软盯得最紧的）。xz 比原来手写的 deflate zip 省 34%：324.3 MB 负载压到 94.0 MB（29.0%），单文件从 133.3 MB 降到 **94.13 MB**。代价是首次展开从 7 秒变成约 10 秒（含 Defender 扫描新写出的 exe）。想再挤一点体积可以构建时设 `SKN_XZ_LEVEL=9`（更慢，通常多省 1～3%）。只有 Windows 10 1803 之前的系统没有 `tar.exe`——那种系统请用文件夹版。

**写入范围只有那一个目录**：`src/paths.js` 把 Electron 的 `userData` / `temp` / `crashDumps` / `logs` 全部指进同一个地方，所以**不写 `%APPDATA%`、`%LOCALAPPDATA%`、`%TEMP%`，也不写注册表**。没有"目录不可写就退到系统目录"的回退——不可写时直接报错并提示换位置（安装版可用 `--install-dir=<目录>` 指定，便携版可用 `SKN_RUNTIME_DIR=<目录>` 指定）。

安装版还顺带解决了两个便携版的别扭之处：exe 不必留在原地（装完可以把安装包收起来），程序位置固定，快捷方式与"固定到任务栏"都指向同一个地方。

**随包文件只有一个卸载程序**：负载里没有说明、没有 .cmd 脚本、除 `.build-id` 外没有任何文本文件，`build/package.mjs` 用正则校验这一点。说明改由 `SKN 键盘驱动.exe --help` 弹窗给出，抓 Chromium 日志用 `--enable-logging --log-file=<路径>`。

开关：

```
--help                    弹窗说明（安装/便携、开关、被拦住怎么办、卸载办法）
--install-dir=<目录>      指定安装位置，不弹选择窗口
--portable                便携模式（exe 旁边的隐藏目录）
--print-target            报告安装/运行目录与「来自网络」标记状态（不写任何文件）
--unblock                 手动清除 exe 与运行目录里所有文件的「来自网络」标记
--extract-only            只展开不启动，并写出 .extract-report.txt
--re-extract              强制重新展开
--no-sandbox              以兼容方式启动
SKN_QUIET=1               不弹任何对话框（脚本化/自动化用）
```

负载里不含 `data\`，所以重新展开不会覆盖使用者的设置与缓存。已校验：解压 **78 条目（76 个文件 + 2 个目录）/ 340,055,314 字节**，关键文件（应用 exe、卸载程序、`app.asar`、`version`、`LICENSE`）逐个 SHA256 与构建清单一致；安装后安装包旁边**没有任何新增项**；临时负载 `.payload.tar.xz` 展开后即删除；第二次运行 0.1 秒跳过展开。

**卸载**：运行安装目录里的 `卸载.exe`。它先弹确认（列出目录、文件数、体积），并且在三种情况下**拒绝执行**：盘符根目录、系统目录（Windows / Program Files / 用户目录 / 桌面）、目录里没有安装标记；检测到**本目录里的程序还在运行**时也会拒绝（否则只能删一半）。确认后删除该目录内除自己以外的一切，再用一个分离的 `cmd` 在它退出后删掉自己和空目录——不写注册表、不写 `%TEMP%`、不留 helper 文件、不需要重启；被占用的文件会如数报告并保留。脚本化：`卸载.exe --yes`（加 `--force` 可跳过前两类拒绝）。

**「应用和功能」里不会有卸载条目**：那需要写注册表，而本项目的规则是只写安装目录。卸载入口就是这个 `卸载.exe`。

> 对比过 electron-builder（NSIS + portable 那套，也是豆包版用的方案）：它靠 7z/LZMA 压到 76 MB（Electron 33，且不带离线缓存），但它的安装版会写 `%LOCALAPPDATA%\Programs`、注册表卸载项和开始菜单/桌面快捷方式，portable 版则解压到 `%TEMP%`（写 C 盘）；构建还会在 dist 里留下 268 MB 的 `win-unpacked.tmp`。本项目的硬要求是"只写安装目录、别处零写入"，所以没有采用它，而是自己写外壳 + 用系统 tar。桌面快捷方式留成了安装窗口里的**可选勾选项，默认不勾**——因为它是唯一会写到安装目录之外的文件。

自愈逻辑做过确定性验证：`build/tools/probe-app.cs` 冒充 `SKN Launcher.exe`，不带 `--no-sandbox` 时立即以 `0x80000003` 退出；外壳先无参数启动、收到退出代码 `-2147483645` 后自动带 `--no-sandbox` 重启（第二次退出代码 0）。解压产物（含中文文件名）与原负载逐文件哈希一致。

## 签名与系统拦截

未签名的程序会被三种**不同**的机制拦下，解法也不同，混在一起谈永远说不清：

| 机制 | 触发条件 | 「解除锁定」能否绕过 | 真正的解法 |
| --- | --- | --- | --- |
| SmartScreen「Windows 已保护你的电脑」 | 文件带 Mark of the Web（浏览器下载、ZIP 解压）且文件与签名证书都没有信誉 | **能**，清除标记后不再提示 | 代码签名（信誉按文件/证书积累） |
| 智能应用控制（SAC）强制模式 | 系统开启了 SAC，程序未知且未签名 | **不能**，没有「仍要运行」按钮 | 只能代码签名（公共 CA） |
| 杀软 / SmartScreen 误报 | 「自解压 + 释放大文件 + 拉起子进程」这类行为特征 | 不能 | 提交误报复核；签名有助于建立信誉 |

### 已经内置、不需要证书的部分

1. **运行即自动解除锁定**：`Zone.Identifier` 这个备用数据流就是「来自网络」标记，程序每次启动都会清掉自己的那一份。所以**同一份文件只会提示一次**。实测：给交付 exe 伪造 `ZoneId=3` 后运行，标记被清除，第二次 `--print-target` 报告 `markOfTheWeb=none`。
   实现细节：.NET 的 `File.Delete` / `FileStream` 会拒绝 ADS 路径（报「不支持给定路径的格式」），所以直接调 Win32 `DeleteFileW`——也就是 exe 属性页里「解除锁定」勾选框背后的同一个调用；失败时把 Win32 错误码写进报告（5=拒绝访问、32=文件被占用）。
2. **`--unblock`**：手动清除 exe 自身 + 运行目录整棵树（含子目录）的标记。实测 2/2 个文件被清除，重复执行返回 0 且不报错。
3. **交付方式直接绕开**：微软文档明确写了 SmartScreen 不检查内部位置与网络共享（UNC / SMB）；U 盘、移动硬盘拷贝也不会带这个标记。
4. **不想先点一次提示**：提前执行 `Unblock-File .\SKN 键盘驱动.exe`，或右键 exe → 属性 → 勾「解除锁定」。
5. **官方复核入口**：认为某个文件被误判，可提交到 <https://www.microsoft.com/wdsi/filesubmission>，产品选 **Microsoft Defender SmartScreen**。

### 彻底解决：代码签名（资格、花费与办理步骤见 [build/SIGNING.md](build/SIGNING.md)）

**一条硬约束要先说**：微软的 Artifact Signing（原 Azure Trusted Signing）**不面向中国大陆**——官方 Quickstart 写明 Public Trust 证书只发给位于美/加/欧盟/英/澳/新/日/韩/新加坡/瑞士/挪/以的**组织**，个人开发者只限**美国或加拿大**，签署端点也没有中国区；Private Trust 虽不受地域限制，但对 SmartScreen 无用。所以国内现实可行的路线是**买一张公共 CA 的 OV/EV 代码签名证书**（2023 年 6 月起私钥必须放在 FIPS 140-2 L2 / CC EAL4+ 硬件令牌或 CA 的云签名服务里，已经不存在"裸 .pfx"）；项目若开源，还可以用 SignPath 这类**免费的开源项目签名服务**。

构建脚本已内置签名步骤：环境变量配好，重建即出签名版，签完自动复核（`signtool verify /pa /all /v` + 时间戳检查 + 识别证书是 EV 还是 OV）。

```powershell
# 路线 A：证书已在 Windows 证书存储里（硬件令牌已插好 / CA 云签名客户端已登录）
$env:SKN_SIGN_THUMBPRINT = '<证书指纹 SHA1>'
# 路线 B：.pfx（现制证书多不可导出，常用于自建 CA 的流程测试）
$env:SKN_SIGN_PFX = 'D:\certs\codesign.pfx'; $env:SKN_SIGN_PFX_PASSWORD = '<口令>'
# 路线 C：Artifact Signing（需要海外资格）
$env:SKN_SIGN_DLIB = '<dlib 目录>\x64\Azure.CodeSigning.Dlib.dll'
$env:SKN_SIGN_METADATA = '<metadata.json 路径>'
# 可选：SKN_SIGN_TIMESTAMP=<RFC3161 地址>、SIGNTOOL=<signtool.exe 路径>

# 出交付物；SKN_REQUIRE_SIGNED=1 时没有有效签名就让构建失败（交付闸门）
$env:SKN_REQUIRE_SIGNED = '1'
node build/make-single-exe.mjs ..\dist-v2\SKN 键盘驱动.exe
```

只查状态（不动文件）：`node build/sign-exe.mjs <exe> --report-only`，加 `--require-signed` 则状态不合格时以退出码 1 失败。三条路线实际下发的命令行（用 `build/tools/fake-signtool.cs` 记录，已实测）：

```
sign /v /debug /fd SHA256 /tr http://timestamp.acs.microsoft.com/ /td SHA256 /dlib <dlib> /dmdf <metadata.json> <exe>
sign /v /fd SHA256 /f <pfx> /p <password> /tr <时间戳> /td SHA256 <exe>
sign /v /fd SHA256 /sha1 <thumbprint> /tr <时间戳> /td SHA256 <exe>
```

必须说清楚的几点：

- **Artifact Signing 不签发 EV 证书**，拿到签名后仍可能看到 SmartScreen 提示，要靠文件/证书信誉积累；OV 证书同理（EV 证书通常可立即放行，但这条我抓不到微软当前 FAQ 原文，办理前向 CA 要书面说明）。必要时用上面的 wdsi 入口申请复核。
- **不要用自签名证书充数**：签名能写进去，但证书链不在公共信任里，SmartScreen 与 SAC 都不认。构建脚本会直接打印这个判断，不会让人误以为已经解决。
- **签名没有时间戳会随证书过期而失效**：脚本在检测到"有效签名但无时间戳"时会明确报警——Artifact Signing 的证书只有 3 天有效期，时间戳是必须的。
- **智能应用控制**：设置 → 隐私和安全性 → Windows 安全中心 → 应用和浏览器控制。状态「打开」= 强制模式，未签名程序无法运行，只能签名；关掉它需要重置/重装系统才能再打开，别把它当开关用。
- 签名只改变「信任」，不改变任何程序行为：安装目录、`data` 位置、不写 C 盘这些性质都不变；也不会让"自解压外壳"这类行为特征从敏感杀软的眼里消失。

参考：[SmartScreen 概述](https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/)（含「不检查内部位置与网络共享」与提交入口）、[Smart App Control 概述](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)、[Unblock-File](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/unblock-file)（`Zone.Identifier` 的定义）、[Artifact Signing 概览](https://learn.microsoft.com/en-us/azure/artifact-signing/overview) / [FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq) / [SignTool 集成](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations) / [定价](https://azure.microsoft.com/pricing/details/artifact-signing/)。

## 离线缓存覆盖范围

只缓存官方首方域名（其余请求原样放行，不落盘）：

- `launcher.skn.net.cn` — 界面本身
- `launcher.keychron.cn` / `launcher.keychron.com` — 键盘定义、多语言、接口数据

明确排除统计与埋点域名（`erpapik.keychron.cn`、`statistic.keychron.com`、Google 统计）。单文件超过 12 MB 不缓存。

## 键位动效覆盖（motion.css）

官方界面给键帽家族带了一组过渡动画，全部写在官方 bundle 的内联组件样式里，无法直接改，只能覆盖：

| 官方规则 | 声明的动效 |
| --- | --- |
| `.keycap-wrapper` | `transition: all .1s linear` |
| `.keycap-wrapper > .keycap-key > .keycap` | `transition: all .1s linear` |
| `.keycap-wrapper .wheel-direction > div` | `transition: all .5s linear` |
| `.keycap-wrapper .stick-direction > div` | `transition: all .5s linear` |
| `.keycap-wrapper .keycap-left/right > div` | `transition: all .5s linear` |
| `.wheel-direction-up/-down`、`.stick-direction-up/-down/-left/-right` | `animation: .5s ease-in-out` |
| `.keycap-left-active`、`.keycap-right-active` | `animation: .5s ease-in-out` |

`transition: all` 把 `left / top / width / height / opacity` 全部纳入过渡，于是布局数据分批到达时，键帽会逐个「缓缓归位」并带轻微淡入——观感拖沓，这正是要修掉的东西。

`src/motion.css` 由 `webContents.insertCSS()` 在每个文档 `dom-ready` 时注入（SPA 路由切换不换文档，因此一次注入持续有效），用 `!important` 让键帽直接落在最终位置：

- 键帽本体与方向层：`transition: none !important`。`!important` 的作者声明优先于动画声明，也优先于官方那些非 `!important` 的 `transition`。
- 方向/按下指示：只把 `animation-duration` 压成 `0s`，**保留终态语义**——不写 `animation: none`，否则 `-active` 键帽会停在起始位置而不是动画终态。
- 其余动效（加载动画、骨架屏、下拉弹层、拖拽高亮）一律不动。

`tools/motion-test.mjs` 把上表逐条钉成断言：官方键帽家族的每个过渡/动画都必须被覆盖，同时校验覆盖范围没有越界、也没有强制 `transition` / `animation-duration` 之外的属性。想跑官方原版动效：`SKN_NO_MOTION=1`。

## 验证情况

在一台插着 SKN QingLong 4.0 Ultra 8K 键盘的机器上，对**打包后的正式产物** `SKN Launcher.exe` 做了端到端自检：

| 检查项 | 实测结果 |
| --- | --- |
| 界面加载 | `https://launcher.skn.net.cn/#/keymap`，`<app-root>` 渲染，标题为 `SKN Launcher` |
| WebHID 可用 | `navigator.hid` 存在，键盘共 5 个 HID 集合 |
| 自动选择设备 | 识别厂商接口（`Ultra-Link 8K`，`0xFF60` 打分 40、`0xFFC1` 打分 30）并自动选中，**没有弹窗** |
| 键盘真的连上 | 页面显示「QingLong 4.0 Ultra 8K ANSI 已连接」，并渲染出 Layer 0–3 键位（Esc / F1…F12 / Del…） |
| 离线改键 | 强制离线运行时：缓存命中 42 次、回源 0 次，`fetch('/')` 返回 `x-skn-cache: HIT`，界面与键位照常渲染 |
| 缓存写入 | 首次联网自动缓存 35 个文件 / 7.51 MB；并发重复请求零写入失败、零残留临时文件 |

自动化测试（`tools/` 目录，均可无界面运行）：

- `node tools/unit-test.mjs` — 15/15 通过（HID 打分、厂商接口识别、普通键盘不被误选、配对记录持久化）
- `node tools/motion-test.mjs` — 18/18 通过（官方键帽过渡/动画逐条覆盖、覆盖范围仅限键帽家族、未破坏 `-active` 终态语义）
- `node tools/paths-test.mjs` — 21/21 通过（写盘位置只落在 exe 同盘、运行根目录内、不含 `AppData`；负例：旧 `%LOCALAPPDATA%` 方案与跨盘布局都会被判失败；并回归 `main.js` 的四个 `setPath` 调用）
- `node tools/cache-test.mjs online <dir>` — 16/16 通过（真实站点抓取、缓存命中、POST 保真、统计域名不缓存、并发写入回归）
- `SKN_FORCE_OFFLINE=1 node tools/cache-test.mjs offline <dir>` — 8/8 通过（离线命中、离线提示页、子资源干净 504）

单文件版另做的验证（无需界面即可复现）：

| 检查项 | 实测结果 |
| --- | --- |
| 负载尾部标记 | `SKNPKG02`，负载起始偏移 = 外壳大小（108,544 字节），负载 78 条目（含 `卸载.exe`） |
| 负载压缩 | tar.xz 94.0 MB（原始 324.3 MB，29.0%）：比原来的 deflate zip 小 34% |
| 交付物大小 | 94.1 MB（98,685,196 字节），其中外壳 108,544 字节（安装窗口 + 安装逻辑 + 解压 + 沙箱自愈） |
| 安装（指定目录） | `--install-dir=<目录> --extract-only` → 退出 0（7.9～10.2 秒）；安装目录里出现 `SKN 键盘驱动.exe`（原 `SKN Launcher.exe` 已改名）、`卸载.exe`、`.build-id`；**安装包旁边零新增项**；`data\` 等一切写入都在安装目录内 |
| 重复安装/运行 | 同一目录再次运行：约 0.1 秒跳过展开（`skipped=True`），设置与缓存保留 |
| 便携模式 | `--portable` → 仍在 exe 旁边建隐藏目录，且保留 `SKN Launcher.exe` 原名，与旧版行为一致 |
| 卸载 | 真实负载：`卸载.exe --yes` → 删掉 77 个文件 + 2 个子目录，`locked=0`，1.4～3.2 秒内自身与空目录一并消失（目录已不存在）；全程不写注册表、不写 `%TEMP%`、不留 helper |
| 卸载的安全性 | 无安装标记的目录 → 拒绝（退出码 20，目录原样保留）；本目录里的程序正在运行时 → 拒绝（退出码 21，文件全在）；盘符根目录与系统目录同样拒绝 |
| 内容一致性 | 关键文件（`SKN Launcher.exe`、`卸载.exe`、`app.asar`、`version`、`LICENSE`）逐个 SHA256 与构建清单一致，0 处不符 |
| 负载展开 | 78 条目（76 文件 + 2 目录）/ 340,067,501 字节 / 首次安装 8.6 秒，退出代码 0；临时 `.payload.tar.xz` 已删除 |
| 发布资产与文件名 | `npm run release-assets` 把构建产物整理成 `release/SKN 键盘驱动.exe` + `release-notes.md`（中英双语，含大小、SHA256、签名状态）；**改完名重新读一遍签名状态**（证明改名不影响 Authenticode 有效性，而不是假设）；PE 元数据 `OriginalFilename` = `SKN 键盘驱动.exe`（csc 的 `/out` 名，此前是 `stub.exe`），内容 SHA256 与交付物逐字节一致 |
| Release 发布链路 | `npm run publish-release` 直接调 GitHub API 建/更新 Release 并上传资产（实测 `softprops/action-gh-release` 会把 `SKN 键盘驱动.exe` 压成 `SKN.exe`，且 `body_path` 失效时不报错、说明会静默变空）；脚本会校验资产名与说明非空，上传后名字不符直接失败；同名旧资产先删除，重跑不会产生副本 |
| 写盘范围 | 便携模式首次运行后交付目录只多出 1 项（带 Hidden 的目录）；安装模式交付目录**零新增项**；`%LOCALAPPDATA%\SKN 键盘驱动` 不存在，系统 `%TEMP%` 无残留 |
| 「来自网络」标记 | 给交付 exe 伪造 `ZoneId=3` 后运行 → 标记被自动清除，`--print-target` 报 `markOfTheWeb=cleared`，再次运行报 `none`；`--unblock` 清除 exe + 目录内 2/2 个文件（含子目录），重复执行无报错 |
| 构建无残留 | 交付目录本次新增项为空；`build/.scratch` 已删除；外壳与卸载程序由构建脚本自己用 `csc` 编译 |
| 签名状态检查 | 每一步都由 `Get-AuthenticodeSignature` 实测并写进构建清单（`signature.status`）；附加 `signtool verify /pa /all /v` 复核、时间戳检查、EV/OV 证书策略识别（OID 2.23.140.1.3 / .1.4）；三条签名路线下发的命令行与官方文档逐字一致（用 `build/tools/fake-signtool.cs` 记录实测） |
| 交付闸门 | `SKN_REQUIRE_SIGNED=1`：假 signtool 报"成功"但文件实际未签名 → 构建以退出码 1 失败并说明原因；缺 signtool、缺证书文件同样以退出码 1 失败，绝不静默交付未签名文件 |
| 沙箱自愈 | 假 app 首次退出 `-2147483645` → 自动带 `--no-sandbox` 重启 → 退出 0，且没有写任何说明文件 |
| 快速路径 | 第二次运行 88～102 ms 跳过展开（外壳总耗时 0.16 秒） |
| 仓库就绪 | `main` 分支首个提交 36 个文件、工作区干净、最大文件 76.4 KB（不需要 Git LFS）；`.gitignore` 覆盖 `node_modules` 与全部构建产物；全库无个人绝对路径、无密钥 |
| CI 定义校验 | `.github/workflows/build.yml`（14 步）解析通过；所有 `steps.<id>` / `env.<name>` 引用都能对应到真实定义；`upload-artifact` 排在 SignPath 提交之前（它是 SignPath 的硬性要求）；`run` 脚本里零非 ASCII 字符（Windows runner 的代码页问题） |
| 全新克隆可构建 | 删掉 `build/out`（不进仓库）后直接构建：**暴露出 `csc` CS1567**（`/out` 所在目录不存在），已修 `make-single-exe.mjs` 与 `package.mjs` 先建目录；修复后从零构建成功（98,673,792 字节，标记 `SKNPKG02`，退出 0） |
| SignPath 产物配置 | `build/signpath/artifact-configuration.xml` XML 良构、命名空间与 `<zip-file>` / `<pe-file>` / `<authenticode-sign>` 结构符合官方语法；`version` 参数由 CI 从 `package.json` 传入 |

补充说明：首次运行会有一次约 2～3 秒的额外开销，来源是 Defender 对**刚写出的**可执行文件做实时扫描（实测：新写出的 exe 首次启动 2.7 秒，再次启动 0.07 秒；同样内容跳过展开后外壳 0.16 秒完成）。这不是程序的等待逻辑。

自检开关（仅调试用，不影响正常使用）：

```
--help                      弹窗列出安装/便携说明、开关、兼容方式与卸载办法
--print-target              报告安装/运行目录与模式（不写文件）
--install-dir=<目录>        指定安装位置，不弹选择窗口
--portable                  便携模式（exe 旁边的隐藏目录）
--enable-logging --log-file=<路径> --v=1
                            抓 Chromium 自身日志（含 [FATAL:] 行）
SKN_RUNTIME_DIR=<目录>      指定运行目录（默认 exe 旁边的隐藏目录）
SKN_SELFTEST=full           启动后自检并退出
SKN_SELFTEST_OUT=<file>     把自检结果写成 JSON
SKN_LOG_FILE=<file>         把主进程日志落盘
SKN_FORCE_OFFLINE=1         强制离线，只用缓存
SKN_NO_MOTION=1             不注入 motion.css，使用官方原始键位动画
```

## 已知限制

- 「Assist」类功能（鼠标设置、2.4G 接收器 VPID 映射）依赖官方在本机 `ws://localhost:40003` 起的辅助服务，本程序未实现该服务；键盘改键、宏、灯光、固件升级不受影响。
- 未做代码签名时仍会被系统拦，但**程度不同**：SmartScreen 只对「带 Mark of the Web 的下载文件」提示，而程序启动时就会清掉这个标记，因此同一份文件只提示一次；用 U 盘或局域网共享交付则完全不提示。若系统开启了「智能应用控制」强制模式，未签名程序会被直接拦下、没有「仍要运行」，那一条只能靠签名解决——本项目走的正是「开源 + [SignPath Foundation](https://signpath.org/) 免费签名」这条路（CI 已接好，等申请通过），完整说明与四条路线见「[签名与系统拦截](#签名与系统拦截)」与 [build/SIGNING.md](build/SIGNING.md)。单文件版带自解压行为，个别杀软可能更敏感；介意的话用文件夹版（`npm run package`，行为与单文件版一致，数据同样落在程序所在目录）。
- 「只写一个目录」的具体含义：**安装版的写入范围就是安装目录**——程序放 C 盘也一样（例如装到 `C:\SKN 键盘驱动`），因为一切都在用户选定的那一个目录里；如果你希望完全不碰 C 盘，在安装窗口里选 D 盘、U 盘等非系统盘即可（默认就已经是非系统盘里剩余空间最大的那个）。便携版的写入范围是 exe 旁边的隐藏目录，所以 exe 放在 C 盘运行目录也就落在 C 盘，想避开就把 exe 放到别的盘。
- 桌面快捷方式只能由安装窗口里的勾选项创建（默认不勾）：它是唯一会写到安装目录之外的文件。安装版不会在开始菜单、「应用和功能」里留任何东西——那些都需要写注册表或系统目录。
- 首次运行要用 Windows 自带的 `tar.exe` 展开负载，因此**需要 Windows 10 1803 或更新的系统**（Electron 38 本身也要求 Win10+）。极老的系统上 `tar.exe` 不存在，外壳会直接报错，不会静默失败。
- 官网若调整静态资源结构或新增数据域名，需要把新域名加进 `src/cache.js` 的 `CACHEABLE_HOSTS`，或者在程序里用 `文件 → 检查更新` 清空缓存后重载。
- 程序依赖官网前端代码（在线或缓存）。它不会绕过任何官方校验，也不修改键盘固件之外的任何文件。