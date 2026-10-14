// TEST ONLY - never shipped.
//
// Stands in for "SKN Launcher.exe" so the portable launcher's crash-detection
// and --no-sandbox fallback can be verified without Chromium or a GUI:
//   * it appends its own command line to argv.log next to itself
//   * without --no-sandbox it exits with 0x80000003 (STATUS_BREAKPOINT as a
//     signed exit code), exactly like the real app does when Chromium's sandbox
//     cannot initialise
//   * with --no-sandbox it exits cleanly
using System;
using System.IO;
using System.Reflection;
using System.Text;

internal static class ProbeApp
{
    internal static int Main(string[] args)
    {
        string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string line = DateTime.Now.ToString("HH:mm:ss.fff") + " exit=";
        bool compatible = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (string.Equals(args[i], "--no-sandbox", StringComparison.OrdinalIgnoreCase)) compatible = true;
        }
        int code = compatible ? 0 : unchecked((int)0x80000003);
        line += code + " " + string.Join(" ", args);

        try
        {
            File.AppendAllText(Path.Combine(dir, "argv.log"), line + Environment.NewLine, Encoding.UTF8);
        }
        catch (Exception)
        {
        }
        return code;
    }
}