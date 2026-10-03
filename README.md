<div align="center">

<img src="resources/icon-1024.png" width="128" alt="Glint 图标" />

# Glint · 瞳问

> 原名 LookAsk（看哪问哪）。**所见，即所问。**

**眼睛负责「大概在看哪」，Joy-Con 负责「就是这个词」，右边的千问自动知道你在看什么。**

[![macOS](https://img.shields.io/badge/macOS-Apple%20芯片-111111?style=flat-square&logo=apple&logoColor=white)](#mac-版)
[![Windows](https://img.shields.io/badge/Windows-10%20%2F%2011%20x64-0078D4?style=flat-square&logo=windows&logoColor=white)](#windows-版)
[![Electron](https://img.shields.io/npm/v/electron?style=flat-square&logo=electron&logoColor=white&label=Electron)](https://www.npmjs.com/package/electron)
[![MediaPipe](https://img.shields.io/npm/v/@mediapipe/tasks-vision?style=flat-square&logo=google&logoColor=white&label=MediaPipe)](https://www.npmjs.com/package/@mediapipe/tasks-vision)
[![Swift](https://img.shields.io/badge/Swift-原生助手-F05138?style=flat-square&logo=swift&logoColor=white)](native/LookAskBridge)
[![iPhone](https://img.shields.io/badge/iPhone-原深感眼动-000000?style=flat-square&logo=apple&logoColor=white)](#iphone-原深感)
[![Qwen](https://img.shields.io/badge/大模型-千问%20Qwen-615CED?style=flat-square&logo=alibabacloud&logoColor=white)](#千问怎么接进来)
[![Joy-Con](https://img.shields.io/badge/Joy--Con-%E5%B7%A6%E5%8F%B3%E5%8F%8C%E6%89%8B%E6%9F%84-E60012?style=flat-square)](#按键)
[![Jev](https://img.shields.io/badge/Jev-先判断再开口-A78BFA?style=flat-square)](#jev-模式先判断再开口)

**[下载 v0.1.0](https://github.com/LeoLee0812/lookask/releases/tag/v0.1.0)**：Mac（Apple 芯片）`Glint-0.1.0-arm64.dmg` · Windows 10 / 11（x64）`Glint-Setup-0.1.0-x64.exe`

</div>

Glint 是一个桌面阅读程序。左边放你要读的东西：论文 PDF（扫描件也行）、Markdown、跑着 Qwen Code 的终端；右边是千问驱动的对话区。摄像头（或者 iPhone 的原深感镜头）看你的眼睛，两只 Joy-Con 一手一只，提问时程序自动把「你正在看的那段」当作上下文发给模型，不用复制粘贴，也不用说「上面第三段那个公式」。

思路来自 Fovea 的「attention is now an input for AI」。参加天猫 AI 黑客松·高校挑战赛「效率进化」赛道。

## 它解决什么

读论文、读代码时遇到不懂的地方，平常要做的是：选中、复制、切到聊天窗口、粘贴、再补一句「这是什么意思」。手离开了文档，注意力也跟着断了。

Glint 把这几步换成「看 + 按一下」：

1. **看**：眼睛落在一段上，这一段（或这个词）被一圈光环包住，这叫软焦点。
2. **定**：推一下右摇杆，软焦点定成硬焦点；再推就按词 / 句 / 段 / 节一格一格挪，每挪一格手柄「咔」一下。
3. **问**：按 A 解释、X 翻译、Y 总结，或者按住 ZR 直接说话。
4. **答**：右边的回答已经带着你正在看的那段原文、前后文，以及来源（PDF 第几页、终端里哪个程序）。

普通摄像头的眼动精度只够「大概在哪一段」，所以眼睛只管粗定位，最后精确到词交给摇杆、关键词吸附和手腕精调。这是整个交互的出发点。

## 功能

**看哪问哪**
- 左侧三种内容：PDF（pdf.js 文字层做版面分析：单双栏、章节标题、公式截图）、Markdown（公式回传 LaTeX 源码）、终端（node-pty + xterm）。
- 粒度只有一档：词 / 句 / 段 / 节，按 R 或点顶栏药丸循环切换。视线、右摇杆、十字键都按这一档走。
- 关键词吸附：「词」这一档时，视线光环会被附近的术语、缩写、公式、加粗词吸过去；吸住时推右摇杆，硬焦点直接落在那个词上。强度在 设置 → 眼动 → 吸附强度 里调。
- 视线分左右：左手柄 − 让视线只跟左边内容，右手柄 + 只跟右边的回答，两栏之间不会乱飘。
- 往下裂变的解释窗口：看着回答里不懂的地方按 A，解释不塞进主对话，而是在下面开一张新卡片；还不懂就再往下一层，B 一层层收回。
- 看图问：截图键把视线所在那一侧整块截下来，在眼睛看的位置画一个蓝圈，交给看图模型「重点解释蓝圈里的东西」。
- 扫描版 PDF：一页文字层的有效字少于 300 个就当扫描页，按像素做版面分析（摆正歪斜、找栏缝、切行、分出图 / 表 / 公式 / 文字块），视线照样按块选，粒度在 行 / 段 / 栏 之间切；提问时把那一块从 PDF 里高清截出来交给看图模型。

**眼动**
- 普通摄像头：MediaPipe 人脸 478 点 + 双眼小图特征，岭回归映射到屏幕，One Euro 平滑、注视检测、眨眼帧丢弃。
- 头动补偿：校准时记下头的三维位置和朝向，之后头挪一挪、转一转，按几何把视线点算回来（设置里可关，要重新校准一次才生效）。
- iPhone 原深感（仅 Mac）：iPhone 上的 Glint Eye 用 ARKit 拿头的三维位姿和双眼朝向，Mac 把视线当射线和屏幕平面求交。详见[下文](#iphone-原深感)。
- 越用越准：用摇杆挪到目标再按 A / X / Y，那一刻记成一次隐式校准；手腕精调松手时也记一次；`⌥ + 点击` 正在看的地方，视线点当场拉回来。

**Joy-Con**
- 原生 HID 读取，左右两只分开拿：左手管左侧内容，右手管右侧 AI。
- 手腕精调：按住右摇杆拧手腕，焦点跟着陀螺仪逐词 / 逐行走，松开落定。
- 震动当反馈：挪一个词「咔」、跨句「咔咔」、跨段「咚」、到头「撞墙」；AI 开始出字往上扬一下；终端里 Qwen Code 等你批准时左手「心跳」。手柄放在桌上不动 3 秒就不震。
- 校准小游戏：两只手柄都连着时，每个校准点是手柄上的一颗键（左十字键蓝、右 XABY 红），亮哪颗按哪颗，有连击和排行榜。要按对就得先看清，眼睛自然盯在点上，采样取按下前那一小段。没连齐就是普通的看圆点校准。

**其它**
- 新手引导：第一次打开一步步带着走：连 Joy-Con → 填千问的 Key（当场试通不通）→ 校准 → 在示范文档上真做一遍「看一段、推摇杆选词、按 A、按住 ZR 说话」→ 可选拍大头照。右上角「？」能从头再走一遍。
- 实时小人：拍一张大头照，千问图像编辑模型画成 Q 版卡通形象，放在回答区右上角，跟着你的头实时转、歪、眨眼、张嘴；坐偏了、离远了它告诉你往哪挪。普通摄像头眼动对头的位置很敏感，这面「小镜子」是为这个做的。
- 菜单栏小眼睛（Mac）：睁眼 = 眼动在跑，闭眼 = 暂停；下拉菜单里能看状态、暂停眼动、切输入源、校准、开关 Jev、让两只手柄一起响着找手柄。
- 配色跟 Joy-Con 对上：左边内容区是左手柄的电光蓝，右边回答区是右手柄的电光红，AI 思考时右侧顶线变成电光紫，跟 HOME 键的灯一起呼吸。

## 千问怎么接进来

### 模型分工

设置 → 模型分配 里有三路模型，按请求类型自动选（`src/renderer/src/chat/chatStore.ts`）：带图片的走看图模型，翻译走快模型，其它走回答模型。代码里的默认值（`src/main/settings.ts`）：

| 用途 | 默认模型 | 跑在哪 |
| --- | --- | --- |
| 回答（解释、总结、自由提问） | `qwen3.8-max` | 阿里云百炼；可在设置或对话区顶上的下拉框换成本地 `qwen3.5:4b` |
| 翻译 | `qwen3.8-flash` | 阿里云百炼 |
| 看图（看图问、扫描版 PDF） | `qwen3.8-max` | 阿里云百炼 |
| 卡通小人 | `qwen-image-3.0-pro` | 阿里云百炼原生多模态生成接口 |
| 终端编程智能体 | Qwen Code，默认 `qwen3.8-max` | 阿里云百炼 |

内置的服务商只有两个：「千问 · 阿里云百炼」（OpenAI 兼容接口）和「本地千问 · Ollama」。你也可以自己添加别的 OpenAI 兼容 / Anthropic 接口。大模型请求都在主进程用 `net.fetch` 流式发出，Key 不进渲染进程，存在本机设置文件里（权限 600）。

### 端云协同：本地算什么，云端算什么

| 在本机完成 | 发到云端 |
| --- | --- |
| 摄像头画面：MediaPipe 人脸关键点、眼部特征、岭回归、平滑，全在渲染进程里跑 | 你提问时的文字上下文（焦点那段原文 + 前后文） |
| iPhone 原深感数据：只在局域网里 UDP 传给 Mac，不出局域网 | 看图问的截图、扫描版 PDF 的那一块截图（看的是屏幕内容，不是你的脸） |
| 语音识别（Mac）：系统语音识别，支持本机识别时强制本机完成 | 拍大头照生成小人时，那一张照片发给百炼图像编辑模型；照片本身不落盘，只存生成好的卡通图 |
| 版面分析：PDF 文字层和扫描页切块都在本机算 | Jev 判断：本地先把停留时长、回看次数分档成文字，再连同段落文字发给 Jev 服务 |
| 可选：本地 Ollama 跑 `qwen3.5:4b` 当回答模型 | Windows 版的按住说话：录音发给百炼 Fun-ASR 实时识别 |

眼动用的摄像头画面从不上传，也不录制。唯一会离开本机的人脸图像是你主动点「拍照生成小人」那一张。

本地模型这条路的细节：`qwen3.5:4b` 能看图，带 `reasoning_effort: "none"` 关掉思考（不关的话一个翻译要先想上千 token）；`scripts/setup-local-model.sh` 用 Modelfile 把上下文放到 16384（Ollama 默认按显存给，16GB 的 Mac 只有 4096，会把系统提示词挤掉），并预热一次 Metal，免得 Ollama 探测 GPU 超时退回 CPU。

### 软硬结合

**Joy-Con**：系统自带的 GameController 框架会把单只 Joy-Con 当成横握的小手柄，丢掉 R、ZR 和摇杆按下。所以 Mac 版用 Swift 写的原生助手（`native/LookAskBridge`）通过 IOHIDManager 直接读 HID 原始报告；Windows 版的原生助手（`native/win`，TypeScript）用 node-hid 同样绕开系统和浏览器的手柄接口直接读写 HID 报告，两边对主进程说的是同一套 JSON 行协议。每个键都能用，程序在后台也收得到。

- 震动：`src/renderer/src/input/haptics.ts` 是一套固定的触感词汇，每种事件一个震法，按 `[毫秒, 低频, 高频, 振幅, ...]` 分段发给原生助手；原生助手按每只手柄一个 15ms 节拍发包（蓝牙大约每 15ms 才送得出一包，发快了会排队）。HD 震动编码移植自 joy-con-webhid。
- IMU：初始化时开 6 轴传感器、读手柄里的出厂校准；每包 3 组样本。静止 3 秒报「放下」（这时不震，硬桌面一震嗡嗡响）；手腕精调时推陀螺仪角度，零偏在静止时自动学。
- HOME 键的灯：AI 思考、出字时呼吸。

**iPhone 原深感**：见[下文](#iphone-原深感)。协议是 HMAC 签名的 UDP 数据报，Bonjour 发现，支持同一 Wi‑Fi、个人热点和点对点 Wi‑Fi。

## 安装和上手

先到 [Release v0.1.0](https://github.com/LeoLee0812/lookask/releases/tag/v0.1.0) 下载对应平台的安装包。两个版本都没有做代码签名，第一次打开会被系统拦一下，下面写了放行方法。

### Mac 版

要求 Apple 芯片、macOS 13 以上。

1. 打开 `Glint-0.1.0-arm64.dmg`，把 Glint 拖进「应用程序」。
2. 第一次双击会被拦：右键 → 打开。如果提示「已损坏」，在终端执行 `xattr -cr /Applications/Glint.app`。
3. 按提示给权限：摄像头（眼动）、麦克风和语音识别（按住说话）；用 iPhone 原深感时还要「本地网络」。
4. Joy-Con 配对：系统设置 → 蓝牙，按住手柄侧面导轨上的小圆键直到指示灯来回跑，分别连上 Joy-Con (L) 和 Joy-Con (R)。手柄闲置会休眠断开，按任意键唤醒。
5. 跟着新手引导走：连手柄 → 填千问的 Key → 校准 → 试一试。

M4 MacBook Air 的「人物居中」会裁切摄像头画面，导致校准失效，用之前在 控制中心 → 视频效果 里关掉。

### Windows 版

要求 Windows 10 / 11 x64。

1. 双击 `Glint-Setup-0.1.0-x64.exe` 安装，可以改安装位置，装完桌面和开始菜单里有「Glint 瞳问」。
2. SmartScreen 拦截时点「更多信息 → 仍要运行」。
3. Joy-Con 配对：设置 → 蓝牙和其他设备 → 添加设备 → 蓝牙，按住手柄侧面的小圆键直到指示灯来回跑，选「Joy-Con (L)」「Joy-Con (R)」。
4. 开着 Steam 的话，在 Steam 设置 → 控制器 里关掉 Switch 控制器支持（或者先退出 Steam），不然两边抢手柄。
5. 摄像头 / 麦克风打不开：设置 → 隐私和安全性 → 相机 / 麦克风，打开「让桌面应用访问」；带「Windows 工作室效果」的电脑先关掉「自动取景」，它会裁切画面，让校准失效。
6. 跟着新手引导走。可选的本地小模型：装 [Ollama](https://ollama.com/download) 后 `ollama pull qwen3.5:4b`，上下文放到 16384 的做法见 `scripts/setup-local-model.sh`。

和 Mac 版的差别：

- 没有 iPhone 原深感，眼动只用电脑摄像头。
- 按住说话走阿里云百炼的 Fun-ASR 实时识别，和对话共用千问的 Key，按说话时长计费。
- 没手柄时键盘用 `Alt` 代替 `⌥`，按住说话是 `Alt+V`（`Alt+空格` 在 Windows 上会弹出窗口的系统菜单）。
- 左侧终端默认是 PowerShell 7（没装就用系统自带的 Windows PowerShell）。
- 按手柄 HOME 呼出窗口时，Windows 不让后台程序抢键盘焦点：窗口会到最前面，但要打字得先点一下。
- 用户数据在 `%APPDATA%\LookAsk`，卸载不会删。

### 填千问的 Key

在[阿里云百炼控制台](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key)创建 API Key（北京地域，国际站的 Key 用不了），填进新手引导，或者 设置 → 模型服务 →「千问 · 阿里云百炼」。回答、翻译、看图、画小人、终端里的 Qwen Code 都用这一个 Key。

Jev 模式要单独的 Jev Key，填在 设置 → Jev 判断。

### 可选：本地小模型（Mac）

```bash
bash scripts/setup-local-model.sh
```

脚本用 Homebrew 装 Ollama 并设成开机自启，拉 `qwen3.5:4b`（约 3.4GB），把上下文放到 16384，预热 Metal，最后试答一句。装好后在 设置 → 模型分配 里选「本地千问 · Ollama」。本地模型不用 Key、不联网、不花钱。

## 按键

两只 Joy-Con 分开拿，一手一只。左手操作左侧内容，右手跟右侧 AI 对话。

| 左手 Joy-Con | 作用 |
| --- | --- |
| 左摇杆 | 上下滚动（推得越深越快），左右翻页 |
| 左摇杆按下 | 拍大头照（只在拍照窗口里用，拍下时手柄重重震一下） |
| 十字键 ↑ ↓ | 文档：跳上 / 下一段；终端：方向键（在 Qwen Code 里选选项） |
| 十字键 → ← | 文档：翻页；终端：→ 回车确认，← Esc 打断 |
| L | 切换左侧标签页 |
| ZL（按住） | 终端：说话直接打字给 Qwen Code；文档：同 ZR |
| − | 视线跟左边内容（终端里再按 = ⇧Tab，切 Qwen Code 审批模式） |
| 截图键 | 视线所在那一侧整块截图，蓝圈标出你在看哪，交给看图模型 |

| 右手 Joy-Con | 作用 |
| --- | --- |
| 右摇杆 | 挪焦点。第一次推先定住眼睛选中的那一格，再推才挪：「词」时左右逐词、上下逐行，句 / 段 / 节时往后 / 往前一格；按住加速 |
| 右摇杆按下 | 焦点跳回眼睛正在看的地方；**按住不放拧手腕** = 从这里精调，松开落定 |
| A / X / Y | 解释 / 翻译 / 总结 |
| B | 放开焦点；AI 回答中 = 停止；右侧模式下 = 收起最下面一层解释窗口 |
| ZR（按住） | 说话提问，松开发送，自动带上焦点上下文 |
| R | 切粒度：词 → 句 → 段 → 节（手柄咔 1~4 下，不用看屏幕就知道切到了哪档） |
| + | 视线跟右边的 AI 回答；长按 = 开关 Jev 模式 |
| HOME | 显示 / 隐藏 Glint |

手感词汇（`src/renderer/src/input/haptics.ts`），同一类事件永远是同一种震法：

| 手感 | 意思 |
| --- | --- |
| 极短一下「咔」 | 焦点挪了一个词（按住摇杆连发时越走越轻） |
| 「咔咔」 / 低沉「咚」 / 重重「噔」 | 跨了一句 / 跨了一段 / 走到头了 |
| 咔 1~4 下 | 按 R 切到了 词 / 句 / 段 / 节 |
| 往上扬 | AI 等了一阵后开始出字 |
| 往下沉 | 松开 ZR / ZL，语音发出去了 |
| 左手「心跳」 | Qwen Code 在等你批准 / 在问你；没处理每 10 秒再跳一次，最多 3 次 |
| 左手三连 | Jev 判断这步放行有风险，要再按一次 → |
| 两只一起「长-短」 | 眼动断了（iPhone 断开 / 摄像头出错），或按右摇杆时看不到你的脸 |

**没有手柄时**，键盘只留五个核心功能（Windows 上把 `⌥` 换成 `Alt`）：

| 键盘 | 作用 |
| --- | --- |
| `⌥ + 方向键` | 挪焦点（等于右摇杆） |
| `⌥ ↩` | 解释（A） |
| `⌥ T` / `⌥ S` | 翻译（X）/ 总结（Y） |
| 按住 `⌥ 空格`（Windows：`Alt+V`） | 说话（ZR） |
| `Esc` | 放开焦点 / 停止（B） |

其余操作用鼠标点界面，比如顶栏的 − / + 切视线跟哪边。没校准眼动时，鼠标停住的地方就当视线；`⌥ + 点击` 直接落硬焦点，已校准时这一下同时是一次漂移校正。

## Jev 模式：先判断，再开口

[Jev](https://docs.typesafe.ai/api) 是一个只做判断的服务（choice / score / noul，带概率），不写字，所以便宜。Glint 让它决定「什么时候插话、怎么答」，写字还是交给千问。默认连 TypeSafe 官方接口，设置里另有几个预设入口可选。

它在后台判断四件事：

1. **段落难度**：盯住一段 1.5 秒，判断难度（0～3 档）、有没有术语、是定义 / 公式 / 实验结果还是代码。
2. **卡住了吗**：停留时长和回看次数先在本地分档成文字（Jev 不擅长读数字），再问它读者是不是卡住了，超过 0.65 才插话。
3. **提问路由**：你说一句话，它判断你要解释、翻译、总结、推导还是挑刺，要不要看图，答多详细，据此改写提示词。
4. **终端**：输出停下来时判断 Qwen Code 是不是在等你批准。

判断结果不往对话区里塞，只在用得上的地方出现：

- 卡住了：那段上方冒一个紫色小签「A 拆开讲」，右手柄轻敲两下；按 A 就分步骤讲。眼睛挪走或 12 秒后小签自己消失。
- 按 A 解释一段 / 一句：按 Jev 判断的难度定详略。
- 自由提问：Jev 改了答法时，提问气泡下面标一行小字，比如「Jev · 按「推导」答 · 指第 2 句」。
- AI 回答里带数字 / 出处的句子：盯着看 2.5 秒，Jev 觉得可能不准，就在那段上方提示核实一下。
- 终端：Qwen Code 在等你批准时终端标签上挂个紫点，左手柄心跳；按 → 放行前先评风险，有风险的左手三连、要再按一次。
- 判断记录：点顶栏的 Jev 药丸，用大白话列最近的判断和今天用了多少 token。

相同内容命中本地缓存不重复花钱，按天记账，有每日 token 上限（默认 60000，设置里可调）。

## 终端里的 Qwen Code

左侧「终端」标签的「启动 Qwen Code」按钮跑的是 [Qwen Code](https://github.com/QwenLM/qwen-code)，千问官方开源的命令行编程智能体（命令 `qwen`），在终端里读代码、改文件、跑命令。

- **不用另配 Key**：起终端时 Glint 把百炼的 Key 放进环境变量 `DASHSCOPE_API_KEY`，再用 `QWEN_CODE_SYSTEM_DEFAULTS_PATH` 指向 Glint 写的一份默认设置（文件里只引用环境变量名，不存 Key）。这一层是 Qwen Code 里优先级最低的「系统默认」，你自己在 `~/.qwen/settings.json` 里配的 Coding Plan、默认模型都会盖过它。没填百炼 Key 时不写这份默认设置，让 Qwen Code 自己弹登录方式。
- **模型**：默认 `qwen3.8-max`，进去后 `/model` 可换 `qwen3.7-plus` 或 `qwen3.8-flash`。
- **没装会自动装**：shell 报找不到 `qwen` 时就地执行 `npm i -g @qwen-code/qwen-code@latest` 再启动（要 Node 22+）。
- **用手柄批准**：Qwen Code 弹出「允许执行：'rm'？」「是否应用此更改？」这类确认时，左手柄心跳，十字键 → 放行、← 打断；− 键等于 ⇧Tab，轮换审批模式。人可以靠在椅子上批准操作。
- 想用 Qwen Code 就在终端里敲 `agent`，确认框和心跳提醒两家都认。
- Qwen Code 的界面语言跟 `LANG` 走，Glint 的终端默认 `zh_CN`；识别确认框时中文、英文两种界面都认。

## iPhone 原深感

仅 Mac 版。普通摄像头看到的是平面画面，头一挪、一歪，校准出来的映射就整体偏。iPhone 的原深感能直接给出头在三维空间里的位置和朝向、两只眼睛各自的朝向，于是 Mac 这边按几何算：从两眼中点沿视线方向打一条射线，和屏幕平面求交，再按显示器的物理尺寸换成屏幕坐标。眼睛转角的增益和偏置在校准时拟合。

它解决的主要是「头一动就偏」，暗光下也比摄像头稳；绝对精度只是小幅提升，最后精确到词仍然靠吸附和摇杆。

用法：

1. iPhone 装上 Glint Eye（`ios/LookAskEye`，目前需要自己用 Xcode 签名安装，见[从源码构建](#从源码构建)），打开后屏幕常亮，App 要一直在前台。
2. 手机竖放、前置镜头对着脸、离脸 40～70 厘米。比如立在 MacBook 屏幕和键盘之间（会挡住屏幕中下部，校准时被挡住的点自动跳过）。
3. Mac 上：设置 → 眼动 → 输入源选「iPhone 原深感」，摆放位置选对应的一项。
4. 手机上列出附近的 Mac，点这台；第一次连要把手机上显示的 4 位配对码填进 Mac 的设置里，之后自动认得。
5. 校准一次。两种输入源的校准分开存。

协议：每个 UDP 数据报 = HMAC 签名 + JSON，密钥由设备 ID 和配对码派生；每帧带序号，乱序的旧帧直接丢；手机 60 帧发送，发热时自动降帧；3 秒收不到帧显示「iPhone 已断开」，恢复后自动续上。只有切到原深感或在配对时 Mac 才开 UDP 监听，没用这个功能的人不会被弹「本地网络」权限。

配对码防的是局域网里别人的手机误连、随手往你的 Glint 发假视线；数据本身是明文 UDP，挡不住有心人抓包后暴力试码。

## 从源码构建

Mac 和 Windows 是同一套代码，平台差别用 `process.platform` 分支（主进程 `src/main/platform.ts`，渲染进程 `src/renderer/src/platform.ts`）。Mac 需要 Node.js 和 Xcode 命令行工具（编译 Swift 原生助手要用 `swiftc`）；Windows 需要 Node 22.12 以上。

```bash
npm install            # 下载 Electron、拷 MediaPipe / pdf.js 资源到 src/renderer/public、为 Electron 重编译 node-pty
npm run build:native   # 编译 Swift 原生助手 → native/bin/lookask-bridge（开发前必须先跑，否则手柄 / 语音 / 原深感都不可用）
npm run dev            # 开发模式，远程调试端口 9333
npm run typecheck      # 主进程和渲染进程分别做类型检查
npm run dist           # 原生助手 + 构建 + electron-builder → release/<版本>/ 下的 arm64 dmg（ad-hoc 签名，未公证）

# Windows
npm install            # Windows 上不为 Electron 重编译 node-pty（它自带 Windows 预编译版）
npm run build:native   # esbuild 把 native/win 打成 native/bin/lookask-bridge.cjs，连同 node-hid 的预编译二进制
npm run dist:win       # → release/<版本>/Glint-Setup-<版本>-x64.exe（NSIS 安装包，没签名）
```

- 国内网络：`.npmrc` 已配 npmmirror 和 Electron 镜像；首次下载 MediaPipe 模型超时可以加 `NODE_USE_ENV_PROXY=1`。
- 原生助手可以单独跑来查手柄：`native/bin/lookask-bridge --probe`（Windows：`node native/bin/lookask-bridge.cjs --probe`），按键会打印 JSON。
- 没有测试框架和 lint 配置，验证靠 `npm run typecheck` 和实际运行。原深感另有 Mac 端全链路测试 `npm run test:truedepth`（起一个隔离的开发版 + 假 iPhone，用 Playwright 走 CDP 跑一次校准），`npm run fake-iphone` 可以单独起一个假 iPhone。

开发时有用的环境变量：

| 变量 | 作用 |
| --- | --- |
| `LOOKASK_FAKE_CAM=1` | 用 Chromium 假摄像头；再加 `LOOKASK_FAKE_CAM_FILE=<y4m/mjpeg>` 用视频文件当摄像头 |
| `LOOKASK_USER_DATA=<目录>` | 换一套用户数据，能和已装好的 Glint 同时开 |
| `LOOKASK_NO_BRIDGE=1` | 不拉原生助手，免得和正在用的 Glint 抢手柄 |
| `LOOKASK_BRIDGE_NO_JOY=1` | 拉原生助手但不接管 Joy-Con（测原深感时用） |
| `LOOKASK_TD_PORT` / `LOOKASK_TD_NAME` | 原深感的 UDP 端口（默认 47650）和 Bonjour 名字 |

iPhone 端（`ios/LookAskEye`，工程由 XcodeGen 按 `project.yml` 生成）：

```bash
bash ios/LookAskEye/build.sh test     # 模拟器上跑协议层单元测试
bash ios/LookAskEye/build.sh ipa      # 无签名 ipa → release/ios/
bash ios/LookAskEye/build.sh device   # 用 Xcode 里登录的个人团队签名，装到连着的 iPhone
```

`project.yml` 里写的是作者自己的开发团队，自己构建要改成你的。免费个人团队签的版本 7 天后过期；第一次打开要在 设置 → 通用 → VPN 与设备管理 里信任开发者。模拟器没有原深感人脸追踪，只能测界面和连接。

## 架构

三个 Electron 进程加一个原生子进程。渲染进程拿不到 Node，系统能力都经 preload 转发：

```
渲染进程（React）──window.lookask──▶ preload（contextBridge）
                                        │ ipcRenderer invoke / send
                                        ▼
                                   主进程（src/main）
                                        │ stdin / stdout JSON 行协议
                                        ▼
                     Swift 原生助手 native/LookAskBridge（Joy-Con HID / 语音 / 原深感收包）
                                        ▲ UDP（Bonjour _lookask._udp）
                     iPhone 上的 Glint Eye（ARKit 人脸追踪 → 签名数据报）
```

数据怎么流：

```
摄像头 ─ MediaPipe 478 点 ─ 眼部特征 ─ 岭回归 ─ 头动补偿 ──┐
iPhone ─ ARKit ─ UDP ─ 原生助手 ─ 主进程验签 ─ 射线求交 ──┴─ 漂移校正 ─ One Euro ─ 注视检测
                                                                          │
Joy-Con ─ IOHIDManager（原生助手）─ 按键路由 ───────────────┐            ▼
麦克风 ─ 语音识别 ─ 按住说话 ───────────────────────────────┴─▶ 焦点控制器（词 / 句 / 段 / 节）
                                                                          │
                      左侧视图：PDF / 扫描版 PDF / Markdown / 终端 ───────┤ 焦点上下文
                                         Jev 判断（插话时机、提问路由）──┤
                                                                          ▼
                                     右侧对话（主进程 net.fetch 流式调用，百炼千问 / 本地千问）
```

目录：

| 路径 | 内容 |
| --- | --- |
| `src/main` | 窗口管理（校准时全屏）、大模型流式调用 `llm.ts`、Jev 客户端 `jev.ts`（缓存、记账）、设置 `settings.ts`、小人生成 `avatar.ts`、原生助手管理 `bridge.ts`、原深感收包 `truedepth.ts`、终端 `pty.ts` 和 Qwen Code 默认设置 `qwenCode.ts`、菜单栏 `tray.ts` |
| `src/preload` | `window.lookask` 接口 |
| `src/shared/types.ts` | 跨进程类型 |
| `src/renderer/src/gaze` | 眼动引擎、校准界面；`sources/` 是两种输入源，`td/` 是原深感的几何换算和校准模型 |
| `src/renderer/src/focus` | 焦点控制器、关键词吸附、看图问截图；每种左侧视图实现一个适配器 |
| `src/renderer/src/input` | Joy-Con 解码与按键路由、触感词汇表、手腕精调 |
| `src/renderer/src/chat` | 对话状态、提示词拼装、Markdown + KaTeX 渲染 |
| `src/renderer/src/jev` | Jev 模式的决策逻辑 |
| `src/renderer/src/panes` | 左侧各视图（PDF、扫描版版面分析、Markdown、终端） |
| `src/renderer/src/avatar` | 2.5D 网格小人 |
| `native/LookAskBridge` | Swift 原生助手：Joy-Con HID（按键、摇杆、6 轴 IMU、震动、灯）、语音、原深感 UDP 收包和 Bonjour 广播 |
| `native/win` | Windows 版原生助手：TypeScript + node-hid，只管 Joy-Con，协议和 Swift 版一样；按住说话由主进程转给百炼 Fun-ASR（`src/main/asrCloud.ts`） |
| `ios/LookAskEye` | iPhone 端 Glint Eye（SwiftUI + ARKit + Network.framework） |
| `scripts` | 资源下载、本地模型安装、原深感测试、打包后签名 |
| `docs/算法论文` | 眼动与焦点算法的论文、讲义和可复现的合成实验 |

## 许可与第三方

本仓库目前没有附带开源许可证文件。

用到的第三方项目：

- 眼动特征与岭回归积木来自 [RealEye Webcam EyeTracker Light Open](https://github.com/RealEye-io/webcam-eyetracker-light-open)（npm 包 `@realeye-io/webcam-eyetracker-light-open`），许可为 AGPL-3.0 或 RealEye 的商业许可。再分发或基于本项目改动时请注意 AGPL 的要求。
- [MediaPipe](https://github.com/google-ai-edge/mediapipe)（Apache-2.0）、[pdf.js](https://github.com/mozilla/pdf.js)（Apache-2.0）、[xterm.js](https://github.com/xtermjs/xterm.js)（MIT）、[node-pty](https://github.com/microsoft/node-pty)（MIT）、[KaTeX](https://github.com/KaTeX/KaTeX)（MIT）、[Qwen Code](https://github.com/QwenLM/qwen-code)（运行时按需安装，不随本项目分发）。
- Joy-Con HID 协议参考 [dekuNukem/Nintendo_Switch_Reverse_Engineering](https://github.com/dekuNukem/Nintendo_Switch_Reverse_Engineering)，HD 震动编码移植自 [tomayac/joy-con-webhid](https://github.com/tomayac/joy-con-webhid)。

Joy-Con、Switch 是任天堂的商标，iPhone、原深感是 Apple 的商标，本项目与它们没有关联。
