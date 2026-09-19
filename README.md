# 零语表情包助手

从网上搜索表情包，一键以**图片消息**发到零语（app.zerotalk.cn）聊天房间的油猴脚本。
带悬浮窗，适配手机端 **Via 浏览器**。

## 文件

| 文件 | 说明 |
| --- | --- |
| `zerotalk-meme.user.js` | 油猴脚本本体，直接安装即可 |
| `PROTOCOL.md` | 从抓包 + 前端产物逆向出的上传/发送协议（实现依据） |
| `preview.html` | 离线联调页：用桩件模拟零语后端，可在浏览器里核对请求序列与 UI |
| `test-user-script.js` | Node + vm 桩件测试（111 项断言），含手势回归与动图 WebP 容器结构验证 |
| `log.txt` | 你提供的原始抓包记录 |

## 安装

1. **桌面 Chrome / Edge**：装 Tampermonkey → 打开 `zerotalk-meme.user.js` → 新标签页粘贴 / 直接把文件拖进浏览器。
2. **手机 Via 浏览器**：菜单 → 扩展 → 脚本管理 → 新建脚本 → 粘贴 `zerotalk-meme.user.js` 全部内容 → 保存。
   - Via 的脚本实现支持 `GM_xmlhttpRequest`、`GM_setValue`、`GM_getValue`，本脚本都有纯前端兜底。
3. 打开 `https://app.zerotalk.cn/app/chat/<房间ID>`，右下角会出现 😊 悬浮球。

## 用法

- 点悬浮球 → 打开面板，输入关键词（如 `哈哈`、`猫`、`无语`）→ 搜索。
- 点缩略图选中 → 点「发送」。开启「点击直接发送」后单击即可发出。
- **换一批**：翻下一页。**发链接**：直接粘贴任意图片直链发送。**传本地**：从相册/本地文件发送。
- 面板可拖动（拖标题栏）、可缩放（右下角手柄）、可换主题；位置和尺寸会记住。
- 手机上面板自动变成底部大面板。

## 发送时到底做了什么

严格复刻官方客户端，不是「模拟点击」：

```
① POST /api/upload/presign   upload_source=chat_image&content_type=…&bytes=…&ext=…&room_id=…
② PUT  <返回的 OSS 签名URL>   Body = 原始字节
③ POST /api/upload/bind      ticket_id=…
④ WS   {event:"message", type:"image", content:<url>, image_url:<url>}
```

- 第 ④ 步没有自己另开 WebSocket，而是在 `document-start` 钩住页面自己的
  `WebSocket.prototype.send`，复用 App 已认证好的那条连接 —— 与真人操作发出的帧**逐字节一致**。
- 请求头 `X-Device-Id` 取自站点自己的 Cookie `zt_reg_did`，同源 XHR 自动带 Cookie。
- 发送成功以「服务端把消息广播回来」为回执，未收到回执会提示「已提交（未收到回执）」。

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

**多源自动回退**：搜索时如果当前源报错或返回空，脚本会按顺序自动尝试其余启用的源，切换时会在状态栏和日志里说明，并把真正出结果的源记住，这样「换一批」不用再走一遍失败流程。

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

GIF 通常又大又糊，转成 WebP 能省一半左右。脚本支持两种模式（设置里的「GIF → WebP」）：

| 模式 | 说明 |
| --- | --- |
| **动图 WebP**（默认） | 逐帧解码 → 逐帧编码 → 自封装成动图容器，**保留动画** |
| 静态 WebP | 只取首帧。体积最小，但动画没了 |
| 关闭 | 原样发 GIF |

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

**图片过大**
默认超过 4MB 自动压缩（GIF 不动，避免丢帧）。若服务端仍返回 `file_too_large`，脚本会降到 1MB 再压一次重试。

**手机上悬浮球挡住内容**
按住悬浮球拖到别处，位置会记住。

**手机上点悬浮窗没反应（v1.0.0 的 bug，v1.0.1 已修）**
旧版在 `touchstart` 里调了 `preventDefault()`。按 Touch Events 规范，一旦 `touchstart`
被取消，浏览器就不会再为这次轻点派发 `click` —— 桌面端不受影响（`mousedown` 的
`preventDefault` 不会掐掉 click），所以症状是「电脑端好的、手机端点不动」。

v1.0.1 改为：`touchstart` 完全不阻止默认行为，只有确认进入拖拽（位移超过 8px）后才
阻止 `touchmove` 滚动；轻点由 `touchend` 自行判定，并给紧随其后的合成 `click` 加了
500ms 抑制窗口，避免一次操作开两次面板。同时阈值从 2px 提到 8px（手指抖动不再被误判成拖拽），
标题栏里的 ⚙ / — 图标也不再被拖拽逻辑吃掉。升级脚本后刷新页面即可。

**装好了但界面上什么都没有**
确认脚本已启用（Tampermonkey 里开关是开的），并且当前在 `app.zerotalk.cn` 域下。
脚本用 `@run-at document-start`，需要在聊天页刷新一次才能挂钩到长连接。

**GIF 发出来还是 GIF，没转成 WebP**
看设置里「GIF → WebP」的模式是否为「关闭」，以及调试日志里有没有 `GIF→WebP：…` 这行。
常见原因是转换后没比原图小（日志会写「转换后反而更大，保留原 GIF」）——这是有意为之，
不会给你发个更大的文件。可以把质量往下调（0.6）再试。

**转完动画没了**
说明当前内核不支持 `ImageDecoder`（安卓 WebView < 94），脚本降级成了静态首帧。
此时会弹一个提示，不会静默。想保留动画就把模式改成「关闭」，原样发 GIF。

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
