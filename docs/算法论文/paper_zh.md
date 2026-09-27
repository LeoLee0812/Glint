<div class="front">
<p class="journal">LookAsk 项目技术报告 · 2026 年 9 月</p>
<h1 class="title">看哪问哪：基于对偶岭回归、核漂移校正与视线—手动协同的摄像头眼动词级阅读辅助</h1>
<p class="authors">Leo<sup>1</sup></p>
<p class="affil"><sup>1</sup>独立开发者　源代码：LookAsk 仓库 <code>src/renderer/src</code></p>

<div class="abstract">
<p><b>摘　要：</b>在阅读时向大语言模型（LLM）提问，至今仍需要选中、复制、粘贴原文。LookAsk 仅使用笔记本内置摄像头和一只 Joy-Con 手柄，在每次提问时自动附上“用户正在看的那段文字”。然而普通摄像头眼动的精度只能到段落级。本文提出一条把这一粗糙信号放大为词级指向的算法链：用约 1650 维的眼部外观与人脸关键点特征，以对偶形式求解岭回归得到屏幕坐标，并用“按校准点整组留出”的交叉验证选择正则强度；校准后的漂移由隐式校准事件驱动的时空 Nadaraya–Watson 估计器在线校正，辅以异常值门限与收缩因子；信号经 One Euro 滤波平滑、由带迟滞的离散度阈值检测器切分为注视事件，再通过软/硬两级焦点模型与关键词吸附启发式落到具体文字；最后由级联判断模块决定助手何时开口。在直接调用生产代码的合成实验中：对偶解法求解 408×1650 问题比原始形式仅做 Gram 与 Cholesky 分解一步还快 4.2 倍；按帧交叉验证把样本外误差低估 7.1 倍，而分组交叉验证只低估 2.3 倍；One Euro 滤波把稳态误差从 40 px 降到 20.5 px，阶跃延迟 33 ms；漂移校正在 16 次隐式校准后把平均误差从 46.7 px 降到 18.7 px，而去掉异常值门限后误差反升至 48.6 px。</p>
<p class="kw"><b>关键词：</b>摄像头眼动追踪；岭回归；核方法；隐式校准；自适应滤波；注视检测；视线交互；大语言模型阅读助手</p>
<p class="cls"><b>中图分类号：</b>TP391.4　　<b>文献标志码：</b>A</p>
</div>

<div class="eabstract">
<p class="etitle">Look-and-Ask: Word-Level Reading Assistance from Commodity Webcam Gaze via Dual Ridge Regression, Kernel Drift Correction and Gaze–Manual Refinement</p>
<p class="eauthor">Leo<br><span>(Independent developer)</span></p>
<p><b>Abstract:</b> LookAsk attaches the passage under the user’s gaze to every question sent to a large language model, using only a laptop webcam and a Joy-Con controller. Because webcam gaze is accurate only to paragraph level, we present an algorithmic chain that turns it into a word-level pointer: dual-form ridge regression with leave-one-calibration-point-out cross-validation, spatio-temporal kernel drift correction driven by implicit calibration events with outlier gating and shrinkage, One Euro filtering, dispersion-threshold fixation detection with hysteresis, two-level gaze–manual focus with keyword attraction, and a cascaded judgement stage. Synthetic experiments that execute the production code show a 4.2× speed-up of the dual solver, a 2.3× (versus 7.1×) underestimation of out-of-sample error by grouped (versus frame-level) cross-validation, a reduction of steady-state noise from 40 px to 20.5 px with 33 ms latency, and a reduction of drift error from 46.7 px to 18.7 px after 16 implicit events.</p>
<p><b>Key words:</b> webcam eye tracking; ridge regression; kernel methods; implicit calibration; adaptive filtering; fixation detection; gaze interaction; LLM reading assistant</p>
</div>
</div>

## 1　引言

借助大语言模型阅读技术资料已十分普遍，但交互仍然笨拙：读者必须离开正文，选中相关段落，复制到对话窗口，再描述哪里没看懂。眼动追踪可以直接回答“用户在问哪一段”这个问题。专用眼动仪精度高，但需要额外硬件；基于摄像头的方法<sup>[1-3]</sup>可在任意笔记本上运行，误差却通常在几十到一百多个屏幕点之间，足以分辨段落，不足以分辨词语。

LookAsk 是一款 macOS 桌面程序：左侧显示阅读内容（PDF、Markdown、终端，或在全局浮层模式下的任意应用），右侧是对话智能体。用户提问时，视线所在的段落被自动附为上下文。本文不试图把摄像头精度推向物理极限，而是把系统设计成一条链，让每一级弥补上一级留下的误差（图 1）。

本文的贡献如下：

1. 对偶形式的岭回归视线映射，配合分组（按校准点整组留出）交叉验证自动选择正则项，并给出诚实的误差估计（4.2–4.3 节）；
2. 在线漂移校正方案：把日常的确认按键转化为隐式校准样本，结合时空核、异常值门限与收缩因子（4.4 节）；
3. 视线到文字的映射层：把段落级视线与手动逐词精修、带迟滞的关键词吸附启发式结合起来（4.6 节）；
4. 级联决策模块：在生成之前放置零成本本地规则与概率判断模型，使大模型调用保持稀少（4.7 节）；
5. 直接运行生产实现的可复现合成实验（第 5 节）。

## 2　相关工作

**摄像头视线估计**　WebGazer<sup>[1]</sup>用带正则的线性回归把眼部图像特征映射到屏幕坐标，并持续利用鼠标点击补充训练样本。iTracker<sup>[2]</sup>、MPIIGaze<sup>[3]</sup>等基于外观的深度模型在大规模数据上学习与人无关的映射，能跨用户泛化，但仍受益于个人校准。也有工作利用视觉显著性隐式获取校准目标<sup>[13]</sup>。LookAsk 沿用轻量回归路线，并借助 MediaPipe 人脸关键点<sup>[11]</sup>获得稳定的眼部区域与头部姿态。

**正则回归与模型选择**　岭回归<sup>[7]</sup>及其对偶（核）形式<sup>[8]</sup>是经典方法；当特征数多于样本数时，对偶形式计算上更有利。对具有分组结构的数据做交叉验证时，必须整组留出，否则估计会偏乐观<sup>[12,15]</sup>。

**指点与视线信号处理**　One Euro 滤波器<sup>[4]</sup>根据信号速度自适应调整截止频率，被广泛用于含噪指点输入。离散度阈值识别（I-DT）<sup>[5]</sup>是区分注视与扫视的经典方法。

**视线—手动协同交互**　只用视线做选择会遇到“点石成金（Midas touch）”问题<sup>[14]</sup>。MAGIC pointing<sup>[6]</sup>让视线负责粗定位、手动输入负责精确选择；LookAsk 采用同一原则，只是把鼠标换成了游戏手柄。

## 3　系统概述

<!--FIG1-->

渲染进程（React）运行眼动引擎、焦点控制器和对话界面，岭回归拟合放在 Web Worker 中执行。Electron 主进程负责大模型访问与设置，原生 Swift 助手直接读取 Joy-Con 的 HID 原始报告，并提供语音识别、OCR 与辅助功能取词。所有视线输出均为屏幕坐标。

## 4　方法

### 4.1　人脸关键点与特征

每帧摄像头画面（1280×720，约 30 Hz）先经 MediaPipe Face Landmarker<sup>[11]</sup>处理，得到 478 个三维关键点（其中 468、473 为虹膜中心）、52 个表情系数和头部姿态变换。开源的 RealEye 特征提取库（AGPL-3.0）把双眼区域裁成 40×20 的灰度块，并与关键点几何、表情系数、头部姿态拼接，得到特征向量 $\mathbf{x}\in\mathbb{R}^{d}$，$d\approx1650$。运行时眨眼系数大于 0.45 的帧直接跳过（校准采集时要求小于 0.4）。这一级使用现成组件，不属于本文贡献。

### 4.2　对偶岭回归

校准时用户依次注视 9 或 17 个目标点，每点 850 ms，得到约 $N\approx400$ 帧样本 $\{(\mathbf{x}_i,\mathbf{t}_i)\}$。记中心化后的特征矩阵为 $X\in\mathbb{R}^{N\times d}$、中心化目标为 $\mathbf{y}$，每个屏幕坐标轴分别求解

$$\min_{\boldsymbol\beta}\ \|\mathbf{y}-X\boldsymbol\beta\|^2+\lambda\|\boldsymbol\beta\|^2 . \tag{1}$$

原始解 $\boldsymbol\beta=(X^\top X+\lambda I_d)^{-1}X^\top\mathbf{y}$ 需要求解 $d\times d$ 的方程组。利用恒等式 $(X^\top X+\lambda I_d)^{-1}X^\top = X^\top(XX^\top+\lambda I_N)^{-1}$，得到等价的对偶解

$$\boldsymbol\alpha=(K+\lambda I_N)^{-1}\mathbf{y},\qquad \boldsymbol\beta=X^\top\boldsymbol\alpha , \tag{2}$$

其中 $K=XX^\top$ 为 $N\times N$ 的 Gram 矩阵。由于 $K+\lambda I_N$ 对称正定，可做 Cholesky 分解 $LL^\top$<sup>[16]</sup>，再经前代、回代求解；若数值上分解失败，则把 $\lambda$ 乘以 10 后重试。对新一帧的预测为

$$\hat{t}_x=\bar{t}_x+(\mathbf{x}-\bar{\mathbf{x}})^\top\boldsymbol\beta_x , \tag{3}$$

即每个轴一次 $d$ 维点积。当 $d\gg N$ 时，对偶形式的代价为 $O(N^2d+N^3/3)$，原始形式为 $O(Nd^2+d^3/3)$（表 1）。

### 4.3　分组交叉验证

正则强度从 $\lambda\in\{3\times10^{-4},3\times10^{-3},3\times10^{-2},3\times10^{-1}\}\cdot\overline{\operatorname{diag}(K)}$ 中选取，乘以 Gram 矩阵对角线均值是为了让候选网格与特征尺度无关。同一目标点录下的各帧几乎一模一样，若只留出单帧，训练集中仍有它的“近似副本”。因此本文每次把一个校准点的全部帧整组留出（leave-one-group-out）<sup>[15]</sup>。每一折对 $K$ 的训练子矩阵重新分解，误差按帧而非按点平均，以贴合运行时的行为：

$$\mathrm{CV}(\lambda)=\frac{1}{N}\sum_{g}\sum_{i\in g}\big\|\hat{\mathbf{t}}^{(-g)}_i(\lambda)-\mathbf{t}_i\big\|_2 . \tag{4}$$

误差最小的 $\lambda^\ast$ 用全部数据重新拟合，其误差 $\mathrm{CV}(\lambda^\ast)$ 展示给用户，也可按 $\theta=\arctan(\mathrm{px}\times0.023\,\mathrm{cm}/55\,\mathrm{cm})$ 换算为视角。校准点少于 5 个时不做交叉验证。

### 4.4　隐式校准与核漂移校正

**隐式样本**　用户按 A、X 或 Y 键确认硬焦点时，假定其正注视该焦点。焦点中心 $\mathbf{t}_i$ 与此前 450 ms 原始预测均值 $\mathbf{p}_i$ 之间的残差 $\mathbf{r}_i=\mathbf{t}_i-\mathbf{p}_i$ 以权重 $w^0_i=0.6$ 记录，前提是 $\|\mathbf{r}_i\|<320$ px；更大的残差说明用户当时并未注视焦点，直接丢弃。用户主动发起的漂移校正以权重 2 记录。最多保留最近 16 条残差。

**估计器**　对新的预测点 $\mathbf{p}$，每条残差获得时空权重

$$w_i(\mathbf{p})=w^0_i\exp\!\Big(-\frac{\|\mathbf{p}_i-\mathbf{p}\|^2}{2\sigma^2}\Big)\exp\!\Big(-\frac{t-\tau_i}{T}\Big), \tag{5}$$

其中 $\sigma=520$ pt，$T=20$ min。校正量为带收缩的 Nadaraya–Watson 估计<sup>[9,10]</sup>：

$$\begin{gathered}\Delta(\mathbf{p})=k\,\frac{\sum_i w_i(\mathbf{p})\,\mathbf{r}_i}{\sum_i w_i(\mathbf{p})},\\ k=\frac{\sum_i w_i(\mathbf{p})}{\sum_i w_i(\mathbf{p})+0.35}.\end{gathered} \tag{6}$$

空间核允许屏幕不同区域有不同的偏移；因子 $k$ 在证据稀少或距离较远时把校正量向 0 收缩。

### 4.5　平滑与注视检测

校正后的信号在每个坐标轴上经 One Euro 滤波<sup>[4]</sup>。指数平滑系数为

$$\alpha=\frac{1}{1+\tau/\Delta t},\qquad \tau=\frac{1}{2\pi f_c} \tag{7}$$

其截止频率随速度自适应：

$$f_c=f_{c,\min}+\beta\,|\dot{\hat{x}}| , \tag{8}$$

速度估计本身先经 1 Hz 低通。本文取 $f_{c,\min}=0.55$ Hz、$\beta=0.0045$；界面上的平滑度滑块 $v\in[0,1]$ 通过 $f_{c,\min}=\max(0.12,\,1.4-1.2v)$ 调节。

注视用在线 I-DT<sup>[5]</sup>检测：最近 140 ms 内至少 3 个样本都落在其质心 95 px 以内时，注视开始；新样本与滑动质心的距离不超过 $1.3\times95\approx124$ px 时注视持续，否则结束。开始与结束半径不同，形成迟滞，避免视线在边界附近抖动时反复开关。

### 4.6　从视线到文字

**两级焦点**　软焦点跟随注视，以段落为粒度。第一次拨动右摇杆时，软焦点转为硬焦点，由手动逐词或逐行移动，粒度可在词、句、段、节之间切换（用 `Intl.Segmenter` 分词，中文采用词典分词）。视线离开超过 0.8 s 或按下摇杆时，控制权交还视线。屏幕分为阅读侧与回答侧，视线只在当前侧解释，距离边界 70 pt 以内的注视被拉回本侧。

**关键词吸附**　在视线点周围按网格布置探测点，用 `caretRangeFromPoint` 取得对应词语。每个词按词法线索得到关键词得分 $s\in[0,1]$（缩写 0.9；字母数字混合或驼峰词 0.85；连字符词 0.72；4 字及以上中文词 0.8；公式 0.95；位于强调格式内加 0.4；停用词为 0），权重为

$$W=s\cdot\max\!\Big(0,\,1-\min\!\big(1,\tfrac{d}{r}\big)^{1.5}\Big) , \tag{9}$$

其中 $d$ 为视线点到词框的距离，$r$ 为搜索半径。新候选的权重须超过当前吸附词的 `switchRatio` 倍才会替换；视线离开超过 `release` 距离才松开；扫视期间暂停吸附。全部 9 个参数都是单一强度 $k\in[0,1]$（默认 0.7）的线性函数，例如 $r=40+100k$。视线指示器是一个 36 节点的质点—弹簧环，吸附时其静止形状渐变为包住目标词的超椭圆 $|x/w|^5+|y/h|^5=1$，使吸附状态一目了然。

### 4.7　级联决策

为决定助手何时主动提供帮助，LookAsk 采用三级级联：（1）零成本本地规则（忽略过短段落、停留不足 1.5 s 以及 20 s 内的重复提示）；（2）低成本判断模型，只回答选择题或概率题（难度、读者是否卡住、提问意图、是否需要看图、是否需要核实）；（3）大模型，仅在（2）判定需要时调用。数值信号在交给判断模型前先离散化为文字档位（如停留 <3 s 为“很短”，3–8 s 为“正常”，8–20 s 为“偏长”，>20 s 为“很长”）。当停留 ≥9 s 或回看 ≥3 次且难度 ≥1.4 时，段落进入主动解释候选；判断模型给出的概率 ≥0.65 时才弹出建议。由于视线只能分辨段落，焦点段落还会被拆成候选句，由判断模型结合用户原话选出所指的那一句（指代消解）。判断结果按内容哈希缓存，并受每日 token 预算约束。

## 5　实验

### 5.1　实验设置

本文未开展真人被试实验，以下实验**全部为合成实验**，直接调用生产代码中的 `fitRidge`、`predictRidge`（ridge.ts）与 `OneEuro`（filters.ts）；漂移估计器按 engine.ts 中的式 (5)–(6) 原样重新实现。合成特征的生成方式为：把目标位置的二次编码经固定随机投影和 tanh 非线性变换（$d=1650$），叠加每个校准点共享的扰动项（模拟头部姿态与眼球微偏）以及逐帧独立噪声。校准布局采用程序中的 17 点方案。随机种子固定，结果可复现（<code>docs/算法论文/experiments</code>）；计时在一台 Apple 芯片 MacBook 上以 Node.js 22 单线程测得。

### 5.2　对偶解法的计算代价

<p class="tcap"><b>表 1</b>　$N=408$ 帧（17 点 × 24 帧）、$d=1650$ 时的拟合代价（时间为 3 次运行的中位数，不同运行间约有百分之几的波动；原始形式只计入 Gram 矩阵构造与 Cholesky 分解）</p>

| 方法 | 浮点运算次数 | 时间 / ms |
|---|---|---|
| 原始形式，$d\times d$ 方程组 | $1.11\times10^{9}+1.50\times10^{9}$ | 1192 |
| 对偶形式，$N\times N$ 方程组，单个 $\lambda$ | $2.75\times10^{8}+2.26\times10^{7}$ | 283 |
| 对偶形式，4 个 $\lambda$ × 17 折分组交叉验证 | — | 719 |

对偶解法比原始形式仅分解一步还快 4.2 倍；包含交叉验证的完整模型选择（额外 68 次分解）约 0.7 s 完成，足以在校准结束时运行而不被察觉。

### 5.3　交叉验证估计的偏差

生成 3 组校准会话（17 点 × 12 帧），比较所选模型在按帧留一与按点分组留一两种交叉验证下的误差，以及它在 200 个未见过的随机屏幕位置上的真实误差。

<p class="tcap"><b>表 2</b>　交叉验证误差与真实误差（px）</p>

| 会话 | 按帧交叉验证 | 分组交叉验证（本文） | 未见位置上的真实误差 |
|---|---|---|---|
| 1 | 5.1 | 17.3 | 34.4 |
| 2 | 4.7 | 15.3 | 50.9 |
| 3 | 6.0 | 15.6 | 26.6 |
| 平均 | 5.3 | 16.1 | 37.3 |

按帧交叉验证平均把真实误差低估 7.1 倍，分组交叉验证低估 2.3 倍。分组交叉验证明显更诚实，但仍偏乐观，原因在于未见位置包含校准网格凸包以外的区域，且合成映射本身是非线性的。

### 5.4　One Euro 滤波

以 30 Hz 模拟一维视线轨迹：12 次注视，每次 600–1200 ms，位置随机，叠加高斯噪声（$\sigma=40$ px）。统计每次注视开始 300 ms 之后的均方根误差（稳态），以及覆盖每次扫视 90% 幅度所需时间的中位数。

<p class="tcap"><b>表 3</b>　合成轨迹上的滤波器对比（原始噪声 40 px）</p>

| 滤波器 | 稳态均方根误差 / px | 90% 阶跃延迟 / ms |
|---|---|---|
| 固定截止频率 0.55 Hz | 90.0 | 700 |
| 固定截止频率 5 Hz | 23.9 | 67 |
| One Euro，$f_{c,\min}=0.55$ Hz，$\beta=0.0045$ | **20.5** | **33** |

<!--FIG2-->

固定低截止频率虽稳定，但慢到扫视后 300 ms 仍未收敛；固定高截止频率反应快，却放过更多噪声。One Euro 滤波把原始噪声减半，同时在一帧之内完成响应（延迟分辨率受限于 33 ms 的帧间隔）。

### 5.5　漂移校正

对预测施加一个平滑、随位置变化、幅度 25–70 px 的漂移场。隐式校准事件在随机屏幕位置产生，残余噪声 12 px；其中 15% 的事件假定用户其实在看别处（每轴偏移 250–650 px）。在 9×6 网格上评估误差，重复 200 次取平均。

<p class="tcap"><b>表 4</b>　经过 $n$ 次隐式校准后的平均误差（px）</p>

| 方案 | $n=0$ | 1 | 2 | 4 | 8 | 16 |
|---|---|---|---|---|---|---|
| 完整方法（式 5–6，320 px 门限） | 46.7 | **32.1** | **27.1** | 23.1 | 20.4 | 18.7 |
| 去掉异常值门限 | 46.7 | 62.2 | 64.2 | 65.9 | 55.9 | 48.6 |
| 全局平均（无空间核） | 46.7 | 31.2 | 28.9 | 26.7 | 25.6 | 24.8 |
| 去掉收缩（$k=1$） | 46.7 | 34.0 | 27.2 | **21.9** | **19.6** | **18.1** |

<!--FIG3-->

完整方法在 16 次事件后把误差降低 60%。异常值门限不可或缺：去掉它后，“看别处时按键”的样本会让校正结果比不校正还差。样本积累到一定数量后空间核开始起作用（$n=16$ 时 18.7 px 对 24.8 px），因为单一全局偏移无法表达随位置变化的漂移。收缩因子在只有 1 个样本时有利（32.1 px 对 34.0 px），样本较多时略有代价（18.7 px 对 18.1 px），这是为会话初期的稳健性有意做出的取舍。

## 6　讨论与局限

LookAsk 的设计原则是：接受摄像头眼动的精度上限，把精度需求分配给最便宜的提供者——校准交给统计，漂移交给用户行为，噪声交给滤波，最后几十个像素交给语言线索，词级选择交给手。

本文仍有以下局限：（1）全部定量结果来自合成数据，需要开展测量校准误差、漂移随时间变化与选择耗时的用户实验；（2）视线映射对特征是线性的，头部大幅运动时可能需要非线性核（如 RBF）或显式的头部姿态补偿；（3）隐式校准假设用户按键时正看着焦点，固定的 320 px 门限可改为基于中位数绝对偏差等自适应稳健准则；（4）关键词得分为人工规则，可改为学习得到或采用词频统计；（5）部分笔记本的摄像头“人物居中”功能会裁切画面，导致校准失效；（6）特征提取库采用 AGPL 许可，限制了再分发。

## 7　结论

本文介绍了 LookAsk 的算法链，它把段落级的摄像头视线转化为可用于大模型辅助阅读的词级指向。对偶岭回归配合分组交叉验证，实现了快速且评估诚实的个人校准；基于核的隐式再校准抑制了漂移；One Euro 滤波与 I-DT 检测产生稳定的注视；两级焦点与关键词吸附弥合了到具体词语的最后差距。直接运行生产代码的合成实验支持了上述各项设计决策。

## 代码可用性

全部算法实现于 LookAsk 仓库：<code>gaze/ridge.ts</code>（式 1–4）、<code>gaze/engine.ts</code>（式 5–6）、<code>gaze/filters.ts</code>（式 7–8 及 I-DT）、<code>focus/focus.ts</code>、<code>focus/magnet.ts</code> 与 <code>focus/snap.ts</code>（4.6 节）、<code>jev/jevBrain.ts</code>（4.7 节）。实验代码位于 <code>docs/算法论文/experiments</code>。

## 生成式人工智能使用声明

LookAsk 软件在开发过程中大量使用了 AI 编程工具；本文及实验脚本由 AI 模型协助起草，再由作者对照源代码核对。所有数值结果均由仓库中的脚本实际运行得到。

## 参考文献

<ol class="refs">
<li>PAPOUTSAKI A, SANGKLOY P, LASKEY J, et al. WebGazer: scalable webcam eye tracking using user interactions[C]//Proceedings of the 25th International Joint Conference on Artificial Intelligence (IJCAI). 2016: 3839-3845.</li>
<li>KRAFKA K, KHOSLA A, KELLNHOFER P, et al. Eye tracking for everyone[C]//Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition (CVPR). 2016: 2176-2184.</li>
<li>ZHANG X, SUGANO Y, FRITZ M, et al. Appearance-based gaze estimation in the wild[C]//Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition (CVPR). 2015: 4511-4520.</li>
<li>CASIEZ G, ROUSSEL N, VOGEL D. 1€ filter: a simple speed-based low-pass filter for noisy input in interactive systems[C]//Proceedings of the SIGCHI Conference on Human Factors in Computing Systems (CHI). 2012: 2527-2530.</li>
<li>SALVUCCI D D, GOLDBERG J H. Identifying fixations and saccades in eye-tracking protocols[C]//Proceedings of the 2000 Symposium on Eye Tracking Research &amp; Applications (ETRA). 2000: 71-78.</li>
<li>ZHAI S, MORIMOTO C, IHDE S. Manual and gaze input cascaded (MAGIC) pointing[C]//Proceedings of the SIGCHI Conference on Human Factors in Computing Systems (CHI). 1999: 246-253.</li>
<li>HOERL A E, KENNARD R W. Ridge regression: biased estimation for nonorthogonal problems[J]. Technometrics, 1970, 12(1): 55-67.</li>
<li>SAUNDERS C, GAMMERMAN A, VOVK V. Ridge regression learning algorithm in dual variables[C]//Proceedings of the 15th International Conference on Machine Learning (ICML). 1998: 515-521.</li>
<li>NADARAYA E A. On estimating regression[J]. Theory of Probability and Its Applications, 1964, 9(1): 141-142.</li>
<li>WATSON G S. Smooth regression analysis[J]. Sankhyā: The Indian Journal of Statistics, Series A, 1964, 26(4): 359-372.</li>
<li>KARTYNNIK Y, ABLAVATSKI A, GRISHCHENKO I, et al. Real-time facial surface geometry from monocular video on mobile GPUs[C]//CVPR Workshop on Computer Vision for Augmented and Virtual Reality. 2019. arXiv:1907.06724.</li>
<li>HASTIE T, TIBSHIRANI R, FRIEDMAN J. The elements of statistical learning[M]. 2nd ed. New York: Springer, 2009.</li>
<li>SUGANO Y, MATSUSHITA Y, SATO Y. Appearance-based gaze estimation using visual saliency[J]. IEEE Transactions on Pattern Analysis and Machine Intelligence, 2013, 35(2): 329-341.</li>
<li>JACOB R J K. What you look at is what you get: eye movement-based interaction techniques[C]//Proceedings of the SIGCHI Conference on Human Factors in Computing Systems (CHI). 1990: 11-18.</li>
<li>ROBERTS D R, BAHN V, CIUTI S, et al. Cross-validation strategies for data with temporal, spatial, hierarchical, or phylogenetic structure[J]. Ecography, 2017, 40(8): 913-929.</li>
<li>GOLUB G H, VAN LOAN C F. Matrix computations[M]. 4th ed. Baltimore: Johns Hopkins University Press, 2013.</li>
</ol>
