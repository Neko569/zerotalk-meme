# 零语表情包助手

从网上搜索表情包，一键以**图片消息**发到零语（app.zerotalk.cn）聊天房间的油猴脚本。

入口直接**长在输入区自带的「表情」面板里**——原生面板多出第三个「梗图」栏，不额外占屏幕、不遮挡聊天。适配手机端 **Via 浏览器**。

## 文件

| 文件 | 说明 |
| --- | --- |
| `zerotalk-meme.user.js` | 油猴脚本本体，直接安装即可 |
| `PROTOCOL.md` | 从抓包 + 前端产物逆向出的上传/发送协议（实现依据） |
| `preview.html` | 离线联调页：桩件模拟零语后端**和原版表情面板**，可直接点着核对 UI 与请求序列 |
| `test-user-script.js` | Node + vm 桩件测试（245 项断言），含注入/三栏布局/设置迁移/正规化上传回归与动图 WebP 容器结构验证 |
| `.workbuddy/tmp/preview-verify.js` | 真实浏览器（headless Chrome + CDP）跑 `preview.html`：注入、三栏布局、缩略图尺寸，以及**三条上传路径**（官方 / 强制直连 / 无入口回落直连）各跑一遍 |
| `.workbuddy/tmp/settings-verify.js` | 真实浏览器 + **站点原版 CSS** 对照测试（74 项断言）：把设置面板和站内 `.chat-modal-*` 弹窗的 computedStyle 逐项比对 |
| `log.txt` | 你提供的原始抓包记录 |

## 安装

1. **桌面 Chrome / Edge**：装 Tampermonkey → 打开 `zerotalk-meme.user.js` → 新标签页粘贴 / 直接把文件拖进浏览器。
2. **手机 Via 浏览器**：菜单 → 扩展 → 脚本管理 → 新建脚本 → 粘贴 `zerotalk-meme.user.js` 全部内容 → 保存。
   - Via 的脚本实现支持 `GM_xmlhttpRequest`、`GM_setValue`、`GM_getValue`，本脚本都有纯前端兜底。
3. 打开 `https://app.zerotalk.cn/app/chat/<房间ID>`，点输入区的 😊 表情按钮——面板顶部原本的两个 Tab 变成了三个：**Emoji / 表情包 / 梗图**。
   - 懒得找按钮就用油猴菜单里的「**打开梗图面板**」，它会自己点开表情面板并切到梗图栏。

## 用法

- 点 😊 表情按钮 → 点顶部 **梗图** Tab。输入关键词（如 `哈哈`、`猫`、`无语`）→ 搜索。
- 点缩略图即可发出（默认「点击直接发送」）；在设置里关掉它，就变成先选中、再点「发送」。
- 工具行只有 **搜索** 和 **⚙** 两个控件：想换一批就换关键词再搜一次（搜索始终是「替换」而不是「追加」）。源切换搬进了 ⚙ 设置面板，链接直发和本地文件两个入口已撤掉（理由与恢复办法见 FAQ）。
- 发送默认走**官方上传通道**（把图交给站点自己的上传入口）。想改上传方式、或发现图没出现在聊天里，见「发送时到底做了什么 → 怎么选」。
- 点原生那两个 Tab 会立刻切回原生 Emoji / 表情包栏，梗图栏不会赖着不走。

### 每行几张（格子多大）

梗图栏嵌在表情面板里，高度只有一百多像素，所以**格子大小直接决定一屏能看几张**。

默认 `每行显示张数 = 6`。调小（如 `4`）格子更大、一屏看到的更少；调大（如 `8`）更密。

实现上是**写死列数**：`grid-template-columns: repeat(var(--ztm-cols,6), minmax(0,1fr))`。
这一点是 v1.2.3 特意改的——之前用 `auto-fill + 最小边`，而站点的输入区是 `position:fixed;left:0;right:0`、
`.chat-shell{max-width:none}`，**面板宽度直接跟着视口走、没有任何上限**，于是一宽就自己往上加列，
格子被挤得越来越小、「放大」不了。站点的原生两个栏也都是写死列数
（`.emoji-ui__row` 是 `repeat(var(--emoji-cols,8),…)`、表情包栏是 `repeat(4,…)`），改成固定列数既跟站点一个路子，
也让格子尺寸随面板变宽真正**变大**。

实测同一个面板宽度下新旧对比（gap 5px；「旧」= `auto-fill` 下限 68px）：

| 面板宽 | 旧的 auto-fill | 现在的 6 列 |
| --- | --- | --- |
| 390px（手机） | 5 列 · 70px | 6 列 · **56px** |
| 640px | 8 列 · 73px | 6 列 · **98px** |
| 1000px | 13 列 · 71px | 6 列 · **158px** |
| 1440px | 19 列 · 70px | 6 列 · **232px** |

> **注意手机端**：窄面板（≲ 470px）下 6 列比原来的 4~5 列**更小**，因为「每行 6 个」是硬约束。
> 如果你主要在手机上用、觉得小，把设置里的「每行显示张数」改成 `4` 就回到原来的大小（甚至可以 `3`）。

参数通过 CSS 自定义属性挂在梗图栏节点上，改动即时生效、不用重开面板。

## 设置面板长什么样

设置面板和提醒（toast）**不是自成一派的设计**，而是照抄站点自己的弹窗样式，所以它跟站内任何弹窗都是同一套视觉。

数值全部来自站点 CSS 里真实存在的规则（`.chat-modal-*`、`.toggle-switch`、`html.dark` 下的 `--zt-*`），不是估的：

| 元素 | 取值 | 来源 |
| --- | --- | --- |
| 面板 | `border-radius:22px`、`box-shadow:0 4px 6px #0f172a0a, 0 20px 48px #0f172a24`、无描边 | `.chat-modal-panel` |
| 遮罩 | `#0f172a6b` + `backdrop-filter:blur(6px)`；深色换 `#020617b8`；窄屏收到 `padding:1rem` + `blur(4px)` | `.chat-modal-overlay` / `html.dark .modal-mask` |
| 标题 | `1.0625rem / 600 / #1e293b`（深色 `#f1f5f9`） | `.chat-modal-heading` |
| 关闭钮 | `32×32`、圆角 `10px`、`#94a3b81a` 底 | `.chat-modal-close` |
| 字段 label | `.75rem / 500 / #64748b` | `.chat-modal-label` |
| 输入框 | 圆角 `10px`、边框 `rgba(148,163,184,.28)`、聚焦 `0 0 0 3px #3b82f61a` | `.chat-modal-textarea` |
| 说明文字 | `.6875rem / #94a3b8` | `.chat-modal-field-hint` |
| 开关 | 轨道 `40×22` / `#e2e8f0` → 选中 `#60a5fa`；圆钮 `16px`、`translate(18px)`、`0 1px 3px #0f172a1f` | `.toggle-switch` |
| 按钮 | 圆角 `12px`、`padding:.625rem 1rem`；主 `#3b82f6`→hover `#2563eb`；次白底描边 | `.chat-modal-btn--primary/--secondary` |
| 底部动作条 | `gap:.625rem`、两个按钮等分 | `.chat-modal-actions` |
| toast | 底 `#1e293b`、`border-radius:12px`，浮起动画 `translate(-50%,-8px) scale(.96)` → `translate(-50%)`，`.25s ease` | `.toast` / `.toast-pop-*` |
| toast 语义色 | 成功 `#d1fae5`/`#059669`、失败 `#fee2e2`/`#dc2626`、警告 `#fef9c3`/`#ca8a04`（深色各有一套） | `bg-emerald-100`+`text-emerald-600` 等 |

字体也统一成站点的 `HarmonyOS Sans, HarmonyOS Sans SC, PingFang SC, Microsoft YaHei, system-ui`。

三处刻意的差别（都是有原因的，不想要可以改回去）：

1. **宽度 400px**，用的是站内最宽弹窗 `.chat-modal-panel--alert` 的值，比表单弹窗（360px）宽一点——这里要放 JSON 文本域和长提示。
2. **头部有一条极淡的分隔线**（`rgba(148,163,184,.18)`，就是站点的 `--zt-border` 色值）。站内弹窗通常很短、不滚动，没有分隔线；我们这个是长表单要滚动，留一条更好读。
3. **分隔线只画在开关行之间**（`.f>.sw+.sw`），不用虚线、不留尾线。

另外，按钮**不要自己写 `line-height`**：站内是 Tailwind preflight 的 `html{line-height:1.5}` + `button{line-height:inherit}`，自己定一个 1.2 会让按钮比站内矮 4px。这条已经写进 `settings-verify.js` 当回归。

## 它是怎么「长」进表情面板的

零语的表情面板是个 Vue SFC（`ChatEmojiPanel`），原生只有两栏，靠一个 200% 宽的轨道左右平移来切换。脚本做的是：

1. 找到 `.composer-emoji-panel`，往 `.emoji-mode-tabs` 追加第三个按钮、往 `.emoji-swap__track` 追加第三个 `.emoji-swap__pane`；
2. 用一段覆盖样式把轨道改成 **300%**、每栏改成 **1/3**，第三个按钮的指示器随之外移两格；
3. 梗图栏的内容跑在**影子根（Shadow DOM）**里，与站点样式完全隔离，不会互相污染。

几个必须踩对的细节，都写进了测试做回归：

| 坑 | 处理 |
| --- | --- |
| 站点自己的 `.emoji-swap[data-mode=sticker]` 位移是**轨道宽度的 -50%**，轨道一变成 300% 就等于 -1.5 屏，表情包栏会错开半屏 | 覆盖成 `-33.333333%` |
| 站点 CSS 都是 `.class[data-v-<hash>]` 形式，注入的元素不带作用域属性就完全没样式 | 从原生 Tab 上读出 `data-v-*` 复制过来 |
| Vue 重渲染会用 `patchClass` 覆盖 `className` | 「当前是梗图栏」的状态**只写在属性上**（`data-ztm-meme`），不写 class |
| `flex-basis` 是 0，三个 Tab 的外宽只由 `padding` 决定；原生 `<button>` 带浏览器默认的 `1px 6px` | 统一三个按钮的内边距，否则梗图格窄 12px |
| 覆盖样式的选择器全部以 `[data-ztm-ready]` 为前提 | 注入失败时原生两栏布局**一点不受影响** |

## 发送时到底做了什么

有两条上传链路，默认走第一条（**官方通道**），可在设置里切换：

### ① 官方通道（默认）

把图片交给站点自己 composer 的 `<input type=file>`，让**官方上传器**跑完整条链路：

```
脚本侧：  造 File → input.files = <DataTransfer>.files → dispatchEvent('change', {bubbles:true})
站点侧：  presign → PUT OSS → bind → WS message(type=image)   ← 由站点代码自己完成
```

- 协议以后怎么变都不用我们跟；进度提示、失败提示也都是官方那套。
- **只能发 jpeg / png / webp**（站点聊天不认 GIF，它自己的 `toChatImage` 就是把 GIF 转 JPEG），
  所以 GIF 会先被转成静态图再交出去。

### ② 直连链路（可强制 / 自动兜底）

脚本自己按官方协议发，与真人操作发出的帧**逐字节一致**：

```
① POST /api/upload/presign   upload_source=chat_image&content_type=…&bytes=…&ext=…&room_id=…
② PUT  <返回的 OSS 签名URL>   Body = 原始字节
③ POST /api/upload/bind      ticket_id=…
④ WS   {event:"message", type:"image", content:<url>, image_url:<url>}
```

- 第 ④ 步没有自己另开 WebSocket，而是在 `document-start` 钩住页面自己的
  `WebSocket.prototype.send`，复用 App 已认证好的那条连接。
- 请求头 `X-Device-Id` 取自站点自己的 Cookie `zt_reg_did`，同源 XHR 自动带 Cookie。
- 能保留**动图 WebP**，错误分类更细（过大 / 格式不支持 / 校验失败）。
- 发送成功以「服务端把消息广播回来」为回执，未收到回执会提示「已提交（未收到回执）」。

### 怎么选

设置 →「上传方式」：

| 选项 | 行为 |
| --- | --- |
| **自动**（默认） | 能找到官方上传入口就交给官方；找不到（比如面板没打开）或交接失败，自动回落到直连链路 |
| 只用官方通道 | 强制官方；找不到入口就直接提示，不发 |
| 只用直连链路 | 强制脚本自己的链路（想发动图 WebP、或发现图没出现在聊天里时用它） |

> 官方通道的交接有两条硬规矩：**不能提前关表情面板**（提前关会让 Vue 重建 `<input>`，
> 刚塞进去的 `files` 一起丢），以及**必须跳过 `.sticker-ui__file` 和表情面板内的输入框**
> （那是收藏表情用的，不是发图）。

细节见 `PROTOCOL.md`。

## 内置表情源

| 源 | 状态 |
| --- | --- |
| 斗图啦 `doutupk.com` | ✅ 已实测：单页可提取 140 张，图片直链可跨域直取 |
| 发表情 `fabiaoqing.com` | ⚠️ 结构稳定但未实测，已内置 `thumb` 排除规则 |
| 慕名 API `xiaoapi.cn/v1/meme.php` | ✅ 已实测：JSON 接口，单页返回 40 张 |

**关于慕名 API（备用源）**

```
https://xiaoapi.cn/v1/meme.php?msg={kw}&page={page}&num=40
→ { code:200, page:"1", num:"40", data:[{img_url, img_size, img_height, img_width}], tips }
```

实测要点：

- **关键词参数叫 `msg`，不是 `text`/`keyword`。** 传错参数不会报错，只会**静默返回默认的「慕名」文字图**——很容易误判成"接口挂了"。分页参数是 `page`（1 起），必须和 `msg` 一起给；`num` 控制每页数量（默认 40，实测 60 也接受）。
- 图片来自腾讯表情 CDN `biaoqing.gtimg.com`，实测 jpg/png/gif 混合，**GIF 占比约 40%**。
- 搜不到结果时**不会返回空数组**，而是回落到「把关键词渲染成文字表情」的图，属正常行为。
- CDN 不返回 `ACAO`，图片同样要走 `GM_xmlhttpRequest` 或代理通道。

**多源自动回退**：搜索时如果当前源报错或返回空，脚本会按顺序自动尝试其余启用的源，切换时会在状态栏和日志里说明，并把真正出结果的源记住（**只记在本次会话**，不回写设置），这样之后继续搜不用再走一遍失败流程。

可在设置里改 `sources` JSON 增加自定义源：

```jsonc
// HTML 抓取型
{
  "id": "my-site", "name": "我的源", "enabled": true, "kind": "html",
  "url": "https://example.com/search?q={kw}&p={page}",   // {kw} {page} 占位符
  "referer": "https://example.com/",
  "pattern": "https://cdn\\.example\\.com/[^\"'\\s]+\\.(jpg|jpeg|png|gif|webp)",
  "exclude": "/thumb/",          // 可选，排除正则
  "https": true                  // 可选，把 http:// 升级为 https://
}

// JSON 接口型
{
  "id": "my-api", "name": "我的API", "enabled": true, "kind": "json",
  "url": "https://api.example.com/doutu?msg={kw}&page={page}",
  "path": "data.list[].url",     // 支持 [] 展开
  "urlKey": "url"                // 可选，数组元素是对象时取哪个字段
}
```

## 图片下载与跨域

表情包 CDN 基本都不返回 `Access-Control-Allow-Origin`，浏览器直连拿不到字节。脚本按此顺序尝试：

1. `GM_xmlhttpRequest`（油猴通道，无跨域限制）——**首选**
2. **图片代理**（默认 `https://wsrv.nl/?url=`，返回 `ACAO: *`）+ 油猴/fetch
3. 代理 + `<img crossOrigin>` → canvas
4. 直连 + `<img crossOrigin>` → canvas

> 如果你的脚本管理器没有 `GM_xmlhttpRequest`，第 2 步是主力通道。
> 代理可在设置里改或清空（清空 = 直连）。

## GIF → WebP

GIF 通常又大又糊，转成 WebP 能省一半左右。脚本支持三种模式（设置里的「GIF → WebP」）：

| 模式 | 说明 |
| --- | --- |
| **静态 WebP**（默认） | 只取首帧。体积最小，且**不依赖内核能力**，任何环境都能转 |
| 动图 WebP | 逐帧解码 → 逐帧编码 → 自封装成动图容器，**保留动画** |
| 关闭 | 原样发 GIF |

> **默认选「静态 WebP」**：只取首帧，体积最小，而且**不依赖 `ImageDecoder`**，老内核照样能用。
> 想要保留动画就切到「动图 WebP」（代价见下面的实现与兼容性说明）。
> 从 v1.2.0 及更早版本升级时，存档里的 `anim` 会被**一次性迁移**成 `static`——因为那多半只是
> 旧版的默认值，并不是你特意选的；迁移之后再手动改回来就会被记住（用 `settingsVersion` 保证只迁一次）。

### 怎么实现的

浏览器没有原生的「动图 WebP 编码器」——`canvas.toBlob('image/webp')` 只能出静帧。所以脚本：

1. 用 WebCodecs 的 `ImageDecoder` 逐帧解出 GIF 的每一帧（含每帧时长）；
2. 每帧画到 canvas 上，编码成一张**独立静帧 WebP**；
3. 把这些静帧的 `VP8 `/`VP8L`/`ALPH` 码流块抽出来，重新包进 `ANMF` 块，自己拼出 `RIFF/WEBP` 动图容器（`VP8X` 声明画布尺寸与动画标志 + `ANIM` 声明循环次数）。

### 实测数据（Chrome headless，3 张真实表情包 GIF）

| 质量 | 产出 / 原 GIF |
| --- | --- |
| q=0.90 | **1.16x ~ 1.98x**（反而更大） |
| q=0.80 | 0.69x ~ 1.19x |
| **q=0.70（默认）** | **0.40x ~ 0.85x** ✅ |
| q=0.60 | 0.40x ~ 0.71x |

**为什么 q=0.9 会变大**：GIF 每帧只存「变化区域」且用调色板 + LZW 压缩；而 WebP 这边每帧都是**整幅画面的有损编码**。所以对表情包这类小图，质量给太高反而吃亏。

据此设了两个保险：

- 默认质量 **0.70**、最长边 **480px**；
- 转换结果**只要没比原图小就自动降质/降分辨率重试**（最多 3 次），三次都压不下来就**直接发原 GIF**，绝不给你发个更大的文件。

> 另：这三张样本的「变化区域占比」实测都是 ~100%（整幅都在动），所以**没有**做只编码变化区域的优化——数据说明它在这个场景下没有收益。

### 兼容性

- `ImageDecoder` 需要 Chrome / 安卓 WebView **94+**。内核不支持时会**自动降级为静态首帧，并弹提示明确告知**，不会闷声把动画丢掉。
- 转换后的 WebP **不参与 JPEG 压缩**（那会把动图压成静态图，等于白转）。超限时改为降分辨率重转。
- 帧数超过 120 的 GIF 会放弃动图转换（避免手机卡死）。

## 常见问题

**「未捕获到聊天连接，请刷新页面」**
脚本在 `document-start` 钩 WebSocket，必须早于页面建立连接。刷新一次页面即可。

**发送后提示「未收到回执」**
图片已上传成功，但 9 秒内没等到服务端广播。通常是房间连接刚重连所致，重发一次即可。
（这条只会出现在**直连链路**下——官方通道由站点自己收发，脚本看不到回执。）

**发完了没报错，但聊天里没出现图片**
v1.2.4 起默认走**官方通道**：脚本只把图交给站点自己的上传入口，上传与发送都由站点完成。
好处是协议以后变了不用跟；代价是脚本看不到结果，失败也可能只体现在站点自己的提示里。

排查办法：设置 →「上传方式」改成**「只用直连链路」**再发一次。直连链路的每一步
（`presign` / `PUT` / `bind` / WS 帧）都写进调试日志，是否送达以服务端广播回执为准。
- 直连能发、官方不能发 → 多半是站点上传入口换了位置或判定条件变了，
  改 `findComposerFileInput()` 的选择规则（必须跳过 `.sticker-ui__file` 和表情面板内的输入框）。
- 两个都不能发 → 看调试日志里的 `err_code` / `msg`。

**动图发出来变成静态的了**
官方通道只收 jpeg/png/webp，**不认 GIF**（站点自己的 `toChatImage` 就是把 GIF 转 JPEG），
所以 GIF 会被先转成静态图再交出去。想要动图：切到「只用直连链路」，并把
「GIF → WebP」设成「动图 WebP」。

**图片过大**
默认超过 4MB 自动压缩（GIF 不动，避免丢帧）。若服务端仍返回 `file_too_large`，脚本会降到 1MB 再压一次重试。

**看不到「梗图」Tab**
两种常见原因：① 还没进聊天房间（输入区不存在，脚本无处注入）；② 改动后没刷新页面。
脚本用 `@run-at document-start`，请在聊天页刷新一次。也可以直接点油猴菜单里的
「打开梗图面板」——它会自动点开表情按钮并切到梗图栏，用来判断是「没注入」还是「没找对地方」。

**从带悬浮窗的旧版（≤ v1.1.1）升级**
v1.2.0 已经把界面整体搬进原生表情面板，**悬浮球没有了**，不会再遮挡聊天内容。
旧版记下的位置/尺寸会失效并被自动忽略，其余设置照常沿用。

**设置面板看起来跟网站风格不一样 / 想改回去**
v1.2.2 起设置面板、开关、按钮、toast 全部对齐了站内 `.chat-modal-*` 弹窗的设计语言
（圆角、投影、品牌蓝、字号、深浅色），见上面「设置面板长什么样」。
只有三处是刻意的：宽度 400px、头部有一条极淡分隔线、开关行之间才画分隔线。
想完全贴回站内（去掉分隔线、宽度收到 360px），改 `OV_CSS` 里 `.sh` 的 `border-bottom` 和
`.sheet` 的 `max-width` 即可。

**「换一批 / 链接 / 本地」按钮去哪了？源切换呢？**
v1.2.3 把工具行收成 **搜索 + ⚙** 两个控件：

| 原来的入口 | 现在 |
| --- | --- |
| 源切换（下拉） | **搬进设置面板**，叫「搜索时优先使用」。选「自动」= 按列表顺序依次尝试 |
| 换一批 | 撤掉。换个关键词再搜一次即可（搜索本身始终是「替换」而不是「追加」） |
| 链接 | 撤掉。想保留的话把按钮加回 `paneHtml()` 的 `.bar`、并在 `buildPaneUi` 的点击分支里接上 `sendOne({type:'url'})` 即可，发送链路一直支持 |
| 本地 | 同上，接 `sendOne({type:'file', file})` |

原因是梗图栏嵌在表情面板里、高度只有一百多像素，这一行按钮太占地方。
旧的 `缩略图最小边` 设置项也在这一版被 `每行显示张数` 取代——升级时会用 `settingsVersion`
把存档里遗留的 `thumbMin` 直接删掉，不留永远不再被读取的僵尸键。

**装好了但界面上什么都没有**
确认脚本已启用（Tampermonkey 里开关是开的），并且当前在 `app.zerotalk.cn` 域下。
脚本用 `@run-at document-start`，需要在聊天页刷新一次才能挂钩到长连接。

**GIF 发出来还是 GIF，没转成 WebP**
看设置里「GIF → WebP」的模式是否为「关闭」，以及调试日志里有没有 `GIF→WebP：…` 这行。
常见原因是转换后没比原图小（日志会写「转换后反而更大，保留原 GIF」）——这是有意为之，
不会给你发个更大的文件。可以把质量往下调（0.6）再试。

**转完动画没了**
两种情况：

1. 设置里选的是默认的**「静态 WebP」**——它本来就只取首帧，这是预期行为。
   想要动画就改成「动图 WebP」。
2. 选的是「动图 WebP」，但当前内核不支持 `ImageDecoder`（安卓 WebView < 94），
   脚本自动降级成了静态首帧。此时会弹提示，不会静默。这种情况只能原样发 GIF
   （把模式改成「关闭」），因为内核确实编不出动图 WebP。

**服务端返回「不支持的文件类型」**
v1.1.1 已修。根因是部分图床/CDN 把标准 MIME `image/jpeg` 返回成**非标准的 `image/jpg`**，
脚本原先直接把它透传给了 presign，服务端不认。现在改为：**以文件头字节为准**决定
`content_type` / `ext`，并把 `image/jpg`、`image/pjpeg`、`image/x-png` 这类别名归一化到标准值。
顺带也修了「URL 是 `.jpg`、响应头说 `image/jpg`、实际是 PNG」这类三方打架的情况。

调试日志里会有一行 `上传格式 {...}`，写明 `content_type` / `ext` / 是否按文件头识别（`sniffed`）。
如果 `sniffed: false`，说明这个格式的文件头没被识别，会回退用归一化后的声明值。

**服务端返回「不支持的文件类型」且这次是 WebP**
说明服务端对 `ext` 有白名单、不收 `webp`。脚本会自动**回退发送原 GIF** 并提示，
不会让这一张丢掉。想彻底避免可以到设置里把「GIF → WebP」改成「关闭」。

**上传失败 / 其他错误码**
在调试日志里能看到具体的 `err_code` 和 `msg`。

## 兼容性

- 代码只用 ES2020 语法（`?.` / `??`），另为 `Promise`、`URLSearchParams`、Shadow DOM、`createImageBitmap`
  都写了降级分支。Android WebView ≥ 80（2020 年）即可。
- 核心不依赖 Shadow DOM：老内核下自动退化为普通 DOM + 前缀化样式。
