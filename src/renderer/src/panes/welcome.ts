// 首次打开时左侧的示范文档：一小段说明 + 拿来试眼动和手柄的练习材料（新手引导「试一试」那一步就在这儿练）

export const WELCOME_MD = `# Glint 瞳问

看着左边的内容按手柄，右边的 AI 就知道你问的是哪一段、哪个词。

按键忘了，点右上角的 **？**。

## 试一试

Transformer 完全基于注意力机制，去掉了循环和卷积。给定查询矩阵 $Q$、键矩阵 $K$ 和值矩阵 $V$，缩放点积注意力（scaled dot-product attention）定义为：

$$\\mathrm{Attention}(Q, K, V) = \\mathrm{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right)V$$

除以 $\\sqrt{d_k}$ 是因为当 $d_k$ 很大时，点积的数值会变得很大，把 softmax 推到梯度极小的饱和区。多头注意力（multi-head attention）把 $Q$、$K$、$V$ 分别线性投影 $h$ 次，并行计算注意力后再拼接，让模型能在不同的表示子空间里同时关注不同位置的信息。

Self-attention layers connect all positions with a constant number of sequentially executed operations, whereas a recurrent layer requires $O(n)$ sequential operations. In terms of computational complexity, self-attention layers are faster than recurrent layers when the sequence length $n$ is smaller than the representation dimensionality $d$, which is most often the case with sentence representations used by state-of-the-art models in machine translation.

## 左边还能放什么

- PDF、Markdown：直接拖进来，或者点标签栏的 **＋**。扫描版 PDF 也能看着问
- 终端：点「启动 Qwen Code」，十字键帮它选选项、批准操作
`
