#!/usr/bin/env node
// 用与 macOS 版相同的模板和 vendor 库,生成 windows/app/reader.html(完全离线)。
// 逻辑与仓库根目录的 build_html.py 一致,这样 Windows 上不需要安装 Python。
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..', '..');
const vendor = path.join(repo, 'vendor');
const rd = p => fs.readFileSync(path.join(vendor, p), 'utf8');

let css = rd('katex.min.css');
// 只保留 woff2 并内联为 data: URL,其余字体格式丢掉
css = css.replace(/url\((fonts\/[^)]+\.woff2)\) format\("woff2"\)(?:,url\([^)]*\) format\("[^"]*"\))*/g, (_m, f) => {
  const data = fs.readFileSync(path.join(vendor, f)).toString('base64');
  return `url(data:font/woff2;base64,${data}) format("woff2")`;
});
if (css.includes('fonts/')) throw new Error('KaTeX 字体没有全部内联');

const styles = `<style id="katex-css">${css}</style>`;
const libs = ['marked.min.js', 'purify.min.js', 'highlight.min.js', 'katex.min.js', 'mermaid.min.js']
  .map(f => `<script>${rd(f).split('</script').join('<\\/script')}</script>\n`).join('');

let html = fs.readFileSync(path.join(repo, 'src', 'reader.template.html'), 'utf8');
html = html.split('/*@@KATEX_CSS@@*/').join(styles).split('<!--@@LIBS@@-->').join(libs);

const out = path.join(__dirname, '..', 'app', 'reader.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`app/reader.html  ${Math.round(html.length / 1024)} KB`);
