// SKN 键盘驱动 — uninstaller (卸载.exe).
//
// It is built by build/make-single-exe.mjs and travels inside the payload, so the
// install folder has a way out without an entry in "Apps & features" - that entry
// would need registry keys, and this program is not allowed to write anything
// outside its own install folder.
//
// What it does, in order:
//   1. refuses to run anywhere that does not look like an install folder, and
//      refuses drive roots and system folders;
//   2. refuses while the app is still running (locked files would half-delete);
//   3. deletes every file and folder inside its own folder, except itself;
//   4. removes itself and the (now empty) folder through a detached cmd.exe that
//      waits two seconds for this process to exit - the classic uninstaller
//      trick, and it leaves no helper file or temporary copy behind.
//
// Writes: only inside its own folder. No registry, no %TEMP%, no logs.
//
// Switches:  --yes     uninstall without asking (scripted / silent)
//            --force   continue even if the app is running or the folder looks wrong
//            --help    explain itself
// Env:       SKN_QUIET=1   same as --yes
//            SKN_TARGET_REPORT=<file>   write a machine-readable report there
//
// Compiled with the .NET Framework csc (C# 5 only: no interpolation, no ?. ).
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("SKN 键盘驱动 卸载程序")]
[assembly: AssemblyProduct("SKN 键盘驱动")]
[assembly: AssemblyCompany("SKN")]
[assembly: AssemblyVersion("1.1.1.0")]
[assembly: AssemblyFileVersion("1.1.1.0")]

namespace SknUninstall
{
    internal static class Program
    {
        private const string AppExeName = "SKN 键盘驱动.exe";
        private const string PayloadAppExeName = "SKN Launcher.exe";
        private const string MarkerName = ".build-id";
        private const string ReportEnvVar = "SKN_TARGET_REPORT";
        private const string QuietEnvVar = "SKN_QUIET";

        [STAThread]
        internal static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string self = Assembly.GetExecutingAssembly().Location;
            string dir = Path.GetDirectoryName(self);
            bool quiet = HasSwitch(args, "--yes") || Quiet();
            bool force = HasSwitch(args, "--force");

            if (HasSwitch(args, "--help") || HasSwitch(args, "-h") || HasSwitch(args, "/?"))
            {
                ShowHelp(dir, quiet);
                return 0;
            }

            string problem = ValidateTarget(dir);
            if (problem != null && !force)
            {
                Fail(problem + "\r\n\r\n如果确认要清空这个目录，请加 --force 参数再运行。", quiet);
                return 20;
            }

            if (IsAppRunning(dir) && !force)
            {
                Fail("SKN 键盘驱动 正在运行，请先关闭它（含所有窗口），再运行卸载程序。\r\n\r\n" +
                     "确认要强制继续请加 --force。", quiet);
                return 21;
            }

            if (!quiet && !Confirm(dir))
            {
                return 0;
            }

            int files = 0;
            int folders = 0;
            int locked = 0;
            DeleteContents(dir, self, ref files, ref folders, ref locked);

            bool scheduled = ScheduleSelfDelete(dir, self);

            StringBuilder report = new StringBuilder();
            report.AppendLine("status=" + (locked == 0 ? "ok" : "partial"));
            report.AppendLine("dir=" + dir);
            report.AppendLine("deletedFiles=" + files);
            report.AppendLine("deletedFolders=" + folders);
            report.AppendLine("locked=" + locked);
            report.AppendLine("selfDeleteScheduled=" + scheduled);
            report.AppendLine("note=只删除本目录内的内容；不写注册表、不写 %TEMP%，也不在别处留下任何文件");
            WriteReport(report.ToString());

            if (!quiet)
            {
                string text;
                if (locked == 0)
                {
                    text = "已卸载：本目录内的 " + files + " 个文件与 " + folders + " 个子目录都已删除。";
                }
                else
                {
                    text = "部分完成：已删除 " + files + " 个文件与 " + folders + " 个子目录，" +
                           locked + " 个文件被占用未能删除。\r\n\r\n" +
                           "请关闭正在使用它们的程序后，重新运行本卸载程序。";
                }

                text += "\r\n\r\n" + (scheduled
                    ? "本卸载程序与目录会在它退出后自动删除（约两秒）。"
                    : "本卸载程序无法自删，请手动删除：" + dir);

                try
                {
                    MessageBox.Show(text, "SKN 键盘驱动 — 卸载", MessageBoxButtons.OK,
                                    MessageBoxIcon.Information);
                }
                catch (Exception)
                {
                }
            }

            return locked == 0 ? 0 : 22;
        }

        /// <summary>Safety net: never let a stray copy empty the wrong folder.</summary>
        private static string ValidateTarget(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return "无法确定自身所在目录。";

            string full = Path.GetFullPath(dir);
            if (!Directory.Exists(full)) return "目录不存在：" + full;

            string trimmed = full.TrimEnd(Path.DirectorySeparatorChar);
            if (trimmed.Length <= 2 && trimmed.EndsWith(":", StringComparison.Ordinal))
            {
                return "拒绝在盘符根目录执行：" + full;
            }

            string[] forbidden = new string[]
            {
                Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                Environment.GetFolderPath(Environment.SpecialFolder.System),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory)
            };
            for (int i = 0; i < forbidden.Length; i++)
            {
                if (string.IsNullOrEmpty(forbidden[i])) continue;
                if (string.Equals(full.TrimEnd(Path.DirectorySeparatorChar),
                                  forbidden[i].TrimEnd(Path.DirectorySeparatorChar),
                                  StringComparison.OrdinalIgnoreCase))
                {
                    return "拒绝在系统目录执行：" + full;
                }
            }

            bool looksInstalled = File.Exists(Path.Combine(full, MarkerName))
                                  || File.Exists(Path.Combine(full, AppExeName))
                                  || File.Exists(Path.Combine(full, PayloadAppExeName));
            if (!looksInstalled)
            {
                return "这个目录里没有 SKN 键盘驱动的安装标记，" + AppExeName + " 也不在里面：" +
                       "\r\n" + full + "\r\n为了安全，卸载程序不会清空它。";
            }

            return null;
        }

        /// <summary>
        /// Only a process started from *this* folder counts. A stale process of the same
        /// name elsewhere (or one whose path cannot be read, e.g. a zombie left behind by
        /// a crashed run) must not block the uninstall - locked files are counted instead.
        /// </summary>
        private static bool IsAppRunning(string dir)
        {
            string prefix = dir.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            return RunningFrom("SKN 键盘驱动", prefix) || RunningFrom("SKN Launcher", prefix);
        }

        private static bool RunningFrom(string name, string prefix)
        {
            try
            {
                Process[] found = Process.GetProcessesByName(name);
                if (found == null) return false;
                for (int i = 0; i < found.Length; i++)
                {
                    try
                    {
                        string path = found[i].MainModule.FileName;
                        if (string.IsNullOrEmpty(path)) continue;
                        if (path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return true;
                    }
                    catch (Exception)
                    {
                        // No access to that process's path: it cannot be ours.
                    }
                }
            }
            catch (Exception)
            {
            }
            return false;
        }

        private static bool Confirm(string dir)
        {
            try
            {
                long size = 0L;
                int count = 0;
                try
                {
                    FileInfo[] files = new DirectoryInfo(dir).GetFiles("*", SearchOption.AllDirectories);
                    count = files.Length;
                    for (int i = 0; i < files.Length; i++) size += files[i].Length;
                }
                catch (Exception)
                {
                }

                string text = "将删除这个目录里的全部内容（包括设置、离线缓存与已配对键盘记录）：\r\n\r\n"
                              + dir + "\r\n\r\n"
                              + "共 " + count + " 个文件，" + (size / 1048576L) + " MB。\r\n\r\n"
                              + "确定要卸载吗？";
                return MessageBox.Show(text, "SKN 键盘驱动 — 卸载确认",
                                       MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes;
            }
            catch (Exception)
            {
                return true;
            }
        }

        private static void DeleteContents(string dir, string self, ref int files, ref int folders,
                                           ref int locked)
        {
            FileInfo[] fileList;
            try
            {
                fileList = new DirectoryInfo(dir).GetFiles("*", SearchOption.AllDirectories);
            }
            catch (Exception)
            {
                fileList = new FileInfo[0];
            }

            for (int i = 0; i < fileList.Length; i++)
            {
                string path = fileList[i].FullName;
                if (string.Equals(path, self, StringComparison.OrdinalIgnoreCase)) continue;
                try
                {
                    File.SetAttributes(path, FileAttributes.Normal);
                    File.Delete(path);
                    files++;
                }
                catch (Exception)
                {
                    locked++;
                }
            }

            // Deepest first, and never the folder itself (that happens after we exit).
            string[] dirList;
            try
            {
                dirList = Directory.GetDirectories(dir, "*", SearchOption.AllDirectories);
            }
            catch (Exception)
            {
                dirList = new string[0];
            }

            Array.Sort(dirList, delegate(string a, string b) { return b.Length.CompareTo(a.Length); });
            for (int i = 0; i < dirList.Length; i++)
            {
                try
                {
                    Directory.Delete(dirList[i], false);
                    folders++;
                }
                catch (Exception)
                {
                }
            }
        }

        /// <summary>
        /// Removes this exe and the now empty folder after this process exits. cmd.exe
        /// is started detached and waits two seconds; nothing is written anywhere, so
        /// no helper file has to be cleaned up afterwards.
        /// </summary>
        private static bool ScheduleSelfDelete(string dir, string self)
        {
            try
            {
                string command = "ping -n 3 127.0.0.1 > nul & del /f /q \"" + self + "\" & rd /q \"" + dir + "\"";
                ProcessStartInfo info = new ProcessStartInfo(
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"),
                    "/c " + command);
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                // Anywhere but our own folder: a process cannot delete the directory it
                // is currently sitting in, so cmd must not run with this cwd.
                info.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System);
                Process.Start(info);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static void ShowHelp(string dir, bool quiet)
        {
            StringBuilder text = new StringBuilder();
            text.AppendLine("SKN 键盘驱动 — 卸载程序");
            text.AppendLine();
            text.AppendLine("本程序只做一件事：删除它所在目录里的全部内容，然后删除自己与");
            text.AppendLine("该目录。它不写注册表、不写 %TEMP%，也不在别处留下任何文件，");
            text.AppendLine("所以“应用和功能”里不会有卸载入口——卸载就是运行它。");
            text.AppendLine();
            text.AppendLine("目录：" + dir);
            text.AppendLine();
            text.AppendLine("  --yes     不再询问，直接卸载");
            text.AppendLine("  --force   目录看起来不对、或程序仍在运行时也继续");
            text.AppendLine("  --help    显示本说明");

            if (quiet)
            {
                WriteReport("status=help\r\ndir=" + dir + "\r\n");
                return;
            }

            try
            {
                MessageBox.Show(text.ToString(), "SKN 键盘驱动 — 卸载程序",
                                MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception)
            {
            }
        }

        private static void Fail(string message, bool quiet)
        {
            WriteReport("status=failed\r\nmessage=" + message.Replace("\r\n", " ") + "\r\n");
            if (quiet) return;
            try
            {
                MessageBox.Show(message, "SKN 键盘驱动 — 卸载程序",
                                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            catch (Exception)
            {
            }
        }

        private static void WriteReport(string text)
        {
            string path = Environment.GetEnvironmentVariable(ReportEnvVar);
            if (string.IsNullOrEmpty(path)) return;
            try
            {
                File.WriteAllText(path, text, Encoding.UTF8);
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

        private static bool Quiet()
        {
            return string.Equals(Environment.GetEnvironmentVariable(QuietEnvVar), "1",
                                 StringComparison.Ordinal);
        }
    }
}