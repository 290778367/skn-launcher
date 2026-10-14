# 参与开发

这个项目的目标很窄，改动也请围绕它：**用最小的桌面外壳，让官方网页驱动在 Windows 上像本地程序一样可用，并且只写自己的目录。**

## 环境

- Windows 10 1803 或更高（外壳用系统自带的 `tar.exe` 解压，1803 起才有）
- Node.js 20 或更高
- 不需要 Visual Studio：外壳与卸载程序用 .NET Framework 自带的 `csc.exe` 编译

```powershell
npm ci                                    # 或按 README 里给受限环境的 npm install --ignore-scripts 两步法
npm test                                  # 三个测试都必须全绿
npm run build -- dist\SKN 键盘驱动.exe     # 一条命令产出交付物
```

## 提交前自检

1. `npm test` 全绿：`tools/unit-test.mjs`（HID 打分、配对记录）、`tools/motion-test.mjs`（键帽动效覆盖）、`tools/paths-test.mjs`（写入范围规则）。
2. 如果改了写盘相关的代码，`tools/paths-test.mjs` 的断言必须同步更新——**不允许出现第二个写盘位置**。
3. 如果改了外壳（`build/stub.cs`）或卸载程序（`build/uninstall.cs`），跑一次真实负载的安装 + 卸载，确认：安装目录之外零新增项、卸载后目录能自行消失。
4. 如果改了签名流程，用 `build/tools/fake-signtool.cs` 复核实际下发的命令行，并确认 `SKN_REQUIRE_SIGNED=1` 时未签名构建会失败。

## 不接受的方向

- 加入统计、上报、遥测或任何自动联网的请求（程序只访问官方首方域名）。
- 往 `%APPDATA%` / `%LOCALAPPDATA%` / `%TEMP%` / 注册表写文件，或引入需要安装的驱动。
- 引入体积庞大的运行时依赖：外壳保持"系统自带工具链即可编译"，交付物保持单文件。
- 把界面逻辑重新实现一遍：改键与固件流程一律沿用官方网页驱动。

## 提交与授权

- 一个提交只做一件事，说明写清"改了什么、为什么、怎么验证的"。
- 提交即表示你同意以本仓库的 [MIT 许可](LICENSE) 授权你的贡献。
- 涉及原生行为（WebHID、沙箱、解压、写盘）的改动，请附上可复现的验证方式（命令 + 观察到的输出）。