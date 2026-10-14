// TEST ONLY - never shipped.
//
// Stands in for signtool.exe so the build's signing integration can be verified
// without a real certificate: it appends its own command line to a log next to
// itself and exits successfully. That proves the exact flags handed to signtool
// (Artifact Signing dlib/dmdf, PFX with password, certificate thumbprint,
// timestamp servers) without touching a private key.
using System;
using System.IO;
using System.Reflection;
using System.Text;

internal static class FakeSignTool
{
    internal static int Main(string[] args)
    {
        string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string line = DateTime.Now.ToString("HH:mm:ss.fff") + " " + string.Join(" ", args);
        try
        {
            File.AppendAllText(Path.Combine(dir, "fake-signtool.log"), line + Environment.NewLine, Encoding.UTF8);
        }
        catch (Exception)
        {
        }
        Console.WriteLine("fake signtool: " + line);
        return 0;
    }
}