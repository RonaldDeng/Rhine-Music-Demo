// Rhine Music launcher for Windows 10+. Built with the C# 5 compiler that ships
// with .NET Framework 4.x, so building it and running it need no extra installs.
//
//   * Prebuilt package (runtime\node.exe, dist\, node_modules\): starts the local
//     music service in the background without a console window, then the Node
//     launcher opens the default browser.
//   * Source checkout that still needs "npm ci" / "npm run build": shows the
//     console through 启动音乐播放器.bat so progress and errors stay visible.
//   * Errors are shown in a dialog instead of a vanishing console window.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("Rhine Music")]
[assembly: AssemblyProduct("Rhine Music Demo")]
[assembly: AssemblyDescription("Rhine Music Demo launcher for Windows")]
[assembly: AssemblyCompany("RonaldDeng")]
[assembly: AssemblyVersion("0.3.0.0")]
[assembly: AssemblyFileVersion("0.3.0.0")]

internal static class Program
{
    private const string Title = "Rhine Music";
    private const int StartupTimeoutMilliseconds = 180000;

    [STAThread]
    private static int Main()
    {
        Application.EnableVisualStyles();
        // Trailing backslashes would escape the closing quote of a command-line argument.
        string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string script = Path.Combine(Path.Combine(baseDir, "scripts"), "launch-music.mjs");
        if (!File.Exists(script))
        {
            Fail("找不到 scripts\\launch-music.mjs。\r\n请把完整的压缩包解压后再运行，不要单独移动此程序。");
            return 2;
        }

        string node = FindNode(baseDir);
        if (node == null)
        {
            OfferNodeDownload();
            return 1;
        }

        string marker = Path.Combine(Path.Combine(baseDir, "dist"), ".music-build.json");
        bool ready = File.Exists(marker) && Directory.Exists(Path.Combine(baseDir, "node_modules"));
        string batch = Path.Combine(baseDir, "启动音乐播放器.bat");
        if (!ready && File.Exists(batch)) return RunVisible(batch, baseDir);
        return RunHidden(node, script, baseDir);
    }

    private static string FindNode(string baseDir)
    {
        List<string> candidates = new List<string>();
        candidates.Add(Path.Combine(Path.Combine(baseDir, "runtime"), "node.exe"));
        string pathVariable = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string entry in pathVariable.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
        {
            candidates.Add(Path.Combine(entry.Trim().Trim('"'), "node.exe"));
        }
        string[] roots = new string[] {
            Environment.GetEnvironmentVariable("ProgramFiles"),
            Environment.GetEnvironmentVariable("ProgramW6432"),
            Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
            Path.Combine(Environment.GetEnvironmentVariable("LocalAppData") ?? "", "Programs"),
            Environment.GetEnvironmentVariable("NVM_SYMLINK"),
        };
        foreach (string root in roots)
        {
            if (string.IsNullOrEmpty(root)) continue;
            candidates.Add(Path.Combine(Path.Combine(root, "nodejs"), "node.exe"));
            candidates.Add(Path.Combine(root, "node.exe"));
        }
        foreach (string candidate in candidates)
        {
            try { if (File.Exists(candidate)) return candidate; } catch (ArgumentException) { }
        }
        return null;
    }

    private static int RunVisible(string batch, string baseDir)
    {
        string shell = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
        ProcessStartInfo info = new ProcessStartInfo(shell, "/d /s /c \"\"" + batch + "\"\"");
        info.WorkingDirectory = baseDir;
        info.UseShellExecute = false;
        using (Process process = Process.Start(info))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }

    private static int RunHidden(string node, string script, string baseDir)
    {
        ProcessStartInfo info = new ProcessStartInfo(node, "\"" + script + "\"");
        info.WorkingDirectory = baseDir;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.StandardOutputEncoding = Encoding.UTF8;
        info.StandardErrorEncoding = Encoding.UTF8;
        info.EnvironmentVariables["PATH"] = Path.GetDirectoryName(node) + ";" + (Environment.GetEnvironmentVariable("PATH") ?? "");

        StringBuilder log = new StringBuilder();
        DataReceivedEventHandler collect = delegate(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            lock (log) { log.AppendLine(e.Data); }
        };

        using (Process process = new Process())
        {
            process.StartInfo = info;
            process.OutputDataReceived += collect;
            process.ErrorDataReceived += collect;
            try { process.Start(); }
            catch (Exception error)
            {
                Fail("无法启动 Node.js：" + error.Message);
                return 3;
            }
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            // WaitForExit(int) deliberately does not wait for the redirected pipes to
            // close: the background music service inherits them and keeps running.
            if (!process.WaitForExit(StartupTimeoutMilliseconds))
            {
                try { process.Kill(); } catch (Exception) { }
                Fail("启动超过 3 分钟仍未完成，已停止。\r\n\r\n" + Tail(log));
                return 4;
            }
            System.Threading.Thread.Sleep(250);
            if (process.ExitCode != 0)
            {
                Fail("启动未完成。\r\n\r\n" + Tail(log));
                return process.ExitCode;
            }
            return 0;
        }
    }

    private static string Tail(StringBuilder log)
    {
        string text;
        lock (log) { text = log.ToString().Trim(); }
        if (text.Length == 0) return "（没有输出）";
        string[] lines = text.Split(new string[] { "\r\n", "\n" }, StringSplitOptions.None);
        int start = Math.Max(0, lines.Length - 14);
        StringBuilder tail = new StringBuilder();
        for (int index = start; index < lines.Length; index++) tail.AppendLine(lines[index]);
        string result = tail.ToString().Trim();
        return result.Length > 1800 ? result.Substring(result.Length - 1800) : result;
    }

    private static void Fail(string message)
    {
        MessageBox.Show(message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private static void OfferNodeDownload()
    {
        DialogResult answer = MessageBox.Show(
            "没有找到 Node.js。\r\n\r\n请安装 Node.js 22.12 或更新的 LTS 版本后再运行；\r\n完整的 Windows 压缩包已自带运行环境，请确认 runtime 文件夹没有被删除。\r\n\r\n是否打开 Node.js 下载页面？",
            Title, MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
        if (answer == DialogResult.Yes)
        {
            try { Process.Start(new ProcessStartInfo("https://nodejs.org/") { UseShellExecute = true }); } catch (Exception) { }
        }
    }
}
