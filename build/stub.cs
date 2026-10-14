// SKN 键盘驱动 — single-file launcher.
//
// Layout of the produced exe:
//   [ this stub ][ tar.xz payload ][ "SKNPKG02" ][ int64 payload length ]
//
// The payload is xz-compressed by Windows' own bsdtar at build time and unpacked
// by the same tar.exe on first run, so no third-party binary is shipped or
// dropped on the user's disk, and the file is ~30% smaller than the zip it
// replaced. tar.exe ships with Windows 10 1803 and later.
//
// The exe stays self-contained and never writes outside the folder it is
// installed into. Two modes:
//
//   install (default)  a dialog asks where to install (default: the non-system
//                      drive with the most free space), the payload is unpacked
//                      there, the launcher is renamed to "SKN 键盘驱动.exe" and
//                      that folder becomes the app's own folder - program, data,
//                      temp, crash dumps and logs all live inside it. Uninstall
//                      is the "卸载.exe" that ships in the payload; it deletes
//                      that folder without touching the registry.
//   portable           --portable (or running from a removable/network drive)
//                      keeps the older behaviour: a hidden "SKN 键盘驱动" folder
//                      beside the exe, for USB sticks.
//
// Either way src/paths.js redirects Electron's profile, temp, crash-dump and log
// paths into the app's own folder, so %APPDATA%, %LOCALAPPDATA% and %TEMP% stay
// untouched. There is deliberately no fallback to a system folder; --help
// explains the switches from a dialog instead of shipping readme or helper files.
//
// Chromium's sandbox is fail-closed - on machines where it cannot initialise
// the app aborts with 0x80000003 - so a launch that dies within seven seconds
// is retried automatically with --no-sandbox.
//
// SmartScreen only warns about files that carry a Mark of the Web, so the start
// of every run clears that mark (Zone.Identifier) from this exe, and --unblock
// clears it across the runtime folder as well.
//
// Compiled with the .NET Framework csc (C# 5 only: no interpolation, no ?. ).
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("SKN 键盘驱动")]
[assembly: AssemblyDescription("SKN 官方网页驱动（launcher.skn.net.cn）的桌面版，单文件安装/便携包")]
[assembly: AssemblyCompany("SKN")]
[assembly: AssemblyProduct("SKN 键盘驱动")]
[assembly: AssemblyVersion("1.1.1.0")]
[assembly: AssemblyFileVersion("1.1.1.0")]

namespace SknPortable
{
    internal sealed class ExtractStats
    {
        internal int Entries;
        internal long Bytes;
        internal bool Skipped;
    }

    internal static class Program
    {
        // Bumped whenever the payload changes; the marker in the runtime folder
        // makes later launches skip unpacking entirely. 2026-10-14.7: installer
        // mode (folder chooser, rename to "SKN 键盘驱动.exe", 卸载.exe in the
        // payload); 2026-10-14.6: payload switched from zip to tar.xz (Windows
        // tar, ~30% smaller); 2026-10-14.5: Mark-of-the-Web self-clearing,
        // --unblock, signing hook in the build.
        internal const string BuildId = "2026-10-14.7";
        internal const string AppExeName = "SKN Launcher.exe";
        internal const string InstalledExeName = "SKN 键盘驱动.exe";
        internal const string UninstallerName = "卸载.exe";
        internal const string RuntimeFolderName = "SKN 键盘驱动";
        internal const string RuntimeEnvVar = "SKN_RUNTIME_DIR";
        internal const string InstallDirEnvVar = "SKN_INSTALL_DIR";
        internal const string PortableEnvVar = "SKN_PORTABLE";
        internal const string TargetReportEnvVar = "SKN_TARGET_REPORT";
        internal const string MarkerName = ".build-id";
        internal const string ReportName = ".extract-report.txt";
        internal const string PayloadName = ".payload.tar.xz";
        internal const string QuietEnvVar = "SKN_QUIET";

        // Browsers and ZIP extraction tag downloaded files with these alternate
        // data streams. SmartScreen is what reacts to Zone.Identifier; deleting it
        // is exactly what the "Unblock" checkbox in a file's Properties does.
        internal static readonly string[] WebMarkStreams = new string[]
        {
            "Zone.Identifier", "SmartScreen"
        };

        /// <summary>Last real Win32 error from a failed Mark-of-the-Web removal.</summary>
        private static int lastWebMarkError = 0;
        internal static readonly byte[] Magic = new byte[]
        {
            0x53, 0x4B, 0x4E, 0x50, 0x4B, 0x47, 0x30, 0x32 // "SKNPKG02"
        };

        /// <summary>Marker of the retired zip payload, kept only to explain the error.</summary>
        internal static readonly byte[] ZipMagic = new byte[]
        {
            0x53, 0x4B, 0x4E, 0x50, 0x4B, 0x47, 0x30, 0x31 // "SKNPKG01"
        };

        [STAThread]
        internal static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool extractOnly = HasSwitch(args, "--extract-only");
            bool force = HasSwitch(args, "--re-extract");

            // Windows only shows "Windows protected your PC" for files carrying a
            // Mark of the Web, so clearing it here means the user allows the app
            // once and is not asked again. Copies handed over on a USB stick or a
            // network share never carry the mark in the first place.
            bool clearedWebMark = false;
            try { clearedWebMark = StripWebMark(SafeSelfPath()); }
            catch (Exception) { }

            // Documentation without shipping files.
            if (HasSwitch(args, "--help") || HasSwitch(args, "-h") || HasSwitch(args, "/?") ||
                HasSwitch(args, "--h"))
            {
                ShowHelp(clearedWebMark);
                return 0;
            }

            // Unblock on request: this exe plus anything already unpacked.
            if (HasSwitch(args, "--unblock"))
            {
                bool strippedSelf = StripWebMark(SafeSelfPath());
                int files = 0;
                string unblockProblem;
                string unblockDir = ResolveTargetDirectory(false, out unblockProblem);
                if (unblockDir != null && Directory.Exists(unblockDir))
                {
                    files = StripWebMarkTree(unblockDir);
                }
                ReportUnblock(strippedSelf, files, unblockDir);
                return 0;
            }

            // Diagnostic switch, handled before the payload is touched so it also
            // works on the bare stub: report where the runtime files live, exit
            // without writing anything else.
            if (HasSwitch(args, "--print-target"))
            {
                string selfDir = "";
                try { selfDir = Path.GetDirectoryName(SelfPath()); }
                catch (Exception) { }
                WriteTargetReport(selfDir, clearedWebMark);
                return 0;
            }

            string self;
            long payloadStart;
            long payloadLength;
            try
            {
                self = SelfPath();
                ReadPayloadRegion(self, out payloadStart, out payloadLength);
            }
            catch (Exception ex)
            {
                Fail("无法读取自身文件。\r\n\r\n" + ex.Message);
                return 10;
            }

            string exeDir = Path.GetDirectoryName(self);
            string problem;

            // Where the program files - and everything they write - go. Install mode
            // is the default: the user picks one folder and nothing is written outside
            // it. Portable mode keeps the older hidden folder beside the exe for USB
            // sticks, and is also chosen automatically on removable/network drives.
            bool portable = HasSwitch(args, "--portable") || EnvIsOne(PortableEnvVar);
            string installDir = SwitchValue(args, "--install-dir");
            if (string.IsNullOrEmpty(installDir))
            {
                installDir = Environment.GetEnvironmentVariable(InstallDirEnvVar);
            }
            if (!portable && string.IsNullOrEmpty(installDir) && IsRemovableOrNetwork(exeDir))
            {
                portable = true;
            }

            bool createShortcut = false;
            bool dialogFailed = false;
            if (!portable && string.IsNullOrEmpty(installDir))
            {
                installDir = AskInstallDir(exeDir, out createShortcut, out dialogFailed);
                if (installDir == null) return dialogFailed ? 13 : 0; // cancel writes nothing
            }

            bool installMode = !portable;
            string target;
            if (installMode)
            {
                target = Path.GetFullPath(installDir);
                if (!IsUsable(target))
                {
                    Fail("无法写入安装目录。\r\n\r\n" + target +
                         "\r\n\r\n请换一个可写的位置，或者用 --install-dir=<目录> 指定后重试。" +
                         "\r\n\r\n本程序不会把文件写到 C 盘的系统目录（AppData / Temp）里，" +
                         "也不会回退到别的位置。");
                    return 14;
                }
            }
            else
            {
                target = ResolveTargetDirectory(true, out problem);
                if (target == null)
                {
                    Fail("无法准备运行目录。\r\n\r\n" + problem +
                         "\r\n\r\n请把本 exe 放到可写的目录（例如 D 盘、U 盘），或者设置环境变量" +
                         " SKN_RUNTIME_DIR 指定一个可写目录后重试。" +
                         "\r\n\r\n本程序不会把文件写到 C 盘的系统目录（AppData / Temp）里，" +
                         "因此没有其它回退位置。");
                    return 14;
                }
            }

            string appExe = Path.Combine(target, installMode ? InstalledExeName : AppExeName);
            ExtractStats stats = new ExtractStats();
            stats.Skipped = !force && IsCurrent(target, appExe);

            if (!stats.Skipped)
            {
                // The progress window is a convenience only: in sessions that
                // cannot create a window the unpacking still has to happen.
                ProgressForm form = null;
                try { form = new ProgressForm(); }
                catch (Exception) { form = null; }

                Exception error = null;
                Thread worker = new Thread(delegate()
                {
                    try
                    {
                        ExtractPayload(self, payloadStart, payloadLength, target, form, stats);
                        WriteMarker(target);
                    }
                    catch (Exception ex)
                    {
                        error = ex;
                    }
                    finally
                    {
                        if (form != null) form.CloseFromWorker();
                    }
                });
                worker.IsBackground = true;
                worker.Start();

                if (form != null)
                {
                    try { Application.Run(form); }
                    catch (Exception) { worker.Join(); }
                }
                else
                {
                    worker.Join();
                }

                if (error != null)
                {
                    Fail("展开程序文件失败。\r\n\r\n" + error.Message +
                         "\r\n\r\n目标目录：" + target +
                         "\r\n\r\n请确认磁盘空间充足、且该目录可写，然后重试。");
                    return 11;
                }
            }

            // The payload ships the launcher as "SKN Launcher.exe"; an install gets
            // the friendly name so the install folder has an obvious exe to run.
            if (installMode)
            {
                appExe = FinalizeInstall(target);
            }

            if (extractOnly)
            {
                WriteReport(target, stats, "ok");
                return 0;
            }

            // Only ever written when the user ticked the box in the install dialog,
            // because a desktop shortcut is a file outside the install folder.
            if (installMode && createShortcut)
            {
                try { CreateDesktopShortcut(appExe); }
                catch (Exception) { }
            }

            string forward = ForwardArgs(args);

            int code;
            try
            {
                // A folder build shipped inside a ZIP can arrive marked as well,
                // and this app is always started by us rather than by Explorer.
                try { StripWebMark(appExe); }
                catch (Exception) { }
                code = Launch(appExe, target, forward, 7000);
            }
            catch (Exception ex)
            {
                Fail("无法启动程序。\r\n\r\n" + ex.Message + "\r\n\r\n程序目录：" + target);
                return 12;
            }

            if (code == 0)
            {
                return 0;
            }

            // Died within seven seconds with a non-zero code: this is the
            // Chromium sandbox abort (0x80000003) seen on locked-down machines.
            // Retry compatible and silently - --help documents it, and nothing
            // is written about it.
            try
            {
                Launch(appExe, target, JoinArgs(forward, "--no-sandbox"), 0);
            }
            catch (Exception ex)
            {
                Fail("正常方式启动失败（退出代码 " + code + "），改用兼容方式启动时也失败。\r\n\r\n" +
                     ex.Message);
                return 13;
            }

            return 0;
        }

        private static string SelfPath()
        {
            try
            {
                string p = Process.GetCurrentProcess().MainModule.FileName;
                if (!string.IsNullOrEmpty(p)) return p;
            }
            catch (Exception)
            {
            }
            return Assembly.GetExecutingAssembly().Location;
        }

        private static void ReadPayloadRegion(string self, out long start, out long length)
        {
            using (FileStream fs = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                long total = fs.Length;
                if (total < 64L) throw new InvalidDataException("文件过小，不是有效的单文件包。");

                byte[] footer = new byte[16];
                fs.Seek(total - footer.Length, SeekOrigin.Begin);
                int got = 0;
                while (got < footer.Length)
                {
                    int n = fs.Read(footer, got, footer.Length - got);
                    if (n <= 0) throw new EndOfStreamException("读取自身文件时提前结束。");
                    got += n;
                }

                bool matches = true;
                for (int i = 0; i < Magic.Length; i++)
                {
                    if (footer[i] != Magic[i])
                    {
                        matches = false;
                        break;
                    }
                }

                if (!matches)
                {
                    bool retiredZip = true;
                    for (int i = 0; i < ZipMagic.Length; i++)
                    {
                        if (footer[i] != ZipMagic[i])
                        {
                            retiredZip = false;
                            break;
                        }
                    }

                    if (retiredZip)
                    {
                        throw new InvalidDataException("这是旧版 zip 负载的外壳：请使用当前版本的 exe。");
                    }

                    throw new InvalidDataException("未找到负载标记：文件不完整或已被截断。");
                }

                length = BitConverter.ToInt64(footer, Magic.Length);
                start = total - footer.Length - length;
                if (length <= 0L || start < 0L)
                {
                    throw new InvalidDataException("负载长度无效（" + length + "）。");
                }
            }
        }

        // One rule: a hidden folder beside the exe, on whatever drive the user put
        // the exe on. There is deliberately no fallback to %LOCALAPPDATA% or
        // %TEMP% - scattering files across the system drive is what this design
        // exists to avoid. SKN_RUNTIME_DIR overrides the location on request.
        // With probe=false nothing is created (used by --help/--print-target).
        private static string ResolveTargetDirectory(bool probe, out string problem)
        {
            problem = null;

            string overrideDir = Environment.GetEnvironmentVariable(RuntimeEnvVar);
            if (!string.IsNullOrEmpty(overrideDir))
            {
                if (!probe || IsUsable(overrideDir))
                {
                    Hide(overrideDir);
                    return overrideDir;
                }
                problem = "SKN_RUNTIME_DIR 指向的目录不可写：" + overrideDir;
                return null;
            }

            string beside = Path.Combine(
                Path.GetDirectoryName(SafeSelfPath()), RuntimeFolderName);
            if (!probe || IsUsable(beside))
            {
                Hide(beside);
                return beside;
            }

            problem = "无法在 exe 所在目录创建运行文件夹：" + beside;
            return null;
        }

        private static string SafeSelfPath()
        {
            try { return SelfPath(); }
            catch (Exception) { return ""; }
        }

        // Keep the folder out of sight: Explorer hides it by default, so the exe
        // still looks like a single file.
        private static void Hide(string dir)
        {
            try
            {
                DirectoryInfo info = new DirectoryInfo(dir);
                if (!info.Exists) return;
                if ((info.Attributes & FileAttributes.Hidden) == 0)
                {
                    info.Attributes = info.Attributes | FileAttributes.Hidden;
                }
            }
            catch (Exception)
            {
            }
        }

        // The user-facing documentation, with no file involved.
        private static void ShowHelp(bool clearedWebMark)
        {
            string problem;
            string target = ResolveTargetDirectory(false, out problem);
            if (target == null) target = "(无法解析：" + problem + ")";

            StringBuilder text = new StringBuilder();
            text.AppendLine("SKN 键盘驱动 —— SKN 官方网页驱动的桌面版（单文件安装/便携包）");
            text.AppendLine();
            text.AppendLine("【两种用法】");
            text.AppendLine("  直接双击 = 安装版：先让你选安装位置（默认非系统盘、剩余空间");
            text.AppendLine("  最大的那个盘），展开程序文件，然后启动。安装目录里会有程序");
            text.AppendLine("  本体、“SKN 键盘驱动.exe”、“卸载.exe”和 data 子目录。");
            text.AppendLine("  再运行一次本 exe 并选同一个目录 = 更新（设置与缓存保留）。");
            text.AppendLine("  --portable = 便携版：不安装，在 exe 旁边建一个隐藏目录运行，");
            text.AppendLine("  适合 U 盘（在可移动盘上会自动选这个模式，不弹选择窗口）。");
            text.AppendLine("  便携版的目录会是：");
            text.AppendLine("    " + target);
            text.AppendLine("  首次运行用 Windows 自带的 tar.exe 展开，不联网、不装任何东西。");
            text.AppendLine();
            text.AppendLine("【只写这一个目录，别处一概不写】");
            text.AppendLine("  程序本体、设置、离线缓存、临时文件、崩溃转储、日志全部在");
            text.AppendLine("  安装目录（或便携目录）里。");
            text.AppendLine("  不写 C 盘系统目录（AppData / Temp），不写注册表，也不写");
            text.AppendLine("  “应用和功能”的卸载条目——所以那里找不到它，卸载就是运行");
            text.AppendLine("  安装目录里的“卸载.exe”。");
            text.AppendLine();
            text.AppendLine("【彻底卸载】");
            text.AppendLine("  安装版：运行安装目录里的“卸载.exe”（它会删掉整个目录）。");
            text.AppendLine("  便携版：删掉 exe，再删掉上面那个目录（连同里面的 data）。");
            text.AppendLine();
            text.AppendLine("【启动参数】");
            text.AppendLine("  --help                  显示本说明");
            text.AppendLine("  --install-dir=<目录>    指定安装位置，不弹选择窗口");
            text.AppendLine("  --portable              便携模式（exe 旁边的隐藏目录）");
            text.AppendLine("  --print-target          报告安装/运行目录（不写任何文件）");
            text.AppendLine("  --no-sandbox            关闭 Chromium 沙箱启动");
            text.AppendLine("  --re-extract            强制重新展开程序文件");
            text.AppendLine("  --extract-only          只展开不启动，并写出 .extract-report.txt");
            text.AppendLine("  --unblock               手动清除“来自网络”标记（等于属性里的解除锁定）");
            text.AppendLine();
            text.AppendLine("【被 Windows 拦住怎么办】");
            text.AppendLine("  现在状态：“来自网络”标记 " + (clearedWebMark ? "已清除" : "不存在"));
            text.AppendLine();
            text.AppendLine("  1) 下载后提示“Windows 已保护你的电脑”（SmartScreen）：");
            text.AppendLine("     点「更多信息」→「仍要运行」即可；程序启动时会自己清除这个");
            text.AppendLine("     标记，所以只会问这一次。");
            text.AppendLine("     想提前处理，可先手动解除锁定（等价于右键 exe → 属性 →");
            text.AppendLine("     勾选“解除锁定”）：");
            text.AppendLine("       PowerShell:  Unblock-File .\\SKN 键盘驱动.exe");
            text.AppendLine("  2) 用 U 盘 / 移动硬盘 / 局域网共享拷贝过来的文件不带该标记，");
            text.AppendLine("     Windows 本来就不提示（SmartScreen 不检查内部位置与网络共享）。");
            text.AppendLine("  3) 若被「智能应用控制」拦住（设置 → Windows 安全中心 → 应用和");
            text.AppendLine("     浏览器控制，状态为“打开”）：未签名程序在强制模式下无法运行，");
            text.AppendLine("     这一条只能靠代码签名解决，没有其它开关。");
            text.AppendLine("  4) 彻底解决：代码签名证书。本项目构建脚本已内置签名入口：");
            text.AppendLine("     设好 SKN_SIGN_* 环境变量后重新构建即可（见 README「签名与系统拦截」）。");
            text.AppendLine();
            text.AppendLine("【打不开 / 一闪而过怎么办】");
            text.AppendLine("  程序会自己处理：正常启动若在 7 秒内异常退出，会自动改用");
            text.AppendLine("  --no-sandbox 重新启动一次，不需要手动操作。这种退出通常是");
            text.AppendLine("  Chromium 沙箱在本机无法初始化（事件日志里是异常代码");
            text.AppendLine("  0x80000003），与键盘和改键功能无关。");
            text.AppendLine();
            text.AppendLine("  想抓 Chromium 自己的日志（含 [FATAL:] 行）用于排查，");
            text.AppendLine("  在命令行运行：");
            text.AppendLine("    SKN 键盘驱动.exe --enable-logging --log-file=D:\\chrome.log --v=1");
            text.AppendLine();
            text.AppendLine("【界面快捷键】");
            text.AppendLine("  F12 开发者工具 / Ctrl+R 重新载入 /");
            text.AppendLine("  Ctrl+Shift+R 清空离线缓存并重新下载");
            text.AppendLine();
            text.AppendLine("时间：" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));

            try
            {
                if (Quiet()) return;
                HelpForm window = new HelpForm(text.ToString());
                window.ShowDialog();
            }
            catch (Exception)
            {
            }
        }

        // ---- Mark of the Web ("unblock") ------------------------------------

        /// <summary>Switches that print without showing a dialog, for scripting.</summary>
        private static bool Quiet()
        {
            return Environment.GetEnvironmentVariable(QuietEnvVar) == "1";
        }

        /// <summary>
        /// Deletes an alternate data stream. .NET's File.Delete/FileStream reject
        /// stream paths outright ("不支持给定路径的格式"), so this calls the Win32 API
        /// that the shell's Unblock checkbox ends up using as well.
        /// </summary>
        [DllImport("kernel32.dll", EntryPoint = "DeleteFileW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool DeleteFileW(string fileName);

        /// <summary>
        /// Removes the alternate data streams Windows uses to remember "this file
        /// came from the internet". Returns true when something was removed.
        /// The last real Win32 error is kept for the diagnostic reports.
        /// </summary>
        private static bool StripWebMark(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            bool cleared = false;
            for (int i = 0; i < WebMarkStreams.Length; i++)
            {
                string streamPath = path + ":" + WebMarkStreams[i];
                try
                {
                    if (DeleteFileW(streamPath))
                    {
                        cleared = true;
                        continue;
                    }
                    int error = Marshal.GetLastWin32Error();
                    // 2 = ERROR_FILE_NOT_FOUND: the stream simply was not there.
                    if (error != 2) lastWebMarkError = error;
                }
                catch (Exception)
                {
                }
            }
            return cleared;
        }

        private static string WebMarkErrorText()
        {
            if (lastWebMarkError == 0) return "none";
            string hint = "";
            if (lastWebMarkError == 5) hint = "（拒绝访问：exe 可能在只读介质上，或权限受限）";
            else if (lastWebMarkError == 32) hint = "（文件被占用：程序正在运行，可在关闭后执行 --unblock）";
            return "win32=" + lastWebMarkError + hint;
        }

        private static int StripWebMarkTree(string dir)
        {
            int cleared = 0;
            try
            {
                string[] files = Directory.GetFiles(dir, "*", SearchOption.AllDirectories);
                for (int i = 0; i < files.Length; i++)
                {
                    if (StripWebMark(files[i])) cleared++;
                }
            }
            catch (Exception)
            {
            }
            return cleared;
        }

        private static void ReportUnblock(bool selfCleared, int filesCleared, string dir)
        {
            StringBuilder text = new StringBuilder();
            text.AppendLine("unblockedSelf=" + (selfCleared ? "yes" : "no"));
            text.AppendLine("unblockedFilesInRuntimeDir=" + filesCleared);
            text.AppendLine("markOfTheWebError=" + WebMarkErrorText());
            text.AppendLine("runtimeDir=" + (dir == null ? "(none)" : dir));
            text.AppendLine("note=只清除 Windows 的“来自网络”标记，不改变文件内容，也不代表已签名");

            string report = Environment.GetEnvironmentVariable(TargetReportEnvVar);
            if (!string.IsNullOrEmpty(report))
            {
                try { File.WriteAllText(report, text.ToString(), Encoding.UTF8); }
                catch (Exception) { }
                return;
            }

            try
            {
                if (Quiet()) return;
                MessageBox.Show(
                    (selfCleared
                        ? "已清除本 exe 的“来自网络”标记（Zone.Identifier）。"
                        : "本 exe 本来就没有“来自网络”标记。") +
                    "\r\n\r\n运行目录中清除 " + filesCleared + " 个文件的同类标记。" +
                    "\r\n\r\n这只影响 Windows 对下载文件的提示，不改变文件内容，" +
                    "也不代表程序已经签名。",
                    "SKN 键盘驱动 — 解除锁定", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception)
            {
            }
        }

        private static void WriteTargetReport(string exeDir, bool clearedWebMark)
        {
            string problem;
            string runtime = ResolveTargetDirectory(false, out problem);
            if (runtime == null) runtime = "(无法解析：" + problem + ")";

            StringBuilder text = new StringBuilder();
            text.AppendLine("exeDir=" + exeDir);
            text.AppendLine("runtimeDir=" + runtime);
            text.AppendLine("buildId=" + BuildId);
            string overrideDir = Environment.GetEnvironmentVariable(RuntimeEnvVar);
            text.AppendLine("override=" + (string.IsNullOrEmpty(overrideDir) ? "(none)" : overrideDir));
            text.AppendLine("writesOutsideRuntimeDir=none");
            text.AppendLine("markOfTheWeb=" + (clearedWebMark ? "cleared" : "none"));
            text.AppendLine("markOfTheWebError=" + WebMarkErrorText());
            string tar = TarPath();
            text.AppendLine("payload=tar.xz（构建期与运行期都用 Windows 自带 tar.exe）");
            text.AppendLine("tar=" + (File.Exists(tar) ? tar : tar + "（未找到：首次运行会失败）"));

            // Install mode is the default; --portable and removable/network drives keep
            // the "hidden folder beside the exe" behaviour. This switch never creates
            // anything, so it just reports what a run *would* do.
            bool portable = HasSwitch(Environment.GetCommandLineArgs(), "--portable") ||
                            EnvIsOne(PortableEnvVar);
            string installDir = SwitchValue(Environment.GetCommandLineArgs(), "--install-dir");
            if (string.IsNullOrEmpty(installDir))
            {
                installDir = Environment.GetEnvironmentVariable(InstallDirEnvVar);
            }
            if (!portable && string.IsNullOrEmpty(installDir) && IsRemovableOrNetwork(exeDir))
            {
                portable = true;
            }

            text.AppendLine("mode=" + (portable ? "portable（exe 旁边的隐藏目录）" : "install（安装目录）"));
            text.AppendLine("portableDir=" + runtime);
            text.AppendLine("installDir=" + (portable
                ? "(未使用)"
                : (string.IsNullOrEmpty(installDir) ? "(未指定：安装时会询问，默认 " +
                    DefaultInstallDir(exeDir) + ")" : installDir)));
            text.AppendLine("installerRename=" + AppExeName + " -> " + InstalledExeName);
            text.AppendLine("uninstaller=" + UninstallerName + "（在安装目录里）");

            // A file only when the caller asks for one (the test harness does);
            // otherwise the same text goes into a dialog, so the switch writes
            // nothing at all.
            string report = Environment.GetEnvironmentVariable(TargetReportEnvVar);
            if (!string.IsNullOrEmpty(report))
            {
                try { File.WriteAllText(report, text.ToString(), Encoding.UTF8); }
                catch (Exception) { }
                return;
            }

            try
            {
                if (Quiet()) return;
                MessageBox.Show(text.ToString(), "SKN 键盘驱动 — 运行目录",
                                MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception)
            {
            }
        }

        // ---- install mode ------------------------------------------------------

        /// <summary>
        /// Asks where to install. Returns null on cancel; dialogFailed tells the two
        /// apart, because a session without a window cannot show the dialog at all.
        /// </summary>
        private static string AskInstallDir(string exeDir, out bool createShortcut, out bool dialogFailed)
        {
            createShortcut = false;
            dialogFailed = false;
            string suggested = DefaultInstallDir(exeDir);
            try
            {
                InstallForm form = new InstallForm(suggested);
                if (form.ShowDialog() != DialogResult.OK) return null;
                string chosen = form.ChosenDirectory;
                if (string.IsNullOrEmpty(chosen) || chosen.Trim().Length == 0) return null;
                createShortcut = form.CreateShortcut;
                return chosen.Trim().Trim('"');
            }
            catch (Exception ex)
            {
                dialogFailed = true;
                Fail("无法显示安装位置选择窗口。\r\n\r\n" + ex.Message +
                     "\r\n\r\n请改用命令行指定安装位置后重试：\r\n" +
                     "  SKN 键盘驱动.exe --install-dir=\"D:\\SKN 键盘驱动\"");
                return null;
            }
        }

        /// <summary>
        /// Default: the non-system fixed drive with the most free space, so a
        /// first-time install does not land on C: unless the user asks for it.
        /// </summary>
        private static string DefaultInstallDir(string exeDir)
        {
            try
            {
                string systemDrive = Path.GetPathRoot(
                    Environment.GetFolderPath(Environment.SpecialFolder.Windows));
                DriveInfo best = null;
                DriveInfo[] drives = DriveInfo.GetDrives();
                for (int i = 0; i < drives.Length; i++)
                {
                    try
                    {
                        DriveInfo drive = drives[i];
                        if (!drive.IsReady || drive.DriveType != DriveType.Fixed) continue;
                        if (string.Equals(drive.Name, systemDrive, StringComparison.OrdinalIgnoreCase)) continue;
                        if (best == null || drive.AvailableFreeSpace > best.AvailableFreeSpace) best = drive;
                    }
                    catch (Exception)
                    {
                    }
                }
                if (best != null) return Path.Combine(best.Name, RuntimeFolderName);
            }
            catch (Exception)
            {
            }

            return Path.Combine(exeDir, RuntimeFolderName);
        }

        private static bool IsRemovableOrNetwork(string dir)
        {
            try
            {
                DriveInfo drive = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(dir)));
                return drive.DriveType == DriveType.Removable || drive.DriveType == DriveType.Network;
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>
        /// The payload ships the launcher as "SKN Launcher.exe"; an install renames it
        /// so the folder has an obviously named exe. Returns what should be started.
        /// </summary>
        private static string FinalizeInstall(string target)
        {
            string from = Path.Combine(target, AppExeName);
            string to = Path.Combine(target, InstalledExeName);

            if (!File.Exists(from))
            {
                return File.Exists(to) ? to : from;
            }

            try
            {
                if (File.Exists(to)) File.Delete(to);
                File.Move(from, to);
                return to;
            }
            catch (Exception)
            {
                // Locked, e.g. the app is running: keep the payload name this time
                // and rename on the next start.
                return File.Exists(to) ? to : from;
            }
        }

        /// <summary>
        /// The one file this program can put outside the install folder, and only when
        /// the user ticked the box in the install dialog. Uses WScript.Shell through
        /// late binding so no COM reference has to be added at compile time.
        /// </summary>
        private static void CreateDesktopShortcut(string exePath)
        {
            string link = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                "SKN 键盘驱动.lnk");

            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) throw new InvalidOperationException("系统未提供 WScript.Shell");

            object shell = Activator.CreateInstance(shellType);
            try
            {
                object shortcut = shellType.InvokeMember(
                    "CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { link });
                Type shortcutType = shortcut.GetType();
                shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut,
                                          new object[] { exePath });
                shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut,
                                          new object[] { Path.GetDirectoryName(exePath) });
                shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut,
                                          new object[] { exePath + ",0" });
                shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut,
                                          new object[] { "SKN 键盘驱动" });
                shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            finally
            {
                try { Marshal.ReleaseComObject(shell); }
                catch (Exception) { }
            }
        }

        private static bool EnvIsOne(string name)
        {
            return string.Equals(Environment.GetEnvironmentVariable(name), "1", StringComparison.Ordinal);
        }

        /// <summary>Reads --name=value or --name value; null when absent.</summary>
        private static string SwitchValue(string[] args, string name)
        {
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg.StartsWith(name + "=", StringComparison.OrdinalIgnoreCase))
                {
                    return arg.Substring(name.Length + 1);
                }
                if (string.Equals(arg, name, StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    return args[i + 1];
                }
            }
            return null;
        }

        private static bool IsUsable(string dir)
        {
            try
            {
                Directory.CreateDirectory(dir);
                string probe = Path.Combine(dir, ".write-test");
                File.WriteAllText(probe, "x");
                try { File.Delete(probe); }
                catch (Exception) { }
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static bool IsCurrent(string target, string appExe)
        {
            try
            {
                if (!File.Exists(appExe))
                {
                    // An install may legitimately still carry the payload's exe name
                    // when the rename was blocked (app running at the time).
                    if (!File.Exists(Path.Combine(target, AppExeName)) &&
                        !File.Exists(Path.Combine(target, InstalledExeName))) return false;
                }
                string marker = Path.Combine(target, MarkerName);
                if (!File.Exists(marker)) return false;
                return string.Equals(File.ReadAllText(marker).Trim(), BuildId, StringComparison.Ordinal);
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static void WriteMarker(string target)
        {
            try
            {
                File.WriteAllText(Path.Combine(target, MarkerName), BuildId);
            }
            catch (Exception)
            {
            }
        }

        /// <summary>
        /// Unpacks the appended tar.xz payload with Windows' own tar.exe (bsdtar,
        /// shipped since Windows 10 1803). Nothing third-party has to ship with the
        /// app or be dropped on the user's disk: the archive is written to a hidden
        /// temporary file inside the runtime folder, expanded there and removed
        /// again, so the runtime folder holds only the program afterwards.
        /// </summary>
        private static void ExtractPayload(string self, long payloadStart, long payloadLength,
                                           string target, ProgressForm form, ExtractStats stats)
        {
            Directory.CreateDirectory(target);
            string archive = Path.Combine(target, PayloadName);
            CopyRegion(self, payloadStart, payloadLength, archive, form);

            try
            {
                if (form != null) form.Marquee("正在展开程序文件（约 340 MB，请稍候）…");
                int code = RunTar(archive, target, null);
                if (code != 0)
                {
                    // Retry once with the tool's own diagnostics kept in a log file:
                    // reading tar's output through a pipe is avoided on purpose, so
                    // this is the only way to explain a failure instead of guessing.
                    string log = Path.Combine(target, "tar-error.log");
                    RunTar(archive, target, log);
                    throw new InvalidDataException("展开程序文件失败（tar 退出码 " + code + "）。诊断信息：" + log);
                }

                int entries;
                long bytes;
                MeasureTree(target, archive, out entries, out bytes);
                stats.Entries = entries;
                stats.Bytes = bytes;
            }
            finally
            {
                TryDelete(archive);
            }
        }

        /// <summary>Copies the payload region out of this exe into its own file.</summary>
        private static void CopyRegion(string self, long start, long length, string destination,
                                       ProgressForm form)
        {
            const int bufferSize = 1 << 20;
            using (FileStream input = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                input.Seek(start, SeekOrigin.Begin);
                using (FileStream output = new FileStream(destination, FileMode.Create, FileAccess.Write,
                                                          FileShare.None))
                {
                    byte[] buffer = new byte[bufferSize];
                    long done = 0;
                    while (done < length)
                    {
                        int want = (int)Math.Min((long)bufferSize, length - done);
                        int read = input.Read(buffer, 0, want);
                        if (read <= 0) throw new EndOfStreamException("读取负载时提前结束。");
                        output.Write(buffer, 0, read);
                        done += read;
                        if (form != null)
                        {
                            form.CopyProgress((int)(done / bufferSize), (int)(length / bufferSize));
                        }
                    }
                }
            }
        }

        /// <summary>Runs tar.exe; logFile != null routes the tool's output into a file.</summary>
        private static int RunTar(string archive, string target, string logFile)
        {
            string tar = TarPath();
            ProcessStartInfo info = new ProcessStartInfo();
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WorkingDirectory = target;

            if (logFile == null)
            {
                info.FileName = tar;
                info.Arguments = "-xf " + Quote(archive) + " -C " + Quote(target);
            }
            else
            {
                info.FileName = Path.Combine(SystemDirectory(), "cmd.exe");
                info.Arguments = "/c " + Quote(tar) + " -xf " + Quote(archive) + " -C " + Quote(target)
                                 + " > " + Quote(logFile) + " 2>&1";
            }

            using (Process process = Process.Start(info))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }

        private static string TarPath()
        {
            string tar = Path.Combine(SystemDirectory(), "tar.exe");
            if (File.Exists(tar)) return tar;
            return "tar.exe";
        }

        private static string SystemDirectory()
        {
            string dir = Environment.SystemDirectory;
            if (string.IsNullOrEmpty(dir))
            {
                dir = Environment.GetFolderPath(Environment.SpecialFolder.System);
            }
            return dir;
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        /// <summary>Counts what ended up in the runtime folder, ignoring our own archive.</summary>
        private static void MeasureTree(string target, string ignore, out int entries, out long bytes)
        {
            entries = 0;
            bytes = 0L;
            entries += Directory.GetDirectories(target, "*", SearchOption.AllDirectories).Length;

            string[] files = Directory.GetFiles(target, "*", SearchOption.AllDirectories);
            for (int i = 0; i < files.Length; i++)
            {
                if (string.Equals(files[i], ignore, StringComparison.OrdinalIgnoreCase)) continue;
                entries++;
                bytes += new FileInfo(files[i]).Length;
            }
        }

        private static void TryDelete(string file)
        {
            try
            {
                if (File.Exists(file)) File.Delete(file);
            }
            catch (Exception)
            {
            }
        }

        private static int Launch(string appExe, string workDir, string arguments, int waitMs)
        {
            ProcessStartInfo info = new ProcessStartInfo(appExe, arguments == null ? "" : arguments);
            info.WorkingDirectory = workDir;
            info.UseShellExecute = false;

            using (Process process = Process.Start(info))
            {
                if (waitMs <= 0) return 0;
                if (process.WaitForExit(waitMs)) return process.ExitCode;
                return 0;
            }
        }

        private static void WriteReport(string target, ExtractStats stats, string status)
        {
            try
            {
                StringBuilder text = new StringBuilder();
                text.AppendLine("status=" + status);
                text.AppendLine("buildId=" + BuildId);
                text.AppendLine("entries=" + stats.Entries);
                text.AppendLine("bytes=" + stats.Bytes);
                text.AppendLine("skipped=" + stats.Skipped);
                text.AppendLine("target=" + target);
                text.AppendLine("pid=" + Process.GetCurrentProcess().Id);
                File.WriteAllText(Path.Combine(target, ReportName), text.ToString(), Encoding.UTF8);
            }
            catch (Exception)
            {
            }
        }

        private static bool HasSwitch(string[] args, string name)
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static string ForwardArgs(string[] args)
        {
            StringBuilder text = new StringBuilder();
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (string.IsNullOrEmpty(arg)) continue;
                if (string.Equals(arg, "--extract-only", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(arg, "--re-extract", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(arg, "--print-target", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(arg, "--unblock", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(arg, "--help", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(arg, "-h", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(arg, "/?", StringComparison.OrdinalIgnoreCase)) continue;
                if (text.Length > 0) text.Append(' ');
                text.Append(arg);
            }
            return text.ToString();
        }

        private static string JoinArgs(string first, string second)
        {
            if (string.IsNullOrEmpty(first)) return second;
            return first + " " + second;
        }

        private static void Fail(string message)
        {
            try
            {
                MessageBox.Show(message, "SKN 键盘驱动 便携版",
                                MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            catch (Exception)
            {
            }
        }
    }

    /// <summary>Scrollable help window: the documentation ships inside the exe, so it
    /// must stay readable however long it gets.</summary>
    /// <summary>
    /// "Where should this be installed?" - an editable path, a browse button and an
    /// opt-in desktop shortcut. The checkbox is off by default because a shortcut is
    /// the only thing this program could write outside the install folder.
    /// </summary>
    internal sealed class InstallForm : Form
    {
        private readonly TextBox pathBox;
        private readonly CheckBox shortcutBox;

        internal InstallForm(string suggested)
        {
            this.Text = "SKN 键盘驱动 — 安装";
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.MaximizeBox = false;
            this.MinimizeBox = false;
            this.ClientSize = new Size(560, 248);

            Label title = new Label();
            title.AutoSize = false;
            title.SetBounds(16, 14, 528, 38);
            title.Text = "选择安装位置。程序本体、设置、离线缓存与已配对键盘记录都只写在这个目录里，" +
                         "不在别处写任何文件。";

            Label caption = new Label();
            caption.AutoSize = true;
            caption.SetBounds(16, 58, 100, 18);
            caption.Text = "安装目录：";

            this.pathBox = new TextBox();
            this.pathBox.SetBounds(16, 80, 428, 24);
            this.pathBox.Text = suggested;

            Button browse = new Button();
            browse.SetBounds(452, 79, 92, 26);
            browse.Text = "浏览…";
            browse.Click += new EventHandler(this.Browse);

            this.shortcutBox = new CheckBox();
            this.shortcutBox.SetBounds(16, 114, 528, 20);
            this.shortcutBox.Text = "在桌面创建快捷方式（会在桌面写一个 .lnk，默认不勾）";

            Label note = new Label();
            note.AutoSize = false;
            note.SetBounds(16, 140, 528, 48);
            note.Text = "再次运行本程序并选择同一个目录即为更新：程序文件覆盖，data 子目录里的" +
                        "设置与缓存保留。\r\n卸载：运行安装目录里的“卸载.exe”。";

            Button ok = new Button();
            ok.SetBounds(344, 200, 96, 30);
            ok.Text = "安装";
            ok.DialogResult = DialogResult.OK;

            Button cancel = new Button();
            cancel.SetBounds(448, 200, 96, 30);
            cancel.Text = "取消";
            cancel.DialogResult = DialogResult.Cancel;

            this.Controls.Add(title);
            this.Controls.Add(caption);
            this.Controls.Add(this.pathBox);
            this.Controls.Add(browse);
            this.Controls.Add(this.shortcutBox);
            this.Controls.Add(note);
            this.Controls.Add(ok);
            this.Controls.Add(cancel);

            this.AcceptButton = ok;
            this.CancelButton = cancel;
        }

        internal string ChosenDirectory { get { return this.pathBox.Text; } }
        internal bool CreateShortcut { get { return this.shortcutBox.Checked; } }

        private void Browse(object sender, EventArgs e)
        {
            try
            {
                FolderBrowserDialog dialog = new FolderBrowserDialog();
                dialog.Description = "选择 SKN 键盘驱动的安装目录";
                dialog.ShowNewFolderButton = true;
                string current = this.pathBox.Text.Trim();
                if (current.Length > 0)
                {
                    try { dialog.SelectedPath = current; }
                    catch (Exception) { }
                }
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    this.pathBox.Text = dialog.SelectedPath;
                }
            }
            catch (Exception)
            {
            }
        }
    }

    internal sealed class HelpForm : Form
    {
        internal HelpForm(string text)
        {
            this.Text = "SKN 键盘驱动 — 帮助";
            this.StartPosition = FormStartPosition.CenterScreen;
            this.MinimizeBox = false;
            this.ClientSize = new Size(640, 480);
            this.MinimumSize = new Size(420, 300);

            TextBox box = new TextBox();
            box.Multiline = true;
            box.ReadOnly = true;
            box.WordWrap = true;
            box.ScrollBars = ScrollBars.Vertical;
            box.Dock = DockStyle.Fill;
            box.Text = text;
            box.Select(0, 0);

            Button close = new Button();
            close.Text = "关闭";
            close.Dock = DockStyle.Bottom;
            close.Height = 34;
            close.Click += delegate(object sender, EventArgs e) { this.Close(); };

            this.Controls.Add(box);
            this.Controls.Add(close);
            this.AcceptButton = close;
        }
    }

    /// <summary>Small progress window shown only while unpacking on first run.</summary>
    internal sealed class ProgressForm : Form
    {
        private readonly Label label;
        private readonly ProgressBar bar;
        private volatile bool closeRequested;

        internal ProgressForm()
        {
            this.Text = "SKN 键盘驱动";
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.MaximizeBox = false;
            this.MinimizeBox = false;
            this.ControlBox = false;
            this.TopMost = true;
            this.ClientSize = new Size(460, 108);

            this.label = new Label();
            this.label.AutoSize = false;
            this.label.SetBounds(16, 14, 428, 40);
            this.label.Text = "首次启动：正在展开程序文件（仅此一次，约十到二十秒）…";

            this.bar = new ProgressBar();
            this.bar.SetBounds(16, 62, 428, 22);
            this.bar.Minimum = 0;
            this.bar.Maximum = 100;

            this.Controls.Add(this.label);
            this.Controls.Add(this.bar);
        }

        /// <summary>Progress for the copy-out phase: the payload is written next to the
        /// program before tar unpacks it.</summary>
        internal void CopyProgress(int doneMb, int totalMb)
        {
            try
            {
                if (!this.IsHandleCreated) return;
                this.BeginInvoke(new MethodInvoker(delegate()
                {
                    if (totalMb > 0)
                    {
                        this.bar.Style = ProgressBarStyle.Continuous;
                        this.bar.Maximum = totalMb;
                        this.bar.Value = Math.Min(doneMb, totalMb);
                    }
                    this.label.Text = "正在准备程序文件… " + doneMb + " / " + totalMb + " MB";
                }));
            }
            catch (Exception)
            {
            }
        }

        /// <summary>Indeterminate phase: tar.exe reports no machine-readable progress.</summary>
        internal void Marquee(string text)
        {
            try
            {
                if (!this.IsHandleCreated) return;
                this.BeginInvoke(new MethodInvoker(delegate()
                {
                    this.bar.Style = ProgressBarStyle.Marquee;
                    this.label.Text = text;
                }));
            }
            catch (Exception)
            {
            }
        }

        internal void CloseFromWorker()
        {
            this.closeRequested = true;
            try
            {
                if (this.IsHandleCreated)
                {
                    this.BeginInvoke(new MethodInvoker(this.Close));
                }
            }
            catch (Exception)
            {
            }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (this.closeRequested) this.Close();
        }
    }
}