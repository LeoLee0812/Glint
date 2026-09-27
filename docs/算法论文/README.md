# LookAsk 算法论文

| 文件 | 说明 |
| --- | --- |
| `LookAsk_paper.pdf` | 期刊格式论文（英文，A4 双栏，编号公式 / 图表 / 参考文献），源文件 `paper.md` |
| `LookAsk_论文_中文版.pdf` | 期刊格式论文中文版（中英文摘要、中图分类号、GB/T 7714 参考文献），源文件 `paper_zh.md` |
| `中文学习笔记.pdf` | 同一套算法的中文讲解版，逐个算法讲「问题 → 原理 → 代码位置 → 为什么这么选」，源文件 `中文学习笔记.md` |
| `experiments/` | 论文第 5 节的合成实验，直接调用项目里的 `ridge.ts` / `filters.ts`，固定随机种子可复现 |

## 重新生成

```bash
node docs/算法论文/experiments/build.mjs      # 重跑实验，更新 experiments/results.json
python3 docs/算法论文/build_paper.py          # 生成 LookAsk_paper.pdf（英文）
python3 docs/算法论文/build_paper.py --lang zh  # 生成 LookAsk_论文_中文版.pdf
python3 docs/算法论文/build_pdf.py            # 生成 中文学习笔记.pdf
```

依赖：本机 Chrome（无头打印 PDF）、Python `markdown` 包、联网加载 KaTeX。
