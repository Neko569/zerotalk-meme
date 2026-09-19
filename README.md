# 零语表情包助手

从网上搜索表情包，一键以**图片消息**发到零语（app.zerotalk.cn）聊天房间的油猴脚本。
带悬浮窗，适配手机端 **Via 浏览器**。

## 文件

| 文件 | 说明 |
| --- | --- |
| `zerotalk-meme.user.js` | 油猴脚本本体，直接安装即可 |
| `PROTOCOL.md` | 从抓包 + 前端产物逆向出的上传/发送协议（实现依据） |
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

## 兼容性

- 代码只用 ES2020 语法（`?.` / `??`），另为 `Promise`、`URLSearchParams`、Shadow DOM、`createImageBitmap`
  都写了降级分支。Android WebView ≥ 80（2020 年）即可。
- 核心不依赖 Shadow DOM：老内核下自动退化为普通 DOM + 前缀化样式。
