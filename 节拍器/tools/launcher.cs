// 自动节拍器启动器：把内嵌的网页释放到临时文件夹，再用默认浏览器打开。
// 由 tools/build-exe.js 编译，网页在编译时作为资源嵌进 exe。
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

static class Program
{
    [STAThread]
    static void Main()
    {
        try
        {
            string dir = Path.Combine(Path.GetTempPath(), "AutoMetronome");
            Directory.CreateDirectory(dir);
            string page = Path.Combine(dir, "index.html");

            using (Stream src = Assembly.GetExecutingAssembly().GetManifestResourceStream("metronome.html"))
            using (FileStream dst = File.Create(page))
            {
                src.CopyTo(dst);
            }

            Process.Start(new ProcessStartInfo(page) { UseShellExecute = true });
        }
        catch (Exception e)
        {
            MessageBox.Show("无法打开自动节拍器：" + e.Message, "自动节拍器", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
