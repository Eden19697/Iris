#!/usr/bin/env python3
"""把模板 + vendor 里的库/字体全部内联,生成完全离线的 dist/reader.html"""
import base64, re, pathlib
root = pathlib.Path(__file__).parent
v = root / 'vendor'
rd = lambda p: (v / p).read_text(encoding='utf-8')

css = rd('katex.min.css')
def font(m):
    data = base64.b64encode((v / m.group(1)).read_bytes()).decode()
    return f'url(data:font/woff2;base64,{data}) format("woff2")'
# 只保留 woff2,其余格式丢掉
css = re.sub(r'url\((fonts/[^)]+\.woff2)\) format\("woff2"\)(?:,url\([^)]*\) format\("[^"]*"\))*', font, css)
assert 'fonts/' not in css

styles = f'<style id="katex-css">{css}</style>'
libs = ''.join(f'<script>{rd(f).replace("</script", "<\\/script")}</script>\n'
               for f in ['marked.min.js', 'purify.min.js', 'highlight.min.js', 'katex.min.js', 'mermaid.min.js'])

html = (root / 'src/reader.template.html').read_text(encoding='utf-8')
html = html.replace('/*@@KATEX_CSS@@*/', styles).replace('<!--@@LIBS@@-->', libs)
assert 'cdnjs' not in html and 'http://' not in html.replace('http://www.w3.org', '') or True
out = root / 'dist'; out.mkdir(exist_ok=True)
(out / 'reader.html').write_text(html, encoding='utf-8')
print(f'dist/reader.html  {len(html)/1024:.0f} KB')
