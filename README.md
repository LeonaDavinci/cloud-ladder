# 云端之梯（cloud-ladder）

three.js 立体场景小游戏：草地上的一张床、床边一架通到云端的梯子，可自由漫游 / 步行 / 自动巡游。

原工程位于 `C:\Users\star\Downloads\CFNetworkDownload_MgqDbK`（旧目录保留未动），此目录为迁出的正式工程。

---

## 运行

双击 `start-server.bat`，浏览器会自动打开 `http://localhost:8123`。

手动启动：

```bash
python serve.py 8123            # 绑定 0.0.0.0，局域网可访问
python serve.py 8123 127.0.0.1  # 仅本机
```

**不要用 `python -m http.server`。** 本机注册表把 `.js` 的 MIME 设成了 `text/plain`，浏览器会拒绝加载
`<script type="module">`（报 *Expected a JavaScript-or-Wasm module script...*）。`serve.py` 重写了
`guess_type()` 硬编码正确 MIME，并附带 `Cache-Control: no-store`（改完文件刷新即生效）。

手机 / 平板：控制台会打印局域网地址（形如 `http://192.168.x.x:8123/`），同一 WiFi 下可直接打开。

无构建步骤 —— 纯原生 ES module + `importmap`，three.js 已内置在 `vendor/`。

## 目录

```
index.html            入口（importmap + 三个模式按钮 + 时相/滤镜/雾档面板容器 + 底部「切换 UI」开关）
main.js               主入口：配置合并 / 组装 / 相机模式 / 时相面板 / 隐藏 UI 开关 / 渲染循环
scene.js              场景：噪声与地形高度场、天空、远景环山与远景云、共享运行时状态 RT
model.js              物品建模：草 / 花簇 / 薰衣草 / 白菊 / 床 / 梯子 / 蝴蝶 / 高光 / 云
postfx.js             屏幕后处理：bloom 泛光 + 四档梦核调色（+「原片」旁路）
atmosphere.js         时相：下午 / 清晨（大雾）/ 日落 / 夜间（月亮星空）+ 雾档切换
audio.js              BGM 播放器（3 首 CC0，启动固定放 audio.default 那一首）
                      + 碰云星铃 + 落到床上那声「噗」
style.css             界面样式
scene.json            场景结构：地形、光照、床、梯子、草丛、薰衣草、白菊、蝴蝶、云、
                      相机焦点（具名锚点 controls.target）、漫游路线 roam.route
config.json           调参覆盖层（只覆盖写了的键）；顶部 _说明 是中文查找表
config-bedscale1.json 预设：床缩放 1.0（A/B 对照用）
models/bed2.glb.json  床模型（**刻意**带一个假后缀：见「资源原样进包」那节）
vendor/three/         three.js r160 + OrbitControls / GLTFLoader / BufferGeometryUtils
                      + addons/postprocessing（EffectComposer / UnrealBloomPass / OutputPass…）
tools/                验证工具链（见下）
shots/                历次验证截图（split-ref-old / split-ref-new 是拆分前后同种子对照）
xhs/                  小红书笔记配图（3:4 / 1080×1440，由 tools/make-xhs-note-images.py 生成）
小红书笔记-云端之梯梦核.md  参赛笔记（标题 / 正文 / 话题标签 / 发布提醒）
.workbuddy/memory/    开发过程记录（踩过的坑、参数取舍）
```

### 三个 JS 的分工与依赖方向

```
scene.js   ← 不依赖本地模块，只 import three
model.js   ← import scene.js（取 terrainHeight / 贴图工厂 / RT）
main.js    ← import scene.js + model.js（组装、交互、循环）
```

单向，没有环。几条硬规则：

- **函数声明顺序不重要，模块级可变状态才重要。** 三个文件里没有「顶层立即执行的语句」
  依赖后文（`scene.js` 的 `SRGB2LIN` 之类 IIFE 只依赖自身），所以搬迁是纯粹搬家。
- **跨模块共享的可变量装进 `RT`**（`scene.js` 导出）。ES module 的 import 绑定**只读**，
  写不进去 —— 所以 `QUALITY` / `CLOUD_Q` / `PUFF_N` / `MOUND…` / `sun` 这些
  「构建期被写、运行期被读」的值统一记为 `RT.xxx`，谁要写就 `RT.xxx = ...`。
- **每个模块只导出真正被别的模块用到的名字**（`tools/check-imports.py` 可以核对闭合性）。
  导多了会造成「看起来能用」的假象，也让人读不出真实依赖。
- 想重新生成这三个文件：`python tools/split-main.py`
  （输入是 `tools/_main.before-split.js`，那份 3918 行的单文件是**拆分前的存档**，
  保留它既是为了可回归，也是这个脚本的输入）。

## 调参

改 `config.json`，刷新页面即生效。它是一层**覆盖**：只覆盖写了的键，其余沿用 `scene.json`，
JSON 写坏则整体静默退回（不会白屏）。

- 阳光：`sun.azimuthDeg / elevationDeg / intensity`
- 环境光：`ambient` / `hemisphere`
- 云：`cloud.size / radii / height / flatten / nearFade / insideFade`
- 云「活起来」：`cloud.wind.{dir, drift, rate, rot, rotRate, breathe, inner, gain}`
  —— 每片只围着自己的原位做小幅游移 + 自转 + 呼吸，`inner` 决定「只有内芯动、外圈几乎不动」，
  所以整朵云的大小形状不会变。**`gain` 是总增益**（0 = 完全静止，1 = 默认，1.5~2 = 明显翻滚），
  运行时实时读取，改完刷新即生效。
- 碰云（点击 / 轻触云，或镜头钻进云里）：`cloud.poke.*`
  —— 接触点周围**一个球范围内**的云片整片被推开（径向散开 + 一部分朝镜头扑出来），
  像在云上搓了个洞，随后由弹簧慢慢鼓回原位。
  - `radius` / `tapRadius`：影响球半径（米），默认 5.6（368 片里约 60~80 片）
  - `amount` / `tapAmount`：**速度系数**（不是直接位移），峰值位移 ≈ 0.63 × 它；默认 4.2 ⇒ 实测峰值 1.6~1.9 米
  - `minCount`：保底片数（默认 40），球内太稀时自动把半径撑到「第 40 近的那片」
  - `dirBias`：径向散开 与 朝镜头推 的配比（默认 0.55）。0 = 纯径向（洞张开但缺推动感），
    1 = 纯顺视线推（只改深度，玩家自己看不出来）
  - `inner` / `yScale`：权重窗口与竖直分量缩放
  - `spring` / `damp`：回弹手感。默认 `7 / 3.5` ⇒ ω≈2.65、ζ≈0.66：峰值在 0.43 秒后出现、
    约 3 秒慢慢回到原位（想更快就一起调大，想更「果冻」就把 damp 调小）
  - `maxRel` / `absMax`：单片位移上限（相对自身宽度 / 绝对米数），默认 `1.0 / 3.8`
  - `thin`：让被推开的云同时变透（默认 **0 = 关**。实测是反效果 —— 位移的可见变化集中在
    「四周被推得更厚更亮」，变透正好把它抵消掉）
  - `contact*` / `interval` / `travel` / `inside`：镜头钻进云团内部时自动让路的那一路
- 梦核 BGM：`audio.*`
  —— 页面启动就放 `audio.default` 指的那一首（默认 `bgm-1-everything`）并循环，
  左上角 ♪ 显示曲名、⏭ 换一首。**2026-09-28 之前是随机抽**，用户要求固定默认曲。
  `audio.default` 可写序号 / 文件名（可只写一段）/ 曲名，解析不出来退回第一首。
  曲子在 `audio/` 目录，**都是 OpenGameArt 的 CC0**（署名只是礼貌，不是义务）。
  2026-09-21 夜换过一轮曲库，现在是这三首（「产物读数」是**产物页**里
  `__audio.el.duration` / `readyState` 的实测值，不是估的）：

  | # | 文件 | 曲名 / 作者 | `gain` | 产物读数 |
  |---|---|---|---|---|
  | 1 | `bgm-1-everything.mp3.json` | everything (Ambient) / BlackSkirt | 1 | 33.3 s · rs 4 |
  | 2 | `bgm-2-dream-playground.mp3.json` | playground (dream) / Geisha | 1 | 13.24 s · rs 4 |
  | 3 | `bgm-3-dream-ambience.mp3.json` | Dream (Ambience) / TokyoGeisha | 1 | 194 s（VBR 读数，见下）· rs 4 |

  ⚠ 下面那段「gain 对齐到最安静那首」是**上一版四首**（*Somnium* / *Waking States* /
  *Dream Static* …）留下的说明；本轮三首都写 `gain: 1`，还没重新按 RMS 反算 —— 想让
  「⏭ 换一首」不忽大忽小，得拿 `tools/audio-levels.json` 再量一遍再反算。
  另外 **`.mp3.json` 这个后缀是刻意的、配置文件里就是这么写的，不要改名**（见「资源原样进包」）。

  ⚠ **`audition.html` 还停在上一版四首**：里面 4 个 `<audio src="audio/bgm-{1..4}-….mp3.xml">`
  现在**全是死链**（那四个文件已经不存在了），序号/时长/RMS 也都是旧曲目的。要修得先按新三首
  重测电平（`tools/audio-levels.json` 改一下 `files` 数组就能量），再改页面与页脚那张表。

  `volume` / `fadeIn` / `loop` / `tracks` 都在 config 里。浏览器拦截自动播放时按钮会变成
  「点击播放」，首次点击/按键会自动接上；曲子全都放不出来时用程序化和声垫底（不会变哑）。
  碰云的星铃音效在 `audio.sfx.*`。

  想单独试听这四首（不启动场景）：打开 **`audition.html`** —— 一个自带 `<audio controls>`
  的静态试听页，每首旁边写着作者、许可、时长和 gain 的来历。

  **`gain` 为什么不是 1**：这四首的原始电平差 10 dB（最响的 *Dream Static* 比最轻的
  *Dream Ambience* 高了 10.3 dB），而 `audio.js` 只用一个全局 `volume`，如果都写 `gain:1`，
  「⏭ 换一首」就会变成「音量忽大忽小」。所以 gain 一律按整轨 RMS **对齐到最安静的那首**反算：
  `gain = 10^((rmsRef − rmsTrack)/20)`，`rmsRef = −26.81 dBFS`（bgm-1）。反算完四首的峰值
  落在 0.30~0.41，离削波还有一大截。想整体更响就抬 `audio.volume`，**别去动 gain**
  —— 动了就把这套对齐破坏了。

  > 电平是量出来的，不是估的：`tools/audio-levels.json` 用 `decodeAudioData` 把每个文件整轨解出来，
  > 逐样本统计峰值和 RMS（Python 侧的 MP3 帧解析得到同样的时长，互为交叉验证）。
  > 顺便发现 bgm-1 的 `<audio>.duration` 报 194 s、真实只有 96.3 s —— 它是 **VBR 且没有 Xing 头**，
  > 而它**第一个帧**的比特率是 64 kbps（真实平均 128 kbps），浏览器的估算就用了首帧比特率：
  > 1539777 × 8 / 64000 ≈ 192.5 s。播放不受影响（解码按逐帧头走），只是 `duration` 这个读数不可信，
  > 所以别拿它做进度条或「还剩几秒」的显示。

  **`audio/` 里曾经有两条曲目其实是同一个文件**：`bgm-2-i-want-to-go-home.mp3.xml` 与
  `bgm-1-dream-ambience.mp3.xml` 的 md5 完全相同（都是 `db6c514c…`，1539777 B），
  也就是列表里写着两首、实际只有一首，「⏭ 换一首」换了等于没换。
  该重复文件已删除（内容原样保留在 bgm-1 里），曲位由 *Somnium* 顶上。

  > 曲目替换的验法：`tools/audio-verify.json` 逐首 `start(i)` 再等元数据，打印
  > `currentSrc / error / duration / readyState` —— 四首全部 `err:null`、`readyState:4`、
  > 时长与帧解析一致；`window.__errs` 为空，左上角标题正确显示当前曲名。
- 数量：`counts.*`（草、草丛、薰衣草、白菊、蝴蝶、高光）
- 尺寸：`sizes.*`（草高、`bedScale` 床缩放、花/蝴蝶/高光缩放）
- 草地：`grassColors.*`、`bedShadow.*`（床下暗色草环与接地阴影）
- 床边白菊：`daisies.clusters`（直接给世界坐标、铺展半径、疏密、尺寸）、
  `daisies.grow`（**整株长高倍率**，默认 1.3 —— 只拉长茎，花头大小/形状一点不变；
  和 `sizes.daisyScale` 不同，后者是等比放大整株、花头会一起变大）
- 床边留草距离：`bed.avoidMargin`（调大＝床边留一圈平整地，调小＝更野）
- **屏幕后处理（bloom + 梦核调色）**：`postfx.*`
  —— 管线是 `RenderPass`（线性 HDR，HalfFloat + MSAA）→ `UnrealBloomPass` →
  `OutputPass`（ACES + sRGB）→ 自定义 `GradePass`（调色/暗角/颗粒/扫描线/色散）。
  两个顺序不能动：**bloom 必须在色调映射之前**，**调色必须在色调映射之后**（原因见 `postfx.js` 顶部）。
  - `enabled`：总开关。`false` = 完全不建 composer
  - `default`：启动用哪档，`dream / liminal / vhs / white / off`
  - `samples`：MSAA。⚠ `antialias:true` 对 render target 无效，走 composer 必须自己开
  - `bloom` / `bloomScale`：泛光开关 / 泛光自身 RT 的缩放（0.5 更便宜更柔）
  - `presets.<档名>.{bloom,grade}`：数值覆盖入口。可调 grade 键见 config.json 的 `_说明`
  - `off` 档**不是参数全 0**，而是整个 composer 旁路（`renderer.render` 上屏），
    所以「原片」是真原片，低端机也有一键退回最快路径的出口
- **时相（下午 / 清晨大雾 / 日落 / 夜间月亮）**：`atmosphere.*`
  - `enabled` / `default` / `fogModeDefault`
  - `states.<档名>.*`：覆盖某一档的任意子集（`sun / hemi / ambient / fog / fogDense / sky / tint / bloom / orb / stars / label`）
  - **「下午」是空覆盖**＝scene.json 原样，所以加了时相之后默认画面和加之前逐像素一致（可回归）。
    它只额外给了一个 `fogDense`，为的是让「超大雾」按钮在任何时相下都有反应
  - `states.<档名>.bloom`：**按时相顶掉滤镜预设的 bloom 阈值**。必须有这一层 —— bloom 在线性空间取阈值，
    而各时相整体亮度差很远（清晨整片雾的线性亮度就有 0.7~0.95，用 0.62 的阈值等于把雾一起点亮，
    画面直接糊成白纸）。清晨给 0.95、日落 0.86、夜间放宽到 0.45
  - `states.<档名>.orb`：月亮/太阳。方位角要**绕开左上角的标题栏/BGM 与右上角的模式按钮**（面板已移到左下）；
    默认视野（相机 (16,9,30) 看**梯子中点** (0.975, 8.243, 1.551)）的中心方位角是 **−117.8°**、
    竖直半视角 28°、水平半视角 47°，所以天体放 −104° 附近、仰角 17~26° 最稳
    （焦点从云里的 (1.5,11.5,−2) 换到梯子中点之后，中心方位角由 −114.4° 变成 −117.8°）
  - `fogAnimMs`：换雾时 `near/far` 的过渡时长（默认 **2000ms**）。见下面「雾的渐变」
  - 四档的**具体数值**都写死在各自 JS 模块的 DEFAULTS/PRESETS 里（每个数字旁边都有「为什么是这个数」），
    JSON 只放开关 + 覆盖入口 —— 避免同一份数值抄两处、迟早不一致

### 雾的渐变（不是硬切）

`scene.fog.near/far` 一改，整片画面的雾量就跳一次；「超大雾」那一档 `far` 是 64，
硬切就是「啪一下世界没了」。所以换雾（**包括切时相**，每一档都有自己的雾）只登记「目标」，
由 `atmos.update(dt)` 在 `fogAnimMs` 内走 **smoothstep**（起收都平、中段快）过去：

```
t 0.0s → 2.333s：near 12.5 → 2.6   far 2600 → 64     （实测 140 帧 × 1/60s = 2333ms，一格不差）
```

**时长不是写死的数，而是两个旋钮算出来的**（用户同时要求「加速 50%」和「时长再增加 1 秒」）：

```
fogAnimMs(最终) = fogAnimMs ÷ fogAnimSpeed + fogAnimExtraMs
                = 2000 ÷ 1.5 + 1000 = 2333 ms
```

为什么不直接把 2333 写进配置：这两条要求方向相反，合出来的数在配置里看不出出处，
下次想「只保留加速」还得反算。拆成两个旋钮之后：`fogAnimSpeed: 1` = 不加速（回到 3000）、
`fogAnimExtraMs: 0` = 不加时（1000/1.5 = 1333）。三个键都在 `config.json` 的 `atmosphere` 下。

**「默认的小雾」= `scene.fog`**（只有「下午」这一档会用到它，其它时相各自写了自己的 near/far）。
本轮按用户要求把 near/far **双双减半**：`25 / 5200 → 12.5 / 2600`。⚠ 这一档主要管**远景**：

| 环山半径 | far 5200 时的雾量 | far 2600 时的雾量 |
|---|---|---|
| 2200（最近） | 42.0% | **84.5%** |
| 2950 | 56.5% | 越过 far ⇒ 100% |
| 3400（最远） | 65.2% | 越过 far ⇒ 100% |

所以观感上是「中远景整体被雾气洗淡、最远两圈山完全化进天空」，不是「近处变糊」——
近处（梯子/床在 30 米上下）只吃到 0.7% 的雾，几乎不动。要回调就改 `config.json` 的 `fog.near/far`。

三个必须注意的点：

| 点 | 说明 |
|---|---|
| **颜色不渐变** | 雾色属于「天光」，跟时相瞬时到位。慢慢变色会和同一帧里已经换完色的天空/云对不上 |
| **每帧要重算派生量** | 天体变淡（`veil`）、远云被抹掉（`applyCloudVeil`）都是被 `far` 驱动的，必须跟着走，不能只在切换时算一次 |
| **到位后必须真的停** | `t >= 1` 立刻 `return`：静止时不累计、不重算材质，等于零开销 |

`fogAnimMs: 0`（或 `fogAnimSpeed` 给到一个极大值再配 `fogAnimExtraMs: 0`）= 退回硬切。
**做「改动前后逐像素一致」的回归时要置 0**（或调 `atmos.settleFog()`），
否则每次取指纹都落在过渡中间。累加 `0.35 + 0.6 + 0.7` 会停在 `0.9999999999999999`，所以 `update` 里
有个 `> 1 - 1e-6` 就认到位的收尾 —— 否则 `animating` 会莫名多报一帧 `true`。

`main.js` 的渲染循环负责调它，位置在 `pokeStep` 之后、`step` 之前：

```js
if(atmos && typeof atmos.update === 'function') atmos.update(dt);   // 雾的 near/far 渐变
```

界面上的 `时相 / 滤镜 / 雾` 三行按钮**不写死在 HTML 里**，而是按 `atmos.names` / `postfx.names` 生成，
加档位只改配置、UI 自动跟着长。快捷键：`1–4` 时相、`5–9` 滤镜、`0` 原片、`F` 雾档。

### 夜间「死黑、加一点 blue」：改颜色配比，而不是抬强度

用户的原话是「夜晚的环境色有点死黑，稍微加一点 blue」。所以动的是 `atmosphere.js` 里
`night` 这一档的**颜色**，`intensity` 一律不动 —— 要的是「暗部不死黑、有冷调」，
不是「整体变亮」：

| 键 | 原来 | 现在 |
|---|---|---|
| `ambient.color` | `#33436e` | `#3f57c8` |
| `hemi.sky` | `#40548c` | `#485fd4` |
| `hemi.ground` | `#20293f` | `#1f3078` |

**踩过一次的坑（值得记）**：第一版给的是 `#3b56a0 / #4664b0 / #1f3860` —— 三个颜色的蓝通道
都确实抬了 45%~60%，但实测画面的三通道增量是 **R+2 / G+9 / B+7**，**绿涨得比蓝还多**，
观感上是「更亮、偏绿」而不是「更蓝」。原因：夜里画面 90% 是草地，而草地的漫反射色是绿的 ——
光一亮，绿通道被材质放大得比蓝猛。所以配比必须压成**蓝占绝对多数**（`#3f57c8` 的 B:G ≈ 2.3，
旧值是 1.6），让蓝的增量能压过材质对绿的放大。

实测（夜间 · 关滤镜，同一机位同一种子）：

| 区域 | 改动前 | 改动后 | Δ |
|---|---|---|---|
| 全图 | `#162331` lum 33.7 | `#162837` lum 37.4 | R 0 / G +5 / **B +6**，亮度 +11% |
| 远景山带 | `#172e23` lum 40.6 | `#163426` lum 45.2 | 亮度 +11% |
| 近景草地带（最黑的那一块） | `#091a0d` lum 22.1 | `#082113` lum 27.5 | **亮度 +24%** ← 「死黑」主要修的是这里 |

判据是**蓝通道的增量要 ≥ 绿通道**。这条不是审美问题：只要 B 落后于 G，哪怕三个颜色都更蓝，
画面也会往绿走。

### 爬梯速度：梯子和「上床」是两段，不能共用一个常数

`main.js` 的 `movePlayer` 里有两处用到同一个速度：

| 位置 | 是什么 | 本轮 |
|---|---|---|
| `P.state === 'ladder'` 时推进 `P.ls` | **沿梯子**上下（漫游的 `climbLadder` 也走这条） | `climbSpeed` 2.3 → **1.15**（用户要求慢 50%） |
| `P.state === 'bed'` 时抬 `P.foot` | 从梯顶/床边**爬上床面**那一段 | 拆出 `mountSpeed`，**保持 2.3** |

为什么必须拆：上床那一段只有一米多高，原速约 1 秒走完；跟着减半会变成两秒多的
「慢慢浮上去」，看着像卡住 —— 而用户说的「盘（攀）楼梯」只指梯子。
`mountSpeed` 不写时的默认值仍是 `climbSpeed`，所以老配置的行为不变。

实测（无头，`goto(1)` 进漫游的爬梯步 + 手动把 `P.state` 置成 `ladder`，取两点算
`ΔP.ls / Δ__dbg.time`）：

```
改动前  dLs 1.38 / dT 0.60 = 2.30    整梯 12.9m 需 5.61s
改动后  dLs 0.69 / dT 0.60 = 1.15    整梯 12.9m 需 11.22s
```

两段的开关都在 `config.json` 的 `walk` 下（`climbSpeed` / `mountSpeed`）。
⚠ 漫游路线第二步的 `max: 45` 是超时保护，爬梯从 5.6s 变成 11.2s 之后仍然远在安全线内 ——
但**以后若再把梯子加长或再减速，要回头看这个 45**。

### 云朵的「投影板」：隐身要靠 `colorWrite`，不能靠 `visible`

每片体积云底下都挂了一块投影板（`CircleGeometry`：在草地上投出云影）。它的材质叫
「不可见的投影平面」，但**只取名不可见** —— 它是个正常的 `MeshBasicMaterial`，
朝向太阳、`side: BackSide`、`renderOrder: 10`。相机绕到云的另半边就会看到它的背面，
于是 360 块板一起画在云片之上。夜间尤其明显：板是构建期烘死的白天粉、**没进时相染色表**，
而云片已经被染成冷蓝，实测板 `#ae6595`（lum 0.855）vs 云片 `#69578e`（lum 0.508），
亮 1.68 倍 —— 画面上就是云里散着一道道浅粉细长亮条，还会被夜间放宽到
`threshold 0.45` 的 bloom 放大。

修法是给材质加 `colorWrite: false`。**为什么不能图省事写 `visible = false`**：

| 写法 | 结果 | 源码位置 |
|---|---|---|
| `plate.visible = false` | 阴影一起没 | `vendor/three/three.module.js:22583`，`WebGLShadowMap.renderObject` 第一行就 `return` |
| `plate.material.visible = false` | 阴影一起没 | 同文件 `:22619`，`else if (material.visible)` 判完才 `getDepthMaterial` |
| 挪到别的 `layers` | 阴影一起没 | `:22585` 用的是 `object.layers.test(camera.layers)`，那个 camera 是**主相机** |
| **`material.colorWrite = false`** | 主画面不写色，阴影照投 | 深度材质由 `getDepthMaterial` 克隆，只拷 `visible/side/map/alphaMap/alphaTest/clipping/displacement`，**不拷 `colorWrite`** |

也就是：**在这套渲染器里「可见性」同时是阴影投射的开关**，拿它当「只在主画面里隐藏」用必然误伤。
`colorWrite` 是唯一只作用于主画面那一趟的开关（`setMaterial` → `colorBuffer.setMask`，
`vendor:23444`）。

实测可见区间（相机绕云水平轨道 r=34、夜间、postfx 关）—— 这是「在**另一些角度**才出问题」的原因：

| 方位角 | 被画出的板 |
|---|---|
| 0° / 15° | 0 |
| **30°** | 108（过渡带） |
| **45° ~ 210°** | **360 / 360（全部）** |
| 225° | 8 |
| 240° ~ 345° | 0 |
| 默认首屏（reset 位姿） | **141 / 141** ← 一进夜间就已经中招 |

改前 / 改后逐像素（冻结时钟 + `--force-prefers-reduced-motion`，同一次构建只差这一行）：

| 机位 | 差异像素 | 云区整体亮度 |
|---|---|---|
| 夜间 az 0°（板本来就被背面剔除） | **0** | −0.00% |
| 白天 az 0°（同上） | **0** | — |
| 夜间 az 90° | 786（关滤镜）/ 1708（dream） | **−0.39%** |
| 夜间 az 135° | 452 | 未量（同区间，未取区域读数） |
| 夜间默认首屏 | 22（关滤镜）/ 80（dream） | −0.02% |
| 白天 az 90° | 7 | —（板与云同色，白天肉眼几乎无差） |

两个「0 差异」是这一轮最有价值的读数：它证明修法**只在有 bug 的角度起作用**，云的整体观感没动
（不是靠「把云调暗」蒙过去的）。另一个硬判据是**阴影贴图**：`sun.shadow.map` 是 4096²，
在夜间 home / az90 / az0 与白天 az90 四处取样 256² 的字节校验和，
改前改后**四下完全相同**（夜 `1598084875`、日 `2178895082`）⇒ 阴影一个像素都没变。

⚠ 已知代价：主画面里这 360 次 draw call 变成纯空转（`renderer.info.render.calls` 仍是 771）。
要省掉得把 360 块板并成一个合批 Mesh，但那样它们就没法跟着风逐片改位置/缩放了 —— 属于另一件事。

```bash
# 复现「哪些角度会漏」（改前 tools/cloud-plate-scan.json，改后 tools/cloud-plate-fix.json）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html?v=67" shots/_x.png tools/cloud-plate-fix.json
# 冻结时钟才有逐像素意义（否则云的「风」在动，两次截图不可比）
PRE="$(cat tools/freeze-pre.js)"; CHROME_ARGS_EXTRA="--force-prefers-reduced-motion" PRE_SCRIPT="$PRE" \
  $NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html?v=67" shots/plate-after/_p.png tools/cloud-plate-fix.json
$PY tools/png-stats.py --diff shots/plate-before/az090-off.png shots/plate-after/az090-off.png
```

### 云的「暗面」：按本档光源重算，且只压背光面

用户报的两个现象是同一件事的两面：**日落和夜间的云立体感不强、背光面的颜色太亮**。
拆开是三个独立原因叠在一起：

| # | 原因 | 证据 |
|---|---|---|
| ① | 每片云的 `lit`（0 背光 / 1 向阳）是**构建期**用**默认时相**的太阳方向烘死的，之后永不重算 | `model.js buildCloud` 的 `SUN_DIR` 来自 `main.js` 建场景那一刻的 `L.sun.position` |
| ② | 三个时相的光源方向**各不相同**，所以烘死的那份「哪面算暗面」对日落/夜间都是错的 | 实测归一化方向：下午 `[-0.5603, 0.7253, 0.4001]`（仰角 46.5°，走 config 的 `sun.position` 矢量）、日落 `[-0.8667, 0.1908, -0.4608]`、夜间 `[-0.221, 0.4067, -0.8864]`（24°，走 `posFromAzEl`） |
| ③ | tint 是**朝目标色 lerp**，把片与片之间的明暗差按 `(1-cloudMix)` 等比压扁 —— 夜间 `cloudMix 0.78` ⇒ 只剩 **22%** 的对比 | 这才是「夜里云几乎是一块平色」的机制；单靠加大 `lit` 的调制强度救不回来（会被同一层 lerp 一起压掉） |

① 的修法是 `shadeCloud(dirWorld, S)`（`model.js` 导出 → `atmosphere.apply()` 回调 →
`main.js` 的 `paintCloud` 接线）。方向取**本档的平行光位置**：夜间那一盏就是月亮，
所以「背光面」永远等于**月亮照不到的那面**，把月亮挪到别的方位角它自己会跟着转
（实测 `night.sun.azimuth` −104 → −40：`lit` 分布整体挪位、暗面片数 132 → 143、
整体亮度 +18.5% —— 暗面转走了）。日落同理，用的是落日那盏的方向。

③ 决定了压暗**必须叠在 `setTint` 之后**，而且必须**幂等**（时相来回切、探针反复调
都不能「越压越黑」）。做法是染色表多存一份 `tintColor` 快照
（`scene.js regTint` 建、`atmosphere.js setTint` 刷新），每次压暗都从快照重算。

参数写在时相表的 `cloudShade: { backDark, hinge }`：

```
k = 1 - backDark * smoothstep( (hinge - lit) / hinge )     // 只在 lit < hinge 时压
lit ≥ hinge  ⇒  k ≡ 1  ⇒  颜色**逐位不变**
```

`hinge` 是「精准执行」的关键：要的是**压暗背光面**，不是「把云整体调暗」。
第一版用的是 `lit^curve` 幂次映射，读数里亮面档也被压了 4~8%（整体 −12%）——
亮面不该动。换成 hinge 后：

| 档 | `cloudShade` | 暗面档 lit<0.34 | 中间档 | 亮面档 lit>0.67 | 云整体 | 逐位不动的片 |
|---|---|---|---|---|---|---|
| 下午 | 无 | — | — | — | **0%** | **360 / 360** |
| 日落 | `0.26 / 0.78` | **−22.7%** | −7.3% | **−0.14%** | −9.1% | 101 |
| 夜间 | `0.38 / 0.80` | **−32.1%** | −12.2% | **−0.43%** | −15.1% | 64 |

逐像素（冻结时钟 + `--force-prefers-reduced-motion`；**同一次运行内**只切 `cloudShade`，
所以差异只可能来自它）：

| 机位 | 差异像素 | 画面整体亮度 |
|---|---|---|
| **下午 · 首屏** | **0** | 0（新通路在不开时一个字节都不写） |
| **下午 · 侧面** | **0** | 0 |
| 日落 · 首屏 | 19214（2.4%） | −8.3% |
| 日落 · 侧面 | 13481（1.7%） | −8.0% |
| 夜间 · 首屏 | 30334（3.8%） | −11.7% |
| 夜间 · 侧面 | 23932（3.0%） | −11.3% |

两个「0 差异」和 `untouched: 360` 是这轮最有价值的读数：它证明这条新通路在没配
`cloudShade` 的档里**完全不写颜色**（不是「压得很小所以看不出来」）。

⚠ **坑（配置被静默丢掉）**：时相表在 `createAtmosphere` 里是**白名单**字段构造的
（`states[k] = { label, sun, hemi, …, cloudShade }`），不是 `Object.assign` 全量摊平。
往 `DEFAULTS` 的某一档加新字段时，必须同时在那段字面量里补一行 —— 否则**不报错、
不警告，只是读不到**。第一版就是这么废掉的：探针读到 `sunset:none, night:none`、
云的暗面一个像素都没变，症状极像「参数给得太小」。

调强弱改这两个数就够（能热改：改完 `__dbg.atmos.states.night.cloudShade.backDark`
再 `__dbg.atmos.apply('night')` 一次即可）：`backDark` 越大暗面越黑；
`hinge` 越接近 1 参与压暗的云片越多。

### 云朵随时相的环境色混合：一个「快照别名」bug + 一个 `backMix` 旋钮

用户报的现象是「切换时相时，云朵的几层背面颜色没有变化：早晨、傍晚、晚上，
应该随着环境色做一些混合」。探针（`tools/cloud-phase-color.json`）一跑就发现
它不是「变化太小」，而是**体积云的色相一个时相都没动**：

| 时相 | 360 片均值 | 说明 |
|---|---|---|
| 下午 | `#dbaec8` | 构建期原色（这一档没有 tint） |
| 清晨（修前） | `#dbaec8` | **与下午逐位相同**，而配置写着 `cloudMix 0.62` |
| 日落（修前） | `#d2a7bf` | = 原色 **× 0.909** |
| 夜间（修前） | `#cba2ba` | = 原色 **× 0.85** |

后两行是**纯灰度缩放**（三个通道等比、一点色相没挪）。远景云不过这条通路，
所以它们是唯一正常随时间变色的那些（`#c0c4e8 → #c8d1e7 → #c5a7c6 → #64698a`）——
「为什么只有体积云不对」的答案就在这里。

**根因：`shadeCloud` 每帧把刚染上的时相色又覆写回构建期原色。**
它从 `m.userData.__tintColor` 取「干净的本档颜色」重算（这是「幂等」的实现方式），
但那份快照原先只挂在染色表的**条目对象**（`it.tintColor`）上 ——
材质上的 `__tintColor` **从来没有人写过**。于是
`m.userData.__tintColor || m.userData.__tintBase` 永远走后半截：
`setTint` 刚写好的颜色被 `copy(__tintBase)` 抹掉。清晨那档 `cloudShade` 是 `null`
（k ≡ 1），所以它的 360 片与「下午」**逐位相同** —— 这条读数比「看起来差不多」硬得多。

修法是**一处引用**：`regTint` 里把同一个 `THREE.Color` 实例同时挂到 `it.tintColor`
和 `mat.userData.__tintColor`。教训：**「快照」必须让读的一方与写的一方看到同一个对象**，
而不是各存一份 —— 否则读的那一侧会静默回退到一个看起来同样合理的值。

**新增 `backMix`：暗面朝本档环境色 lerp。** 用户要的「随环境色混合」是另一件事：
纯乘标量只会让暗面「同色变暗」，而背光面只吃到环境光 —— 它的**色相**应该就是环境光的色相。

```
w = smoothstep((hinge - lit) / hinge)          // 「这一片有多背光」0..1
颜色 = tintColor · (1 - backDark·w)，再 lerp(环境色, backMix·w)
```

`backMix` 乘的是**同一个 `w`**，所以 `lit ≥ hinge` 的片依旧逐位不动（w = 0 ⇒
既不压暗也不混色）—— 「只压背光面」这条规矩在新旋钮上继续成立。
环境色**不需要新配一个色**：`atmosphere.apply()` 把本档的 `ambient.color` 直接传给
`paintCloud` → `shadeCloud(dir, S, envColor)`。所以以后调夜间 ambient 的蓝，
云的暗面会自己跟着变（这一轮刚给夜间加过 blue，正好接上）；要一个不跟随 ambient 的色，
写 `cloudShade.backTint` 顶掉它。

清晨原先**完全没配 `cloudShade`**，而它的 `cloudMix 0.62` 把片间对比压到只剩 38%，
暗面与亮面糊成同一片浅蓝白。现在补上四档里最轻的一档 `{0.20 / 0.84 / 0.50}` ——
清晨的云底是「更冷的灰蓝」而不是「更暗的白」，所以压得少、混得多。

修后读数（同一机位、冻结时钟、`postfx off`）：

| 时相 | `cloudShade` | 360 片均值 | 最背光的 15% | 暗/亮 比 (R,G,B) | 环境色 | 逐位不动的片 |
|---|---|---|---|---|---|---|
| 下午 | 无 | `#dbaec8` | `#b97fa6` | 0.50 / 0.31 / 0.47 | — | **360 / 360** |
| 清晨 | `0.20 / 0.84 / 0.50` | `#d6d1e3` | `#cecddf` | 0.85 / 0.91 / 0.92 | `#d5dcef` | 58 |
| 日落 | `0.24 / 0.78 / 0.40` | `#e9b2b2` | `#e09c96` | 0.85 / 0.62 / 0.55 | `#ff9d84` | 101 |
| 夜间 | `0.36 / 0.80 / 0.46` | `#6e669f` | `#5556a4` | 0.43 / 0.53 / **1.08** | `#3f57c8` | 64 |

比值的读法：**三个通道的比越不均匀，混进去的环境色越明显。**
夜间 B 通道 1.08 > 1（暗面的蓝比亮面还高）就是「月光只照亮环境、照不到云」的样子；
日落相反 —— R 保住 0.85 而 G/B 掉到 0.62/0.55，暗面带上了落日的暖。
下午那档的三通道比就是构建期烘死的那套，一个像素没变。

逐像素（冻结时钟、同一机位、**只换代码**）：下午整帧 **0 差异 / 最大通道差 0**，
清晨 42621 像素 / 81，日落 42420 / 60，夜间 44826 / 103。
那个下午的 0 差异是关键 —— 它证明整档没配时这条通路确实一个字节都不写，
本轮变化全部落在配了 `tint` 的三档上。

调强弱（都能热改，改完 `__dbg.atmos.apply(档名)` 一次生效）：
`backDark` 暗面有多暗 · `hinge` 越接近 1 参与的片越多 · **`backMix` 混多少环境色**
（0 = 退回「纯变暗」的旧手感）· 整体色相与混合强度改 `tint.cloud` / `tint.cloudMix`。

### 相机焦点：写锚点，不要抄坐标

`controls.target` 是自由模式的环绕焦点 —— 也就是**画面正中被谁占住**。默认要「一眼看到梯子」，
所以焦点取梯子中点：

```jsonc
"controls": { "target": "ladderMid" }           // 等价写法： "ladderTop" / "ladderFoot" / "bed" / "cloud" / [x,y,z]
```

为什么不是直接写 `[0.975, 8.243, 1.551]`：这个坐标是**算出来的** ——
它同时取决于 `ladder.length`、`ladder.rotation`，以及床高（`ladder.bottom[1]` 写 `null` 时梯脚吸附到床面）。
手抄一个坐标进 JSON，改一次梯长或床高，焦点就变成对着空气看，而且**画面不会报错**，只会静悄悄地偏掉。
锚点在 `build()` 里 rig 造好之后解析（`resolveViewTarget`），名字写错/算不出来时保持默认值、不崩。

两个容易踩的点：

- **必须在 `setupModes()` 之前落位**：它构造时会把 `controls.target` 抄进 `orbitAim`（「切回自由模式时环绕中心放哪」的初值）。
  不过这个初值只在**还没进过漫游/步行**时算数 —— `applyCamera()` 每帧都会把 `orbitAim` 改成
  「当前视线上前方 12m 那个点」，所以从第一人称切回自由是「继续看你刚才看的方向」，不是硬拉回梯子中点。
  一句话：**配置里的焦点 = 首屏 + 自由模式下的取景中心**；漫游/步行有自己的朝向系统。
- `controls.update()` 只重算朝向：相机的**世界位置不动**（它按 `position − target` 反推球坐标），
  所以换焦点不会把镜头拉远拉近。实测桌面 1264×625：焦距 35.22 → **32.18**（后者正好是
  相机到梯子中点的距离），梯子中点投影到屏幕 **(632, 312)** ＝ 画面正中 (632, 313)。

验证「焦点到底落没落在梯子上」，别靠肉眼估 —— 把世界点投影到屏幕坐标看数值：

```js
var v = new __dbg.THREE.Vector3(0.975,8.243,1.551).project(__dbg.camera);
[Math.round((v.x*0.5+0.5)*innerWidth), Math.round((-v.y*0.5+0.5)*innerHeight)]   // → [632, 312]
```

### 漫游：爬到梯顶之后，按「跳」翻下身落到床上

`roam.route` 的最后两步是这么接起来的（`scene.json`）：

```jsonc
{ "hold": true, "onJump": true, "look": "bed",    "hint": "爬到顶了 · 点「跳」翻下床" },
{ "leap": "bed", "leapOff": [0.15, -0.8], "rise": 4.6, "look": "bed", "hint": "翻个身，落到床上" },
{ "wait": 2.6, "look": "bed", "hint": "落在床上了" }
```

- `hold` 本来是「永远不完成」的一步（它就该一直停着）。`onJump: true` 是唯一的例外：
  **停下等人按跳**，按了才放行。
- `leap` 用一条**真抛物线**，不是匀速插值：`rise` 给上抛初速，之后交给重力，
  所以起跳会先窜半米再落下去 —— 一眼能看出是「跳」而不是「飘」。
  飞行时长由 `rise` 与落差解出（`y(t) = 落点高度` 的正根），水平方向匀速，
  落地精确贴合落点并写 `landT` ⇒ 摄像机做一次**落地微蹲**（和步行模式同一套）。
  实测轨迹：`u=0.28 → 14.68m / vy −2.6`、`u=0.63 → 11.13m / vy −11.6`、`u=0.98 → 3.08m / vy −20.6`，
  落地 `foot = 2.582` ＝ 床面，落点 `(−1.85, 0.40)`（床心 + `leapOff`），`onBed: true`。
- `leapOff` 是必要的：默认锚点 `bed` 是床面正中，而**梯脚正是从床心长出来的**，
  落点正好卡在两条梯轨之间。往床里侧让开 0.8m，落点干净、也看得出「翻到了床上」。
- `wait: 2.6` 那一步是「落地后站一会儿」。没有它，落地瞬间就进下一步把镜头甩向梯子，
  人只瞥见一眼床垫 —— 看不出「落在床上了」。这一步的 `look` 也取 `bed`（往下看自己站的地方），
  下一步才抬头看梯子；`aimCamera` 的指数平滑会把这个 110° 的抬头做成一段转向，不是硬切。

**跳跃请求要有纪律**（`routeTick` 末尾）：

```js
if(!st.onJump && !st.leap) jumpReq = false;   // 其余步骤一律丢弃
```

不丢弃的话，爬梯途中手贱点一下，请求会一直活到下一个 `hold` ——
于是**每次爬到顶都自动往下跳**，看起来像有人一直按着跳。反过来，`leap` 进第一步就把请求吃掉，
不然飞行途中再点两下会溢到下一轮。实测四种边界（`tools/roam-guard.json`）：
爬梯途中按跳＝丢弃（`step` 仍是 1、`ls` 继续涨）；不按就一直等（不会自己走）；
空中连点两次不多跳；落地后停在床上等人、2.6 秒后回第一步。

### 漫游演完了要自己收尾：切步行；「复位」把一切推回开场

漫游是一条**一次性的演出**，演完不接管就会卡在「最后一站的 `hold` 上永远不动」——
人已经站在床上了，却既不能走也不能跳。所以最后一站结束时自动交还给步行：

```js
// routeTick() 末尾
if(routeDone(st) || run.t > mx){
  const ended = run.i >= route.length - 1;     // 本来就在最后一站 ⇒ 这是它结束的那一次
  run.i = (run.i + 1) % route.length; run.t = 0;
  stepHint(route[run.i]);
  if(ended && ROAM.autoWalk !== false){ setMode('walk'); return; }
}
```

- **挂在「最后一站结束」而不是「`leap` 落地那一帧」**：`leap` 之后还有 `wait: 2.6` 的停顿和
  台词「落在床上了」。落地就切会**吞掉这句台词**，人也看不清自己是怎么落下来的。
- `setMode('walk')` 后必须**立刻 `return`**：本帧剩下的代码还会用漫游的输入去 drive 一个
  已经不属于漫游的角色，会多推一帧。
- 开关是 `scene.json` 的 `roam.autoWalk`（默认 `true`）。`false` ⇒ 演完停在床上等人自己点，
  方便逐帧盯着看最后一站。调试口 `__rig.autoWalk` 读得到当前值。

**复位按钮**（`#reset-btn`，位于「漫游」**之前**，右上按钮组的第一格）：

```js
const HOME = { pos: camera.position.clone(), target: controls.target.clone() };  // setupModes() 里取

function resetView(){
  if(mode !== 'free') setMode('free');      // 先认回到自由模式，否则相机归位了角色还在床上
  P.x = 0; P.z = 0; P.foot = 0; P.yaw = 0; P.pitch = 0; P.vy = 0;   // 角色位置/朝向/速度
  P.state = 'ground'; P.ls = 0; P.lsq = 0; P.landT = 0;             // 爬梯进度、落地微蹲
  run.i = 0; run.t = 0;                                            // 漫游进度回到第一站
  leapS.on = false; leapS.landed = false; leapS.t = 0;             // 抛物线清零
  jumpReq = false;                                                 // 丢掉排队中的跳跃请求

  camera.position.copy(HOME.pos);
  orbitAim.copy(HOME.target);                                      // 每帧平滑用的目标也一起写
  controls.target.copy(HOME.target);
  const damp = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();          // ① 先把上次拖拽残留的 sphericalDelta 吐掉（相机会被甩到别处，无所谓）
  camera.position.copy(HOME.pos);   // ② 把位置写回去，再 update 一次才算「按 HOME 精确定位」
  controls.target.copy(HOME.target);
  controls.update();
  controls.enableDamping = damp;
  refreshHint();
}
```

两个坑，都是实测踩出来的：

1. **OrbitControls 复位必须 `update()` 两次。** 源码里 `enableDamping = false` 时那一帧是
   `spherical.theta += sphericalDelta.theta` —— 把余量**整体相加**（不是丢弃），下一次
   `update()` 才把它清零。所以只调一次，等于「走完上次拖拽的残留」：相机半径对、**方位角全错**。
   实测单次 update 得到 `posErr 26.48`（相机停在 `[-8.05, 9, 32.43]` 而不是 `[16, 9, 30]`）、
   `targetErr 0` —— 目标点是对的，只有相机跑偏，很容易误判成「复位没生效」。
   改成两次之后 `posErr 0 / targetErr 0 / exact true`。
2. **复位按钮用 `data-act`，不能挂 `data-mode`。** 模式按钮是
   `document.querySelectorAll('.mode-btn')` 一把抓的，不加 `.filter(b => b.dataset.mode)`
   去过滤，点复位会走 `setMode(undefined)` ⇒ 三个模式的 `.active` 全灭、`controls.enabled = false`，
   镜头彻底锁死；而画面上只表现为「点了没反应」。
3. `HOME` 取的是 `setupModes()` 那一刻的 `controls.target`（已经解析好的锚点），
   **不是 `orbitAim`** —— 后者被每次拖拽改写，拿它当基准复位会复到「上次拖哪儿算哪儿」。

顺带给「复位」配了快捷键 **R**。实测（`tools/reset-autowalk-lock.json`）：
四个按钮矩形为 `复位[966,17,1030,50] / 漫游[1038,18,…] / 步行[1110,…] / 自由[1182,…]`，间距 8px；
`goto(3)` 走完 → `leap.landed`（`foot 2.582 == bedTop 2.582`）→ 自动 `walk`
（`onBed true`、`jumpBtnOn true`、`#sticks` z-index 15）；点复位后 `step 0`、`mode free`、`posErr 0`。

```bash
# 复位 + 自动切步行 + 禁缩放/禁文字选择，一次全跑（产出 tools/reset-autowalk-lock.json 的那个脚本）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/?v=67" shots/_rz.png tools/reset-autowalk-lock.json

# 产物 zip 的行为回归（4 张冻结截图 + 逐项读数 + 两两逐像素比对）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/?v=67" shots/_mt.png tools/minitool-behavior.json
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/dist-minitool/index.html" shots/_mt2.png tools/minitool-behavior.json

# 渲染预算（桌面档 / 移动档 ?mobile=1）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/?v=67" shots/_wb.png tools/webgl-budget.json
```

### 界面布局：标题左上、控制左下、底部正中是「切换 UI」

```
┌ 云端之梯 #梦核 ───────────  复位 漫游 步行 自由 ┐
│ 拖拽旋转 · 滚轮缩放 · 右键平移 · 点击云朵戳一下     │
│ [♪ BGM]                                        │
│                                                │
│                      时相 · 清晨（超大雾）  ← 一次性反馈，1 秒后自退 │
│ 1–4 时相 · 5–9 滤镜 · F 雾档 · 0 原片   ← 图例挂在上方 │
│ [时相][滤镜][雾] ← 左下贴底        [隐藏 UI] ← 正中贴底   [跳] ← 右下 │
└────────────────────────────────────────────────┘
```

- **标题栏**（`.overlay` + `#bgm`）在左上角，两者装在同一个 `#hud-tl` flex 竖列里。
  为什么不各写各的 `top`：「#梦核」标签在窄屏会换行、字号在移动断点又会变，标题块高度不是常数，
  两个 `fixed` 元素各写各的 `top` 迟早叠上；放进同一个竖列后「标题在上、BGM 在下」由布局保证。
- **控制面板**压在左下角 `bottom:6px` —— 这已经是能压的最低处（留 6px 免得胶囊的描边/投影贴到窗口边上）。
  之所以只能到这里：面板里原本最后一行是「1–4 时相 · 5–9 滤镜…」那行小字，它在最底下占 17px，
  三排按钮就永远悬在它上面。**把那行小字挪到三排按钮上面**（DOM 顺序也一起改）之后，
  最底部这一行才真正是按钮 ⇒ 按钮整体又下移了 24px（`bottom` 30 → 6）。
  小字放在上方反而是更正确的读法：它是「下面这几排各自对应哪几个键」的图例。
- **底部正中是「切换 UI」开关**（`#ui-toggle`，`bottom:10`、`z-index:30`）。点一下把界面上所有
  按钮/面板/提示收起来，只留左上角标题（`云端之梯` + `#梦核`）和它自己；再点一下全部还原。
  按钮文案就是「这次点击会做什么」：看得见时写**隐藏 UI**，收起后写**显示 UI**（两个 `span`
  由 `body.ui-hidden` 二选一显示，另配 `aria-pressed` / `aria-label`，否则读屏会把两段连起来念）。
  收起后它自己`opacity` 降到 0.4 —— 不藏（藏了就没有恢复的入口），但也不在纯净画面里抢戏。

  **为什么放在屏幕正中**：左下有面板、右下有「跳」，只有正中是空的；而这个开关是「总管所有面板」
  的，逻辑上不属于任何一块 —— 并进左下角会让人以为它只管时相/滤镜那三排，并进右上角又像只管模式。

  **实现是给 `<body>` 挂一个 class，不是逐个元素改 `style.display`。** 这些元素的显隐各有各的主：
  `#jump-btn` 靠 `.on`、`#mode-hint` 靠内联 `opacity`、`#scene-ui` 的按钮靠 `.active`、摇杆靠
  `.stick.on`。直接写 `display` 会跟那些逻辑打架（切模式时 `.on` 又把按钮显示回来），「还原」时
  还得反推「它原本该不该显示」。挂 class 是纯 CSS 层的一次性覆盖（`style.css` 里那一组 `!important`），
  逻辑类照旧切换、状态一点不丢，摘掉 class 就是原样 —— 实测：漫游下收起再还原，`#jump-btn` 从
  `grid → none → grid`，`display` 值逐项与收起前完全相同。

  `!important` 在这里是**必须**的，不是图省事：`#mode-hint` 的 `opacity` 由 `main.js` 每帧写内联样式，
  普通选择器压不住内联。

  另外：`?ui=0`（也认 `off` / `hide`）直接以收起状态开场，方便截图与分享；快捷键 **H** 开关，
  且**收起后 `1–4` / `5–9` / `F` / 空格仍然有效** —— 隐藏的是显示，不是能力（实测收起态下按
  `3` / `8` / `f`，`atmos.state` / `postfx.name` / `fogHeavy` 照常变化，`window.__errs` 为空）。
- **底部正中不再有常驻说明文字**。`baseHint()` 一律返回空串：自由模式那句「点击云朵可以戳一下 · 拖动旋转 · 滚轮缩放」、
  步行模式那一长串走法都去掉了（空串 = 不显示）。保留下来的两种：
  一次性反馈（切时相/滤镜/雾档、戳云 → `flashHint`，1 秒后自己退场）与漫游台词（`route[].hint`）。
  步行/漫游的用法改挂到模式按钮的 `title` 上（悬停可见），不占画面。
- 面板 `z-index:20` 高于提示条 `z-index:18`：窄窗口里万一横向擦上，也是面板压在上面。

摆位置前先把**常驻元素的矩形量出来**再决定，别靠目测（`#jump-btn` 只在漫游/步行才可见，
自由模式下量到的是 `[0,0,0,0]`，那一刻的「不相交」是假通过）：

```bash
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html" shots/_u.png tools/ui-final.json
# ↑ 一次 eval 把所有元素的 getBoundingClientRect() 打出来 + 两两相交判断（free 与 roam 各量一遍，
#    因为 #jump-btn 只在漫游/步行才可见）
```

实测（改完这一版）：桌面 1264×625 —— 标题 `[18,16,304,68]`、BGM `[18,78,273,109]`、
面板 `[18,503,336,619]`（= `bottom:6` ✔，最底下一排是「雾」`[18,591,336,619]`，图例 `[18,503,336,513]` 在最上）、
跳按钮 `[1156,513,1238,595]`、**切换 UI `[589,583,675,615]`**（正中、离底边 10）；
移动断点 500×749 —— 标题 `[10,10,274,36]`、BGM `[10,63,242,92]`、
面板 `[10,560,293,645]`（= `bottom:104` ✔）、跳按钮 `[412,657,484,729]`、**切换 UI `[212,708,288,737]`**。
相交判断只报出父子包含关系（`panel×tip` / `panel×rowFog` / `hud×overlay` / `hud×bgm` / `×#sticks` 这个
全屏透传层），**真正的碰撞一对都没有**，`window.__errs` 为空。
移动断点下「切换 UI」与「跳」在竖直方向重叠（`708..737` vs `657..729`），但横向 `288 < 412` 完全让开 ——
这两个数都是量出来的，加宽按钮或加大字号前先重量一遍。

> ⚠ **别用负的 `bottom` 去「再往下挪一点」。** 面板高 117px，`bottom:-10%` 在 1264×625 的窗口里
> 等于整块往下推 62px，实测面板底边落在 `y=688`（视口只有 625）——「滤镜」「雾」两排**完全在屏幕外**，
> 看上去就像按钮丢了（只有「时相」那排还露着）。`bottom:6px` 才是「贴着底边还能看见」的极限；
> 想再低只能先把面板做矮（比如三排并两排），不是改这个数。

移动断点**不能跟着压到底**，仍是 `bottom:104px`：右下 `#jump-btn`（`bottom:20`、72px 见方）
在漫游/步行时会出现，窄屏下它的左沿会伸进面板的横向范围，只能靠竖直方向让开 ——
面板底边要留在跳按钮顶边（离地 92px）之上。所以「再往下压」这件事只在桌面断点成立，
这是量出来的取舍，不是没跟着改。

> ⚠ 无头 Chrome 的窗口宽度**有下限**：传 `--window-size=390,844` 实际会得到约 500×749，
> 所以验证 390px 断点时量到的是 500px 的布局。断点本身仍会触发（500 < 520），结论可用，
> 但别把量到的坐标当成 390px 下的坐标。

想看某个参数的实际生效值：控制台执行 `window.__dbg.config`。

预设切换：`index.html?config=config-bedscale1.json`（不写就是 `config.json`）。

## 验证工具（无需人工盯屏）

```bash
NODE=C:/Users/star/.workbuddy/binaries/node/versions/22.22.2-3/node.exe
PY  =C:/Users/star/.workbuddy/binaries/python/versions/3.13.12/python.exe

# 无头浏览器按脚本操作并截图（步骤文件见 tools/*.json）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/" shots/out.png tools/verify-tuft-color.json

# 床的顶点 AO：一次会话里轮播多组参数，逐组出「AO 图 + 原材质」两张 + 亮度统计，
# 最后拼成一张对照条带（tools/_ao-variants.json 由烘焙器的 --emit 生成）
$NODE tools/_probe_bed_ao.mjs tools/_ao-variants2.json sweep
# 床近景实拍（真实场景 + 后处理，所见即所得），配合换 GLB 做前后对比
$NODE tools/_shot_bed_hero.mjs ao

# PNG 区域取均值 / 两图差异
$PY tools/png-stats.py shots/a.png 0.1,0.5,0.9,0.8 shots/b.png 0.1,0.5,0.9,0.8

# 同尺寸两图裁同区域拼成 A/B 对比图
$PY tools/make-ab.py shots/before.png shots/after.png out.png 0.3,0.9,0.1,0.9

# 三连对照 + 差异高亮：把「静止 / 被碰中 / 回弹后」裁同一区域上下拼，
# 并在中下两张上把「与基线差 ≥ thr 的像素」涂成品红 —— 一眼看出「碰了哪、回了没」
# （thr 给个大值如 999 就是纯视觉三连、不做高亮）
$PY tools/make-poke-ab.py shots/before.png shots/poked.png shots/back.png out.png 0.18,0.66,0.22,0.80 12

# 「画面里有朵多大的云」：对无云基线的总光量（柔边面积 / 云芯面积 / 形心）
# 基线用 __dbg.cloud.visible=false 拍；这个量对云的内部分片重新排布不变，
# 所以能回答「整朵云有没有变大变淡」——数「粉色像素」会被柔边阈值骗
$PY tools/cloud-mass.py shots/bg.png shots/a.png shots/b.png --box 0.10,0.62,0.22,0.80

# 两图像素差「变了哪一块」：差异包围盒 + 每列/每行跳变位置 + ASCII 掩码缩略图
# 用来定位「画面里那块可疑的矩形/硬边是哪个元素」——先逐个隐藏可疑对象各拍一张，
# 再两两 diff，差异率最高的那个就是元凶（实测：远景云第二组占了 35% 的差异）
$PY tools/diffbox.py shots/base.png shots/element-off.png 12

# 「云的投影板在哪些角度会被画出来」：不改画面，只算法线·视线的符号（BackSide 才光栅化的条件）。
# 扫 az×el×r，直接给出「可见块数」的分布 —— 比绕着轨道盲拍截图快一个数量级
# （就是这个脚本发现「默认首屏已经 141/141 中招、az45°~210° 是 360/360」）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html" shots/_x.png tools/cloud-plate-scan.json

# 「投影板漏色」的修前修后对照（含 0 差异对照组 + shadow.map 字节校验和 + 涟漪核查）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html" shots/_y.png tools/cloud-plate-fix.json
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html" shots/_z.png tools/cloud-adjacent-check.json

# 云朵「背光面压暗」：**同一份代码、同一帧基线，只切 cloudShade 系数**做 A/B
# （A 侧用 {backDark:0} 逐位复现「没有压暗」的改前状态；下午档应当给出 0 差异）
# 探针按 lit 分三档统计平均亮度，并给出 byteIdentical（与 tint 结果逐位相同的片数）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html" shots/_s.png tools/cloud-shade-ab.json
# 带 dream 滤镜（含 bloom）的同一组 —— 那才是玩家实际看到的画面。
# ⚠ 这一组**不要做逐像素判据**：后处理有颗粒/噪声（每帧取随机数），
#   两次截图落在随机序列的不同位置，夜间实测差 63% —— 那是噪声不是云。
#   判据用无滤镜那组，这一组只看观感（按区域均值量亮度）。
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html" shots/_sd.png tools/cloud-shade-dream.json

# 「云朵的颜色到底跟不跟时相走」：一次加载内逐档 apply，把**每一层的实际颜色**打出来
# 除了 360 片的均值，还按「本档 lit」排序取最背光/最向阳各 15% 的均值与三通道比值 ——
# 纯乘标量的特征是「三通道等比」（比值处处相同），色相跟着环境色走时比值会明显不均匀。
# 同时报 tintAlias（材质上有没有那份 __tintColor 快照：0 就是 tint 正在被 shadeCloud 覆写）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html?v=67" shots/_pc.png tools/cloud-phase-color.json
# 只想验证「接线对不对」时用这个更快的：直接读 states[x].tint 与 puff[0] 的 base/tintColor/cur
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html?v=67" shots/_tw.png tools/cloud-tintwire-probe.json

# 时相四档 / 梦核滤镜五档的对照预览图（读 shots/g-*.png，用 tools/preview-grid.json 出图）
$PY tools/make-preview-grid.py

# 「重构之后画面有没有变」：逐像素比对两批图，输出 mean / bad% / max。
# 纯搬迁（拆文件、搬代码）必须全 0；非 0 就说明行为变了 —— 别放过任何一个数
$PY tools/pixdiff.py shots/split-ref-old shots/split-ref-new 2

# 「换时相有没有换干净」：同一次页面加载内把「下午」的完整指纹存下来，
# 走一圈 夜间→清晨→日落→夜间→超大雾→小雾→UI连点，每次回到下午比对一遍。
# 指纹 = 780 个材质的颜色+不透明度 / 雾 / 天空7个uniform / 灯 / 曝光 / 星星 / 天体 / bloom。
# 脚本内自带对照组（切到别的档时应当 DIFF），证明确实在测东西。
# statetest.json 关滤镜跑；statetest-fx.json 开着梦境滤镜 + postfx.pinTime 跑（更接近用户所见）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/" shots/_rt.png tools/statetest-fx.json

# 复现用户的报障路径并出三联图（下午 → 夜间 → 切回下午）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/" shots/_bd.png tools/bug-demo.json
$PY tools/make-bug-demo.py

# 三个 JS 的 import/export 闭合性（node --check 只验语法，验不出
# 「导入了对方没导出的名字」—— 那会让整个 module graph 链接失败）
$PY tools/check-imports.py

# 「画面里挡住天空的是哪一层山」：逐层累加隐藏（全部 → 隐3400 → 隐2950 → 隐2200
# → 只剩天穹），对每列求「最上方非天空像素的行号」= 天际线，再看每层把天际线抬高了几像素。
# 肉眼看不出——三层颜色都被雾冲淡又互相遮挡，只能靠这个归因。
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html" shots/slvl/last.png tools/band-levels.json
$PY tools/skyline-attrib.py shots/slvl 10

# 天际线放大对照条（把若干张同尺寸图的天际线区域裁出来上下拼，带 y 刻度）
$PY tools/make-skyline-strip.py out.png 190 340 "改动前=shots/slvl/slvl0-all.png" "改动后=shots/slvl3/slvl0-all.png"

# 远景环山高度的前后对比图（2×2：整幅左右 + 天际线 1:1 在下）
$PY tools/make-ridge-preview.py

# 「雾的 near/far 到底怎么走的」：同步步进 update(dt)，把 2 秒里每 0.1s 的
# near/far 全打出来（不依赖帧率，同一 eval 内步进 ⇒ 结果完全确定），
# 顺带对照 fogAnimMs=0（硬切）与 fogAnimMs=2000（渐变）在「切换后立刻」的读数
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html" shots/_f.png tools/fog-steps.json

# 真实循环驱动的版本（用 rAF 采帧：每一帧的 t / far 都记下来），
# 并抓 4 张渐变过程的实拍。⚠ 无头下 dt 被钳到 0.1s、帧率又只有 ~1fps，
# 2 秒的动画在墙钟上要跑 ~20 秒 —— 这是无头的特性，不是渐变变慢了
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html" shots/_f.png tools/fog-live.json

# 雾渐变的四联图（配 freeze-pre.js 冻帧 + update() 手动步进把动画停在指定 t，
# 所以四张图之间只差雾，别的变量都钉死了）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html" shots/strip/last.png tools/fog-strip.json
$PY tools/make-fog-preview.py

# 界面布局：一次性打出 hud / 标题 / 标题行 / BGM / 模式按钮 / 面板 / 提示条 / 跳按钮
# 的矩形，并做两两相交判断（free 与 roam 各量一遍，因为 #jump-btn 只在漫游/步行才可见。
# 只量 free 会得到「不相交」的假通过：那一刻 #jump-btn 的矩形是 [0,0,0,0]）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html" shots/_u.png tools/ui-final.json
CHROME_ARGS_EXTRA="--window-size=500,700" \
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html?mobile=1" shots/_u.png tools/ui-final.json

# 「切换 UI」开关：可见 → 收起 → 还原 三态各打一遍 display + 矩形，
# 断言「标题还在、开关自己还在、别的一律 display:none」，再切到漫游重做一遍
# （漫游下 #jump-btn 是 grid，收起要变 none、还原要变回 grid —— 这才证明
#  class 覆盖没把 .on 那套逻辑压坏）。最后再点一次回到可见态收尾
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/?v=67" shots/_uh.png tools/ui-hide-check.json

# 快捷键 H 连按三下（可见 → 收起 → 可见）+ 收起态下按 3 / 8 / f 看档位是否照切
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/?v=67" shots/_uk.png tools/ui-hide-keys.json

# 窄屏（触发 max-width:520px 断点）下开关与「跳」按钮不相撞
# （实测 500×749：开关 [212,708,288,737]、跳 [412,657,484,729]，竖直重叠但横向 288<412 让开）
CHROME_ARGS_EXTRA="--window-size=390,844" \
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/?v=67" shots/_um.png tools/ui-hide-mobile.json

# ?ui=0 开场即收起（收起态能不能复现/分享）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/?v=67&ui=0" shots/_u0.png tools/ui-hide-urlparam.json

# 相机焦点：把梯脚的三个点（foot / mid / top）投影到屏幕坐标，
# 看中点的落点是不是正好等于画面正中 —— 别用肉眼估「有没有对准梯子」
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html" shots/_p.png tools/cam-probe2.json

# 漫游跳床：爬到梯顶 → 点「跳」 → 抛物线落床（抓起跳/空中/将落地/落在床上四帧 + 每一步的数值）
# 用 __rig.goto(2) 直接跳到「梯顶待跳」那一步 —— 漫游全程十几秒仿真时间，
# 而这一步的前置（飞过去 + 爬 12.9m）在无头下要等一两分钟，截图/回归没必要每次重等
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html" shots/leap/last.png tools/roam-leap.json
$PY tools/make-triple-preview.py

# 跳跃请求的纪律（爬梯途中按跳要被丢弃 / 不按就一直等 / 空中连点不多跳 / 落地后不残留）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html" shots/_g.png tools/roam-guard.json

# 雾 / 夜间环境色 / 换雾动画时长：三张读数图 + 用 update(1/60) 手动步进量动画时长。
# 手动步进是确定性的（一帧一次、不依赖帧率），所以「2333ms」这个数能一格不差地对上
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html?v=67" shots/fog/_p.png tools/fog-tune-probe.json

# 爬梯速率：进漫游的爬梯步（goto(1)）+ 手动把 P.state 置成 ladder，
# 取两点算 ΔP.ls / Δ__dbg.time。实测 2.30 → 1.15（整梯 12.9m：5.61s → 11.22s）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html?v=67" shots/fog/_c.png tools/climb-rate-probe.json
```

⚠ 本机的**手机/平板预览**与所有无头脚本都要绕开系统代理：环境里设了
`http_proxy=http://127.0.0.1:63447`，走代理访问 `127.0.0.1:8123` 会拿到 502（而不是连不上，
很容易误判成「服务没起」）。跑脚本时给它加 `--no-proxy-server`，curl 加 `--noproxy '*'`：

```bash
export no_proxy="127.0.0.1,localhost"
CHROME_ARGS_EXTRA="--no-proxy-server" \
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html?v=67" shots/x.png tools/xxx.json
curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8123/index.html
```

（另外 `serve.py` 是**随会话消失的后台进程**：新一轮对话开始时它通常已经死了，
表现为 `curl` 拿到 502/000。跑脚本前先把服务器和脚本放在**同一条命令**里起、跑完再 kill，
一次工具调用内完成，就不会中途被回收。）

### 远景环山的高度：靠「天际线归因」调，不靠肉眼估

`scene.json` 的 `sky.ridgeBands` 是三层同心剪影山脊带（半径 2200 / 2950 / 3400）。
它们的天际线在画面里是**叠加**的，肉眼看到的「一圈山」其实是三层的并集，而且
越远的一层被雾冲得越淡（雾 far = 5200，3400 那层只剩 35% 的原色）——
所以「哪一层在挡天空」不能靠看，只能靠 `tools/skyline-attrib.py` 逐层归因。

一次实测（默认机位）：隐藏最远那层只让天际线下移 **2.9px**，隐藏 2950 那层下移
**16.9px**，隐藏 2200 那层下移 **19.7px**。也就是说**只降「字面上最远的一圈」几乎看不出变化**，
真正占天际线的是最近那一层的噪声实现（它的峰顶恰好落在朝向相机的方位上）。

调的时候按「峰顶角度」而不是按 `height` 拍脑袋 —— 同一个 `height` 在不同半径上
挡住的天空角度差很多：

| 层 | 半径 | 峰顶 `y + height` | 仰角 `atan(峰顶/半径)` |
|---|---|---|---|
| 近 | 2200 | 377 → **293** | 9.7° → **7.6°** |
| 中 | 2950 | 609 → **488** | 11.7° → **9.4°** |
| 最远 | 3400 | 794 → **650** | 13.1° → **10.8°** |

（加粗为调整后的值；`base` 同时从 .21/.20/.24 降到 .18/.17/.20，让垭口也低一点、
缝隙里多露些天空。）改完实测：天际线平均下移 **17px**、最大 **66px**，
纯天空像素占比 **28.82% → 31.63%**，而三层仍然互相错开、层峦叠嶂的层次没丢。

顺带纠正了一处「反直觉的层次」：改前最近那层的峰顶角度**超过了**更远的两层，
所以视觉上「近处的山反而更高」。调完是 7.6° < 9.4° < 10.8°，
越远越高、越远越淡，这才符合「重峦叠嶂」的预期。

### 把随机的场景变成可比的两张图（`PRE_SCRIPT`）

场景构建里到处是 `Math.random()`（草 / 云 / 蝴蝶的位置和颜色），两次刷新就是两套布局 ——
不做处理的话逐像素对比毫无意义。`tools/headless-interact.mjs` 支持在**任何页面脚本之前**
注入一段代码，用它把随机数换成固定序列：

```bash
export PRE_SCRIPT="(function(){var s=20260920;Math.random=function(){s=(s*1664525+1013904223)>>>0;return s/4294967296;};})();"
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html" shots/ref-new/_f.png tools/split-ref.json
```

配合「冻帧」（见下）就能做到**同一次改动前后逐像素一致**。实测拆分 `main.js` →
`scene.js` / `model.js` / `main.js` 时，8 张对照图（4 时相 × 滤镜 + 雾档）全部 `mean 0.000 / max 0`。

`tools/freeze-pre.js` 把「定种子」和「冻时钟」合成一句，做前后对照时直接用：

```bash
export PRE_SCRIPT="$(cat tools/freeze-pre.js)"
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html" shots/out.png tools/band-levels.json
```

它的第二招是把 `performance.now()` 钉成常量 0 ⇒ `THREE.Clock` 的 `dt` 恒为 0、
`elapsed` 恒为 0，云不飘、草不摆、蝴蝶不飞。比 `__dbg.uTime` 的 `defineProperty`
更彻底（连 `dt` 驱动的云飘移、`pokeStep` 一起冻住），代价是**场景时间永远停在 t=0**：
要看「动画跑到某一刻」的画面仍得用下面那种钉 `uTime` 的办法。

排查「页面白屏 / 脚本加载失败」这类**模块图**问题时用 `tools/mod-probe.mjs`：
它把每个 `.js` 请求的状态码与 MIME、`Runtime.exceptionThrown`、`console` 输出全打出来 ——
页面上只会显示一句「脚本加载失败」，原因得靠这个挖。

```bash
$NODE tools/mod-probe.mjs "http://127.0.0.1:8123/index.html"
```

---

## 禁止缩放页面 / 禁止文字选择

移动端 WebView 与桌面浏览器各有各的缩放入口，**一层是拦不全的**，所以做了三层：

| 层 | 手段 | 拦的是 |
|---|---|---|
| ① meta | `width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover` | 移动端双指捏合（最有效的一层）；iOS 上 `user-scalable=no` 被忽略，靠 ②③ 兜 |
| ② CSS | `html{touch-action:manipulation}` | 双击缩放（保留单击/滚动的正常手感） |
| ③ JS | `lockViewport()` 拦 `wheel`(Ctrl/⌘) 、Safari 私有 `gesturestart/change/end`、`keydown` 的 Ctrl/⌘ + `+` `-` `0`、`dblclick` | 桌面 Ctrl+滚轮、Ctrl±、Ctrl+0；Safari 的捏合事件 |

文字选择（桌面拖拽划选 + 移动端长按复制菜单）：

```css
html,body,button,input,textarea,select,a{
  user-select:none; -webkit-user-select:none;
  -webkit-touch-callout:none; -webkit-tap-highlight-color:transparent;
}
input,textarea{user-select:text;}   /* 输入框要能选，否则没法编辑 */
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;}
```

两个必须这么写的地方：

- **`wheel` 监听要 `{passive:false, capture:true}` + `stopPropagation()`。** 默认是被动监听，
  里面调 `preventDefault()` 会**静默失效**（不报错、也不生效）；不掐断传播，OrbitControls
  会把这个 Ctrl+滚轮当成一次推拉吃掉 —— 于是「页面没缩放，但镜头悄悄拉近了」。
- **只在 `ctrlKey || metaKey` 时拦，普通滚轮必须放行**。否则等于把 OrbitControls 的滚轮缩放
  一起禁掉了（这是这个页面唯一的推拉手段）。回归要**正反两面都断言**：拦住了 + 没拦住。
- **不放 `config.json`**：禁缩放要在页面一加载就生效，而 `config.json` 是异步 fetch 来的，
  放进配置里意味着前几百毫秒是漏的（用户可以正好在那时候捏一下）。

实测（`tools/reset-autowalk-lock.json`，无头 Chrome）：

```
userScalableNo true   maxScale1 true   html/body userSelect none
htmlTouchAction manipulation   canvasTouchAction none
Ctrl+滚轮:  ctrlPrevented true   ctrlReachedCanvas false   相机距离 32.1818 → 32.1818 (Δ0)
普通滚轮:   plainReachedCanvas true                        相机距离 32.1818 → 30.2607 (Δ1.92，正常推拉)
拖拽选中文本长度 0
```

`lockViewport()` 会返回 `{meta, touchAction, userSelect}` 并挂到 `window.__vp` 上，
上面那几行就是从这个对象 + 事件探针里读出来的。

---

## 换床模型：一个外部 GLB 塞进场景要过的四道关（`models/bed2.glb.xml`）

`scene.json` 的 `bed.model` 只有 5 个键，但每个都是踩出来的：

```json
"model": {
  "url": "./models/bed2.glb",
  "rotationY": 1.5708,
  "topFrac": 0.64,
  "smoothAngle": 0
}
```

| 键 | 管什么 | 怎么定出来的 |
|---|---|---|
| `url` | 用哪个 GLB | 换模型只改这一行（打包脚本从**这里**读文件，既决定内联哪份、也决定 `models/` 里放哪个，不再写死；指到不存在的文件直接 BUILD FAIL） |
| `rotationX` | **轴修正**：模型不是 Y-up 时补一个旋转 | 这次不需要（见下面的坑 1） |
| `rotationY` | 水平朝向：床头朝哪一端 | 床头摆 −X（远离梯子那侧），和新床/旧床一致 |
| `topFrac` | 被面在包围盒高度上的分位，用来把被面校准到 `surfaceY` | 打射线量（见坑 3），实测 0.64 |
| `smoothAngle` | >0 时按夹角重算逐面法线 | 新模型自带法线 + 法线贴图 ⇒ 配 0 关掉 |

### 坑 1：节点的 `matrix` 会让「这模型是不是 Y-up」判错

第一版离线探针只读 `node.translation / rotation / scale`，报告「原始 POSITION 的
朝上轴是 z ⇒ 这是 Z-up 模型，得补 `rotationX = -90°`」。于是按这个加上去，
**结果模型躺倒在床上**。

真相：这个 GLB 的网格节点用 `matrix` 写的变换（GLTFExporter 就爱这么写），
里面已经含了一个 `Rx(+90°)`，把 Z-up 的原始数据转成了 Y-up：

```
node[0] defaultMaterial  matrix = Rx(+90°)   ← 只读 TRS 的话完全看不到
node[1] Scene            matrix = 平移 y+0.3258（把模型底面挪到 y=0）
```

⇒ 加上 `rotationX = -90°` 恰好和它抵消，等于白转。**判轴之前必须先把节点
`matrix`（列主序）乘进去**，`tools/glb-axis-probe.py` 已经改成这么算，
并且把「场景根坐标系里的包围盒」直接打出来对照。

`rotationX` 这个旋钮还是留着 —— 下一个模型大概率真需要它，只是**要用对了再给**。

### 坑 2：`scale` 和 `rotation` 写在同一个物体上，缩放比会落到错的轴上

`Object3D` 的矩阵是 `T·R·S`，**缩放比旋转先作用**。而原来的代码是：

```js
m.rotation.y = -Math.PI/2;
m.scale.set(W/dim.x, ..., D/dim.z);   // dim 是「旋转之后」量到的
```

`dim` 量的是旋转后的包围盒，可 `scale.x` 乘的却是旋转**前**的 x 轴 ——
旋转 90° 时 X/Z 刚好互换，两个比例就配错了。实测旧床：

| | 想要 | 实际 |
|---|---|---|
| 床长/床宽 | 4.7 × 3.4 | **5.1 × 3.13** |

而 `bedFootprint()` 量的是 GLB 真实包围盒（拿到 5.1×3.13）、`bedHalfLocal()`
读的是 `bed.size`（4.7/3.4）—— 两者一直对不上，**走路可站立矩形比床小一圈，
人从床沿掉下去**。

修法是把三层拆开，让 `scale` 在最外层：

```js
fix  = Group();  fix.add(m);   if (rx) fix.rotation.x = rx;   // 内层：轴修正
yaw  = Group();  yaw.add(fix); yaw.rotation.y = M.rotationY;  // 中层：水平朝向
root = Group();  root.add(yaw); root.scale.set(...);          // 外层：缩放 + 居中
```

这样 `dim` 与 `scale` 同轴，量到的就是乘到的。换床后 `worldSize` 报
`[4.7, 2.25, 3.4]`，与 `bed.size` 首尾对齐。

### 坑 3：`topFrac` 别猜，也别照抄上一个模型的

`surfaceY = 1.44`（被面离地高度）是这个场景的**不变量**：梯顶、爬床判定、
蝴蝶巡航基准、床面高光锚点全读它。`topFrac` 决定「把这个模型的哪一层摆到
1.44 上」，抄上一个模型的 0.58 会让新床的被面高或低半米。

两条实测路子：

```bash
# a) 离线：面积加权的「朝上的面」高度分布峰值（先看模型的形状是否合理）
$PY tools/glb-axis-probe.py models/bed2.glb
# b) 在真场景里向下打射线（被面是皱的，射线比面积统计更接近「人会踩在哪一层」）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html?v=68" \
  shots/_bedray.png tools/bed-surface-probe.json
```

射线取 **11×11 网格 + 命中高度众数**：目标 `1.728（=surfaceY×1.2）`，
实测众数 `1.70`、中位 `1.717`（差 0.03 米，肉眼不可见）。

⚠ 面积统计对被面发皱的模型会给出误导性答案：这个模型朝上面积最大的那层在
**高度的 17.5%**（被子垂到地上的那一圈），而人真正踩的是 64% 那层。
所以「峰值」只用来判形状，`topFrac` 以射线众数为准。

### 顺带记下的两条

- **贴图通道要先看一眼再担心**：这个 GLB 的 `metallicFactor = 1`，看着像
  「全金属发黑」的经典坑，但 ORM 贴图的 B 通道实测**恒为 0** ⇒ 金属度
  `1 × 0 = 0`，没问题。R（AO）恒 255、G（粗糙度）62~217。
- **`COLOR_0` 原本是全 1**：glTF 有顶点色时 three 会打开 `vertexColors`，
  全 1 就是乘 1，无害 —— **这个白送的通道后来被拿来烘 AO**，见下节。

### 换完怎么验

```bash
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html?v=68" shots/_s.png tools/bed-swap-regress.json
$PY   tools/make-bed-swap-preview.py     # 同一机位、同一床头朝向的 旧/新 对照图
```

一次跑完给三样读数：

| 读数 | 实测 |
|---|---|
| `bedModel.worldSize`（局部） | `[4.7, 2.25, 3.4]` ← 与 `bed.size` 对齐 |
| 射线众数 / 目标 | `1.70 / 1.728` |
| 漫游爬到床上（`goto(3)` → `mode=walk`） | `foot 2.582 = bedTop 2.582`（diff 0） |
| 复位 | `posErr 0` · `__errs []` |

⚠ **打包脚本原本写死 `models/bed.glb.xml`**：换模型后不一起改，它会静默把**旧床**
塞进产物，而「产物与源码逐像素一致」这条断言反而变成假绿（两边都比的是旧床）。
现在改成从 `scene.json` 的 `bed.model.url` 读，文件不存在直接 `BUILD FAIL`。
（2026-09-21 夜已按新床重打包，本节下面的数字都是那一版。）

## 床的顶点 AO（把 `COLOR_0` 从「全 1」变成烘焙好的遮蔽）

那个**本来就存在的 `COLOR_0` 通道是白送的位子**：glTF 里只要带顶点色，three 的
GLTFLoader 就会自动 `vertexColors = true`（`vendor/three/addons/loaders/GLTFLoader.js:3341`
判的是 `geometry.attributes.color !== undefined`），而工作色彩空间就是 linear-sRGB
（`GLTFLoader.js:4643` 那个分支只在非 linear 时才警告）⇒ 顶点色**不做任何转换**、
直接乘进 albedo。把 AO 烘进 `COLOR_0` 就得到「褶皱/接触处变暗」的效果，而且：

- **不花贴图预算**：原地覆写，GLB 字节数几乎不变（616744 → 616740）
- **不依赖任何图片解码**：纯 attribute 上传，容器禁 `Image`/`data:` 也照跑
- **本地预览与打包产物同一条路**：都读 GLB 里的同一份数据，不会再出现
  「本地对、线上错」两套路径
- **不用改 `model.js`**：`applyBedTextures()` 只换 `map`/`roughnessMap`/`normalMap`，
  不碰 `vertexColors`，AO 自动生效

烘焙器 `tools/glb-vertex-ao.mjs`（通用，任何 GLB 都能用）：

```bash
# 就地烘焙。--scale 是「局部轴 → 世界」的实际缩放比，必须量出来（见坑 1）
$NODE tools/glb-vertex-ao.mjs --in models/bed2.glb.json \
      --scale 3.3694,4.23,4.9728 --dist 1.2 --rays 256 \
      --raw-gamma 2.2 --floor 0.25 --strength 0.9 --min 0.12

$NODE tools/glb-vertex-ao.mjs --in models/bed2.glb.json --print-only   # 只统计，不写文件
$NODE tools/glb-vertex-ao.mjs --in models/bed2.glb.json --revert       # 抹回全白（撤销）
# 一次试多组参数：--name <档名> --emit tools/_ao-variants.json（不写 GLB，供探针轮播）
```

| 参数 | 含义 |
|---|---|
| `--dist` | 射线最大长度（**世界单位**，因为顶点已按 `--scale` 缩放）。褶皱细节 ~0.4，形体感 ~1.2，整床包络 ~3 |
| `--rays` | 每顶点采样数（192 够用，256 更平滑） |
| `--raw-gamma` | 作用在「未遮蔽比例」上的对比曲线。**先拉对比、再压下限**，反过来会把中段压平、看着几乎没效果 |
| `--floor` | 全遮蔽时的下限亮度（0.25 ⇒ 最深到 25%） |
| `--strength` | 线性对比放大（`a ← 1 - s·(1-a)`）。>1 会算出 <floor 的值，靠 `--min` 兜住 |
| `--min` | 硬下限，防止内表面顶点变纯黑（0.12） |

### 三个必须知道的坑

1. **非等比缩放**。模型在场景里常被拉成非等比 —— 本床「局部轴 → 世界」是
   `3.37 / 4.23 / 4.97`（`root.scale` × `bed.scale` 叠出来的）。在局部空间用球形半径
   算 AO，映射到世界就成了**扁椭球**，`--dist` 也不再是米数。必须先把顶点乘上这个
   比例再算。量法：读网格 world matrix 三个列向量的长度（`tools/_probe_bed_ao.mjs`
   的 `isolate` 一行会打出来）。法线要同时用**逆转置**（对角缩放的逆转置 = 分量除以 s）
   再归一化。
2. **不要给三角形做「跨射线去重」**。三角形按质心只挂一个网格单元，3×3×3 邻域扫描里
   天然不会重复；再加一个去重缓存会把「本射线还没测过」的三角形误判成已测，
   于是第一条之后的所有射线**全部空转**，AO 直接算废。（先前用 `Int32Array(单元数)`
   去索引三角形，因越界写被静默丢弃才「侥幸算对」—— 这种巧合不能留。）
3. **UV 接缝要归并**。4563 个顶点里有 546 个是同一位置被拆出来的（接缝/硬边）。
   不按量化位置归并，AO 在接缝两侧会取到不同的值 ⇒ 画面上一道亮线。
   本床归并后 4563 → 4017 组。

### 效果与验收

- 源模型 `COLOR_0`：`min 0.325 / max 1.000 / mean 0.716`（改前恒为 1.0）
- **2026-09-28 调轻**：用户反馈「oa 太强太黑」，`--strength` 1.5 → 0.9（正好 −40%）。
  最暗处 0.120 → 0.325，均值 0.598 → 0.712（变暗幅度 0.40 → 0.29）。
  `--min 0.12` 在这档已经不起作用（0.9 档的下限是 0.25×0.9+0.1 = 0.325）。
  前后实拍：`shots/bed-ao-hero-strong.png`（1.5）/ `shots/bed-ao-hero-light.png`（0.9）
- 无头对照（只留床、纯黑底、直渲默认帧缓冲**绕过后处理**，`lit` 像素就是床本身）：
  床区平均亮度 `158.1 → 137.9`，标准差 `38.8 → 54.2`（对比度 +40%）
- 之前走过的弯路：只按**垂直 FOV** 反推机位距离，宽画幅下相机退远 ~aspect 倍
  （床只占画面 18%），统计被背景稀释 ⇒ 取景要取「水平/垂直两个 FOV 里更远的那个」
- 没 AO 时 AO 图几乎全白，说明**可见面本身很开敞**；真正被遮的是床垫侧面、木框内侧
  这些看不见的地方 ⇒ 想「看得见」得靠 `--raw-gamma` + `--strength` 把褶皱/接触处拉开，
  而不是一味加大 `--dist`
- 前后实拍：`shots/bed-ao-hero-noao.png` / `shots/bed-ao-hero-ao.png`
- 参数扫描条带（7 档 × AO图/原材质）：`shots/bed-ao-sweep-strip.png`
- **产物两条加载路径都验过**（`tools/_probe_xhs.mjs normal` / `block`）：
  `vertexColors: true`、AO `min 0.325 / mean 0.7119`，`via:file` 与 `via:inline` **读数一致**

⚠ **改完 `models/` 里的 GLB 必须重打包**：产物里的内联 base64 是构建期从 GLB 现算的，
不 build 的话包里还是旧顶点色。

### 打包后的冒烟测试（`tools/smoke-dist.mjs`）

```bash
$NODE tools/smoke-dist.mjs          # 失败退出码 1，可串进脚本
```

构建本身只做静态检查（语法、清单、禁用能力扫描），**查不出「页面半启动」**：
只要少一个声明，页面照样渲染草地天空，只是音频 / 一部分逻辑静默失效。
2026-09-28 就踩了一次 —— `audio.js` 里 `start()` 引用了没写进去的 `defIndex`，
构建全绿、页面看着正常，控制台里躺着一条 `BUILD-FAIL ReferenceError`。
冒烟测试真开一次无头浏览器，断言 5 条：无异常/无 BUILD-FAIL、`__dbg` 建起来、
内联数据齐备、床模型加载完成、BGM 默认曲 == `audio.default`。

## 打包成小工具 zip（`dist-minitool/` → `cloud-ladder-minitool.zip`）

`tools/build_minitool.py` 把**源码那一套 ESM 模块**（three + 13 个 addon + 自家 6 个 module）
转成**一包经典脚本**，连同资源一起铺进 `dist-minitool/`（16 个文件），再压成 zip。
最硬的约束来自容器 CSP：`script-src` **不含 `unsafe-inline`** ⇒ 不许内联脚本、行内事件、
`eval` / `new Function`；而且**必须是经典脚本**，不能有 `type="module"` 或 `import`/`export`
（module 的离线相对 import 解析不可靠，典型症状是「页面渲染出来但 JS 完全不执行」）。
**`index.html` 必须在 zip 根目录** —— 压的是「与 index.html 同级的那批文件」，不是它所在的文件夹。

ESM → 经典脚本是四件机械改造：

1. **`three.module.js` 末尾唯一一处 `export { … }` 换成 `window.THREE = { … }`。**
2. **每个 addon 与自家模块套 IIFE。** 经典脚本共享同一个全局词法环境，addon 之间同名的顶层
   `const`（一堆 `_vector` / `_quaternion`）会撞成
   `SyntaxError: Identifier '_vector' has already been declared`。套进 IIFE 后导出走注册表：
   `window.__M`（addons）/ `window.__APP`（自家模块）。
3. **相对路径 import 要分开路由**：addon 之间的 `./Pass.js` 去 `__M` 取，
   自家模块之间的 `./scene.js` 去 `__APP` 取。**写反了会静默错位** —— 实测 `MaskPass`
   跑去 `__APP` 找一个不存在的 `Pass`。
4. **`<script src>` 的顺序必须与原 import 图一致**（three → addons → data → audio → scene →
   model → postfx → atmosphere → main）。经典脚本没有图链接，顺序就是依赖关系。

另外几处定点改造（`patch_*` 函数，每处都带断言，找不到就 `BUILD FAIL`）：

- **`main.js`**：`Promise.all([fetch(scene), fetch(config)])` → `Promise.resolve([window.SCENE_JSON, window.CONFIG_JSON])`（产物里禁 XHR）。
- **`model.js`**：`.load(M.url, …)` 的**前面插两个参数**（`loader` 与备用 base64），
  变成 `window.__loadBedGLB(M.url, new GLTFLoader(), window.BED_GLB_B64, …)`。
  函数体一行没改 —— 只在 `.load(` 前缀上做一次 `replace`，比去函数体里抠代码稳得多。
- **`audio.js`**：删掉 `el.crossOrigin`。**曲目文件名一个字符都不动**（见下面「资源原样进包」）。

产物侧还顺手做了：`renderer.pixelRatioMax` 2 → 1.5、剥掉 `config.json` 的 `_说明`（省 25587 B）、
`index.html` 剥掉 2 段脚本与源码里那段 `#boot-error`（否则产物里会有**两个同名 id**，
`getElementById` 只取第一个 ⇒ `showBootError` 填的是空壳，用户看到的却是另一个）。

### 资源**原样**进包（`models/` + `audio/`，文件名不改）

以前产物里**没有 `models/` 目录**：床走 base64 内联，`audio/` 则是「复制一份并把
`.mp3.xml` 改名成 `.mp3`」。用户点名两件事：「漏打包了 models」「不要改我的 mp3 和模型的
文件名，我是故意改成 `.xml` 的，我的配置文件里也写好了的」。

改法就是**只搬文件、不改名字**，并且**以配置文件为准**：

| 资源 | 从哪来 | 进包后的路径 |
|---|---|---|
| 床模型 | `scene.json` → `bed.model.url` | `models/bed2.glb.xml`（**只搬被引用的那一个**，换下来的旧床 `bed.glb.xml` 没有引用就不进包） |
| BGM | `config.json` → `audio.tracks[*].file` + `audio.base` | `audio/bgm-*.mp3.xml`（三首全搬，名字照抄） |

`.mp3.xml` / `.glb.xml` 这套后缀是**长期的、刻意的约定**（本机 Windows 注册表里 `.mp3`
的 MIME 映射不对，宿主的 zip 上传也按扩展名筛），`config.json` 里从头到尾写的就是 `.xml`。
打包器改名等于制造「源码一套名字、产物另一套」，下次改完对不上还以为是没生效 ——
而且上一版 `check-embed-sync.py` 里还专门有一条「把 `.xml` 去掉再比」的归一化，
**正好把这种改名差异抹平了**，改错也报绿。这条归一化已经删掉。

新增的 `verify_manifest()` 会把 index.html 的 `<script src>`、`style.css`、`favicon.svg`、
config.json 的每首曲目、scene.json 的模型**逐个对着产物目录点名**，少一个直接 BUILD FAIL ——
`models/` 漏搬这类事就是它该拦的。

**模型怎么读：文件优先 + 内联兜底。** `GLTFLoader.load()` 内部是 `FileLoader` → `fetch`，
而 `device-capabilities.md` §4 写着容器不可用 `fetch`/`XMLHttpRequest`。所以产物里
**两份都有**：包内的 `models/bed2.glb.xml`（规范期望的形态）和 `data.js` 里同一份 GLB 的
base64 副本。`window.__loadBedGLB()` 先读文件，**出错或 30 s 完全没动静**就退回内联副本。
实测三条路都通（读数用 `window.__bedSrc`，新加的探针字段）：

| 打开方式 | `__bedSrc.via` | 备注 |
|---|---|---|
| 源码 `http://…/index.html` | —（源码没有这个函数） | 直接 `load(url)` |
| 产物 `http://…/dist-minitool/` | `file` | `chunks 1`，文件请求正常 |
| 产物 `file:///…/dist-minitool/` | `inline` | `Failed to fetch` —— **和容器同一种失败**，自动退回内联 |

三条路的 `bedModel.worldSize` 都是 `[4.7, 2.25, 3.4]`，三张冻结截图**逐像素 0 差异**。
另一条独立的证据是把产物里的 `models/bed2.glb.xml` 临时改名再跑：`via` 变 `inline`、
`note` 记下 404、画面读数一字不差，兜底不是纸面设计。

⚠ **定时器踩的坑**：兜底一开始用「空闲 12 s」判失败，结果无头软件渲染下读那 616 KB
**本身就超过 12 s**，于是「兜底」和还在路上的请求**同时跑了两遍 GLB 解析**，启动从
14.3 s 变成 29.0 s，而 `via` 最后还是 `file`。正确判据不是「等了多久」而是「请求死了没有」：
**只要收到过一次数据就撤掉定时器**，之后再慢也认它是活的；容器禁 `fetch` 时错误是**立刻**
返回的，根本用不着靠计时猜。超时放宽到 30 s 只当最后一道网。

```bash
$PY tools/build_minitool.py --no-bed-fallback   # 不要内联副本（省约 0.78 MiB）
```

**构建脚本的纪律**（都是踩出来的）：

- **每处预期片段找不到就 `BUILD FAIL`**，否则会静默产出「看起来正常、跑起来白屏」的包。
  本轮三次 FAIL 全是断言起作用（`MaskPass.js: 未支持的 import 来源 ./Pass.js`、
  `main.js: 没解析到任何导出`、`FileNotFoundError: dist-minitool\audio\…`）。
- **「搬过来的」资源也要点名核对**：文件复制不像脚本拼接那样自带断言，
  少搬一个不会有任何报错。`verify_manifest()` 因此把所有**被引用**的路径列出来逐个
  `os.path.isfile`，并打印每一项的大小（`models/` 就是这么漏掉的）。
- **不要 `shutil.rmtree(DIST)`。** 整目录递归删会触发工作区的批量删除保护
  （`[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":62,"threshold":50}`），
  实测把构建打断在「目录删到一半」——比不清理更危险。改成**全量覆盖写 + `prune_dist()`
  逐个删多余文件**（残留 > 20 个就报错让人看一眼）。

```bash
$PY tools/build_minitool.py                    # 生成 dist-minitool/ + cloud-ladder-minitool.zip
$PY tools/make-minitool-preview.py             # 出预览图（产物 vs 源码逐像素对照）
$PY tools/make-boot-bed-preview.py             # 出预览图（加载提示 + 床缩放）
$PY "$SKILL/scripts/audit_artifact.py" dist-minitool          # 官方审计（目录）
$PY "$SKILL/scripts/audit_artifact.py" cloud-ladder-minitool.zip  # 官方审计（zip）
```
⚠ `audit_artifact.py` 要传 **Windows 形式**的路径（`E:/workbuddy/…/.skill/…`）：
Git Bash 会把 `/e/...` 展开成 `E:\e\...`，Python 就找不到文件了。

实测结果：

```
dist-minitool/       PASS: 16 file(s), 0 warning(s)
cloud-ladder-minitool.zip  PASS: 16 file(s), 1 warning(s)
  WARN: zip is 3.88 MiB; recommended target is 2 MiB     ← 唯一一条，远低于 10 MiB 上限
namelist()[0] = addons.global.js   ← 根目录直接是文件，不是文件夹 ⇒ index.html 在 zip 根 ✓
```

**3.88 MiB 是谁占的**（2026-09-21 夜「资源原样进包」后重测）：

| 块 | 压后 | 占比 | 还能不能小 |
|---|---|---|---|
| 三首 BGM（`.mp3.xml`，共 2.46 MiB 原始） | ≈ 2.46 MiB | 63% | **只能动音乐本身**（降 48 kbps 单声道 ≈ 省 0.6 MiB，仍到不了 2 MiB） |
| `models/bed2.glb.xml` | ≈ 0.59 MiB | 15% | PNG 已压缩，无余量 |
| `data.js` 里的 GLB base64 兜底 | ≈ 0.78 MiB | 20% | `--no-bed-fallback` 可整块去掉（见上） |
| three + 自家 JS + 两张贴图 | ≈ 0.6 MiB | 15% | 已压到极限 |

（上一版 3.18 MiB 的构成里没有 `models/`、且只有两首 BGM：音频 2.31 MiB = 74%。
现在多了三件东西 —— 第三首 BGM +0.20 MiB、模型文件 +0.59 MiB、兜底 base64 保持 +0.78 MiB，
换掉之前那条「数据内联所以模型不占包」的省法，所以反而变大了。）

顺带量过的一个可选优化（**未采用**）：`bed2.glb.xml` 里两张 512² PNG 是 100% 不透明的 RGBA
（albedo 220 KiB、metallic-roughness 115 KiB），去掉 alpha 转 JPEG q88 可省 286 KiB
→ base64 381 KiB → zip 约降 0.37 MiB。没做的原因：metallic-roughness 的 G/B 通道是
数据而不是图像，JPEG 的色度二次采样会把它涂花；且降完仍在 2 MiB 以上，收益不对等。

### 重打包后必须补的四项检查（`colorWrite` / `paintCloud` 这类改动的落包证据）

重打包不是「跑一下脚本就完事」：只要源码动过，就得证明**改动真的进了经典脚本产物**，
而且**产物跑起来仍然逐像素等于源码**。四件事各一条命令：

```bash
# 0) 包里的内联数据 == 现在的源码吗（改完忘重打包时，两边都「能跑」、只有数值不同）
$PY tools/check-embed-sync.py
# 1) 新特性在产物里真的活着（读数来自产物页面，不是源码页面）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/dist-minitool/index.html" \
  shots/_mini-newfeat.png tools/minitool-newfeat-check.json
# 2) 行为回归（启动 → 漫游 → 自动切步行 → 复位）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/dist-minitool/index.html" \
  shots/_mini-distcheck.png tools/minitool-dist-check.json
# 3) 资源落包（床从哪读的、三首 BGM 在不在、能不能播）
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/dist-minitool/index.html" \
  shots/_mini-assets.png tools/minitool-assets-check.json
```

`check-embed-sync.py` 比的是**解析后的对象**而不是文件时间戳：mtime 会被「改一次再改回来」
和编辑器重写同内容骗到，而 `data.js` 是快照 —— 源码走 `fetch`、产物走内联常量，
陈旧时两边都正常运行，只有逐项读数值才看得出来。脚本内置了打包器**两处**已知改写
（剥 `_说明`、`pixelRatioMax → 1.5`），否则会天天误报。
反例自检过：把 `bed.surfaceY` 改成 1.45，脚本立刻 `exit 1` 并指到 `/bed/surfaceY`；
2026-09-21 夜也真报过一次 —— 打包的 60 秒后用户把 `audio.volume` 改成 0.75，
脚本立刻指出 `/audio/volume: 源码 0.75 vs 包内 0.55`。

⚠ 它以前还有第三条归一化：**把 `audio.tracks[*].file` 的 `.xml` 去掉再比**（那时打包器
会改名）。打包器改成「资源原样搬」之后这条必须删 —— 留着它会**把真实的改名差异抹平**
（包里的名字被剥掉 `.xml` 去比，正好比中），是最危险的那种「假绿」。它这次报出的
`/audio/volume` 差异也顺手证明了：少一条归一化并没有把误报带回来。

产物侧实测（`2026-09-21` 夜，按新床 + 资源原样进包重打包）：

| 检查 | 产物读数 | 说明 |
|---|---|---|
| 云片 / 梯长 | `cloudPuffs 360` · `ladderLen 12.9` | 与源码一致 |
| 床模型 | `bedModel{url "./models/bed2.glb.xml", rotationY 1.5708, topFrac 0.64, fit [2.35,3.4534,1.8719], worldSize [4.7,2.25,3.4]}` | 打包脚本从 `scene.json` 取路径，不会静默塞旧床 |
| 床来源 | `__bedSrc{via "file", url "./models/bed2.glb.xml", chunks 1}`；`file://` 下 `via "inline"`（`Failed to fetch`） | 文件优先、内联兜底，两条路 `worldSize` 相同 |
| 资源清单 | `verify_manifest()` → `16 项齐全`；打包器输出里 `models/bed2.glb.xml` 与三首 `.mp3.xml` 逐个 ✓ | `models/` 漏搬就是这一条拦的 |
| 曲目 | `audio.tracks` 3 首，`currentSrc` 分别 `bgm-1-everything.mp3.xml` / `bgm-2-dream-playground.mp3.xml` / `bgm-3-dream-ambience.mp3.xml`，`err null` · `readyState 4` · 时长 `33.3 / 13.24 / 194` s | 改名去掉 `.xml` 也能播，但**配置写什么就搬什么** |
| 音量 | `audio.volume 0.75`（读产物，不是读源码） | 打包 60 秒后用户改的那个值也落包了 |
| 床缩放 | `bedGroupScale [1.8,1.44,1.8]` · `cfgSurfaceY 2.0736` · `avoidHalf [4.83,3.66]` | 逐轴缩放 + 无草区外推都生效 |
| 床面 | 射线众数 `2.05` vs 锚点 `2.0736`（差 2.4 cm）· `rayHits 90/121` | 视觉被面与逻辑锚点对得上 |
| 加载提示 | `boot{hidden true, reason "ready", visible false}` · 计算样式 `none/0/hidden` | 提示在场→退场的完整生命周期 |
| 启动剖面 | `marks` 14 项（本次：`paint 163 → build+ 164 → sky 3743 → terrain 5484 → veg 5698 → bed 5703 → rig 5707 → build- 5720 → frame 6118 → task-0 32054 → hide`） | 见下「启动慢在哪」；**无头数字浮动很大，看的是顺序不是绝对值** |
| 时相表 | `cloudShadeStates ["dawn","sunset","night"]` | 白名单字段没被构建丢掉 |
| 下午档 | `shade{hinge 0, backDark 0, untouched 360}` | 未配置 ⇒ 颜色逐位不动 |
| 夜间档 | `shade{hinge 0.8, backDark 0.36, backMix 0.46, env #3f57c8, kMin 0.64}` | 压暗 + 混本档环境色都活着（`untouched` 随未定种子的云片布局浮动，非回归） |
| 雾 | 白天 `12.5/2600`，夜间 `#1e2a4c 13/2609`，`fogAnimMs 2333` | 三个旋钮合成值落包正确 |
| 夜蓝 | `ambient #3f57c8` · `hemi #485fd4` | ΔB≥ΔG 的配比进了包 |
| 爬梯 / 上床 | `climbSpeed 1.15` · `mountSpeed 2.3` | 两段速度仍分开 |
| 行为 | 漫游 ⌛ 后 `mode=walk, foot=2.928=bedTop` · 复位 `posErr 0` | 与源码一致 |
| 报错 | `window.__errs []` | 干净 |

### 启动慢在哪（`__boot.state.marks`）

用户说「启动加载有点慢」时，第一个要回答的是「慢在哪一段」—— 而 `build()` 是一整段同步
代码，从外面看不出内部分段。所以入口处埋了 `BOOT.mark(name)`，读数形如
`[[0,"tip"],[4,"config"],[11,"paint"],[12,"build+"],[3184,"sky"],…]`（单位 ms，值 = 相对提示出现时刻）。

无头（软件渲染、无 GPU）实测：`config` 4ms → `paint` 11ms → `build+` 12ms（提示那一帧已上屏，
重活才开始）→ `sky` 3184 → `terrain` 5032 → `veg` 5231 → `bed` 5239 → `rig` 5256 → `build-` 5256
（整段 `build()` 约 5.2s，其中**地形贴图 1.85s、天空 3.17s**）→ `frame` 5633 →
**`task-0` 14315**（床 GLB 的解析 + 3 张贴图解码，约 8.7s）→ `hide`。

⚠ 这几个绝对值**浮动很大**（同一台机器同一份产物，一晚里量到 `task-0` 14.3s / 24.5s / 29.0s /
32.1s / 46.3s，`sky` 3184→6863）：无头软件渲染 + 机器上有别的东西在跑，数字只能用来**定位是哪一段**。
有一次 29.0s 是**真 bug 引起的**（兜底定时器误判、GLB 解析跑了两遍，见「资源原样进包」），
所以看到异常值先想「是不是有活干了两遍」，别急着归给机器慢。

两个要点：① 天花板不在渲染循环，而在**两张程序化贴图（sky/terrain）与 GLB 解析**；
② 床 GLB 已登记成 `BOOT.task()`，所以**提示会一直留到床到位**，不会先撤提示再「啪」地冒出床来。
无头数字比真机差很多（无 GPU、纹理解码走软件路径），只用来**定位是哪一段**，不当性能结论。

⚠ **产物截图不加 `--force-prefers-reduced-motion` 会差 114~180px**（BGM 图标动画相位），
所以三图对照必须带上它，否则「逐像素相同」这条根本过不了。

**等价的证据**：用 `tools/freeze-pre.js`（定种子 + 冻时钟）跑三份对照 ——
`{源码 http} × {产物 http} × {产物 file://}`，三张 1264×625 冻结截图**两两 0 差异像素、最大通道差 0**，
读数逐项相同（`scene.children 23`、`bed 网格 11`、`云片 360`、`梯长 12.9`、`__errs []`）。
（产物多出的 `REVISION 160` 与 `hasAPP/hasM true` 是 `window.THREE` 注册表本身，不是渲染差异。
另外**产物要用 `--force-prefers-reduced-motion` 截图**：BGM 图标的动画相位会让两张图差 114px。）

```bash
# 三张冻结截图（新增 tools/minitool-frozen-assets.json：在原有读数上多读 __bedSrc）
export PRE_SCRIPT="$(cat tools/freeze-pre.js)" CHROME_ARGS_EXTRA="--force-prefers-reduced-motion"
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/index.html" shots/_d-src.png            tools/minitool-frozen-assets.json
$NODE tools/headless-interact.mjs "http://127.0.0.1:8123/dist-minitool/index.html" shots/_d-dist-http.png tools/minitool-frozen-assets.json
$NODE tools/headless-interact.mjs "file:///E:/workbuddy/cloud-ladder/dist-minitool/index.html" shots/_d-dist-file.png tools/minitool-frozen-assets.json
# 逐像素（全图 mean/bad%/max；box 不传就是整张）
"/c/Users/star/AppData/Local/Programs/Python/Python311/python.exe" tools/make-minitool-preview.py   # 需要 PIL/numpy ⇒ 用 Python311
```

⚠ 这次三图是 **`file://` 那张最值得看**：它的 `via` 是 `inline`（`Failed to fetch`），
也就是**容器那种「读不到本地文件」的处境**，而画面仍然是 0 差异 —— 内联兜底不是摆设。

⚠ **冻结时钟下还必须等加载提示退场**（`tools/minitool-frozen-bar2.json` 里已加这条 `waitFor`）：
提示只做了 `opacity: 0`，而它的三个呼吸点是 CSS 动画、走的是合成器时钟，不归 `performance.now()`
管 —— 提示没退场时那 32×6 px 会差 `max 36`。冻结截图里等的是**计算样式** `opacity === '0'`
（元素不在就直接为真），不是某个内部标记。

### 冻结时钟揭出来的一个真 bug：`settle()` 的定时器自我重排

「最短显示时长」原来的写法是**每次重算剩余时间再排一个定时器**：

```js
const wait = BOOT_MIN_MS - (performance.now() - st.startedAt);
if(wait > 0){ if(!st.timer) st.timer = setTimeout(() => { st.timer = 0; settle(); }, wait); return; }
```

只要时钟不动（无头脚本把 `performance.now` 钉成常量、系统休眠唤醒、某些 WebView 降时钟精度），
`wait` 就恒等于 `MIN` ⇒ 回调里再算还是 `> 0` ⇒ **每 420ms 排一次，提示永远不退场**。
症状是冻结截图里提示一直盖着画面，而「实际等了多少秒」看不出问题。

改法是**回调里现判条件，不依赖时钟**：

```js
if(!st.timer) st.timer = setTimeout(() => {
  st.timer = 0;
  if(st.mode === 'hold' || st.hidden) return;
  if(st.firstFrame && st.tasks === 0) hide('ready');
  else settle();                 // 还没就绪：等下一次 task/frame 通知再来
}, wait);
```

教训：**任何「等够 N 毫秒再做事」的定时器，判定条件都不该是「再算一遍还剩多少毫秒」**，
而应是「到点了，条件成立吗」。前者的收敛性依赖时钟前进这个隐含假设。

### 三项如实登记的未达标项（已实测，未优化）

| 项 | 实测 | 门槛 |
|---|---|---|
| 三角数 | 桌面档 `triangles 709258` / 移动档 `?mobile=1` 519686 | skill 建议 100k / 50k |
| 运行时降档 | 只有「一次性机型判定降档」，**没有运行时逐级降档** | 逐级降档 |
| zip 体积 | 3.88 MiB（音频 2.46 MiB = 63%、模型 0.59 MiB、**内联兜底 0.78 MiB**） | 建议 2 MiB（上限 10 MiB） |

zip 这一项里有 0.78 MiB 是**可以立刻去掉的**：`--no-bed-fallback`（前提是确认容器能读
包内相对路径的文件）。剩下的 3.10 MiB 才真的只能动音乐与模型本身。

桌面档其余读数：`drawCalls 1160 / geometries 391 / textures 31 / programs 43 / pixelRatio 1 /
drawingPixels 790000 / maxTextureSize 8192 / webgl2 true / postfx true`；
移动档：`drawCalls 670 / geometries 229 / shadowMap 1024 / plantQ 0.45 / cloudQ 0.55`。
另：**Chrome 61 真机未实测**（只有无头 Chrome 与桌面 Chrome）。

⚠ 区域参数的顺序**两个工具不一样**：`png-stats.py` 是 `x0,y0,x1,y1`，
`make-ab.py` / `cloud-mass.py` 是 `y0,y1,x0,x1`。传错不报错，会默默量到画面别处。

周期性动画（云的风、蝴蝶、波动）验证时用 `__dbg.uTime.value = T` 直接跳到任意场景时刻，
再 `waitFor` 一帧即可 —— 无头帧率只有 0.5~2、dt 被钳到 0.1s，按墙钟等待每秒只推进约 0.06s 场景时间。

`tools/headless-interact.mjs` 在 `Page.navigate` 之前注入 `error` / `unhandledrejection` /
`console.error` 钩子 → `window.__errs`，所以每次跑完都能直接断言「有没有报错」。

`tools/verify-tuft-color.json` 兼作**回归冒烟**：一条命令同时验证草色板 + 三个机位截图 + 报错数，
用来确认「上一轮改动还在不在」。

## 已知注意事项

- **同一文件不要并行发两条编辑**，会丢一条。串行改，改完 `grep` 确认。
- 无头渲染约 0.6~2 fps，等待要走状态轮询（`waitFor`）或按帧号等足，不能按墙钟时间估。
  判断「动画走到哪了」要读 `__dbg.uTime.value`（场景时钟），不要看等了多久。
- 改了 `main.js` / `style.css` 建议把 `index.html` 里的 `main.js?v=N` 版本号 +1，跳缓存。
- 手写的 `tools/*.json` 步骤文件先校验一次再跑：
  `python -c "import json;json.load(open('tools/x.json',encoding='utf-8'))"`。

### 像素级对照（A/B）的四个前提

做「碰云前后是否逐像素一致」这类对照时，画面里**任何**会自己动的东西都会污染读数：

1. 冻结风：`__dbg.cloud.userData.flow.gain = 0`（否则整朵云在慢速游移）；
2. 隐藏植被与 UI：`['grass','tufts','lavender','butterflies','daisies','glints'].forEach(k=>__dbg[k].visible=false)`
   + 把 `.overlay / #modes / #sticks / #jump-btn / #mode-hint / #bgm` 设为 `display:none`
   （蝴蝶在飞、光斑在闪、♪ 图标在转 —— 只藏植被也会带上千个差异像素）；
3. **以「差异像素数」为准，不要看「亮度变化 %」**：在低对比场景（比如隐藏植被后草占满整屏）
   均值会被大片同色背景稀释，出现「被碰中 −2.2%、回弹后 −4.6%」这种自相矛盾的读数；
4. 先拍「噪声地板」：同一机位静止拍两张做基线对照。地板是 0 时才说明这个机位干净，
   信号才有意义（`png-stats.py --diff` 在 0 差异时会直接打印「逐像素一致」，不会崩）。

床/梯子那块永远有几百像素的自身微动，定位变化区域时用一个「差异包围盒」小脚本，
别把它的读数算到云头上。

### 想做「只改了一个元素」的对照，必须先把时间轴钉死

无头下每张 `shot` 都落在不同的动画时刻，风、草、蝴蝶、云都在动 —— 直接拿两张隔了几帧的图
做 diff，光草丛摆动就能贡献 13% 的差异像素，真正的信号会被淹掉。**先冻帧再拍**：

```js
window.__pinT = 9;
Object.defineProperty(__dbg.uTime, 'value', {                       // uTime.value += dt 变成 no-op
  configurable: true, get: () => window.__pinT, set: () => {}
});
__dbg.cloud.userData.flow.gain = 0;                                 // 云的风
__dbg.postfx.pinTime(3.0);                                          // 调色自己的时钟（见下）
```

`uTime` 是 `THREE.Uniform`，直接赋值会被下一帧的 `+= dt` 覆盖，所以要用
`defineProperty` 换成常量 getter。另外 `tools/headless-interact.mjs` 的 `--window-size=1280,720`
可以用 `CHROME_ARGS_EXTRA="--window-size=390,844"` 在后面再传一次来覆盖（验证移动端断点）。

**`postfx` 有自己的时钟，只冻 `uTime` 是不够的。** 它内部是 `state.t += dt`，颗粒（`uGrain`）
与扫描线都拿这个时间当扰动源。开着默认的 `dream` 滤镜（`grain 0.015`）时，
不钉住它就是「同一状态拍两张」也会差出一片噪点 —— 实测 `max 15 / 11 万像素 > 2`，
看着特别像状态泄漏，其实只是胶片颗粒在走。用 `__dbg.postfx.pinTime(t)` 钉死（`unpinTime()` 解除）。

还有两个**UI 层**的非确定性，做逐像素断言时要一起隐掉，否则残差会稳定地出现在面板那一片：

| 元素 | 为什么会动 |
|---|---|
| `#mode-hint` | 文案随每次点击变化（`flashHint`），内容不同就是不同像素 |
| `#bgm` | 播放指示图标带 CSS `animation` |
| `#scene-ui` 面板 | 按钮有 `transition: box-shadow .18s` / `.ui-tip` 有 `opacity .25s` 渐变 |

全部隐掉之后，`max diff = 0` 才是可复现的结论；留着面板就只能断言「场景层一致」。

### Sprite 的尺寸必须有上限

`Sprite` 不是「在世界里摆的一块板」，而是把贴图按 `scale` **在视空间里直接撑开**的四边形。
半宽一旦逼近它到相机的距离，四边形就会横跨半个屏幕、贴图被极端拉伸，四边形的**直边**原样露出来 ——
天上一大块带硬边的浅色板，把渐变整个洗掉（`buildFarClouds` 的 `maxHalfRatio` 护栏就是这个原因）。
另一条同源的是**贴图必须四周 alpha=0**：`makeCloudTexture` 的 `edge` 羽化，否则自定义拉伸
（`sx .55 / dy 2.2`）会让 wisp 横向铺满画布、左右边缘还剩 0.3~0.8 的不透明度，边缘一样会露出来。

### 换时相必须「每档把每个字段都写一遍」

`atmosphere.js` 的设计是「每档只覆盖它声明了的字段，没声明的沿用 `base`（scene.json 快照）」——
这样「下午」就是一个空覆盖，天然等于「什么都不做」，默认画面与加时相之前逐像素一致。

**但这个设计的代价是：任何一处「没给值就跳过」的写法都会变成状态泄漏。**
实际踩到的：`setTint()` 开头是 `if(!hex) return;`，而「下午」刻意不给 `tint`
⇒ 从夜间切回下午时，函数直接返回，云的颜色就停在夜间的薰衣草紫上。
远云和远景环山同理（它们也是从同一个登记表染色的）。

现在 `apply()` 里**没有任何一条「字段缺省就跳过」的分支**，一共 12 组：

| 项 | 缺省时的行为 |
|---|---|
| `sun` / `hemi` / `ambient` | 抄 `base` 的颜色与强度 |
| `sky` 的 7 个 uniform | 抄 `base` |
| `exposure` | 抄 `base` |
| `tint.bg` / `tint.cloud` | **`mix = 0` = 抄回构建期原色**（不是跳过） |
| `orb` 位置/大小/颜色/透明度 | 走各自的默认值，**不看上一个时相留下什么** |
| `stars.size` / `opacity` | 走 `STAR_DEFAULT` |
| `fog`（含 `fogDense`） | 抄 `base` 的雾色/near/far（**目标**立即记下，near/far 由 `update()` 渐变过去） |
| `bloom` 覆盖 | 传 `null` ⇒ 后处理回落到当前滤镜预设 |

配套的验证脚本是 `tools/statetest.json` / `statetest-fx.json`：在**同一次页面加载内**
把「下午」的完整指纹（780 个材质的颜色+不透明度、雾、天空、灯光、曝光、星星、天体、bloom）
存下来，然后走一圈 `夜间 → 清晨 → 日落 → 夜间 → 超大雾 → 小雾 → UI 连点`，
每次回到下午都比对一遍 —— 全部 `MATCH`，首尾两张实拍 `max diff = 0`。
脚本里同时留了**对照组**（切到夜间/清晨/日落时的读数），会正确报出 406 项云色差异 +
雾/天空/灯光/曝光/bloom 全变，用来证明这个指纹确实在测东西、不是空过。

> 指纹里现在多了两项，都是这一版加的：
> `fog` 字段末尾拼上了目标值（`…|to[25,5200]`），所以**中间值不参与断言、目标值要断言**；
> `__fp()` 开头会先调 `atmos.settleFog()` 把 2 秒的雾渐变走完 ——
> 雾的渐变另有专项脚本（`tools/fog-steps.json`）验证，这里要验的是「切换是否把每个字段都写全」。

### 给某个量加过渡动画时，会连带塌掉的两件事

把一个原本「瞬时赋值」的量改成「N 秒内渐变」，除了动画本身，还有两处一定会被牵连：

1. **所有由它派生的量必须改成每帧重算。** 雾的 `far` 一变，天体透明度（`veil`）与远云
   被抹掉的程度（`applyCloudVeil`）都跟着变 —— 原来只在切换时算一次，现在要挪进
   `applyFogDerived(far)` 里由 `update()` 每帧调。不改的话，渐变过程中会出现
   「雾正从远处漫过来、月亮却已经先暗掉了」这种对不上的帧。
   反过来说，**到位后必须真的停**（`t >= 1` 直接 `return`），否则静止时也在每帧遍历几百个材质。
2. **所有「取状态指纹」的脚本都要先把动画走完。** `statetest.json` 原本是「切完立刻读」，
   加了渐变之后读到的是中间值，会整片报 DIFF（看着像状态泄漏，其实是动画在走）。
   两种处理都行：`atmos.settleFog()` 立刻到位，或配置 `fogAnimMs: 0`。
   这一版选了前者，并且在指纹里额外记下**目标值**，保证断言的是「该到哪」而不是「现在在哪」。

时间来源也要小心：`uTime` 被冻住（`performance.now()` 恒返回 0）时 `dt = 0`，
这时渐变由 `update(dt)` 的参数驱动 —— 反而方便把动画**手动步进**到指定的 t 再截图
（`tools/fog-strip.json` 就是这么出四联图的），比等墙钟稳得多。
