// 首次打开时左侧的示范文档：既是使用说明，也是拿来试眼动和手柄的练习材料

export const WELCOME_MD = `# LookAsk · 看哪问哪

眼睛负责「大概在看哪」，Joy-Con 负责「就是这个词」，右边的 AI 自动知道你在看什么。

## 三步上手

1. 右上角点 **校准**（或长按左手柄的 **−**），盯着圆点看完 17 个点，大约 30 秒。
2. 眼睛扫到哪一段，哪一段就会被淡淡圈出来，这是「软焦点」。
3. 推一下**右摇杆**，焦点会缩成一个词，继续推就逐词、逐行移动；按 **A** 解释、**X** 翻译、**Y** 总结，按住 **ZR** 直接说出你的问题。

## Joy-Con 按键：左手管左边，右手管右边

| 左手 Joy-Con（操作左侧内容） | 作用 |
| --- | --- |
| 左摇杆 上下 | 滚动；左右 = 翻页 |
| 左摇杆 按下 | 开关「读到底部自动翻页」 |
| 十字键 ↑ ↓ | 文档里跳上 / 下一段；终端里是方向键（在 Qwen Code 里选选项） |
| 十字键 → / ← | 文档里翻页；终端里 → = 回车确认，← = Esc 打断 |
| L | 切换左侧标签页 |
| ZL 按住 | 说话 → 文字直接打进终端（对 Qwen Code 说话），文档里等同 ZR |
| − | 漂移校正（看着焦点按一下）；长按 = 重新校准 |
| 截图键 | 把焦点区域截图发给视觉模型（公式、图表、视频画面） |

| 右手 Joy-Con（跟 AI 对话） | 作用 |
| --- | --- |
| 右摇杆 | 微调焦点：左右逐词，上下逐行 |
| 右摇杆 按下 | 焦点跳回眼睛正在看的地方 |
| A | 解释焦点 |
| X | 翻译焦点 |
| Y | 总结焦点所在的段 / 节 |
| B | 放开焦点；AI 在回答时 = 停止 |
| ZR 按住 | 按住说话，松开发问（自动带上焦点上下文） |
| R | 切换粒度：词 → 句 → 段 → 节 |
| + | 开关 Jev 模式 |
| HOME | 显示 / 隐藏 LookAsk；长按退出全局模式 |

没连手柄也能用键盘：**⌥ + 方向键** 移动焦点，**⌥⇧ + 方向键** 滚动，**⌥↩** 解释，**⌥T** 翻译，**⌥S** 总结，**⌥G** 切粒度，按住 **⌥空格** 说话，**⌥C** 截图问，**⌥J** Jev 模式，**⌥D** 漂移校正。

## Jev 模式：先判断，再开口

打开后，Jev 会在后台判断你正在读的段落「难不难、有没有术语」；如果你在一段上停留很久、反复回看，它会判断你是不是卡住了，再决定要不要主动插话。你提问时，它先判断你想要解释、翻译、推导还是挑刺，要不要看图，再交给大模型回答。每次判断都记在右侧的 Jev 面板里，带概率。

## 练习材料：注意力机制

Transformer 完全基于注意力机制，去掉了循环和卷积。给定查询矩阵 $Q$、键矩阵 $K$ 和值矩阵 $V$，缩放点积注意力（scaled dot-product attention）定义为：

$$\\mathrm{Attention}(Q, K, V) = \\mathrm{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right)V$$

除以 $\\sqrt{d_k}$ 是因为当 $d_k$ 很大时，点积的数值会变得很大，把 softmax 推到梯度极小的饱和区。多头注意力（multi-head attention）把 $Q$、$K$、$V$ 分别线性投影 $h$ 次，并行计算注意力后再拼接，让模型能在不同的表示子空间里同时关注不同位置的信息。

Self-attention layers connect all positions with a constant number of sequentially executed operations, whereas a recurrent layer requires $O(n)$ sequential operations. In terms of computational complexity, self-attention layers are faster than recurrent layers when the sequence length $n$ is smaller than the representation dimensionality $d$, which is most often the case with sentence representations used by state-of-the-art models in machine translation.

> 试试看：盯着上面的公式，推一下右摇杆，再按 A。

## 左侧还能放什么

- 把 **.md / .pdf** 直接拖到左侧，或点标签栏的 **＋**
- **终端**标签里可以直接跑 \`agent\`，手柄十字键就能帮你选选项、批准操作
- **全局模式**：LookAsk 缩成右侧边栏，视线和手柄可以用在任何 App 上（浏览器、预览、微信……）
`
