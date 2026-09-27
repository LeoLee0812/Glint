# 把 paper.md（英文）或 paper_zh.md（中文，--lang zh）按期刊论文版式渲染成 HTML，再用 Chrome 无头模式打印成 PDF
# 版式：A4、双栏、编号公式/图表/参考文献；图 2、图 3 的数据来自 experiments/results.json（先跑 node experiments/build.mjs）
import html
import sys
import json
import pathlib
import re
import subprocess

import markdown

here = pathlib.Path(__file__).parent
res = json.loads((here / 'experiments' / 'results.json').read_text())
LANG = 'zh' if '--lang' in sys.argv and sys.argv[sys.argv.index('--lang') + 1] == 'zh' else 'en'

# 两种语言的图内文字、图题和文件名
T = {
    'en': {
        'src': 'paper.md', 'css': 'journal.css', 'out': 'LookAsk_paper', 'html_lang': 'en', 'font': 'Times New Roman, serif',
        'boxes': [('Webcam', '1280×720, 30 Hz'), ('Face landmarks', '478 pts [11]'), ('Features', 'd ≈ 1650'),
                  ('Dual ridge', 'Eqs. 1–4'), ('Drift correction', 'Eqs. 5–6'), ('One Euro', 'Eqs. 7–8'), ('I-DT', 'fixations'),
                  ('Focus + magnet', 'Sec. 4.6'), ('Context', 'focused passage'), ('Cascade', 'Sec. 4.7'), ('LLM', 'answer')],
        'legend1': 'Blue: contributions of this work · Grey: existing components or plumbing',
        'cap1': '<b>Fig. 1.</b> Processing pipeline of LookAsk. Top row: gaze estimation in screen coordinates; '
                'bottom row (right to left): gaze-to-text resolution and the decision stage that forwards the focused passage to the LLM.',
        'f2names': ['Raw observation', 'Ground truth', 'Fixed 0.55 Hz', 'Fixed 5 Hz', 'One Euro'],
        'f2x': 'Time (s)', 'f2y': 'Horizontal gaze (px)',
        'cap2': '<b>Fig. 2.</b> First 5 s of the synthetic trace used in Table 3. The One Euro filter follows saccades almost immediately while suppressing fixation noise.',
        'f3names': None, 'f3x': 'Number of implicit calibration events n', 'f3y': 'Mean error (px)',
        'cap3': '<b>Fig. 3.</b> Drift-correction error versus the number of implicit calibration events (Table 4), averaged over 200 repetitions.',
    },
    'zh': {
        'src': 'paper_zh.md', 'css': 'journal_zh.css', 'out': 'LookAsk_论文_中文版', 'html_lang': 'zh-CN', 'font': 'Times New Roman, Songti SC, serif',
        'boxes': [('摄像头', '1280×720，30 Hz'), ('人脸关键点', '478 点 [11]'), ('特征提取', 'd ≈ 1650'),
                  ('对偶岭回归', '式 1–4'), ('漂移校正', '式 5–6'), ('One Euro', '式 7–8'), ('I-DT', '注视事件'),
                  ('焦点 + 吸附', '4.6 节'), ('上下文', '焦点段落'), ('级联判断', '4.7 节'), ('大模型', '回答')],
        'legend1': '蓝色：本文贡献　灰色：现有组件或衔接环节',
        'cap1': '<b>图 1</b>　LookAsk 处理流程。上行：在屏幕坐标下估计视线；下行（自右向左）：视线到文字的映射，以及把焦点段落交给大模型的决策环节',
        'f2names': ['原始观测', '真实值', '固定 0.55 Hz', '固定 5 Hz', 'One Euro'],
        'f2x': '时间 / s', 'f2y': '水平视线位置 / px',
        'cap2': '<b>图 2</b>　表 3 所用合成轨迹的前 5 s。One Euro 滤波几乎立即跟上扫视，同时压制注视期间的噪声',
        'f3names': ['完整方法', '去掉 320 px 门限', '全局平均（无空间核）', '去掉收缩'],
        'f3x': '隐式校准事件数 n', 'f3y': '平均误差 / px',
        'cap3': '<b>图 3</b>　漂移校正误差随隐式校准事件数的变化（对应表 4，200 次重复取平均）',
    },
}[LANG]


def fig1() -> str:
    """图 1：系统流水线（上行 7 个环节，下行 4 个环节自右向左接回）"""
    own = [0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0]
    w, h, gap = 118, 46, 14
    out = [f'<svg viewBox="0 0 1000 170" xmlns="http://www.w3.org/2000/svg" font-family="{T["font"]}">',
           '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#444"/></marker></defs>']
    pos = [(10 + i * (w + gap), 20) for i in range(7)] + [(10 + (6 - j) * (w + gap), 110) for j in range(4)]
    for (name, sub), mine, (x, y) in zip(T['boxes'], own, pos):
        fill = '#EAF3FF' if mine else '#F4F4F4'
        stroke = '#1F5FBF' if mine else '#888'
        out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{fill}" stroke="{stroke}" stroke-width="1.2"/>')
        out.append(f'<text x="{x + w / 2}" y="{y + 20}" font-size="14" text-anchor="middle" font-weight="bold">{html.escape(name)}</text>')
        out.append(f'<text x="{x + w / 2}" y="{y + 37}" font-size="12" text-anchor="middle" fill="#444">{html.escape(sub)}</text>')
    for i in range(6):
        x = pos[i][0] + w
        out.append(f'<line x1="{x + 1}" y1="43" x2="{x + gap - 1}" y2="43" stroke="#444" stroke-width="1.2" marker-end="url(#ah)"/>')
    x = pos[6][0] + w / 2
    out.append(f'<line x1="{x}" y1="67" x2="{x}" y2="108" stroke="#444" stroke-width="1.2" marker-end="url(#ah)"/>')
    for j in range(3):
        x = pos[7 + j][0]
        out.append(f'<line x1="{x - 1}" y1="133" x2="{x - gap + 1}" y2="133" stroke="#444" stroke-width="1.2" marker-end="url(#ah)"/>')
    out.append(f'<text x="10" y="92" font-size="12" fill="#1F5FBF">{T["legend1"]}</text>')
    out.append('</svg>')
    return f'<figure class="wide">{"".join(out)}<figcaption>{T["cap1"]}</figcaption></figure>'


def plot(series, xs, xlabel, ylabel, w=460, h=250, ymax=None, xticks=None):
    """一个极简的折线图（纯 SVG，期刊风格：黑白 + 线型区分）"""
    ml, mr, mt, mb = 52, 12, 12, 40
    pw, ph = w - ml - mr, h - mt - mb
    allv = [v for s in series for v in s['y']]
    ymin, ymax = 0, ymax or max(allv) * 1.08
    xmin, xmax = min(xs), max(xs)
    sx = lambda v: ml + (v - xmin) / (xmax - xmin) * pw
    sy = lambda v: mt + ph - (v - ymin) / (ymax - ymin) * ph
    o = [f'<svg viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg" font-family="{T["font"]}" font-size="12">']
    o.append(f'<rect x="{ml}" y="{mt}" width="{pw}" height="{ph}" fill="none" stroke="#000" stroke-width="0.8"/>')
    for k in range(6):
        v = ymin + (ymax - ymin) * k / 5
        o.append(f'<line x1="{ml - 4}" y1="{sy(v):.1f}" x2="{ml}" y2="{sy(v):.1f}" stroke="#000" stroke-width="0.8"/>')
        o.append(f'<text x="{ml - 6}" y="{sy(v) + 4:.1f}" text-anchor="end">{v:.0f}</text>')
    for v in (xticks or xs):
        o.append(f'<line x1="{sx(v):.1f}" y1="{mt + ph}" x2="{sx(v):.1f}" y2="{mt + ph + 4}" stroke="#000" stroke-width="0.8"/>')
        o.append(f'<text x="{sx(v):.1f}" y="{mt + ph + 16}" text-anchor="middle">{v:g}</text>')
    o.append(f'<text x="{ml + pw / 2}" y="{h - 4}" text-anchor="middle">{xlabel}</text>')
    o.append(f'<text transform="translate(12 {mt + ph / 2}) rotate(-90)" text-anchor="middle">{ylabel}</text>')
    for s in series:
        pts = ' '.join(f'{sx(x):.1f},{sy(y):.1f}' for x, y in zip(xs, s['y']))
        o.append(f'<polyline points="{pts}" fill="none" stroke="{s["color"]}" stroke-width="{s.get("width", 1.4)}" stroke-dasharray="{s.get("dash", "none")}"/>')
        if s.get('marker'):
            for x, y in zip(xs, s['y']):
                o.append(f'<circle cx="{sx(x):.1f}" cy="{sy(y):.1f}" r="2.6" fill="{s["color"]}"/>')
    # 图例放在坐标轴下方，两列排布，不压数据
    for i, s in enumerate(series):
        lx = ml + (i % 2) * (pw / 2)
        y = h + 8 + (i // 2) * 15
        o.append(f'<line x1="{lx}" y1="{y}" x2="{lx + 22}" y2="{y}" stroke="{s["color"]}" stroke-width="{s.get("width", 1.4)}" stroke-dasharray="{s.get("dash", "none")}"/>')
        o.append(f'<text x="{lx + 28}" y="{y + 4}">{html.escape(s["name"])}</text>')
    o.append('</svg>')
    rows = (len(series) + 1) // 2
    o[0] = o[0].replace(f'viewBox="0 0 {w} {h}"', f'viewBox="0 0 {w} {h + 6 + rows * 15}"')
    return ''.join(o)


def fig2() -> str:
    tr = res['E3']['trace']
    n = len(tr['truth'])
    xs = [i * 1000 / 30 / 1000 for i in range(n)]
    styles = [('#999999', '2,2', 1.0), ('#555555', '6,3', 1.2), ('#1F5FBF', 'none', 1.6)]
    n0, n1, *names = T['f2names']
    series = [{'name': n0, 'y': tr['obs'], 'color': '#C8C8C8', 'width': 0.8}]
    series.append({'name': n1, 'y': tr['truth'], 'color': '#000000', 'width': 1.0, 'dash': '3,2'})
    for s, (c, d, wd), nm in zip(tr['series'], styles, names):
        series.append({'name': nm, 'y': s['y'], 'color': c, 'dash': d, 'width': wd})
    svg = plot(series, xs, T['f2x'], T['f2y'], ymax=1500, xticks=[0, 1, 2, 3, 4, 5])
    return f'<figure>{svg}<figcaption>{T["cap2"]}</figcaption></figure>'


def fig3() -> str:
    e4 = res['E4']
    xs = e4['counts']
    styles = [('#1F5FBF', 'none', 1.8, True), ('#000000', '6,3', 1.2, True), ('#777777', '2,2', 1.2, True), ('#1F5FBF', '4,2', 1.0, True)]
    names = T['f3names'] or [r['name'] for r in e4['table']]
    series = [{'name': nm, 'y': r['errorPx'], 'color': c, 'dash': d, 'width': w, 'marker': m} for nm, r, (c, d, w, m) in zip(names, e4['table'], styles)]
    svg = plot(series, xs, T['f3x'], T['f3y'], ymax=80, xticks=[0, 2, 4, 8, 16])
    return f'<figure>{svg}<figcaption>{T["cap3"]}</figcaption></figure>'


src = (here / T['src']).read_text()
front, body = src.split('</div>\n</div>\n', 1)
front += '</div>\n</div>\n'

maths: list[str] = []


def keep(m: re.Match) -> str:
    maths.append(m.group(0))
    return f'@@MATH{len(maths) - 1}@@'


body = re.sub(r'\$\$.+?\$\$', keep, body, flags=re.S)
body = re.sub(r'\$[^$\n]+?\$', keep, body)
front = re.sub(r'\$[^$\n]+?\$', keep, front)
body_html = markdown.markdown(body, extensions=['tables'])
body_html = body_html.replace('<p><!--FIG1--></p>', fig1()).replace('<!--FIG1-->', fig1())
body_html = body_html.replace('<p><!--FIG2--></p>', fig2()).replace('<!--FIG2-->', fig2())
body_html = body_html.replace('<p><!--FIG3--></p>', fig3()).replace('<!--FIG3-->', fig3())
restore = lambda t: re.sub(r'@@MATH(\d+)@@', lambda m: html.escape(maths[int(m.group(1))]), t)
body_html = restore(body_html)
front = restore(front)

css = (here / T['css']).read_text()
page = f'''<!doctype html><html lang="{T['html_lang']}"><head><meta charset="utf-8"><title>LookAsk</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
<style>{css}</style></head><body>
<header>{front}</header>
<main class="cols">{body_html}</main>
<script>renderMathInElement(document.body,{{delimiters:[{{left:"$$",right:"$$",display:true}},{{left:"$",right:"$",display:false}}],trust:true,strict:false}});</script>
</body></html>'''
out_html = here / f"{T['out']}.html"
out_html.write_text(page)
chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
subprocess.run([chrome, '--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=20000',
                f'--print-to-pdf={here / (T["out"] + ".pdf")}', out_html.as_uri()], check=True,
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print('ok')
