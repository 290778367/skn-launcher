// Test-only asset: a process that just sits there for a while, so the uninstaller's
// "the app is still running" guard can be exercised deterministically. It is
// compiled into build/out/sleeper.exe by the verification runs and never shipped.
//
//   sleeper.exe <milliseconds>
using System;
using System.Threading;

internal static class Sleeper
{
    private static int Main(string[] args)
    {
        int ms = 5000;
        if (args.Length > 0)
        {
            try { ms = int.Parse(args[0]); }
            catch (Exception) { }
        }
        Thread.Sleep(ms);
        return 0;
    }
}