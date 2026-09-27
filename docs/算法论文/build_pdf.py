# 把 LookAsk算法说明.md 渲染成带 KaTeX 公式的 HTML，再用 Chrome 无头模式打印成 PDF
import re, subprocess, pathlib, markdown, html
here = pathlib.Path(__file__).parent
src = (here / 'LookAsk算法说明.md').read_text()
src = re.sub(r'^---\n.*?\n---\n', '', src, flags=re.S)  # 去掉 front matter
maths = []
def keep(m):
    maths.append(m.group(0)); return f'@@MATH{len(maths)-1}@@'
src = re.sub(r'\$\$.+?\$\$', keep, src, flags=re.S)
src = re.sub(r'\$[^$\n]+?\$', keep, src)
body = markdown.markdown(src, extensions=['tables', 'fenced_code'])
body = re.sub(r'@@MATH(\d+)@@', lambda m: html.escape(maths[int(m.group(1))]), body)
css = (here / 'paper.css').read_text()
page = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
<style>{css}</style></head><body><main>{body}</main>
<script>renderMathInElement(document.body,{{delimiters:[{{left:"$$",right:"$$",display:true}},{{left:"$",right:"$",display:false}}]}});</script>
</body></html>'''
out_html = here / 'LookAsk算法说明.html'
out_html.write_text(page)
chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
subprocess.run([chrome, '--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=15000',
                f'--print-to-pdf={here / "LookAsk算法说明.pdf"}', out_html.as_uri()], check=True)
print('ok')
