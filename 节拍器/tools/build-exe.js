// 打包：node tools/build-exe.js
//  1. 把 index.html 和它用到的 CSS、JS 合并成一个单文件网页 dist/自动节拍器.html
//  2. 用 Windows 自带的 C# 编译器把这个网页嵌进 dist/自动节拍器.exe
// 只需要 Node.js 和 Windows (自带 .NET Framework 4)，不用安装其他东西。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---------- 1. 单文件网页 ----------
let html = read('index.html');
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) => `<style>\n${read(href)}</style>`);
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  const code = read(src);
  if (code.includes('</script')) throw new Error(`${src} 里含有 </script，不能直接内联`);
  return `<script>\n${code}</script>`;
});

fs.mkdirSync(dist, { recursive: true });
const htmlOut = path.join(dist, '自动节拍器.html');
fs.writeFileSync(htmlOut, html);
console.log('单文件网页:', path.relative(root, htmlOut), `(${Math.round(html.length / 1024)} KB)`);

// ---------- 2. exe ----------
if (process.platform !== 'win32') {
  console.log('不是 Windows，跳过 exe');
  process.exit(0);
}
const windir = process.env.WINDIR || 'C:\\Windows';
const csc = [
  path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
].find((p) => fs.existsSync(p));
if (!csc) throw new Error('找不到 .NET Framework 4 的 csc.exe');

const exeOut = path.join(dist, '自动节拍器.exe');
execFileSync(csc, [
  '/nologo',
  '/target:winexe',
  '/optimize+',
  '/codepage:65001',
  `/out:${exeOut}`,
  `/resource:${htmlOut},metronome.html`,
  path.join(__dirname, 'launcher.cs'),
], { stdio: 'inherit' });
console.log('exe:', path.relative(root, exeOut), `(${Math.round(fs.statSync(exeOut).size / 1024)} KB)`);
