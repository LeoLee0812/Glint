<div class="front">
<p class="journal">Technical Report · LookAsk Project · September 2026</p>
<h1 class="title">Look-and-Ask: Word-Level Reading Assistance from Commodity Webcam Gaze via Dual Ridge Regression, Kernel Drift Correction and Gaze–Manual Refinement</h1>
<p class="authors">Leo<sup>1</sup></p>
<p class="affil"><sup>1</sup>Independent developer. Source code: <code>LookAsk</code> repository, <code>src/renderer/src</code>.</p>

<div class="abstract">
<p><b>Abstract</b> — Asking a large language model (LLM) about the passage one is reading still requires selecting, copying and pasting text. LookAsk removes this step by attaching “what the user is looking at” to every question, using only the built-in webcam of a laptop and a handheld Joy-Con controller. Commodity webcam gaze, however, is accurate only to the level of a paragraph. We present the algorithmic pipeline that turns this coarse signal into a word-level pointer. Gaze is regressed from ≈1650-dimensional appearance and landmark features with ridge regression solved in its dual form, and the regularisation strength is selected by leave-one-calibration-point-out cross-validation. Post-calibration drift is corrected online by a spatio-temporal Nadaraya–Watson estimator fed by implicit calibration events, with outlier gating and shrinkage. The signal is smoothed with a One Euro filter, segmented into fixations with a dispersion-threshold detector with hysteresis, and resolved to text through a two-level (soft/hard) focus model and a keyword-attraction heuristic. A cascaded judgement stage decides when the assistant should speak. In synthetic experiments that execute the production code, the dual solver fits a 408 × 1650 problem 4.2× faster than the primal Gram–Cholesky step alone; frame-level cross-validation underestimated out-of-sample error by 7.1×, versus 2.3× for grouped cross-validation; the One Euro filter reduced steady-state error from 40 px to 20.5 px with a 33 ms step latency; and drift correction reduced mean error from 46.7 px to 18.7 px after 16 implicit events, whereas omitting the outlier gate increased it to 48.6 px.</p>
<p class="kw"><b>Keywords</b> — webcam eye tracking; ridge regression; kernel methods; implicit calibration; adaptive filtering; fixation detection; gaze-based interaction; LLM reading assistant</p>
</div>
</div>

## 1. Introduction

Reading technical material with an LLM at hand is now common, but the interaction is clumsy: the reader must leave the text, select the relevant passage, copy it into a chat window and describe what is unclear. Eye tracking offers a direct answer to the question *which passage is the user asking about?* Dedicated eye trackers are accurate but add hardware; webcam-based trackers [1–3] run on any laptop but typically reach errors of tens to more than one hundred screen points, which is sufficient to identify a paragraph but not a word.

LookAsk is a macOS desktop application in which the left pane shows reading material (PDF, Markdown, a terminal, or any application in a global overlay mode) and the right pane hosts a conversational agent. When the user asks a question, the passage under gaze is attached as context. Rather than attempting to push webcam accuracy towards its physical limit, the system is designed as a chain in which each stage compensates for the residual error of the previous one (Fig. 1).

The contributions of this report are:

1. A dual-form ridge regression gaze mapper with grouped (leave-one-calibration-point-out) cross-validation that selects the regulariser and reports an honest error estimate (Section 4.2–4.3).
2. An online drift-correction scheme that converts ordinary confirmation presses into implicit calibration samples and combines them with a spatio-temporal kernel, an outlier gate and shrinkage (Section 4.4).
3. A gaze-to-text layer that couples paragraph-level gaze with manual word-level refinement and a keyword-attraction heuristic with hysteresis (Section 4.6).
4. A cascaded decision stage that keeps LLM calls rare by placing cheap local rules and a probabilistic judgement model before generation (Section 4.7).
5. Reproducible synthetic experiments that run the production implementation (Section 5).

## 2. Related Work

**Webcam gaze estimation.** WebGazer [1] maps eye-patch features to screen coordinates with regularised linear regression and continuously adds training samples from mouse clicks. Appearance-based deep models such as iTracker [2] and MPIIGaze [3] learn person-independent mappings from large datasets; they generalise across users but still benefit from per-user calibration. Visual saliency has also been used to obtain calibration targets implicitly [13]. LookAsk follows the lightweight regression line of work and uses MediaPipe face landmarks [11] to obtain stable eye regions and head pose.

**Regularised regression and model selection.** Ridge regression [7] and its dual (kernel) formulation [8] are standard; when features outnumber samples the dual form is computationally preferable. Cross-validation on data with group structure must hold out whole groups to avoid optimistic estimates [12, 15].

**Signal processing for pointing and gaze.** The One Euro filter [4] adapts its cut-off frequency to signal speed and is widely used for noisy pointing input. Dispersion-threshold identification (I-DT) [5] is a classical method for separating fixations from saccades.

**Gaze–manual interaction.** Using gaze alone for selection suffers from the “Midas touch” problem [14]. MAGIC pointing [6] cascades gaze for coarse positioning with manual input for fine selection; LookAsk adopts this principle with a game controller instead of a mouse.

## 3. System Overview

<!--FIG1-->

The renderer process (React) runs the gaze engine, focus controller and chat interface; ridge fitting runs in a Web Worker. The Electron main process owns LLM access and settings, and a native Swift helper reads raw Joy-Con HID reports and provides speech recognition, OCR and accessibility text extraction. All gaze outputs are in screen coordinates.

## 4. Methods

### 4.1 Face landmarks and features

Each camera frame (1280 × 720, ≈30 Hz) is processed by the MediaPipe Face Landmarker [11], which returns 478 three-dimensional landmarks (indices 468 and 473 are the iris centres), 52 blendshape coefficients and a head-pose transform. The open-source RealEye feature extractor (AGPL-3.0) crops both eye regions to 40 × 20 grey-scale patches and concatenates them with landmark geometry, blendshapes and head pose, yielding a feature vector $\mathbf{x}\in\mathbb{R}^{d}$ with $d\approx1650$. Frames with a blink coefficient above 0.45 are skipped at run time (below 0.4 is required during calibration). This stage uses existing components and is not a contribution of this work.

### 4.2 Dual ridge regression

During calibration the user fixates 9 or 17 targets for 850 ms each, yielding $N\approx400$ frames $\{(\mathbf{x}_i,\mathbf{t}_i)\}$. With centred features $X\in\mathbb{R}^{N\times d}$ and centred targets $\mathbf{y}$, one model per screen axis solves

$$\min_{\boldsymbol\beta}\ \|\mathbf{y}-X\boldsymbol\beta\|^2+\lambda\|\boldsymbol\beta\|^2 . \tag{1}$$

The primal solution $\boldsymbol\beta=(X^\top X+\lambda I_d)^{-1}X^\top\mathbf{y}$ requires a $d\times d$ system. Using the identity $(X^\top X+\lambda I_d)^{-1}X^\top = X^\top(XX^\top+\lambda I_N)^{-1}$, the equivalent dual solution is

$$\boldsymbol\alpha=(K+\lambda I_N)^{-1}\mathbf{y},\qquad \boldsymbol\beta=X^\top\boldsymbol\alpha , \tag{2}$$

where $K=XX^\top$ is the $N\times N$ Gram matrix. Since $K+\lambda I_N$ is symmetric positive definite, it is factorised as $LL^\top$ by Cholesky decomposition [16] and solved by forward and back substitution; if factorisation fails numerically, $\lambda$ is multiplied by 10 and the step repeated. Prediction for a new frame is

$$\hat{t}_x=\bar{t}_x+(\mathbf{x}-\bar{\mathbf{x}})^\top\boldsymbol\beta_x , \tag{3}$$

a single $d$-dimensional dot product per axis. For $d\gg N$ the dual construction costs $O(N^2d+N^3/3)$ versus $O(Nd^2+d^3/3)$ for the primal (Table 1).

### 4.3 Grouped cross-validation

The regulariser is chosen from $\lambda\in\{3\times10^{-4},3\times10^{-3},3\times10^{-2},3\times10^{-1}\}\cdot\overline{\operatorname{diag}(K)}$, scaling by the mean Gram diagonal to make the grid invariant to feature scale. Frames recorded at the same target are nearly identical, so leaving out single frames would leave their near-duplicates in the training set. We therefore hold out all frames of one calibration point at a time (leave-one-group-out) [15]. For each fold the training sub-matrix of $K$ is re-factorised, and the error is averaged per frame rather than per point, matching run-time behaviour:

$$\mathrm{CV}(\lambda)=\frac{1}{N}\sum_{g}\sum_{i\in g}\big\|\hat{\mathbf{t}}^{(-g)}_i(\lambda)-\mathbf{t}_i\big\|_2 . \tag{4}$$

The minimiser is refitted on all data and its error $\mathrm{CV}(\lambda^\ast)$ is shown to the user, optionally converted to visual angle as $\theta=\arctan(\mathrm{px}\times0.023\,\mathrm{cm}/55\,\mathrm{cm})$. Cross-validation is skipped when fewer than five points are available.

### 4.4 Implicit calibration and kernel drift correction

**Implicit samples.** When the user confirms a hard focus with the A, X or Y button, we assume they are looking at it. The residual $\mathbf{r}_i=\mathbf{t}_i-\mathbf{p}_i$ between the focus centre $\mathbf{t}_i$ and the mean raw prediction over the preceding 450 ms $\mathbf{p}_i$ is stored with weight $w^0_i=0.6$, provided $\|\mathbf{r}_i\|<320$ px; larger residuals indicate that the user was not looking at the focus and are discarded. An explicit drift-correction command stores a residual with weight 2. At most 16 residuals are retained.

**Estimator.** For a new prediction $\mathbf{p}$, each residual receives a spatio-temporal weight

$$w_i(\mathbf{p})=w^0_i\exp\!\Big(-\frac{\|\mathbf{p}_i-\mathbf{p}\|^2}{2\sigma^2}\Big)\exp\!\Big(-\frac{t-\tau_i}{T}\Big), \tag{5}$$

with $\sigma=520$ pt and $T=20$ min, and the correction is a Nadaraya–Watson estimate [9, 10] with shrinkage:

$$\begin{gathered}\Delta(\mathbf{p})=k\,\frac{\sum_i w_i(\mathbf{p})\,\mathbf{r}_i}{\sum_i w_i(\mathbf{p})},\\ k=\frac{\sum_i w_i(\mathbf{p})}{\sum_i w_i(\mathbf{p})+0.35}.\end{gathered} \tag{6}$$

The kernel allows a spatially varying offset field; the factor $k$ shrinks the correction towards zero when evidence is scarce or distant.

### 4.5 Smoothing and fixation detection

The corrected signal is filtered per axis with a One Euro filter [4]. An exponential smoother with factor

$$\alpha=\frac{1}{1+\tau/\Delta t},\qquad \tau=\frac{1}{2\pi f_c} \tag{7}$$

uses an adaptive cut-off

$$f_c=f_{c,\min}+\beta\,|\dot{\hat{x}}| , \tag{8}$$

where the speed estimate is itself low-pass filtered at 1 Hz. We use $f_{c,\min}=0.55$ Hz and $\beta=0.0045$; a user-facing smoothness slider $v\in[0,1]$ sets $f_{c,\min}=\max(0.12,\,1.4-1.2v)$.

Fixations are detected online with I-DT [5]: a fixation starts when at least three samples within the last 140 ms lie within 95 px of their centroid, continues while new samples stay within $1.3\times95\approx124$ px of the running centroid, and ends otherwise. The different start and end radii provide hysteresis against boundary jitter.

### 4.6 From gaze to text

**Two-level focus.** A *soft* focus follows fixations at paragraph granularity. The first deflection of the right stick converts it into a *hard* focus that moves word by word or line by line under manual control, with granularity cycling through word, sentence, paragraph and section (segmentation by `Intl.Segmenter`, which uses dictionary segmentation for Chinese). Looking elsewhere for more than 0.8 s, or pressing the stick, returns control to gaze. The screen is split into a reading side and an answer side; gaze is only interpreted on the active side, and fixations within 70 pt of the border are pulled back.

**Keyword attraction.** Around the gaze point, probe positions are laid on a grid and mapped to words via `caretRangeFromPoint`. Each word receives a keyword score $s\in[0,1]$ from lexical cues (acronyms 0.9; alphanumeric or camel-case tokens 0.85; hyphenated tokens 0.72; Chinese words of four or more characters 0.8; formulae 0.95; +0.4 inside emphasis; 0 for stop words), and a weight

$$W=s\cdot\max\!\Big(0,\,1-\min\!\big(1,\tfrac{d}{r}\big)^{1.5}\Big) , \tag{9}$$

where $d$ is the distance to the word box and $r$ the search radius. A new candidate replaces the current one only if its weight exceeds it by a factor `switchRatio`, attraction is released beyond a distance `release`, and it is suspended during saccades. All nine parameters are linear functions of a single strength $k\in[0,1]$ (default 0.7), e.g. $r=40+100k$. The gaze indicator is a 36-node mass–spring ring whose rest shape morphs into a superellipse $|x/w|^5+|y/h|^5=1$ around the attracted word, making the attraction state visible.

### 4.7 Cascaded decision stage

To decide when the assistant should volunteer help, LookAsk uses a three-level cascade: (i) zero-cost local rules (ignore short passages, dwell below 1.5 s, or repeated prompts within 20 s); (ii) a low-cost judgement model that answers multiple-choice or probability questions (difficulty, “is the reader stuck?”, intent, need for an image, need for fact checking); (iii) the LLM, called only when (ii) requires it. Numerical signals are discretised into verbal levels before being passed to the judgement model (e.g. dwell < 3 s “very short”, 3–8 s “normal”, 8–20 s “long”, > 20 s “very long”). A passage is considered for an unprompted explanation when dwell ≥ 9 s or revisits ≥ 3 and difficulty ≥ 1.4, and the suggestion is shown if the judged probability is ≥ 0.65. Because gaze resolves only paragraphs, the focused paragraph is also split into candidate sentences, and the judgement model selects the sentence referred to by the user’s utterance (reference resolution). Judgements are cached by content hash and subject to a daily token budget.

## 5. Experiments

### 5.1 Setup

No human-subject study was conducted for this report. All experiments below are **synthetic** and execute the production functions `fitRidge`, `predictRidge` (ridge.ts) and `OneEuro` (filters.ts); the drift estimator re-implements Eqs. (5)–(6) exactly as in engine.ts. Synthetic features are generated by passing a quadratic encoding of the target position through a fixed random projection and a tanh non-linearity ($d=1650$), adding a per-calibration-point nuisance term (modelling head pose and eye micro-offsets that are shared by all frames of a point) and independent per-frame noise. The 17-point calibration layout of the application is used. A fixed random seed makes all results reproducible (<code>docs/算法论文/experiments</code>); timings were measured single-threaded in Node.js 22 on an Apple-silicon MacBook.

### 5.2 Computational cost of the dual solver

<p class="tcap"><b>Table 1.</b> Fitting cost for $N=408$ frames (17 points × 24 frames) and $d=1650$. Times are medians of three runs and vary by a few percent between executions; the primal time covers only Gram construction and Cholesky factorisation.</p>

| Method | Floating-point operations | Time (ms) |
|---|---|---|
| Primal, $d\times d$ system | $1.11\times10^{9}+1.50\times10^{9}$ | 1192 |
| Dual, $N\times N$ system, one $\lambda$ | $2.75\times10^{8}+2.26\times10^{7}$ | 283 |
| Dual, 4 $\lambda$ × 17-fold grouped CV | — | 719 |

The dual solver was 4.2× faster than the primal factorisation step alone, and the complete model selection with cross-validation (68 additional factorisations) finished in about 0.7 s, fast enough to run at the end of calibration without noticeable delay.

### 5.3 Bias of cross-validation estimates

We generated three calibration sessions (17 points × 12 frames) and compared the cross-validated error of the selected model under frame-level leave-one-out and under grouped leave-one-point-out with its true error on 200 unseen random screen positions.

<p class="tcap"><b>Table 2.</b> Cross-validated versus true error (px).</p>

| Session | Frame-level CV | Grouped CV (ours) | True error on unseen positions |
|---|---|---|---|
| 1 | 5.1 | 17.3 | 34.4 |
| 2 | 4.7 | 15.3 | 50.9 |
| 3 | 6.0 | 15.6 | 26.6 |
| Mean | 5.3 | 16.1 | 37.3 |

Frame-level CV underestimated the true error by a factor of 7.1 on average, grouped CV by 2.3. Grouped CV is therefore substantially more honest, although it remains optimistic because unseen positions also include locations outside the convex hull of the calibration grid and the non-linearity of the synthetic mapping.

### 5.4 One Euro filtering

A one-dimensional gaze trace was simulated at 30 Hz with 12 fixations of 600–1200 ms at random positions and additive Gaussian noise ($\sigma=40$ px). We report the RMS error from 300 ms after each fixation onset (steady state) and the median time to cover 90% of each saccade.

<p class="tcap"><b>Table 3.</b> Filter comparison on the synthetic trace (raw noise 40 px).</p>

| Filter | Steady-state RMS error (px) | 90% step latency (ms) |
|---|---|---|
| Fixed cut-off 0.55 Hz | 90.0 | 700 |
| Fixed cut-off 5 Hz | 23.9 | 67 |
| One Euro, $f_{c,\min}=0.55$ Hz, $\beta=0.0045$ | **20.5** | **33** |

<!--FIG2-->

A low fixed cut-off is stable but so slow that it has not settled 300 ms after a saccade; a high cut-off is fast but passes more noise. The One Euro filter halved the raw noise while reacting within one frame (latency resolution is limited to the 33 ms frame period).

### 5.5 Drift correction

A smooth, spatially varying drift field of magnitude 25–70 px was applied to predictions. Implicit calibration events were drawn at random screen positions with 12 px residual noise; in 15% of events the user was assumed to be looking elsewhere (offset 250–650 px per axis). Error was evaluated on a 9 × 6 grid and averaged over 200 repetitions.

<p class="tcap"><b>Table 4.</b> Mean error (px) after $n$ implicit calibration events.</p>

| Variant | $n=0$ | 1 | 2 | 4 | 8 | 16 |
|---|---|---|---|---|---|---|
| Full method (Eqs. 5–6, 320 px gate) | 46.7 | **32.1** | **27.1** | 23.1 | 20.4 | 18.7 |
| Without outlier gate | 46.7 | 62.2 | 64.2 | 65.9 | 55.9 | 48.6 |
| Global mean (no spatial kernel) | 46.7 | 31.2 | 28.9 | 26.7 | 25.6 | 24.8 |
| Without shrinkage ($k=1$) | 46.7 | 34.0 | 27.2 | **21.9** | **19.6** | **18.1** |

<!--FIG3-->

The full method reduced the error by 60% after 16 events. The outlier gate is essential: without it, look-away presses made the correction worse than no correction at all. The spatial kernel mattered once enough samples accumulated (18.7 vs 24.8 px at $n=16$), because a single global offset cannot represent a position-dependent drift. Shrinkage helped with a single sample (32.1 vs 34.0 px) at a small cost when many samples were available (18.7 vs 18.1 px), a deliberate trade-off in favour of robustness early in a session.

## 6. Discussion and Limitations

The design principle of LookAsk is to accept the accuracy ceiling of webcam gaze and to allocate precision to the component that can provide it most cheaply: statistics for calibration, user behaviour for drift, filtering for noise, language cues for the last few tens of pixels, and the hand for word-level selection.

Several limitations remain. (i) All quantitative results are synthetic; a user study measuring calibration error, drift over time and selection time is needed. (ii) The gaze mapping is linear in the features; large head movements may call for a non-linear (e.g. RBF) kernel or explicit head-pose compensation. (iii) Implicit calibration assumes the user looks at the focus when pressing a button; the fixed 320 px gate could be replaced by an adaptive robust criterion such as a median-absolute-deviation threshold. (iv) The keyword score is hand-crafted and could be learned or replaced by term-frequency statistics. (v) Camera “centre stage” features on some laptops crop the image and invalidate calibration. (vi) The feature extractor is AGPL-licensed, which constrains redistribution.

## 7. Conclusion

We described the algorithmic chain of LookAsk, which turns paragraph-level webcam gaze into a word-level pointer for LLM-assisted reading. Dual ridge regression with grouped cross-validation provides fast and honestly evaluated per-user calibration; kernel-based implicit recalibration counteracts drift; One Euro filtering and I-DT detection produce stable fixations; and two-level focus with keyword attraction bridges the remaining gap to individual words. Synthetic experiments with the production code support each design decision.

## Code Availability

All algorithms are implemented in the LookAsk repository: <code>gaze/ridge.ts</code> (Eqs. 1–4), <code>gaze/engine.ts</code> (Eqs. 5–6), <code>gaze/filters.ts</code> (Eqs. 7–8 and I-DT), <code>focus/focus.ts</code>, <code>focus/magnet.ts</code> and <code>focus/snap.ts</code> (Section 4.6), and <code>jev/jevBrain.ts</code> (Section 4.7). The experiments are in <code>docs/算法论文/experiments</code>.

## Declaration of Generative AI Use

The LookAsk software was developed with substantial assistance from AI coding tools, and this report, including the experiment scripts, was drafted with the assistance of an AI model and then checked against the source code by the author. All numerical results were produced by executing the scripts in the repository.

## References

<ol class="refs">
<li>Papoutsaki A, Sangkloy P, Laskey J, Daskalova N, Huang J, Hays J. WebGazer: Scalable webcam eye tracking using user interactions. In: <i>Proc. IJCAI</i>; 2016. p. 3839–3845.</li>
<li>Krafka K, Khosla A, Kellnhofer P, Kannan H, Bhandarkar S, Matusik W, Torralba A. Eye tracking for everyone. In: <i>Proc. IEEE CVPR</i>; 2016. p. 2176–2184.</li>
<li>Zhang X, Sugano Y, Fritz M, Bulling A. Appearance-based gaze estimation in the wild. In: <i>Proc. IEEE CVPR</i>; 2015. p. 4511–4520.</li>
<li>Casiez G, Roussel N, Vogel D. 1€ filter: A simple speed-based low-pass filter for noisy input in interactive systems. In: <i>Proc. ACM CHI</i>; 2012. p. 2527–2530.</li>
<li>Salvucci DD, Goldberg JH. Identifying fixations and saccades in eye-tracking protocols. In: <i>Proc. ACM ETRA</i>; 2000. p. 71–78.</li>
<li>Zhai S, Morimoto C, Ihde S. Manual and gaze input cascaded (MAGIC) pointing. In: <i>Proc. ACM CHI</i>; 1999. p. 246–253.</li>
<li>Hoerl AE, Kennard RW. Ridge regression: Biased estimation for nonorthogonal problems. <i>Technometrics</i>. 1970;12(1):55–67.</li>
<li>Saunders C, Gammerman A, Vovk V. Ridge regression learning algorithm in dual variables. In: <i>Proc. ICML</i>; 1998. p. 515–521.</li>
<li>Nadaraya EA. On estimating regression. <i>Theory of Probability and Its Applications</i>. 1964;9(1):141–142.</li>
<li>Watson GS. Smooth regression analysis. <i>Sankhyā: The Indian Journal of Statistics, Series A</i>. 1964;26(4):359–372.</li>
<li>Kartynnik Y, Ablavatski A, Grishchenko I, Grundmann M. Real-time facial surface geometry from monocular video on mobile GPUs. In: <i>CVPR Workshop on Computer Vision for Augmented and Virtual Reality</i>; 2019. arXiv:1907.06724.</li>
<li>Hastie T, Tibshirani R, Friedman J. <i>The Elements of Statistical Learning</i>. 2nd ed. New York: Springer; 2009.</li>
<li>Sugano Y, Matsushita Y, Sato Y. Appearance-based gaze estimation using visual saliency. <i>IEEE Transactions on Pattern Analysis and Machine Intelligence</i>. 2013;35(2):329–341.</li>
<li>Jacob RJK. What you look at is what you get: Eye movement-based interaction techniques. In: <i>Proc. ACM CHI</i>; 1990. p. 11–18.</li>
<li>Roberts DR, Bahn V, Ciuti S, et al. Cross-validation strategies for data with temporal, spatial, hierarchical, or phylogenetic structure. <i>Ecography</i>. 2017;40(8):913–929.</li>
<li>Golub GH, Van Loan CF. <i>Matrix Computations</i>. 4th ed. Baltimore: Johns Hopkins University Press; 2013.</li>
</ol>
