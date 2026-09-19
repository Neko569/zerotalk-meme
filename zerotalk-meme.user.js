// ==UserScript==
// @name         零语表情包助手 · Zerotalk Meme Helper
// @namespace    https://app.zerotalk.cn/
// @version      1.2.4
// @description  在零语聊天输入区的原生「表情」面板里加一个「梗图」栏，搜索网络梗图并一键以图片消息发送。默认走官方上传通道（把图片交给站点 composer 的上传入口），官方入口不可用时回落到自实现的直连链路（presign → OSS PUT → bind → WebSocket message）。支持手机端 Via 浏览器，支持 GIF 转 WebP。设置面板与站内弹窗同一套视觉。版本号以外的描述同步更新。
// @author       Neko
// @match        *://app.zerotalk.cn/*
// @match        *://*.zerotalk.cn/*
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%98%82%3C/text%3E%3C/svg%3E
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      app.zerotalk.cn
// @connect      zerotalk.oss-cn-beijing.aliyuncs.com
// @connect      doutupk.com
// @connect      img.doutupk.com
// @connect      fabiaoqing.com
// @connect      xiaoapi.cn
// @connect      biaoqing.gtimg.com
// @connect      tugelepic.mse.sogou.com
// @connect      wsrv.nl
// @connect      *
// @run-at       document-start
// @noframes
// ==/UserScript==

/* eslint-disable no-multi-str */
(function () {
  'use strict';

  /* =========================================================================
   * 0. 常量 / 环境
   * =======================================================================*/

  var VERSION = '1.2.4';
  var PREFIX = 'ztm';

  // 从抓包日志还原的服务端常量
  var DEFAULT_BASE = 'https://app.zerotalk.cn';        // axios baseURL
  var DEVICE_COOKIE = 'zt_reg_did';                    // 设备指纹 Cookie 名
  var REQ_TIMEOUT = 90000;                             // uploadFileDirect 中 p = 9e4
  var API_TIMEOUT = 20000;                             // axios timeout = 15e3，略放宽

  var UNSAFE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  /* =========================================================================
   * 1. 基础设施：存储 / 样式 / 小工具
   * =======================================================================*/

  var nativeGet = (typeof GM_getValue === 'function') ? GM_getValue : null;
  var nativeSet = (typeof GM_setValue === 'function') ? GM_setValue : null;

  var store = {
    get: function (key, def) {
      try {
        if (nativeGet) {
          var v = nativeGet(key, undefined);
          if (v === undefined || v === null) return def;
          return (typeof v === 'object') ? v : safeParse(v, def);
        }
        var raw = localStorage.getItem(PREFIX + ':' + key);
        if (raw === null) return def;
        return safeParse(raw, def);
      } catch (e) { return def; }
    },
    set: function (key, value) {
      try {
        if (nativeSet) {
          nativeSet(key, JSON.stringify(value));
          return;
        }
        localStorage.setItem(PREFIX + ':' + key, JSON.stringify(value));
      } catch (e) { /* ignore */ }
    }
  };

  function safeParse(raw, def) {
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch (e) { return raw; }
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isMobile() {
    return /Android|iPhone|iPad|iPod|HarmonyOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
      || (window.innerWidth <= 820);
  }

  function isGif(mime, name) {
    if (/gif/i.test(mime || '')) return true;
    return /\.gif(\?|$)/i.test(name || '');
  }

  function bytesText(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* =========================================================================
   * 2. 设置
   * =======================================================================*/

  var DEFAULT_SOURCES = [
    {
      id: 'doutupk',
      name: '斗图啦',
      enabled: true,
      kind: 'html',
      url: 'https://www.doutupk.com/search?keyword={kw}&page={page}',
      referer: 'https://www.doutupk.com/',
      pattern: 'https?://(?:img\\.doutupk\\.com|doutula-oss[\\w.-]*\\.aliyuncs\\.com)/production/uploads/image/[^"\\\'\\s<>]+?\\.(?:jpg|jpeg|png|gif|webp)',
      https: true
    },
    {
      id: 'fabiaoqing',
      name: '发表情',
      enabled: true,
      kind: 'html',
      url: 'https://www.fabiaoqing.com/search/search/keyword/{kw}/page/{page}.html',
      referer: 'https://www.fabiaoqing.com/',
      pattern: 'https?://www\\.fabiaoqing\\.com/uploads/[^"\\\'\\s<>]+?\\.(?:jpg|jpeg|png|gif|webp)',
      exclude: '/thumb/|/_thumb\\.',
      https: true
    },
    {
      // 说明：这个接口的坑是关键词参数叫 msg 而不是 text/keyword ——
      // 传 text 不会报错，只会静默返回默认的「慕名」文字图，很容易误判成「接口坏了」。
      // 分页参数是 page（1 起），需与 msg 同时给出；num 控制每页数量（默认 40，实测 60 也认）。
      // 图片来自腾讯表情 CDN（biaoqing.gtimg.com），实测 jpg/png/gif 混合，GIF 占比约 40%。
      // 搜不到结果时不会返回空数组，而是回落到「关键词文字表情」图，属正常行为。
      id: 'xiaoapi',
      name: '慕名 API（备用）',
      enabled: true,
      kind: 'json',
      url: 'https://xiaoapi.cn/v1/meme.php?msg={kw}&page={page}&num=40',
      path: 'data[].img_url',
      https: true
    }
  ];

  var SETTINGS_KEY = 'settings';
  var SETTINGS_VERSION = 3;   // 1→2：GIF→WebP 默认「动图」改「静态」；2→3：缩略图改按「每行张数」

  var settings = mergeSettings(store.get(SETTINGS_KEY, {}));

  function mergeSettings(raw) {
    var base = {
      settingsVersion: SETTINGS_VERSION,
      baseUrl: DEFAULT_BASE,
      tapSend: true,                 // 点一下梗图就直接发送（像原生表情包栏那样）
      cols: 6,                       // 每行显示几张（网格列数），决定格子大小
      sourceId: '',                  // 优先使用的表情源；空 = 自动（按列表顺序尝试）
      uploadMode: 'auto',            // 上传方式：auto 优先官方通道 · official 只走官方 · manual 只走直连
      autoCompress: true,
      compressOverMB: 4,
      maxDimension: 1600,
      gifToWebp: 'static',           // 静态首帧：体积小、且不依赖 ImageDecoder
      webpMaxDim: 480,
      webpQuality: 0.7,
      imageProxy: 'https://wsrv.nl/?url=',
      preferHookSocket: true,
      allowStandaloneSocket: false,
      showLog: false,
      sources: null
    };
    var out = {};
    for (var k in base) { if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k]; }
    if (raw && typeof raw === 'object') {
      for (var k2 in raw) { if (Object.prototype.hasOwnProperty.call(raw, k2)) out[k2] = raw[k2]; }
    }
    // 老版本没写过 settingsVersion，它存下来的 gifToWebp:'anim' 只是「当时的默认值」，
    // 十有八九不是用户特意选的。一次性迁到新默认「静态」，之后用户再改就会被记住。
    var fromV = Number(raw && raw.settingsVersion) || 1;
    if (fromV < 2 && out.gifToWebp === 'anim') out.gifToWebp = 'static';
    // v3 起网格按「每行张数」排，不再用「缩略图最小边」。老存档里那个 thumbMin
    // 已经没有任何代码读它了，直接从存储里抹掉，别留个永远不改的僵尸键。
    if (fromV < 3) delete out.thumbMin;
    out.settingsVersion = SETTINGS_VERSION;
    // 上传方式是新增键，老存档里没有 → 这个归一化只是防手改存档写进非法值。
    // 注意：这里不能用文件后面才赋值的 var 常量（本函数在启动时立刻执行，那时它是 undefined）。
    if (out.uploadMode !== 'official' && out.uploadMode !== 'manual') out.uploadMode = 'auto';

    if (!Array.isArray(out.sources) || !out.sources.length) out.sources = clone(DEFAULT_SOURCES);
    return out;
  }

  function saveSettings() { store.set(SETTINGS_KEY, settings); }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function activeSources() {
    return (settings.sources || []).filter(function (s) { return s && s.enabled !== false && s.url; });
  }

  function getSource(id) {
    var list = settings.sources || [];
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) return list[i]; }
    return list[0] || null;
  }

  /**
   * 精确查找一个「可用」的源，找不到就返回 null。
   * 跟 getSource 的区别：getSource 找不到会回落成第一个（用它做「当前源」是对的），
   * 但判断「用户选的那个源还在不在」时必须用这个，否则一个被删掉的 id 也会「命中」。
   */
  function pickSource(id) {
    if (!id) return null;
    var list = settings.sources || [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s && s.id === id && s.enabled !== false && s.url) return s;
    }
    return null;
  }

  /** 本次搜索该优先用哪个源：设置里选的那个，否则第一个可用的 */
  function firstActiveId() {
    var list = activeSources();
    return list[0] ? list[0].id : null;
  }

  function preferSourceId() {
    return pickSource(settings.sourceId) ? settings.sourceId : firstActiveId();
  }

  /* =========================================================================
   * 3. 日志
   * =======================================================================*/

  var logBuf = [];

  function log() {
    var args = Array.prototype.slice.call(arguments);
    var line = '[' + new Date().toLocaleTimeString() + '] ' + args.map(function (a) {
      if (a instanceof Error) return a.message;
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
      return String(a);
    }).join(' ');
    logBuf.push(line);
    if (logBuf.length > 300) logBuf.shift();
    if (settings.showLog) {
      try { console.log('%c[表情包]', 'color:#e8734a;font-weight:bold', line); } catch (e) { /* ignore */ }
    }
    if (ui && ui.els && ui.els.sheet && ui.els.logBox && ui.els.logBox.parentNode &&
      !ui.els.sheet.classList.contains('off')) {
      ui.els.logBox.textContent = logBuf.slice(-80).join('\n');
      ui.els.logBox.scrollTop = ui.els.logBox.scrollHeight;
    }
  }

  /* =========================================================================
   * 4. WebSocket 钩子
   *    官方实现（index chunk）：
   *      wss://app.zerotalk.cn/ws
   *      认证: {event:"auth",user_id,ws_token,device_id,user_agent}
   *      心跳: {event:"ping",room_id}
   *      发送: ws.send(JSON.stringify(frame))  —— sendOverWebSocket 不做任何包装
   * =======================================================================*/

  var sockets = [];
  var wsListeners = [];

  function onWsFrame(raw) {
    var data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    for (var i = 0; i < wsListeners.length; i++) {
      try { wsListeners[i](data); } catch (e) { /* ignore */ }
    }
  }

  function installWsHook() {
    var targets = [];
    try { if (UNSAFE && UNSAFE.WebSocket) targets.push(UNSAFE); } catch (e) { /* ignore */ }
    try { if (window && window !== UNSAFE && window.WebSocket) targets.push(window); } catch (e) { /* ignore */ }
    for (var i = 0; i < targets.length; i++) patchWebSocket(targets[i]);
  }

  var patchedCtors = [];

  function patchWebSocket(W) {
    var OrigWS = W.WebSocket;
    if (!OrigWS) return;
    for (var i = 0; i < patchedCtors.length; i++) { if (patchedCtors[i] === OrigWS) return; }
    patchedCtors.push(OrigWS);

    function PatchedWS(url, protocols) {
      var ws = (protocols === undefined) ? new OrigWS(url) : new OrigWS(url, protocols);
      try {
        if (String(url).indexOf('/ws') !== -1) {
          sockets.push(ws);
          ws.addEventListener('message', function (ev) { onWsFrame(ev.data); });
          ws.addEventListener('close', function () {
            var i = sockets.indexOf(ws); if (i >= 0) sockets.splice(i, 1);
            log('WebSocket 已关闭');
          });
          log('已捕获 WebSocket:', String(url));
        }
      } catch (e) { /* ignore */ }
      return ws;
    }

    PatchedWS.prototype = OrigWS.prototype;
    try {
      ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { PatchedWS[k] = OrigWS[k]; });
    } catch (e) { /* ignore */ }

    try { W.WebSocket = PatchedWS; } catch (e) { log('WebSocket 钩子安装失败', e); }
  }

  function liveSocket() {
    for (var i = sockets.length - 1; i >= 0; i--) {
      var s = sockets[i];
      if (s && s.readyState === 1) return s;
    }
    return null;
  }

  function wsSend(frame) {
    var s = liveSocket();
    if (!s) return false;
    try {
      s.send(JSON.stringify(frame));
      return true;
    } catch (e) {
      log('WS 发送失败', e);
      return false;
    }
  }

  /* =========================================================================
   * 5. HTTP：完全对齐官方 axios 实例
   *    axios.create({baseURL, withCredentials:true, timeout:15e3})
   *    request 拦截器注入 X-Device-Id
   *    response 拦截器解包 {code:1,data:...}
   * =======================================================================*/

  function uuid4() {
    try {
      if (crypto && crypto.randomUUID) return crypto.randomUUID();
      if (crypto && crypto.getRandomValues) {
        var b = new Uint8Array(16); crypto.getRandomValues(b);
        b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
        var h = []; for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
        return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') +
          '-' + h.slice(8, 10).join('') + '-' + h.slice(10, 16).join('');
      }
    } catch (e) { /* ignore */ }
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
    });
  }

  function readCookie(name) {
    var parts = String(document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i].trim();
      var idx = seg.indexOf('=');
      if (idx < 0) continue;
      if (seg.slice(0, idx) === name) {
        try { return decodeURIComponent(seg.slice(idx + 1)); } catch (e) { return seg.slice(idx + 1); }
      }
    }
    return '';
  }

  var cachedDeviceId = null;
  function deviceId() {
    if (cachedDeviceId) return cachedDeviceId;
    var id = '';
    try { id = String(readCookie(DEVICE_COOKIE) || '').trim(); } catch (e) { /* ignore */ }
    // 与官方 Cc() 一致的格式校验：uuid 或 32~64 位 hex
    if (id && !/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{32,64})$/i.test(id)) {
      id = '';
    }
    if (!id) {
      id = uuid4();
      try {
        document.cookie = DEVICE_COOKIE + '=' + encodeURIComponent(id) +
          '; Path=/; Max-Age=' + (60 * 60 * 24 * 365) + '; SameSite=Lax' +
          (location.protocol === 'https:' ? '; Secure' : '');
      } catch (e) { /* ignore */ }
    }
    cachedDeviceId = id;
    return id;
  }

  function unwrap(json) {
    if (json && typeof json === 'object' && !Array.isArray(json) &&
      Object.prototype.hasOwnProperty.call(json, 'code')) {
      if (json.code !== 1) {
        var err = new Error(json.msg || json.message || '请求失败');
        err.payload = json;
        err.errCode = json.err_code;
        throw err;
      }
      return (json.data === undefined || json.data === null) ? json : json.data;
    }
    return json;
  }

  function baseUrl() {
    return String(settings.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  }

  // 与 axios 等价的 JSON 请求（same-origin，自动带 Cookie）
  function apiJson(method, path, body, extraHeaders, responseType) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var url = /^https?:/i.test(path) ? path : (baseUrl() + (path.charAt(0) === '/' ? path : '/' + path));
      xhr.open(method, url, true);
      xhr.withCredentials = true;
      xhr.timeout = API_TIMEOUT;
      xhr.responseType = responseType || 'text';
      try { xhr.setRequestHeader('X-Device-Id', deviceId()); } catch (e) { /* ignore */ }
      try { xhr.setRequestHeader('Accept', 'application/json, text/plain, */*'); } catch (e) { /* ignore */ }
      if (extraHeaders) {
        for (var k in extraHeaders) {
          if (Object.prototype.hasOwnProperty.call(extraHeaders, k)) {
            try { xhr.setRequestHeader(k, extraHeaders[k]); } catch (e) { /* ignore */ }
          }
        }
      }
      xhr.onload = function () {
        var txt = (responseType === 'text' || !responseType) ? xhr.responseText : '';
        if (xhr.status < 200 || xhr.status >= 300) {
          var pe = null;
          try { pe = JSON.parse(txt); } catch (e) { /* ignore */ }
          var ee = new Error((pe && (pe.msg || pe.message)) || ('HTTP ' + xhr.status));
          ee.status = xhr.status; ee.payload = pe;
          reject(ee); return;
        }
        if (!txt) { resolve(null); return; }
        var json;
        try { json = JSON.parse(txt); } catch (e) { reject(new Error('响应解析失败')); return; }
        try { resolve(unwrap(json)); } catch (e2) { reject(e2); }
      };
      xhr.onerror = function () { reject(new Error('网络错误')); };
      xhr.ontimeout = function () { reject(new Error('请求超时')); };
      xhr.onabort = function () { reject(new Error('请求已取消')); };
      xhr.send(body === undefined || body === null ? null : body);
    });
  }

  /* =========================================================================
   * 6. 下载图片字节
   *    优先级：GM_xmlhttpRequest → 图片代理 + fetch → 直连 fetch → <img>+canvas
   * =======================================================================*/

  function gmRequest(opts) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: opts.method || 'GET',
          url: opts.url,
          headers: opts.headers || {},
          data: opts.data,
          responseType: opts.responseType || 'arraybuffer',
          timeout: opts.timeout || 45000,
          anonymous: opts.anonymous !== false,
          onload: function (r) { resolve({ status: r.status, headers: r.responseHeaders || '', body: r.response }); },
          onerror: function () { reject(new Error('网络请求失败（GM 通道）')); },
          ontimeout: function () { reject(new Error('网络请求超时（GM 通道）')); },
          onabort: function () { reject(new Error('请求已取消')); }
        });
        return;
      }
      // 无 GM 通道时的 fetch 回退
      var init = { method: opts.method || 'GET', headers: opts.headers || {}, credentials: 'omit', mode: 'cors' };
      if (opts.data !== undefined) init.body = opts.data;
      fetch(opts.url, init).then(function (resp) {
        if (resp.status < 200 || resp.status >= 300) throw new Error('HTTP ' + resp.status);
        return opts.responseType === 'text' ? resp.text() : resp.arrayBuffer();
      }).then(function (b) { resolve({ status: 200, headers: '', body: b }); })
        .catch(function (e) { reject(e); });
    });
  }

  function fetchText(url, referer) {
    var headers = {};
    if (referer) headers['Referer'] = referer;
    headers['User-Agent'] = navigator.userAgent;
    headers['Accept'] = 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8';
    return gmRequest({ url: url, headers: headers, responseType: 'text', anonymous: true })
      .then(function (r) {
        if (r.status < 200 || r.status >= 300) throw new Error('抓取失败 HTTP ' + r.status);
        return typeof r.body === 'string' ? r.body : String(r.body || '');
      });
  }

  function mimeFromName(name) {
    var ext = String(name || '').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'png') return 'image/png';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'bmp') return 'image/bmp';
    return 'application/octet-stream';
  }

  /**
   * 归一化 MIME。
   *
   * 最要命的一个是 image/jpg —— 这不是标准 MIME（标准是 image/jpeg），
   * 但很多图床/CDN 就是这么返回的。零语服务端会直接回「不支持的文件类型」，
   * 而抓包日志里只看到 content_type: image/jpg，很容易误以为是 WebP 的锅。
   * 同类别名还有 image/pjpeg、image/x-png、image/x-webp 等。
   */
  function normalizeMime(m) {
    m = String(m || '').split(';')[0].trim().toLowerCase();
    if (!m) return '';
    if (m === 'image/jpg' || m === 'image/pjpeg' || m === 'image/x-jpg' ||
      m === 'image/jpe' || m === 'image/jfif') return 'image/jpeg';
    if (m === 'image/x-png') return 'image/png';
    if (m === 'image/x-webp') return 'image/webp';
    if (m === 'image/x-gif') return 'image/gif';
    return m;
  }

  /**
   * 按文件头识别真实格式 —— 比 content-type 可靠得多。
   * CDN 会撒谎：给 .jpg 的 URL 返回 PNG、动态接口返回的 URL 干脆没后缀、
   * jpeg 被写成 image/jpg……服务端只认标准值，所以上传前以字节为准。
   */
  var FORMAT_TABLE = [
    { mime: 'image/jpeg', ext: 'jpg', magic: [0xFF, 0xD8, 0xFF] },
    { mime: 'image/png', ext: 'png', magic: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
    { mime: 'image/gif', ext: 'gif', magic: [0x47, 0x49, 0x46, 0x38] },   // GIF87a / GIF89a
    { mime: 'image/bmp', ext: 'bmp', magic: [0x42, 0x4D] }
  ];

  function sniffFormat(head) {
    if (!head || head.length < 4) return null;
    var i, j;
    for (i = 0; i < FORMAT_TABLE.length; i++) {
      var f = FORMAT_TABLE[i];
      var hit = true;
      for (j = 0; j < f.magic.length; j++) {
        if (head[j] !== f.magic[j]) { hit = false; break; }
      }
      if (hit) return { mime: f.mime, ext: f.ext };
    }
    // WebP: RIFF....WEBP
    if (head.length >= 12 &&
      head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) {
      return { mime: 'image/webp', ext: 'webp' };
    }
    return null;
  }

  function sniffFormatBytes(buf) {
    if (!buf) return null;
    try {
      var u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
      return sniffFormat(u8.subarray(0, 16));
    } catch (e) { return null; }
  }

  function readMagic(blob) {
    return new Promise(function (resolve) {
      try {
        var head = blob.slice(0, 16);
        if (head && head.arrayBuffer) {
          head.arrayBuffer().then(function (ab) {
            resolve(new Uint8Array(ab));
          }, function () { resolve(null); });
          return;
        }
      } catch (e) { /* 落到下面的兜底 */ }
      resolve(null);
    });
  }

  /**
   * 决定这次上传用哪个 content_type / ext / 文件名。
   * 优先信文件头；认不出来才回退到（归一化后的）content-type 与文件名后缀。
   */
  function resolveUploadFormat(blob, filename) {
    var declaredRaw = String(blob.type || '');
    var declared = normalizeMime(declaredRaw);
    if (!declared || declared === 'application/octet-stream') declared = mimeFromName(filename);
    declared = normalizeMime(declared);

    return readMagic(blob).then(function (head) {
      var s = sniffFormat(head);
      var mime = (s && s.mime) || declared || 'image/jpeg';
      var ext = (s && s.ext) || extFromMime(mime);
      return {
        mime: mime,
        ext: ext,
        name: alignName(filename, mime),
        sniffed: !!s,
        declared: declaredRaw
      };
    });
  }

  function nameFromUrl(url) {
    try {
      var clean = String(url).split('#')[0].split('?')[0];
      var seg = clean.split('/').pop() || '';
      seg = decodeURIComponent(seg);
      if (seg && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(seg)) return seg;
    } catch (e) { /* ignore */ }
    return '';
  }

  function proxyUrl(original) {
    var p = String(settings.imageProxy || '').trim();
    if (!p) return '';
    return p + encodeURIComponent(original);
  }

  function refererFor(srcUrl) {
    var list = settings.sources || [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || !s.referer) continue;
      var host = '';
      try { host = new URL(s.referer).host; } catch (e) { host = ''; }
      if (host && srcUrl.indexOf(host) !== -1) return s.referer;
    }
    return '';
  }

  // 下载 → { blob, filename }
  // 依次尝试：GM/fetch 直连 → 图片代理 → 代理+canvas → 直连+canvas
  function downloadImage(srcUrl, onProgress) {
    var fileName = nameFromUrl(srcUrl) || ('meme-' + Date.now() + '.jpg');
    var referer = refererFor(srcUrl);
    var proxy = settings.imageProxy ? proxyUrl(srcUrl) : '';
    var attempts = [];

    attempts.push(function () {
      return gmRequest({ url: srcUrl, headers: buildImgHeaders(referer), responseType: 'arraybuffer', anonymous: true });
    });
    if (proxy) {
      attempts.push(function () {
        return gmRequest({ url: proxy, responseType: 'arraybuffer', anonymous: true });
      });
    }
    attempts.push(function () { return canvasGrabBlob(srcUrl); });
    if (proxy) {
      attempts.push(function () { return canvasGrabBlob(proxy); });
    }

    var idx = 0;
    function next() {
      if (idx >= attempts.length) {
        return Promise.reject(new Error('图片下载失败，可尝试关闭「图片代理」或改用本地上传'));
      }
      var fn = attempts[idx++];
      if (onProgress) onProgress(0);
      return Promise.resolve().then(fn).then(function (res) {
        if (res && res.blob) {
          var m0 = normalizeMime(res.blob.type) || mimeFromName(res.filename);
          if (m0 === 'application/octet-stream') m0 = mimeFromName(res.filename);
          if (m0.indexOf('image/') !== 0) throw new Error('返回内容不是图片');
          return { blob: (res.blob.type === m0) ? res.blob : res.blob.slice(0, res.blob.size, m0), filename: alignName(res.filename, m0) };
        }
        if (!res || !res.body || res.status < 200 || res.status >= 300) throw new Error('下载失败 HTTP ' + (res && res.status));
        var buf = res.body;
        if (!(buf instanceof ArrayBuffer) && !(buf instanceof Uint8Array)) throw new Error('响应体异常');
        // 文件头优先于响应头：CDN 会返回 image/jpg 这种非标准值，甚至给 .jpg 的 URL 回 PNG
        var sniffed = sniffFormatBytes(buf);
        var mime = (sniffed && sniffed.mime) || normalizeMime(sniffMime(res.headers)) || mimeFromName(fileName);
        if (mime === 'application/octet-stream') mime = mimeFromName(fileName);
        var blob = new Blob([buf], { type: mime });
        if (!blob.size) throw new Error('图片为空');
        if (mime.indexOf('image/') !== 0) throw new Error('返回内容不是图片');
        return { blob: blob, filename: alignName(ensureExt(fileName, mime), mime) };
      }).catch(function (e) {
        log('下载尝试 ' + idx + ' 失败：' + (e && e.message));
        return next();
      });
    }
    return next();
  }

  function buildImgHeaders(referer) {
    var h = { 'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' };
    if (referer) h['Referer'] = referer;
    try { h['User-Agent'] = navigator.userAgent; } catch (e) { /* ignore */ }
    return h;
  }

  function sniffMime(headers) {
    if (!headers) return '';
    var m = String(headers).match(/content-type\s*:\s*([^\r\n;]+)/i);
    return m ? m[1].trim().toLowerCase() : '';
  }

  function ensureExt(name, mime) {
    if (/\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(name)) return name;
    return name.replace(/\.[^.]*$/, '') + '.' + extFromMime(mime);
  }

  function extFromMime(mime) {
    if (mime === 'image/jpeg') return 'jpg';
    if (mime === 'image/png') return 'png';
    if (mime === 'image/gif') return 'gif';
    if (mime === 'image/webp') return 'webp';
    if (mime === 'image/bmp') return 'bmp';
    return 'jpg';
  }

  // 让文件名后缀与实际 MIME 保持一致，避免 presign 的 content_type 和 ext 互相矛盾
  function alignName(name, mime) {
    if (!mime || mime.indexOf('image/') !== 0) return name;
    var want = extFromMime(mime);
    var m = String(name).match(/\.([a-z0-9]+)$/i);
    if (!m) return name + '.' + want;
    var cur = m[1].toLowerCase();
    var norm = (cur === 'jpeg') ? 'jpg' : cur;
    if (norm === want) return name;
    // 只有后缀指向的 MIME 与真实 MIME 冲突时才改写
    var declared = mimeFromName(name);
    if (declared === 'application/octet-stream' || declared === mime) return name;
    return name.slice(0, -m[1].length) + want;
  }

  function canvasGrabBlob(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          var c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          c.toBlob(function (b) {
            if (!b) { reject(new Error('canvas 编码失败')); return; }
            resolve({ blob: b, filename: nameFromUrl(url) || ('meme-' + Date.now() + '.png') });
          }, 'image/png');
        } catch (e) { reject(new Error('canvas 读取失败（跨域受限）')); }
      };
      img.onerror = function () { reject(new Error('图片加载失败')); };
      img.src = url;
    });
  }

  /* =========================================================================
   * 7. 压缩（超限时使用）
   * =======================================================================*/

  function blobToBitmap(blob) {
    return new Promise(function (resolve, reject) {
      if (typeof createImageBitmap === 'function') {
        createImageBitmap(blob).then(resolve, function () { imgFallback(); });
      } else { imgFallback(); }
      function imgFallback() {
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
        img.src = url;
      }
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('编码失败')); }, type, quality);
        return;
      }
      try {
        var dataUrl = canvas.toDataURL(type, quality);
        var parts = dataUrl.split(',');
        var mime = parts[0].match(/:(.*?);/)[1];
        var bin = atob(parts[1]);
        var u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        resolve(new Blob([u8], { type: mime }));
      } catch (e) { reject(e); }
    });
  }

  function compressBlob(blob, maxBytes, maxDim) {
    return blobToBitmap(blob).then(function (src) {
      var w = src.width || src.naturalWidth || 0;
      var h = src.height || src.naturalHeight || 0;
      if (!w || !h) throw new Error('图片尺寸无效');

      var scale = Math.min(1, (maxDim || 1600) / Math.max(w, h));
      var tw = Math.max(1, Math.round(w * scale));
      var th = Math.max(1, Math.round(h * scale));
      var quality = 0.9;
      var out = blob;

      function encode() {
        var c = document.createElement('canvas');
        c.width = tw; c.height = th;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, tw, th);
        ctx.drawImage(src, 0, 0, tw, th);
        return canvasToBlob(c, 'image/jpeg', quality);
      }

      function step(n) {
        if (n > 8) return Promise.resolve(out);
        return encode().then(function (b) {
          out = b;
          if (!maxBytes || b.size <= maxBytes) return out;
          if (quality > 0.5) { quality = Math.max(0.45, quality - 0.12); }
          else { tw = Math.max(24, Math.round(tw * 0.8)); th = Math.max(24, Math.round(th * 0.8)); }
          if (tw <= 24 || th <= 24) return out;
          return step(n + 1);
        });
      }

      return step(0).then(function (b) {
        if (src.close) { try { src.close(); } catch (e) { /* ignore */ } }
        return { blob: b, filename: 'meme.jpg' };
      });
    });
  }

  /* =========================================================================
   * 7.5 GIF → WebP
   *
   * 两种模式：
   *   static —— 只取首帧，编码成静帧 WebP。到处都能跑，但会丢动画。
   *   anim   —— 逐帧解码 + 每帧编码成静帧 WebP，再自己封装成动图 WebP。
   *            依赖 WebCodecs 的 ImageDecoder（Chrome/Android WebView 94+），
   *            不可用时自动降级为 static 并明确告知用户，不会闷声丢动画。
   *
   * 为什么自己封装：浏览器没有原生的「动图 WebP 编码器」。
   * canvas.toBlob('image/webp') 只能出静帧，所以每帧先编码成独立静帧 WebP，
   * 再把它们的 VP8/VP8L/ALPH 码流重新包进 ANMF 块，拼出 RIFF/WEBP 动图容器。
   * =======================================================================*/

  var WEBP_MIME = 'image/webp';
  var MAX_ANIM_FRAMES = 120;          // 超过就放弃动图，避免手机上卡死/爆内存
  var _canEncodeWebp = null;

  function canEncodeWebp() {
    if (_canEncodeWebp !== null) return _canEncodeWebp;
    try {
      var c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      _canEncodeWebp = String(c.toDataURL(WEBP_MIME)).indexOf('data:image/webp') === 0;
    } catch (e) {
      _canEncodeWebp = false;
    }
    return _canEncodeWebp;
  }

  // ---- RIFF 小工具 ----

  function rd32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function wr32(b, o, v) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; }
  function wr16(b, o, v) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; }
  function wr24(b, o, v) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; }
  function id4(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }
  function wrId(b, o, s) { b[o] = s.charCodeAt(0); b[o + 1] = s.charCodeAt(1); b[o + 2] = s.charCodeAt(2); b[o + 3] = s.charCodeAt(3); return o + 4; }

  /**
   * 从一张静帧 WebP 里取出可以放进 ANMF 的码流块。
   * 丢掉 VP8X（帧内不允许）、ICCP/EXIF/XMP（属于文件级元数据），保留 ALPH + VP8 /VP8L。
   */
  function parseStillWebp(u8) {
    if (u8.length < 16 || id4(u8, 0) !== 'RIFF' || id4(u8, 8) !== 'WEBP') {
      throw new Error('不是 WebP 静帧数据');
    }
    var chunks = [];
    var hasAlpha = false;
    var p = 12;
    while (p + 8 <= u8.length) {
      var id = id4(u8, p);
      var size = rd32(u8, p + 4);
      var start = p + 8;
      var end = Math.min(start + size, u8.length);
      if (id === 'VP8X') {
        // VP8X 标志位：bit4(0x10) = Alpha，bit1(0x02) = Animation
        if (size >= 1 && (u8[start] & 0x10)) hasAlpha = true;
      } else if (id === 'ALPH') {
        hasAlpha = true;
        chunks.push({ id: id, bytes: u8.subarray(start, end) });
      } else if (id === 'VP8 ' || id === 'VP8L') {
        chunks.push({ id: id, bytes: u8.subarray(start, end) });
      }
      p = start + size + (size & 1);   // RIFF 块按偶数对齐
    }
    if (!chunks.length) throw new Error('WebP 里没有找到 VP8/VP8L 码流');
    return { chunks: chunks, hasAlpha: hasAlpha };
  }

  /**
   * 把若干「每张都是完整画面」的静帧 WebP 合成一张动图 WebP。
   * frames: [{ data: Uint8Array(完整静帧 WebP 文件), duration: 毫秒 }]
   */
  function muxAnimatedWebp(frames, width, height) {
    if (!frames || !frames.length) throw new Error('没有可用帧');
    if (width < 1 || height < 1) throw new Error('画布尺寸无效');

    var parsed = [];
    var hasAlpha = false;
    var i;
    for (i = 0; i < frames.length; i++) {
      var pr = parseStillWebp(frames[i].data);
      if (pr.hasAlpha) hasAlpha = true;
      parsed.push({ chunks: pr.chunks, duration: Math.max(20, Math.round(frames[i].duration) || 100) });
    }

    function anmfSize(f) {
      var n = 16;                                   // ANMF 帧头固定 16 字节
      for (var j = 0; j < f.chunks.length; j++) {
        n += 8 + f.chunks[j].bytes.length;
        if (f.chunks[j].bytes.length & 1) n += 1;   // 对齐填充
      }
      return n;
    }

    var total = 12 + (8 + 10) + (8 + 6);            // 文件头 + VP8X + ANIM
    for (i = 0; i < parsed.length; i++) total += 8 + anmfSize(parsed[i]);

    var out = new Uint8Array(total);
    var o = 0;

    o = wrId(out, o, 'RIFF');
    wr32(out, o, total - 8); o += 4;
    o = wrId(out, o, 'WEBP');

    // VP8X：声明画布尺寸 + 动画标志（+ 有透明就带 Alpha 标志）
    o = wrId(out, o, 'VP8X');
    wr32(out, o, 10); o += 4;
    out[o] = 0x02 | (hasAlpha ? 0x10 : 0x00); o += 1;
    out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; o += 3;
    wr24(out, o, width - 1); o += 3;
    wr24(out, o, height - 1); o += 3;

    // ANIM：背景色 + 循环次数（0 = 无限）
    o = wrId(out, o, 'ANIM');
    wr32(out, o, 6); o += 4;
    wr32(out, o, 0); o += 4;
    wr16(out, o, 0); o += 2;

    for (i = 0; i < parsed.length; i++) {
      var f = parsed[i];
      o = wrId(out, o, 'ANMF');
      wr32(out, o, anmfSize(f)); o += 4;
      wr24(out, o, 0); o += 3;                      // 帧左上角 X（单位 2px）
      wr24(out, o, 0); o += 3;                      // 帧左上角 Y
      wr24(out, o, width - 1); o += 3;
      wr24(out, o, height - 1); o += 3;
      wr24(out, o, f.duration); o += 3;
      // 标志位：bit0 = 0 走 alpha 混合，bit1 = 1 显示完清除为背景。
      // 每帧都是整幅画面，这样处理不会残留上一帧的鬼影。
      out[o] = 0x02; o += 1;

      for (var j = 0; j < f.chunks.length; j++) {
        var c = f.chunks[j];
        o = wrId(out, o, c.id);
        wr32(out, o, c.bytes.length); o += 4;
        out.set(c.bytes, o); o += c.bytes.length;
        if (c.bytes.length & 1) { out[o] = 0; o += 1; }
      }
    }

    return out;
  }

  // ---- 转换 ----

  function fitSize(w, h, maxDim) {
    var scale = Math.min(1, (maxDim || 640) / Math.max(w, h || 1));
    return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
  }

  function encodeWebp(canvas, quality) {
    return canvasToBlob(canvas, WEBP_MIME, quality).then(function (b) {
      if (!b || b.type !== WEBP_MIME) throw new Error('内核不支持 WebP 编码');
      return b;
    });
  }

  /** 只取首帧的静帧 WebP（到处都能跑） */
  function gifToStaticWebp(blob, maxDim, quality) {
    return blobToBitmap(blob).then(function (src) {
      var w = src.width || src.naturalWidth || 0;
      var h = src.height || src.naturalHeight || 0;
      if (!w || !h) throw new Error('图片尺寸无效');
      var s = fitSize(w, h, maxDim);
      var c = document.createElement('canvas');
      c.width = s.w; c.height = s.h;
      c.getContext('2d').drawImage(src, 0, 0, s.w, s.h);
      if (src.close) { try { src.close(); } catch (e) { /* ignore */ } }
      return encodeWebp(c, quality).then(function (b) {
        return { blob: b, filename: 'meme.webp', frames: 1, degraded: false };
      });
    });
  }

  /** 逐帧解码 + 重新封装成动图 WebP */
  function gifToAnimatedWebp(blob, maxDim, quality) {
    if (typeof ImageDecoder !== 'function') throw new Error('内核不支持 ImageDecoder');

    return blob.arrayBuffer().then(function (buf) {
      var dec = new ImageDecoder({ data: buf, type: 'image/gif' });

      return Promise.resolve(dec.tracks.ready).then(function () {
        var track = dec.tracks.selectedTrack;
        var fc = track && track.frameCount;
        return Promise.resolve(fc).then(function (count) {
          count = Number(count) || 0;
          if (count < 2) throw new Error('只有 ' + count + ' 帧，按静帧处理');
          if (count > MAX_ANIM_FRAMES) throw new Error('帧数过多（' + count + '）');

          // 先解一帧拿到尺寸
          return dec.decode({ frameIndex: 0 }).then(function (r0) {
            var f0 = r0.image;
            var w = f0.displayWidth || f0.codedWidth || 0;
            var h = f0.displayHeight || f0.codedHeight || 0;
            if (f0.close) { try { f0.close(); } catch (e) { /* ignore */ } }
            if (!w || !h) throw new Error('无法确定画布尺寸');

            var s = fitSize(w, h, maxDim);
            var frames = [];

            // 串行解码：手机内存经不起并行堆几十张全尺寸帧
            var seq = Promise.resolve();
            for (var i = 0; i < count; i++) {
              (function (idx) {
                seq = seq.then(function () {
                  return dec.decode({ frameIndex: idx }).then(function (res) {
                    var img = res.image;
                    var durUs = img.duration || 0;
                    var c = document.createElement('canvas');
                    c.width = s.w; c.height = s.h;
                    c.getContext('2d').drawImage(img, 0, 0, s.w, s.h);
                    if (img.close) { try { img.close(); } catch (e) { /* ignore */ } }
                    return encodeWebp(c, quality).then(function (b) {
                      return b.arrayBuffer();
                    }).then(function (ab) {
                      frames.push({
                        data: new Uint8Array(ab),
                        duration: Math.max(20, Math.round((durUs || 100000) / 1000))
                      });
                    });
                  });
                });
              })(i);
            }

            return seq.then(function () {
              var bytes = muxAnimatedWebp(frames, s.w, s.h);
              return {
                blob: new Blob([bytes], { type: WEBP_MIME }),
                filename: 'meme.webp',
                frames: frames.length,
                degraded: false
              };
            });
          });
        });
      });
    });
  }

  /**
   * 统一入口。mode: 'anim' | 'static'
   * anim 不可用时降级为 static，并把 degraded 标记带出去，让调用方明确告知用户。
   */
  function convertToWebp(blob, mode, maxDim, quality) {
    var wantAnim = (mode !== 'static');
    if (wantAnim) {
      return gifToAnimatedWebp(blob, maxDim, quality).catch(function (e) {
        log('动图 WebP 不可用（' + e.message + '），降级为静态首帧');
        return gifToStaticWebp(blob, maxDim, quality).then(function (r) {
          r.degraded = true;
          return r;
        });
      });
    }
    return gifToStaticWebp(blob, maxDim, quality);
  }

  /**
   * 带体积约束的 GIF→WebP：只要「没变小」就降分辨率/降质量重来，最多 3 次，
   * 最后交出试过的里面最小的那张。
   *
   * 为什么要拿原图大小当条件：动图 WebP 的每一帧都是整幅画面的**有损**编码，
   * 而 GIF 每帧只存变化区域且带调色板压缩。实测同一张表情包，q=0.90 时产出
   * 是原 GIF 的 1.5~2 倍；q≈0.70 才稳定压到 0.5~0.85 倍。所以必须允许降质重试，
   * 否则这个功能会几乎每次都因为「变大」而放弃转换。
   */
  function convertToWebpFitted(blob, mode, maxDim, quality, maxBytes) {
    var dim = maxDim;
    var q = quality;
    var best = null;
    var tries = 0;

    function once() {
      return convertToWebp(blob, mode, dim, q).then(function (r) {
        if (!best || r.blob.size < best.blob.size) best = r;
        tries++;
        var tooBig = (maxBytes && r.blob.size > maxBytes) || r.blob.size >= blob.size;
        if (!tooBig || tries >= 3) return best;
        dim = Math.max(160, Math.round(dim * 0.8));
        q = Math.max(0.5, q - 0.12);
        log('WebP 没比原图小（' + bytesText(r.blob.size) + ' vs ' + bytesText(blob.size) +
          '），降到 ' + dim + 'px / q=' + q.toFixed(2) + ' 重试');
        return once();
      });
    }

    return once();
  }

  /* =========================================================================
   * 8. 上传链（严格复刻 uploadFileDirect.y）
   *    POST /api/upload/presign  →  PUT upload_url  →  POST /api/upload/bind
   * =======================================================================*/

  function extFromName(name, contentType) {
    var e = String(name).split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (e && e !== 'blob') return e;
    var map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' };
    return map[contentType] || 'jpg';
  }

  function putRaw(url, blob, headers, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      xhr.timeout = REQ_TIMEOUT;
      for (var k in headers) {
        if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
        if (!k || headers[k] == null || headers[k] === '') continue;
        if (k.toLowerCase() === 'content-length') continue; // 与官方一致：跳过该头
        try { xhr.setRequestHeader(k, headers[k]); } catch (e) { /* ignore */ }
      }
      if (onProgress && xhr.upload) {
        xhr.upload.onprogress = function (ev) {
          if (ev.lengthComputable && ev.total) onProgress(ev.loaded / ev.total);
        };
      }
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error('上传失败(' + xhr.status + ')'));
      };
      xhr.onerror = function () { reject(new Error('上传失败')); };
      xhr.ontimeout = function () { reject(new Error('上传超时')); };
      xhr.onabort = function () { reject(new Error('上传已取消')); };
      xhr.send(blob);
    });
  }

  function uploadImage(blob, filename, roomId, onProgress) {
    if (!blob || !blob.size || blob.size < 1) return Promise.reject(new Error('文件大小无效'));

    // 以字节为准决定 content_type / ext，绝不把 CDN 给的非标准值（如 image/jpg）透传给服务端
    return resolveUploadFormat(blob, filename).then(function (fmt) {
      var contentType = fmt.mime;
      var ext = fmt.ext;
      var size = blob.size;

      if (!fmt.sniffed) log('未能从文件头识别格式，按声明值处理', { declared: fmt.declared, mime: contentType });

      var form = new URLSearchParams();
      form.set('upload_source', 'chat_image');
      form.set('content_type', contentType);
      form.set('bytes', String(size));
      form.set('ext', ext);
      if (roomId) form.set('room_id', roomId);

      if (onProgress) onProgress(0.02);
      log('presign', { content_type: contentType, bytes: size, ext: ext, room_id: roomId });

      return apiJson('POST', '/api/upload/presign', form.toString(),
        { 'Content-Type': 'application/x-www-form-urlencoded' })
        .then(function (cred) {
          if (!cred || !cred.ticket_id || !cred.upload_url) throw new Error('上传凭证无效');
          if (Number(cred.content_length) !== size) throw new Error('上传大小不一致，请重新选择图片');
          if (onProgress) onProgress(0.08);

          var headers = {};
          var src = cred.headers || {};
          for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) headers[k] = src[k]; }
          var ct = src['Content-Type'] || src['content-type'] || contentType;
          headers['Content-Type'] = ct;

          return putRaw(cred.upload_url, blob, headers, function (p) {
            if (onProgress) onProgress(0.08 + p * 0.8);
          }).then(function () {
            if (onProgress) onProgress(0.9);
            var bf = new URLSearchParams();
            bf.set('ticket_id', String(cred.ticket_id));
            return apiJson('POST', '/api/upload/bind', bf.toString(),
              { 'Content-Type': 'application/x-www-form-urlencoded' });
          }).then(function (bound) {
            var finalUrl = String((bound && bound.url) || '');
            if (!finalUrl) throw new Error('上传校验失败');
            if (onProgress) onProgress(1);
            return {
              url: finalUrl,
              upload_file_id: bound.upload_file_id,
              ticket_id: bound.ticket_id || cred.ticket_id,
              file_size: bound.file_size,
              mime_type: bound.mime_type
            };
          });
        })
        .catch(function (e) {
          var payload = e && e.payload;
          var code = String((payload && (payload.err_code || payload.error)) || '');
          var msg = String((payload && payload.msg) || (e && e.message) || '上传失败');
          if (code === 'file_too_large' || /超过|过大|too.?large/i.test(msg)) {
            var err = new Error(msg || '图片过大'); err.reason = 'too_large'; throw err;
          }
          if (code === 'unsupported_type' || /不支持|格式/.test(msg)) {
            var e2 = new Error(msg || '格式不支持');
            e2.reason = 'unsupported';
            e2.mime = contentType;
            e2.ext = ext;
            throw e2;
          }
          if (code === 'bind_failed' || /校验/.test(msg)) {
            var e3 = new Error(msg || '上传校验失败'); e3.reason = 'bind_failed'; throw e3;
          }
          throw e;
        });
    });
  }

  /* =========================================================================
   * 9. 发送图片消息（与官方 sendImageMessage 完全一致的帧）
   *    官方：ws.send({event:"message", content:url, type:"image", image_url:url})
   * =======================================================================*/

  function getRoomId() {
    // 调试/测试钩子：可在控制台执行
    //   unsafeWindow.__ZTM_ROOM_ID__ = '房间ID'
    try {
      if (UNSAFE.__ZTM_ROOM_ID__) return String(UNSAFE.__ZTM_ROOM_ID__);
    } catch (e) { /* ignore */ }
    try {
      var m = location.pathname.match(/\/(?:app\/)?(?:chat|public-chat)\/([A-Za-z0-9_-]{4,})/);
      if (m) return m[1];
    } catch (e) { /* ignore */ }
    try {
      var q = new URLSearchParams(location.search).get('room_id');
      if (q) return q;
    } catch (e) { /* ignore */ }
    try {
      var h = new URLSearchParams(String(location.hash || '').replace(/^#/, '')).get('room_id');
      if (h) return h;
    } catch (e) { /* ignore */ }
    return '';
  }

  // 与官方 sendImageMessage 完全一致的帧：
  //   ws.send(JSON.stringify({event:"message", content:url, type:"image", image_url:url}))
  // 服务端按 socket 已 join 的房间路由，因此帧内不需要 room_id。
  function sendImageFrame(imageUrl) {
    return new Promise(function (resolve, reject) {
      var roomId = getRoomId();
      if (!roomId) { reject(new Error('当前不在聊天房间页，无法发送')); return; }
      if (!liveSocket()) {
        reject(new Error('未捕获到聊天连接，请刷新页面后重试'));
        return;
      }
      var payload = { event: 'message', content: imageUrl, type: 'image', image_url: imageUrl };

      var timer = setTimeout(function () {
        cleanup();
        resolve({ acked: false });
      }, 9000);

      function onFrame(data) {
        if (!data || data.event !== 'message') return;
        if (String(data.image_url || '') === imageUrl || String(data.content || '') === imageUrl) {
          cleanup();
          resolve({ acked: true, message: data });
        }
      }
      function cleanup() {
        clearTimeout(timer);
        var i = wsListeners.indexOf(onFrame);
        if (i >= 0) wsListeners.splice(i, 1);
      }
      wsListeners.push(onFrame);

      var ok = wsSend(payload);
      if (!ok) { cleanup(); reject(new Error('连接不可用，发送失败')); return; }
      log('已发出图片消息帧', { room: roomId, image_url: imageUrl });
    });
  }

  /* =========================================================================
   * 10. 表情源
   * =======================================================================*/

  function tpl(str, kw, page) {
    return String(str)
      .replace(/\{kw\}/g, encodeURIComponent(kw))
      .replace(/\{page\}/g, String(page || 1));
  }

  function pickPath(obj, path) {
    var parts = String(path || '').split('.');
    var cur = [obj];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var isArr = false;
      if (p.indexOf('[]') !== -1) { p = p.replace('[]', ''); isArr = true; }
      var next = [];
      for (var j = 0; j < cur.length; j++) {
        var v = cur[j];
        if (v == null) continue;
        if (p) { try { v = v[p]; } catch (e) { v = undefined; } }
        if (v == null) continue;
        if (isArr) {
          if (Array.isArray(v)) { for (var k = 0; k < v.length; k++) next.push(v[k]); }
        } else next.push(v);
      }
      cur = next;
    }
    return cur;
  }

  function absoluteUrl(u, base) {
    if (!u) return '';
    u = String(u).trim();
    if (u.indexOf('data:') === 0) return '';
    if (u.indexOf('//') === 0) return 'https:' + u;
    if (/^https?:/i.test(u)) return u;
    if (/^\//.test(u)) {
      try { return new URL(u, base).href; } catch (e) { return ''; }
    }
    return '';
  }

  function dedupe(list) {
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (!u || seen[u]) continue;
      seen[u] = 1;
      out.push(u);
    }
    return out;
  }

  function searchSource(source, kw, page) {
    var url = tpl(source.url, kw, page);
    log('搜索', source.name, url);
    return fetchText(url, source.referer).then(function (text) {
      var urls = [];
      if (source.kind === 'json') {
        var json;
        try { json = JSON.parse(text); } catch (e) { throw new Error('接口返回非 JSON'); }
        var vals = pickPath(json, source.path || 'data');
        for (var i = 0; i < vals.length; i++) {
          var v = vals[i];
          if (typeof v === 'string') urls.push(v);
          else if (v && typeof v === 'object') {
            var inner = source.urlKey ? v[source.urlKey] : (v.url || v.img || v.image || v.src || v.pic || v.url_path);
            if (typeof inner === 'string') urls.push(inner);
          }
        }
      } else {
        var body = text.replace(/\\\//g, '/');
        var re;
        try { re = new RegExp(source.pattern, 'gi'); } catch (e) { throw new Error('正则表达式无效'); }
        var m;
        var guard = 0;
        while ((m = re.exec(body)) !== null && guard++ < 3000) {
          urls.push(m[0]);
        }
      }
      urls = dedupe(urls);
      if (source.https !== false) {
        urls = urls.map(function (u) { return String(u).replace(/^http:\/\//i, 'https://'); });
      }
      if (source.exclude) {
        var ex;
        try { ex = new RegExp(source.exclude, 'i'); } catch (e) { ex = null; }
        if (ex) urls = urls.filter(function (u) { return !ex.test(u); });
      }
      var base = url;
      urls = urls.map(function (u) { return absoluteUrl(u, base); })
        .filter(function (u) { return u && !/\.(js|css|ico|svg)(\?|$)/i.test(u); });
      log('搜索到 ' + urls.length + ' 张');
      return urls.slice(0, 60);
    });
  }

  /* =========================================================================
   * 11. UI
   * =======================================================================*/

  /* =========================================================================
   * 11. UI：把「梗图搜索」整合进站点原生表情面板
   *
   * 不再有独立悬浮窗。做法是往站点自带的「表情」面板里再插一个 Tab：
   *
   *   div.composer-emoji-panel                      ← 站点原生，常驻 DOM，
   *     div.composer-emoji-panel__slide               仅靠 inert / --open 开关
   *       div.composer-emoji-panel__body
   *         div.emoji-mode-tabs                     ← 原生只有 Emoji / 表情包 两个 Tab
   *         div.emoji-swap[data-mode]
   *           div.emoji-swap__track                 ← 横向 200% 轨道，靠 data-mode 平移
   *             div.emoji-swap__pane (emoji)
   *             div.emoji-swap__pane (表情包)
   *
   * 我们追加第 3 个 Tab + 第 3 个 pane，并且**用属性而不是 class** 标记当前模式：
   * Vue 每次重渲染都会覆盖 class（patchClass 直接给 className 赋值），
   * 但它不会碰自己 vnode 里没声明过的属性，所以 data-ztm-meme 能稳定存活。
   *
   * 面板本身是 20rem 定高、`.emoji-swap` overflow:hidden，所以只要把轨道加宽到
   * 300%、每栏 1/3、整体再平移两屏，就能得到与原生完全一致的滑动切换手感。
   * =======================================================================*/

  var ui = {
    // 覆盖层（toast / 设置面板）—— 自带 shadow root，和站点样式互不污染
    host: null, shadow: null, ovRoot: null,
    // 站点原生表情面板里的注入点
    panel: null, tabs: null, swap: null, track: null, tab: null, pane: null, active: false,
    // 站内影子根里的控件
    els: {}, logBox: null
  };

  var state = {
    query: '', page: 1, results: [], selected: null, busy: false, sourceId: null
  };

  var SITE_READY = 'data-ztm-ready';     // 挂在 .composer-emoji-panel，表示注入成功
  var SITE_MODE = 'data-ztm-meme';       // 挂在 .emoji-mode-tabs / .emoji-swap，表示当前是梗图栏
  var TAB_CLASS = 'ztm-tab';
  var PANE_CLASS = 'ztm-pane';
  var SCOPE_RE = /^data-v-[0-9a-f]+$/i;  // Vue SFC 作用域属性，形如 data-v-db343221

  /* 宿主页面覆盖样式：必须放在文档里（要能命中站点的元素） */
  var SITE_CSS = [
    /* —— 一律以 [data-ztm-ready] 为前提，注入失败时原生两栏布局不受影响 —— */
    '.composer-emoji-panel[' + SITE_READY + '] .emoji-swap__track{width:300%!important;}',
    '.composer-emoji-panel[' + SITE_READY + '] .emoji-swap__pane{width:33.333333%!important;flex:0 0 33.333333%!important;}',
    /* 真三等分。flex-basis 是 0，所以外宽完全由 padding+border 决定：
       原生 <button> 带浏览器默认的 1px 6px 内边距（左右共 12px），如果只让我的
       Tab 用 padding:0，它就会比另外两个窄 12px。三个统一成同一个值即可。
       按钮文字本来就是居中的，所以对原生外观没有可见改变。 */
    '.composer-emoji-panel[' + SITE_READY + '] .emoji-mode-tabs__btn{padding:0 6px!important;min-width:0!important;}',
    /* 站点自己的位移是「轨道宽度的百分比」：轨道一旦从 200% 变 300%，
       原来的 -50% 就变成 -1.5 屏，表情包栏会正好错开半屏。必须一起改。 */
    '.composer-emoji-panel[' + SITE_READY + '] .emoji-swap[data-mode=sticker] .emoji-swap__track' +
    '{transform:translate3d(-33.333333%,0,0)!important;}',
    '.composer-emoji-panel[' + SITE_READY + '] .emoji-swap[' + SITE_MODE + '] .emoji-swap__track' +
    '{transform:translate3d(-66.666667%,0,0)!important;}',
    '.composer-emoji-panel[' + SITE_READY + '] .emoji-mode-tabs__indicator{width:calc(33.333333% - .12rem)!important;}',
    '.composer-emoji-panel[' + SITE_READY + '] .emoji-mode-tabs[' + SITE_MODE + '] .emoji-mode-tabs__indicator' +
    '{transform:translate3d(200%,0,0)!important;}',

    /* —— 第三个 Tab。自带完整样式，站点改了作用域 id 也不会变成裸按钮 —— */
    '.' + TAB_CLASS + '{position:relative;z-index:1;flex:1 1 0;height:1.75rem;margin:0;',
    '  border:0;border-radius:999px;background:transparent;color:#64748b;font-size:.8rem;font-weight:600;',
    '  font-family:inherit;line-height:1.75rem;cursor:pointer;transition:color .2s ease;',
    '  -webkit-tap-highlight-color:transparent;}',
    'html.dark .' + TAB_CLASS + '{color:#94a3b8;}',
    /* 梗图栏激活时，把原生的「选中色」让给我的 Tab（原生激活态变回未选中灰） */
    '.emoji-mode-tabs[' + SITE_MODE + '] .emoji-mode-tabs__btn--active{color:#64748b!important;}',
    'html.dark .emoji-mode-tabs[' + SITE_MODE + '] .emoji-mode-tabs__btn--active{color:#94a3b8!important;}',
    '.emoji-mode-tabs[' + SITE_MODE + '] .' + TAB_CLASS + '{color:#fff!important;}',
    'html.dark .emoji-mode-tabs[' + SITE_MODE + '] .' + TAB_CLASS + '{color:#f1f5f9!important;}'
  ].join('\n');

  /* ---------------------------------------------------------------
   * 设计令牌 —— 全部从站点自己的 CSS 里抄的，不是猜的
   *   面板：.chat-modal-panel / .chat-modal-overlay
   *   开关：.toggle-switch / .toggle-switch-slider
   *   深色：html.dark 下的 --zt-* 与 .chat-modal-* 覆盖
   * 目的：脚本弹出来的东西跟站内弹窗是同一套视觉语言。
   * 备注：--bd/--bg/--bg2/--fg/--fg2/--line/--brand 是梗图栏在用的老名字，保留。
   * --------------------------------------------------------------- */
  var VARS_FONT = 'HarmonyOS Sans,HarmonyOS Sans SC,PingFang SC,Microsoft YaHei,system-ui,-apple-system,sans-serif';

  var VARS = [
    '--bd:#e2e8f0;--bg:#fff;--bg2:#f8fafc;--fg:#0f172a;--fg2:#64748b;--line:#e2e8f0;--brand:#3b82f6;',
    // 站点新增令牌
    '--fg-strong:#1e293b;--fg3:#94a3b8;',
    '--panel:#fff;--field:#fff;',
    '--line-soft:rgba(148,163,184,.18);--bd-soft:rgba(148,163,184,.28);',
    '--brand-h:#2563eb;--brand-a:#3b82f61a;--ring:#3b82f673;',
    '--track:#e2e8f0;--track-on:#60a5fa;',
    '--tool:rgba(148,163,184,.102);--tool-h:rgba(148,163,184,.18);',
    '--btn2-bg:#fff;--btn2-fg:#64748b;--btn2-bd:rgba(148,163,184,.32);',
    '--btn2-bg-h:rgba(148,163,184,.059);--btn2-fg-h:#475569;',
    '--toast-bg:#1e293b;--toast-fg:#f1f5f9;',
    // 站内 toast 的语义配色（浅色是 bg-*-100 + text-*-600，深色见下面 VARS_DARK）
    '--tk-ok-bg:#d1fae5;--tk-ok-fg:#059669;',
    '--tk-err-bg:#fee2e2;--tk-err-fg:#dc2626;',
    '--tk-warn-bg:#fef9c3;--tk-warn-fg:#ca8a04;',
    '--modal-sh:0 4px 6px #0f172a0a,0 20px 48px #0f172a24;',
    '--scrim:#0f172a6b;--scrim-blur:6px;',
    '--ease:cubic-bezier(.22,1,.36,1);--dur:.18s;'
  ].join('');
  var VARS_DARK = [
    '--bd:#334155;--bg:transparent;--bg2:#1e293b;--fg:#e2e8f0;--fg2:#94a3b8;--line:#334155;--brand:#3b82f6;',
    '--fg-strong:#f1f5f9;--fg3:#94a3b8;',
    '--panel:#1e293b;--field:#0f172a;',
    '--line-soft:rgba(148,163,184,.18);--bd-soft:rgba(148,163,184,.28);',
    '--brand-h:#2563eb;--brand-a:#3b82f61a;--ring:#3b82f673;',
    '--track:#475569;--track-on:#60a5fa;',
    '--tool:rgba(51,65,85,.85);--tool-h:rgba(51,65,85,.96);',
    '--btn2-bg:#0f172a;--btn2-fg:#cbd5e1;--btn2-bd:rgba(148,163,184,.28);',
    '--btn2-bg-h:rgba(51,65,85,.9);--btn2-fg-h:#e2e8f0;',
    '--toast-bg:#334155;--toast-fg:#f1f5f9;',
    '--tk-ok-bg:rgba(6,78,59,.92);--tk-ok-fg:#6ee7b7;',
    '--tk-err-bg:rgba(127,29,29,.92);--tk-err-fg:#fca5a5;',
    '--tk-warn-bg:rgba(113,63,18,.92);--tk-warn-fg:#fcd34d;',
    '--modal-sh:0 24px 60px #00000073;',
    '--scrim:#020617b8;--scrim-blur:6px;',
    '--ease:cubic-bezier(.22,1,.36,1);--dur:.18s;'
  ].join('');

  var PANE_CSS = [
    '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}',
    '.root{display:flex;flex-direction:column;height:100%;min-height:0;padding:0 .2rem;',
    '  font-family:' + VARS_FONT + ';',
    '  font-size:13px;line-height:1.4;color:var(--fg);' + VARS + '}',
    '.root.dark{' + VARS_DARK + '}',

    '.bar{display:flex;gap:6px;flex:0 0 auto;}',
    '.q{flex:1 1 auto;min-width:0;height:30px;padding:0 9px;border-radius:8px;border:1px solid var(--line);',
    '  background:var(--bg2);color:var(--fg);font-size:13px;font-family:inherit;outline:none;}',
    '.q:focus{border-color:var(--brand);}',

    '.go{flex:0 0 auto;height:30px;padding:0 13px;border:0;border-radius:8px;background:var(--brand);color:#fff;',
    '  font-size:12.5px;font-weight:600;font-family:inherit;cursor:pointer;white-space:nowrap;}',
    '.go:disabled{opacity:.5;cursor:not-allowed;}',

    /* 设置齿轮：跟搜索框同一行、同高，占 30×30。原来它和源下拉 / 换一批 / 链接 / 本地
       挤在第二行，那一行有 24px，在只有一百多像素高的面板里太奢侈了 —— 整行撤掉，
       源切换搬进设置面板，另外三个入口直接去掉。 */
    '.cfg{flex:0 0 auto;width:30px;height:30px;padding:0;border:1px solid var(--line);border-radius:8px;',
    '  background:var(--bg2);color:var(--fg2);font-size:14px;line-height:1;font-family:inherit;',
    '  cursor:pointer;white-space:nowrap;-webkit-tap-highlight-color:transparent;}',
    '.cfg:active{background:var(--bd);}',

    '.st{margin-top:4px;flex:0 0 auto;font-size:10.5px;color:var(--fg2);height:14px;overflow:hidden;',
    '  white-space:nowrap;text-overflow:ellipsis;}',
    '.pb{margin-top:3px;height:3px;border-radius:2px;background:var(--line);overflow:hidden;flex:0 0 auto;}',
    '.pb i{display:block;height:100%;width:0;background:var(--brand);transition:width .18s;}',
    '.pb.off{visibility:hidden;}',

    '.ft{display:flex;align-items:center;gap:8px;margin-top:5px;flex:0 0 auto;}',
    '.ft.off{display:none;}',
    '.ft .fi{flex:1 1 auto;min-width:0;font-size:11px;color:var(--fg2);overflow:hidden;',
    '  text-overflow:ellipsis;white-space:nowrap;}',

    /* 每行张数：**固定列数**，跟站点自己的两个栏一个路子
       （.emoji-ui__row 是 repeat(var(--emoji-cols,8),…)、表情包栏是 repeat(4,…)）。
       之前用 auto-fill + 最小边，而桌面端输入区是 width:100% 撑满的 ——
       面板一宽列数就自己往上窜（能到 9 列），格子被挤得越来越小。
       改成固定列数后「每行几张」是确定的，格子尺寸随面板变宽而**变大**。
       想再大/再小改设置里的「每行显示张数」（--ztm-cols）。 */
    '.grid{flex:1 1 auto;min-height:0;margin-top:5px;overflow-x:hidden;overflow-y:auto;',
    '  overscroll-behavior:contain;-webkit-overflow-scrolling:touch;',
    '  display:grid;grid-template-columns:repeat(var(--ztm-cols,6),minmax(0,1fr));',
    '  grid-auto-rows:max-content;gap:5px;align-content:start;}',
    '.grid::-webkit-scrollbar{width:0;height:0;}',
    // 那条 1px 描边用 inset box-shadow 画，不用 border：
    // 格子高度靠 padding-top:100% 撑起来，而百分比是相对**包含块宽度**算的，
    // 一旦有 border，高度就比宽度多出 2px，格子不再是正方形（真机实测 75.1×77.2）。
    '.cell{position:relative;width:100%;padding:0;padding-top:100%;border:0;border-radius:8px;',
    '  background:var(--bg2);overflow:hidden;cursor:pointer;box-shadow:inset 0 0 0 1px var(--line);',
    '  -webkit-tap-highlight-color:transparent;touch-action:manipulation;}',
    '.cell>img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;display:block;',
    '  pointer-events:none;}',
    '.cell.on{box-shadow:inset 0 0 0 2px var(--brand);}',
    '.cell.busy{opacity:.45;pointer-events:none;}',
    '.tg{position:absolute;left:3px;bottom:3px;padding:0 3px;border-radius:3px;background:rgba(0,0,0,.6);',
    '  color:#fff;font-size:9px;letter-spacing:.3px;}',
    '.m2{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
    '  background:rgba(0,0,0,.42);color:#fff;font-size:10px;text-align:center;padding:2px;}',
    '.empty{grid-column:1/-1;padding:18px 6px;text-align:center;color:var(--fg2);font-size:11.5px;line-height:1.6;}'
  ].join('\n');

  /* 覆盖层样式：toast + 设置面板
     整套是照着站点自己的 .chat-modal-* / .toggle-switch / html.dark 的 --zt-* 抄的，
     所以字号、圆角、阴影、动效曲线都跟站内弹窗一致。 */
  var OV_CSS = [
    '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}',
    '.ov{font-family:' + VARS_FONT + ';',
    '  font-size:14px;line-height:1.5;color:var(--fg);' + VARS + '}',
    '.ov.dark{' + VARS_DARK + '}',

    /* toast —— 站内 .toast 的浮起位移 + 深色底（#1e293b） */
    '.toast{position:fixed;z-index:2147483600;left:50%;top:1rem;transform:translate(-50%,-8px) scale(.96);',
    '  max-width:84vw;padding:.5rem .875rem;border-radius:12px;border:1px solid var(--line-soft);',
    '  background:var(--toast-bg);color:var(--toast-fg);box-shadow:0 12px 32px rgba(15,23,42,.16);',
    '  font-size:.8125rem;line-height:1.45;text-align:center;opacity:0;pointer-events:none;',
    '  transition:opacity .25s ease,transform .25s ease;}',
    '.toast.on{opacity:1;transform:translate(-50%) scale(1);}',
    /* 语义配色与站内一起（bg-emerald/red/yellow-100 + 深色变体） */
    '.toast[data-kind=ok]{background:var(--tk-ok-bg);color:var(--tk-ok-fg);border-color:transparent;}',
    '.toast[data-kind=err]{background:var(--tk-err-bg);color:var(--tk-err-fg);border-color:transparent;}',
    '.toast[data-kind=warn]{background:var(--tk-warn-bg);color:var(--tk-warn-fg);border-color:transparent;}',

    /* 遮罩 —— 站内 .chat-modal-overlay：rgba(15,23,42,.42) + blur(6px) */
    '.mask{position:fixed;z-index:2147483601;inset:0;background:var(--scrim);',
    '  display:flex;align-items:center;justify-content:center;padding:1.5rem;',
    '  -webkit-backdrop-filter:blur(var(--scrim-blur));backdrop-filter:blur(var(--scrim-blur));}',
    '.mask.off{display:none;}',

    /* 面板 —— 站内 .chat-modal-panel：22px 圆角 + 双层投影，无描边。
       宽度取 400px，正是站内最宽的那个弹窗（.chat-modal-panel--alert），
       比表单弹窗(360px)宽一点，因为这里要放 JSON 文本域和长提示。 */
    '.sheet{width:100%;max-width:400px;max-height:84vh;display:flex;flex-direction:column;',
    '  background:var(--panel);border-radius:22px;overflow:hidden;box-shadow:var(--modal-sh);',
    '  will-change:transform,opacity;animation:ztm-pop .32s var(--ease);}',
    '@keyframes ztm-pop{from{opacity:0;transform:translate3d(0,10px,0) scale(.98);}}',

    /* 头 —— 站内 .chat-modal-header / .chat-modal-heading */
    '.sh{display:flex;align-items:center;flex:0 0 auto;gap:.5rem;padding:1.125rem 1.25rem .75rem;',
    '  border-bottom:1px solid var(--line-soft);}',
    '.sh .t{flex:1 1 auto;font-size:1.0625rem;font-weight:600;color:var(--fg-strong);}',
    '.sh .ver{font-size:.6875rem;font-weight:400;color:var(--fg3);}',
    /* 关闭 —— 站内 .chat-modal-close（32×32 / 10px 圆角 / 灰底） */
    '.x{flex:0 0 auto;width:32px;height:32px;border:0;border-radius:10px;background:var(--tool);',
    '  color:var(--fg2);font-size:.875rem;line-height:1;font-family:inherit;cursor:pointer;',
    '  display:flex;align-items:center;justify-content:center;',
    '  transition:background var(--dur) ease,color var(--dur) ease;}',
    '.x:hover{background:var(--tool-h);color:var(--btn2-fg-h);}',

    '.sc{flex:1 1 auto;min-height:0;overflow-y:auto;padding:.25rem 1.25rem 1rem;',
    '  overscroll-behavior:contain;-webkit-overflow-scrolling:touch;}',

    /* 字段 —— 站内 .chat-modal-label / .chat-modal-textarea / .chat-modal-field-hint */
    '.f{margin-bottom:1rem;}',
    '.f>label{display:block;margin-bottom:.375rem;font-size:.75rem;font-weight:500;color:var(--fg2);}',
    '.f input[type=text],.f input[type=number],.f textarea,.sw select{padding:.5rem .625rem;',
    '  border:1px solid var(--bd-soft);border-radius:10px;background:var(--field);color:var(--fg);',
    '  font-size:.8125rem;line-height:1.5;font-family:inherit;outline:none;',
    '  transition:border-color var(--dur) ease,box-shadow var(--dur) ease;}',
    '.f input[type=text],.f textarea{width:100%;}',
    '.f input::placeholder,.f textarea::placeholder{color:#cbd5e1;}',
    '.f input[type=text]:focus,.f input[type=number]:focus,.f textarea:focus,.sw select:focus{',
    '  border-color:var(--ring);box-shadow:0 0 0 3px var(--brand-a);}',
    '.f textarea{min-height:120px;resize:vertical;font-family:ui-monospace,Menlo,Consolas,monospace;',
    '  font-size:.75rem;}',

    /* 开关行 —— 站内 .toggle-switch 的那套（40×22 轨道 + 16px 圆钮） */
    '.sw{display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.5625rem 0;}',
    '.f>.sw+.sw{border-top:1px solid var(--line-soft);}',
    '.sw>.lbl{font-size:.8125rem;color:var(--fg);}',
    // 下拉让它自己长：手机上面板只有 358px，写死 56% 会把「静态 WebP（只留首帧）」
    // 这种长选项截掉半句。给它 flex:1 + min-width:0，标签让位，它就能整句显示。
    '.sw select{width:auto;max-width:none;flex:1 1 auto;min-width:0;}',
    '.sw input[type=number]{width:88px;flex:0 0 auto;}',
    '.tgl{position:relative;display:inline-block;flex:0 0 auto;width:40px;height:22px;cursor:pointer;}',
    '.tgl input{position:absolute;opacity:0;width:0;height:0;}',
    '.tgl-s{position:absolute;inset:0;border-radius:999px;background:var(--track);',
    '  transition:background-color .2s ease;}',
    '.tgl-s:before{content:"";position:absolute;left:3px;top:3px;width:16px;height:16px;border-radius:50%;',
    '  background:#fff;box-shadow:0 1px 3px #0f172a1f;transition:transform .2s ease;}',
    '.tgl input:checked+.tgl-s{background-color:var(--track-on);}',
    '.tgl input:checked+.tgl-s:before{transform:translate(18px);}',
    '.tgl input:focus-visible+.tgl-s{box-shadow:0 0 0 3px var(--brand-a);}',

    '.hint{margin:.375rem 0 0;font-size:.6875rem;line-height:1.45;color:var(--fg3);}',
    '.btns{display:flex;gap:.5rem;margin-top:.75rem;flex-wrap:wrap;}',

    /* 按钮 —— 站内 .chat-modal-btn（primary #3b82f6→#2563eb / secondary 白底描边）。
       注意别写 line-height：站内是 Tailwind preflight 的 html{line-height:1.5} +
       button{line-height:inherit}，自己定一个会让按钮比站内矮 4px。 */
    '.b{flex:0 1 auto;padding:.625rem 1rem;border:0;border-radius:12px;background:var(--brand);color:#fff;',
    '  font-size:.875rem;font-weight:500;line-height:inherit;font-family:inherit;cursor:pointer;white-space:nowrap;',
    '  transition:background var(--dur) ease,color var(--dur) ease,border-color var(--dur) ease,opacity var(--dur) ease;}',
    '.b:hover{background:var(--brand-h);}',
    '.b:active{opacity:.9;}',
    '.b:disabled{opacity:.55;cursor:not-allowed;}',
    '.b.gray{background:var(--btn2-bg);color:var(--btn2-fg);border:1px solid var(--btn2-bd);}',
    '.b.gray:hover{background:var(--btn2-bg-h);color:var(--btn2-fg-h);}',

    /* 底部动作条 —— 站内 .chat-modal-actions */
    '.sf{display:flex;gap:.625rem;flex:0 0 auto;padding:.875rem 1.25rem 1.125rem;',
    '  border-top:1px solid var(--line-soft);}',
    '.sf .b{flex:1 1 0;min-width:0;}',

    '.logbox{width:100%;height:130px;overflow:auto;padding:.5rem .625rem;border-radius:10px;',
    '  border:1px solid var(--bd-soft);background:var(--field);color:var(--fg2);',
    '  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.6875rem;line-height:1.5;',
    '  white-space:pre-wrap;word-break:break-all;}',

    /* 移动端 —— 站内把遮罩内边距收到 1rem、模糊降到 4px */
    '@media (max-width:480px){.mask{padding:1rem;--scrim-blur:4px;}.sheet{max-height:88vh;}}',
    '@media (prefers-reduced-motion: reduce){',
    '  .toast,.sheet,.b,.x,.tgl-s,.tgl-s:before{transition:none!important;animation:none!important;}}'
  ].join('\n');

  /* ---------- 主题跟随站点（站点是给 <html> 加 .dark） ---------- */

  function isDark() {
    try {
      return !!(document.documentElement && document.documentElement.classList &&
        document.documentElement.classList.contains('dark'));
    } catch (e) { return false; }
  }

  function applyTheme() {
    var d = isDark();
    if (ui.pane && ui.pane.__ztmRoot) ui.pane.__ztmRoot.classList[d ? 'add' : 'remove']('dark');
    if (ui.ovRoot) ui.ovRoot.classList[d ? 'add' : 'remove']('dark');
  }

  /**
   * 把可调的显示项以 CSS 自定义属性喂进梗图栏。
   * 挂在 pane 元素上：自定义属性会穿过影子边界继承给里面的 .grid，
   * 而 pane 是我们自己插进去的节点，Vue 重渲染不会碰它。
   */
  function applyPaneVars() {
    if (!ui.pane || !ui.pane.style || typeof ui.pane.style.setProperty !== 'function') return;
    var n = Math.round(Number(settings.cols));
    if (!isFinite(n) || n <= 0) n = 6;
    n = Math.max(3, Math.min(12, n));
    ui.pane.style.setProperty('--ztm-cols', String(n));
  }

  /* ---------- 影子根工具 ---------- */

  function makeShadow(host, css) {
    var root = null;
    if (host && host.attachShadow) {
      try { root = host.attachShadow({ mode: 'open' }); } catch (e) { root = null; }
    }
    if (!root) root = host;                       // 极老内核：退化为普通子节点
    var st = document.createElement('style');
    st.textContent = css;
    root.appendChild(st);
    return root;
  }

  function ensureSiteCss() {
    if (document.getElementById(PREFIX + '-site-css')) return;
    var st = document.createElement('style');
    st.id = PREFIX + '-site-css';
    st.textContent = SITE_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /* =========================================================================
   * 梗图栏 UI（影子根，与站点样式完全隔离）
   * =======================================================================*/

  function paneHtml() {
    return [
      '<div class="root">',
      '  <div class="bar">',
      '    <input class="q" type="search" autocomplete="off" enterkeyhint="search" placeholder="搜索梗图，如：猫 / 无语 / 哈哈">',
      '    <button class="go" data-a="search" type="button">搜索</button>',
      '    <button class="cfg" data-a="cfg" type="button" title="设置" aria-label="设置">⚙</button>',
      '  </div>',
      '  <div class="st"></div>',
      '  <div class="pb off"><i></i></div>',
      '  <div class="ft off">',
      '    <div class="fi">就绪</div>',
      '    <button class="go" data-a="send" type="button" disabled>发送</button>',
      '  </div>',
      '  <div class="grid"><div class="empty">输入关键词，搜索网络梗图<br>点一下即可发到聊天</div></div>',
      '</div>'
    ].join('\n');
  }

  function buildPaneUi(pane) {
    var root = makeShadow(pane, PANE_CSS);
    var box = document.createElement('div');
    box.innerHTML = paneHtml();
    var wrap = box.firstChild;
    root.appendChild(wrap);
    pane.__ztmRoot = wrap;

    ui.els.root = wrap;
    ui.els.input = wrap.querySelector('.q');
    ui.els.grid = wrap.querySelector('.grid');
    ui.els.status = wrap.querySelector('.st');
    ui.els.bar = wrap.querySelector('.pb');
    ui.els.send = wrap.querySelector('[data-a="send"]');
    ui.els.foot = wrap.querySelector('.ft');
    ui.els.footInfo = wrap.querySelector('.fi');

    // 面板在站点里是浮在输入区上方的，软键盘弹起/收起时不需要我们插手，
    // 但输入必须阻止冒泡：站点在 document 上挂了若干全局键盘/手势监听。
    function swallow(ev) { ev.stopPropagation(); }
    ['keydown', 'keyup', 'keypress', 'pointerdown', 'click', 'contextmenu', 'selectstart']
      .forEach(function (t) { wrap.addEventListener(t, swallow); });

    wrap.addEventListener('click', function (ev) {
      var t = ev.target;
      var el = t && t.closest ? t.closest('[data-a]') : null;
      if (el) {
        var act = el.getAttribute('data-a');
        switch (act) {
          case 'search': doSearch(1); return;
          case 'send': sendSelected(); return;
          case 'cfg': openSettings(); return;
          default: return;
        }
      }
      var cell = t && t.closest ? t.closest('.cell') : null;
      if (cell && cell.getAttribute('data-url')) pickCell(cell);
    });

    if (ui.els.input) {
      ui.els.input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); doSearch(1); }
      });
    }

    // 这里主要不是为了画下拉（下拉在设置面板里、此刻可能还没建），
    // 而是为了把「本次优先用哪个源」定下来 —— 搜索要用它。见 renderSources()。
    renderSources();

    applyPaneVars();
    applyTheme();
  }

  /* =========================================================================
   * 注入：给站点的表情面板补第三个 Tab
   * =======================================================================*/

  function scopeAttrOf(el) {
    var attrs = el && el.attributes;
    if (!attrs) return null;
    for (var i = 0; i < attrs.length; i++) {
      var n = attrs[i].name;
      if (SCOPE_RE.test(n)) return n;
    }
    return null;
  }

  function makeTab(scope) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-label', '梗图搜索');
    b.setAttribute('aria-selected', 'false');
    // 带上站点的作用域属性 → 原生 tab 的样式直接生效；同时用自己的 class 兜底
    b.className = 'emoji-mode-tabs__btn ' + TAB_CLASS;
    if (scope) b.setAttribute(scope, '');
    b.textContent = '梗图';
    return b;
  }

  function makePane(scope) {
    var d = document.createElement('div');
    d.setAttribute('role', 'tabpanel');
    d.setAttribute('aria-label', '梗图搜索');
    d.className = 'emoji-swap__pane ' + PANE_CLASS;
    if (scope) d.setAttribute(scope, '');
    return d;
  }

  /**
   * 把梗图 Tab / 梗图栏插进站点表情面板。幂等，可以反复调用。
   * @returns {boolean} 是否已就绪
   */
  function ensureInjected() {
    var panel = document.querySelector('.composer-emoji-panel');
    if (!panel) { ui.panel = null; return false; }

    // 快路径：已经插好了就别再动 DOM（MutationObserver 会被自己的写入触发）
    if (ui.panel === panel && ui.tab && ui.pane &&
      ui.tab.parentNode === ui.tabs && ui.pane.parentNode === ui.track) return true;

    var tabs = panel.querySelector('.emoji-mode-tabs');
    var track = panel.querySelector('.emoji-swap__track');
    if (!tabs || !track) return false;
    var swap = track.parentNode;

    ensureSiteCss();
    var scope = scopeAttrOf(tabs) || scopeAttrOf(panel);

    ui.panel = panel; ui.tabs = tabs; ui.track = track; ui.swap = swap;

    var tab = tabs.querySelector('.' + TAB_CLASS);
    if (!tab) {
      tab = makeTab(scope);
      tabs.appendChild(tab);
      // 站点切换自己那两个 Tab 时，把梗图栏让出去
      tabs.addEventListener('click', function (ev) {
        var t = ev.target;
        var b = t && t.closest ? t.closest('.emoji-mode-tabs__btn') : null;
        if (b && b !== ui.tab) setMemeMode(false);
      }, true);
    } else if (scope && !scopeAttrOf(tab)) {
      tab.setAttribute(scope, '');
    }
    ui.tab = tab;

    var pane = track.querySelector('.' + PANE_CLASS);
    if (!pane) {
      pane = makePane(scope);
      track.appendChild(pane);
      buildPaneUi(pane);
      try { tab.addEventListener('click', function () { setMemeMode(true); }); } catch (e) { /* ignore */ }
    } else if (scope && !scopeAttrOf(pane)) {
      pane.setAttribute(scope, '');
    }
    ui.pane = pane;

    panel.setAttribute(SITE_READY, '');
    applyPaneVars();
    applyTheme();
    setMemeMode(ui.active);
    return true;
  }

  function setMemeMode(on) {
    if (!ui.tabs || !ui.swap || !ui.tab || !ui.pane) return;
    ui.active = !!on;
    var mark = on ? '' : null;
    if (on) {
      ui.tabs.setAttribute(SITE_MODE, mark);
      ui.swap.setAttribute(SITE_MODE, mark);
    } else {
      ui.tabs.removeAttribute(SITE_MODE);
      ui.swap.removeAttribute(SITE_MODE);
    }
    ui.tab.setAttribute('aria-selected', on ? 'true' : 'false');
    ui.tab.classList[on ? 'add' : 'remove']('on');

    // 让原生的两栏在梗图模式下不可聚焦
    var panes = ui.track.children;
    for (var i = 0; i < panes.length; i++) {
      var p = panes[i];
      if (!p || p === ui.pane || !p.removeAttribute) continue;
      if (on) p.setAttribute('inert', '');
      else p.removeAttribute('inert');
    }
  }

  /** 展开站点表情面板并切到梗图栏（GM 菜单/兜底入口用） */
  function openMemeTab() {
    ensureInjected();
    if (!ui.tab) { toast('请先进入一个聊天房间', 'error'); return; }
    var panel = document.querySelector('.composer-emoji-panel');
    var open = !!(panel && panel.classList && panel.classList.contains('composer-emoji-panel--open'));
    if (!open) {
      var btn = document.querySelector('.composer-tool[aria-label="表情"]');
      if (btn && btn.click) btn.click();
    }
    setMemeMode(true);
    // 面板展开有 .3s 过渡，DOM 可能在动画后又重建一次
    setTimeout(function () { ensureInjected(); setMemeMode(true); }, 380);
  }

  /* =========================================================================
   * 覆盖层：toast + 设置面板
   * =======================================================================*/

  function buildOverlay() {
    if (ui.host) return;
    var host = document.createElement('div');
    host.id = PREFIX + '-host';
    // 挂 <html> 而不是 <body>：站点若给 body 加 transform/filter，
    // 会变成 fixed 的包含块，导致定位跑偏
    host.style.cssText = 'all:initial;position:static;';
    (document.documentElement || document.body).appendChild(host);

    var root = makeShadow(host, OV_CSS);
    var box = document.createElement('div');
    box.className = 'ov';
    box.innerHTML = [
      '<div class="mask off">',
      '  <div class="sheet" role="dialog" aria-label="梗图助手设置">',
      '    <div class="sh"><div class="t">梗图助手设置 <span class="ver">v' + VERSION + '</span></div>',
      '      <button class="x" data-a="close-settings" type="button" aria-label="关闭">✕</button></div>',
      '    <div class="sc">',
      '      <div class="f"><label>表情源</label>',
      '        <div class="sw"><span class="lbl">搜索时优先使用</span><select data-k="sourceId"></select></div>',
      '        <div class="hint">选「自动」= 按下面列表的顺序依次尝试，某个源失败就顺延到下一个。要增删或改写源，见下方「编辑表情源列表」。</div>',
      '      </div>',
      '      <div class="f"><label>服务端地址</label><input type="text" data-k="baseUrl"></div>',
      '      <div class="f"><label>图片代理前缀（无 GM 通道时用于绕过跨域）</label>',
      '        <input type="text" data-k="imageProxy" placeholder="https://wsrv.nl/?url=">',
      '        <div class="hint">留空表示直连。代理会把图片转成可跨域读取的响应。</div></div>',
      '      <div class="f"><label>上传方式</label>',
      '        <div class="sw"><span class="lbl">发送时走哪条上传链路</span>',
      '          <select data-k="uploadMode">',
      '            <option value="auto">自动（优先官方通道）</option>',
      '            <option value="official">只用官方通道</option>',
      '            <option value="manual">只用直连链路</option>',
      '          </select></div>',
      '        <div class="hint">「官方通道」= 把图片塞进站点 composer 的图片上传入口，让官方自己走完上传+发送（协议改了也不用我们跟，但只能发 jpeg/png/webp，所以 GIF 会被转成静态图）。「直连链路」= 脚本自己 presign → OSS PUT → bind → 发 WebSocket 帧，能保留动图 WebP、错误提示更细。<b>自动</b>：能找到官方入口就用它，找不到或交接失败自动回落到直连。如果发现图发不出去（或没出现在聊天里），切成「只用直连链路」。</div>',
      '      </div>',
      '      <div class="f"><label>压缩</label>',
      '        <div class="sw"><span class="lbl">自动压缩超限图片</span>',
      '          <label class="tgl"><input type="checkbox" data-k="autoCompress"><span class="tgl-s"></span></label></div>',
      '        <div class="sw"><span class="lbl">超过此大小(MB)开始压缩</span><input type="number" data-k="compressOverMB" min="1" max="20" step="0.5"></div>',
      '        <div class="sw"><span class="lbl">最长边(px)</span><input type="number" data-k="maxDimension" min="320" max="4096" step="80"></div>',
      '      </div>',
      '      <div class="f"><label>GIF → WebP</label>',
      '        <div class="sw"><span class="lbl">转换模式</span>',
      '          <select data-k="gifToWebp">',
      '            <option value="static">静态 WebP（只留首帧）</option>',
      '            <option value="anim">动图 WebP（保留动画）</option>',
      '            <option value="off">关闭，原样发送 GIF</option>',
      '          </select></div>',
      '        <div class="sw"><span class="lbl">最长边(px)</span><input type="number" data-k="webpMaxDim" min="160" max="2048" step="80"></div>',
      '        <div class="sw"><span class="lbl">质量 (0.5–1)</span><input type="number" data-k="webpQuality" min="0.5" max="1" step="0.05"></div>',
      '        <div class="hint">默认「静态 WebP」：只取首帧，体积最小，而且不依赖内核支持，任何环境都能转。选「动图 WebP」可以保留动画，但它需要内核用 ImageDecoder 逐帧解码再自封装成动图容器（Chrome / 安卓 WebView 94+），内核不支持时会自动降级为静态首帧并明确提示。质量默认 0.70：实测 q=0.9 时产出反而是原 GIF 的 1.5~2 倍（GIF 每帧只存变化区域，WebP 每帧是整幅有损编码），q≈0.7 才稳定压到 0.5~0.85 倍。</div>',
      '      </div>',
      '      <div class="f"><label>显示</label>',
      '        <div class="sw"><span class="lbl">每行显示张数</span><input type="number" data-k="cols" min="3" max="12" step="1"></div>',
      '        <div class="hint">表情栏只有一百多像素高，这个数字直接决定格子大小：默认 6（每行 6 张）。调小（如 4）格子更大、一屏看到的更少；调大（如 8）更密。格子平分面板宽度，所以面板越宽格子越大；反过来手机窄屏上 6 列会偏小，觉得小就调到 4（甚至 3）。</div>',
      '      </div>',
      '      <div class="f"><label>交互</label>',
      '        <div class="sw"><span class="lbl">点击梗图直接发送（关闭后先选中再点「发送」）</span>',
      '          <label class="tgl"><input type="checkbox" data-k="tapSend"><span class="tgl-s"></span></label></div>',
      '      </div>',
      '      <div class="f"><label>编辑表情源列表（JSON 数组，可增删）</label>',
      '        <textarea data-k="sources"></textarea>',
      '        <div class="hint">html 源：url 支持 {kw} {page}，pattern 为正则字符串，exclude 为可选的排除正则；json 源：额外用 path（如 data.list[].url）取图。</div>',
      '        <div class="btns">',
      '          <button class="b gray" data-a="reset-sources" type="button">恢复内置源</button>',
      '          <button class="b gray" data-a="test-src" type="button">测试当前源</button>',
      '        </div>',
      '      </div>',
      '      <div class="f"><label>调试</label>',
      '        <div class="sw"><span class="lbl">输出调试日志到控制台</span>',
      '          <label class="tgl"><input type="checkbox" data-k="showLog"><span class="tgl-s"></span></label></div>',
      '        <div class="logbox" data-k="log"></div>',
      '        <div class="btns">',
      '          <button class="b gray" data-a="copy-log" type="button">复制日志</button>',
      '          <button class="b gray" data-a="clear-log" type="button">清空</button>',
      '        </div>',
      '      </div>',
      '      <div class="hint">默认走<b>官方通道</b>：脚本只把图片交给站点自己的上传入口，后面的 presign → PUT OSS → bind → WS message(type=image) 由站点完成。切成「只用直连链路」时，才由脚本自己按同一套协议发。</div>',
      '    </div>',
      '    <div class="sf">',
      '      <button class="b gray" data-a="close-settings" type="button">取消</button>',
      '      <button class="b" data-a="save" type="button">保存设置</button>',
      '    </div>',
      '  </div>',
      '</div>',
      '<div class="toast"></div>'
    ].join('\n');
    root.appendChild(box);

    ui.host = host;
    ui.shadow = root;
    ui.ovRoot = box;
    ui.els.sheet = box.querySelector('.mask');
    ui.els.toast = box.querySelector('.toast');
    ui.els.logBox = box.querySelector('.logbox');
    // 「表情源」下拉现在住在这里（原来在梗图栏的工具行上）。建完就填一次，
    // 否则用户第一次打开设置会看到一个空下拉。
    ui.els.sourceSel = box.querySelector('[data-k="sourceId"]');
    renderSources();

    box.addEventListener('click', function (ev) {
      var t = ev.target;
      var el = t && t.closest ? t.closest('[data-a]') : null;
      if (!el) return;
      switch (el.getAttribute('data-a')) {
        case 'close-settings': closeSettings(); break;
        case 'save': commitSettings(); break;
        case 'reset-sources': resetSources(); break;
        case 'test-src': testSource(); break;
        case 'copy-log': copyLog(); break;
        case 'clear-log': logBuf.length = 0; if (ui.els.logBox) ui.els.logBox.textContent = ''; break;
        default: break;
      }
    });
    // 点遮罩空白处关闭
    if (ui.els.sheet) {
      ui.els.sheet.addEventListener('click', function (ev) {
        if (ev.target === ui.els.sheet) closeSettings();
      });
    }

    applyTheme();
  }

  function buildUI() {
    buildOverlay();

    ensureInjected();
    ensureSiteCss();
    applyTheme();

    // 房间切换 / SPA 路由会让站点重建 composer；主题也会变。
    // 用 rAF 节流，避免跟站的 DOM 写入互相触发。
    if (typeof MutationObserver === 'function') {
      try {
        var pending = false;
        var obs = new MutationObserver(function () {
          if (pending) return;
          pending = true;
          setTimeout(function () { pending = false; ensureInjected(); applyTheme(); }, 120);
        });
        obs.observe(document.documentElement || document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      } catch (e) { /* ignore */ }
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', function () { ensureInjected(); });
    }
    syncSettingsForm();
  }

  /* ---------- 反馈 ---------- */

  var toastTimer = null;

  function toast(msg, kind) {
    var el = ui.els.toast;
    if (!el) { log('[toast] ' + msg); return; }
    el.textContent = msg;
    // 配色交给 CSS（对齐站内 toast 的语义色），不再写内联样式，
    // 这样深色模式能自动跟着 --tk-* 令牌走。
    var k = kind === 'error' ? 'err' : (kind === 'ok' || kind === 'warn') ? kind : '';
    if (k) { if (el.setAttribute) el.setAttribute('data-kind', k); }
    else if (el.removeAttribute) el.removeAttribute('data-kind');
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 2400);
  }

  function setStatus(text) {
    if (ui.els.status) ui.els.status.textContent = text || '';
    if (ui.els.footInfo) ui.els.footInfo.textContent = text || '';
  }

  function setProgress(p) {
    var bar = ui.els.bar;
    if (!bar) return;
    if (p == null) { bar.classList.add('off'); if (bar.firstChild) bar.firstChild.style.width = '0'; return; }
    bar.classList.remove('off');
    if (bar.firstChild) bar.firstChild.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%';
  }

  function setSendEnabled(on) {
    if (ui.els.send) ui.els.send.disabled = !on;
  }

  function setFootVisible(on) {
    if (ui.els.foot) ui.els.foot.classList[on ? 'remove' : 'add']('off');
  }

  /* ---------- 设置面板开关 ---------- */

  function openSettings() {
    renderSources();          // 先重建源下拉的选项；它的选中值由下面的 syncSettingsForm 按设置填
    syncSettingsForm();
    if (ui.els.logBox) ui.els.logBox.textContent = logBuf.slice(-80).join('\n');
    if (ui.els.sheet) ui.els.sheet.classList.remove('off');
  }

  function closeSettings() {
    if (ui.els.sheet) ui.els.sheet.classList.add('off');
  }

  /* ---------- 渲染 ---------- */

  function gridEmpty(text) {
    var grid = ui.els.grid;
    if (!grid) return;
    grid.innerHTML = '';
    var d = document.createElement('div');
    d.className = 'empty';
    d.innerHTML = esc(text).replace(/\n/g, '<br>');
    grid.appendChild(d);
  }

  /**
   * 刷新「表情源」下拉（在设置面板里），顺带把本次要用的源定下来。
   *
   * 两个职责合在一起是有意的：下拉框挂在设置面板里，而设置面板是懒建的 ——
   * 梗图栏刚注入时它还不存在。但搜索又必须知道「优先用哪个源」，
   * 所以状态那一步不能写在 `if (!sel) return` 后面，否则一装好就搜索会用错源。
   */
  function renderSources() {
    if (!state.sourceId || !pickSource(state.sourceId)) state.sourceId = preferSourceId();

    var sel = ui.els.sourceSel;
    if (!sel) return;
    var list = activeSources();
    sel.innerHTML = '';

    // 「自动」交给 doSearch 的按顺序尝试逻辑（某个源失败就顺延下一个）
    var auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '自动（按顺序尝试）';
    sel.appendChild(auto);

    for (var i = 0; i < list.length; i++) {
      var o = document.createElement('option');
      o.value = list[i].id;
      o.textContent = list[i].name || list[i].id;
      sel.appendChild(o);
    }
    // 存的那个源要是已经被删了/禁用了，就显示回「自动」，别留一个不存在的选中项
    sel.value = pickSource(settings.sourceId) ? settings.sourceId : '';
  }

  function renderResults(list) {
    var grid = ui.els.grid;
    if (!grid) return;
    grid.innerHTML = '';
    if (!list.length) {
      gridEmpty('没有结果，换个关键词或换一个表情源试试');
      return;
    }
    var frag = document.createDocumentFragment();
    for (var i = 0; i < list.length; i++) {
      var url = list[i];
      var cell = document.createElement('div');
      cell.className = 'cell';
      cell.setAttribute('data-url', url);
      cell.setAttribute('title', url);

      var img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.src = url;
      (function (c) {
        img.onerror = function () {
          var b = document.createElement('div');
          b.className = 'm2';
          b.textContent = '加载失败';
          c.appendChild(b);
        };
      })(cell);
      cell.appendChild(img);

      if (/\.gif(\?|$)/i.test(url)) {
        var g = document.createElement('div');
        g.className = 'tg';
        g.textContent = 'GIF';
        cell.appendChild(g);
      }
      frag.appendChild(cell);
    }
    grid.appendChild(frag);
    // 每次结果变化都重置选中态：旧的选中项已经不在 DOM 里了
    state.selected = null;
    setSendEnabled(false);
  }

  /** 点一下格子：默认直接发；关闭 tapSend 时改为选中后再点「发送」 */
  function pickCell(cell) {
    var url = cell && cell.getAttribute ? cell.getAttribute('data-url') : null;
    if (!url) return;
    if (state.busy) { toast('正在处理上一张，请稍候'); return; }

    if (settings.tapSend) {
      sendOne({ type: 'url', url: url, cell: cell });
      return;
    }

    var grid = ui.els.grid;
    var prev = grid && grid.querySelector ? grid.querySelector('.cell.on') : null;
    if (prev && prev !== cell) prev.classList.remove('on');

    if (state.selected === url) {
      state.selected = null;
      cell.classList.remove('on');
      setSendEnabled(false);
      setStatus('已取消选择');
      return;
    }
    state.selected = url;
    cell.classList.add('on');
    setSendEnabled(true);
    setStatus('已选中 ' + shortUrl(url) + '，点「发送」发出');
  }

  function shortUrl(u) {
    try {
      var x = String(u).split('?')[0].split('/');
      return decodeURIComponent(x[x.length - 1] || u).slice(0, 34);
    } catch (e) { return String(u).slice(0, 34); }
  }

  /* ---------- 搜索 ---------- */

  function doSearch(page) {
    var inp = ui.els.input;
    var kw = inp ? String(inp.value || '').trim() : '';
    if (!kw) { toast('请输入关键词'); return; }
    var list = activeSources();
    if (!list.length) { toast('没有可用的表情源，请到设置里配置', 'error'); return; }
    if (state.busy) return;

    var primary = getSource(state.sourceId) || list[0];
    // 选中的源排最前，其余启用源作为备用 —— 失败或返回空时依次顶上
    var order = [primary];
    for (var q = 0; q < list.length; q++) {
      if (list[q].id !== primary.id) order.push(list[q]);
    }

    state.busy = true;
    state.query = kw;
    state.page = page || 1;
    state.selected = null;
    setSendEnabled(false);
    gridEmpty('搜索中…');
    setStatus('正在从「' + (primary.name || primary.id) + '」搜索：' + kw + '（第 ' + state.page + ' 页）');

    var tried = [];

    function attempt(i) {
      var src = order[i];
      var name = src.name || src.id;
      return searchSource(src, kw, state.page).then(function (urls) {
        if (urls && urls.length) return { src: src, urls: urls };
        tried.push(name + '（无结果）');
        if (i + 1 < order.length) {
          log('「' + name + '」没有结果，改用「' + (order[i + 1].name || order[i + 1].id) + '」');
          setStatus('「' + name + '」无结果，正在尝试备用源…');
          return attempt(i + 1);
        }
        return { src: src, urls: [] };
      }, function (err) {
        tried.push(name + '（' + err.message + '）');
        if (i + 1 < order.length) {
          log('「' + name + '」失败：' + err.message + '，改用「' + (order[i + 1].name || order[i + 1].id) + '」');
          setStatus('「' + name + '」失败，正在尝试备用源…');
          return attempt(i + 1);
        }
        throw new Error(tried.join('；') || err.message);
      });
    }

    attempt(0).then(function (r) {
      state.results = r.urls;
      if (r.urls.length) {
        // 记住真正出结果的源，本次会话后面就直接用它。
        // 注意**不回写设置**：某次失败顺延只是临时的，不该把用户选的源改掉；
        // 设置面板里那个下拉始终显示用户的偏好。
        state.sourceId = r.src.id;
      }
      renderResults(r.urls);
      var name = r.src.name || r.src.id;
      if (r.urls.length) {
        setStatus('「' + name + '」第 ' + state.page + ' 页 · ' + r.urls.length + ' 张' +
          (settings.tapSend ? '（点一下直接发送）' : '（先选中再点发送）'));
        if (tried.length) toast('已自动切换到「' + name + '」', 'warn');
      } else {
        setStatus('没有搜索结果');
        gridEmpty('没有搜索结果，换个关键词或换个源试试');
      }
    }).catch(function (e) {
      state.results = [];
      gridEmpty('搜索失败：' + e.message);
      setStatus('搜索失败：' + e.message);
      toast('所有表情源都失败了', 'error');
    }).then(function () {
      state.busy = false;
    });
  }

  function testSource() {
    var src = getSource(state.sourceId);
    if (!src) { toast('没有可用表情源', 'error'); return; }
    var inp = ui.els.input;
    var kw = (inp ? String(inp.value || '').trim() : '') || '哈哈';
    setStatus('测试「' + src.name + '」…');
    searchSource(src, kw, 1).then(function (urls) {
      toast('可用，返回 ' + urls.length + ' 张', 'ok');
      setStatus('测试通过：' + urls.length + ' 张');
    }).catch(function (e) {
      toast('测试失败：' + e.message, 'error');
      setStatus('测试失败：' + e.message);
    });
  }

  /* =========================================================================
   * 10.5 正规化上传：把图交给站点自己的图片上传入口
   *
   * 我们原先的做法是「照抄协议」——自己 presign → OSS PUT → bind → 发 WS 帧。
   * 这条路能用（抓包逐字对过），但服务端改协议就得跟着改，而且它绕过了站点
   * 自己的上传器。更正规的做法是把文件塞进 composer 的 <input type=file>，
   * 让**官方上传链路**自己去走完那四步：它自己知道收哪些格式、自己做进度与
   * 失败提示，协议变了也不用我们跟。
   *
   * 做法参考站点自己分发的那版脚本（v1.0.2）。注意几条踩过的坑：
   *   1. 「表情包」栏的上传框（.sticker-ui__file）是收藏表情用的，不是发图，必须跳过；
   *      表情面板（.composer-emoji-panel）里的输入框同理。
   *   2. 派发 change **之前不能先把面板关掉**：站点 onImagePicked 会自己关，
   *      提前关会让 Vue 重建 input，刚塞进去的 files 一起丢掉。
   *   3. 站点聊天不认 GIF（它自己的 toChatImage 就是把 GIF 转 JPEG），
   *      所以 GIF 要在交给官方之前先转成静帧。
   *   4. File / DataTransfer 优先用页面 Realm 的（UNSAFE）：脚本跑在沙箱里，
   *      用沙箱 Realm 造出来的 FileList 赋给页面元素上的 input.files 不保险。
   * =======================================================================*/

  /**
   * 找站点 composer 的「发图」输入框。
   * 三级优先：composer 行内且收 jpeg > 页面上任意收 jpeg 的 > composer 行内收其他图片的。
   * 站点自己的发图入口 accept 里一定有 image/jpeg（或 .jpg），所以「收 jpeg」是主判据；
   * 最后一档兜底**限定在 composer 行内**，免得误抓页面上别的 `input[type=file]`
   * （换头像、传背景图之类）——参考实现只认 jpeg，我们放宽一档但加了作用域限制。
   */
  function findComposerFileInput() {
    var nodes = document.querySelectorAll('input[type="file"]');
    var jpg = null;      // 页面上收 jpeg 的（站点发图输入框基本都收 jpeg）
    var anyImg = null;   // composer 行内任意收图片的，最后兜底
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.disabled) continue;
      if (el.classList && el.classList.contains('sticker-ui__file')) continue;
      if (el.closest) {
        if (el.closest('.composer-emoji-panel')) continue;      // 表情面板里的不是 composer 的
        if (el.closest('.' + PANE_CLASS)) continue;             // 我们自己的梗图栏
        if (el.closest('#' + PREFIX + '-host')) continue;       // 我们自己的设置面板
      }
      var acc = String(el.getAttribute('accept') || '').toLowerCase();
      var takesJpg = acc.indexOf('jpeg') >= 0 || acc.indexOf('jpg') >= 0;
      var takesImg = takesJpg || acc.indexOf('image') >= 0 ||
        acc.indexOf('png') >= 0 || acc.indexOf('webp') >= 0 || acc.indexOf('gif') >= 0;
      if (!takesImg) continue;
      // 写成两次 closest 而不是 '.composer-row,.input-card'：逗号选择器在
      // 单测桩件的选择器引擎里不支持，拆开既好读也免得桩件给出假结论。
      var inComposer = el.closest ? (!!el.closest('.composer-row') || !!el.closest('.input-card')) : false;
      if (takesJpg && inComposer) return el;
      if (takesJpg && !jpg) jpg = el;
      if (takesImg && inComposer && !anyImg) anyImg = el;
    }
    return jpg || anyImg;
  }

  function blobToArrayBuffer(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('读取图片数据失败')); };
      fr.readAsArrayBuffer(blob);
    });
  }

  /**
   * 把 blob 交给站点的上传入口：造 File → 塞进 input.files → 派发 change。
   * @returns {Promise<void>} resolve 表示已交接（后续由站点自己上传），reject 表示交接失败
   */
  function handoffToComposer(blob) {
    var input = findComposerFileInput();
    if (!input) return Promise.reject(new Error('找不到站点的图片上传入口'));

    // 站点聊天不认 GIF；其余非图片类型也一律按 jpeg 交出去（与站点 toChatImage 一致）
    var mime = String(blob.type || '');
    if (mime.indexOf('image/') !== 0 || mime === 'image/gif') mime = 'image/jpeg';
    var name = mime === 'image/png' ? 'meme.png'
      : mime === WEBP_MIME ? 'meme.webp'
        : 'meme.jpg';

    return blobToArrayBuffer(blob).then(function (buf) {
      var FileCtor = UNSAFE.File || File;
      var DTCtor = UNSAFE.DataTransfer || DataTransfer;
      var EvCtor = UNSAFE.Event || Event;
      var file = new FileCtor([buf], name, { type: mime, lastModified: Date.now() });
      var dt = new DTCtor();
      dt.items.add(file);
      input.files = dt.files;
      if (!input.files || !input.files.length) throw new Error('无法把图片交给官方上传');
      // 见文件头注释第 2 条：这里绝不能先关面板
      input.dispatchEvent(new EvCtor('change', { bubbles: true }));
      log('已交给官方上传通道', name, bytesText(blob.size), mime);
    });
  }

  /**
   * 官方通道只认 jpeg/png/webp。用户把「GIF → WebP」关掉时会走到这里，
   * 补一次 GIF → 静帧 JPEG，否则官方会拒收（这就是站点自己 toChatImage 干的事）。
   */
  function ensureNonGifPayload(got) {
    if (!isGif(got.blob.type, got.filename)) return Promise.resolve(got);
    var over = settings.autoCompress ? settings.compressOverMB * 1024 * 1024 : 0;
    setStatus('GIF 转静态图（官方通道不认 GIF）…');
    setProgress(0.72);
    return compressBlob(got.blob, over, settings.maxDimension).then(function (c) {
      log('官方通道不认 GIF，已转 JPEG：' + bytesText(got.blob.size) + ' → ' + bytesText(c.blob.size));
      return { blob: c.blob, filename: c.filename };
    }).catch(function (e) {
      log('GIF 转静态图失败，仍按原样交给官方：' + e.message);
      return got;
    });
  }

  /* ---------- 发送主流程 ---------- */

  function sendSelected() {
    if (!state.selected) { toast('先点一张梗图选中它'); return; }
    var url = state.selected;
    sendOne({ type: 'url', url: url });
  }

  /**
   * 直连上传（我们自己的链路）：presign → OSS PUT → bind → 发 WS 帧。
   * 官方通道不可用时用它兜底；也可以用设置强制只走它。
   * @returns {Promise<{url:string, acked:boolean}>}
   */
  function manualUploadAndSend(got, roomId) {
    function put(blob, filename) {
      setStatus('上传中（' + bytesText(blob.size) + '）…');
      setProgress(0.78);
      return uploadImage(blob, filename, roomId, function (p) {
        setProgress(0.78 + p * 0.18);
      });
    }

    return put(got.blob, got.filename).catch(function (e) {
      var isWebpFile = (got.blob.type === WEBP_MIME);

      // 服务端不接受 webp（扩展名白名单/iOS 兼容之类）→ 原样回退发原图，别让用户白等
      if (e.reason === 'unsupported' && got.fallback) {
        log('服务端不接受 WebP（' + e.message + '），回退发送原图');
        toast('服务端不支持 WebP，已改发原图', 'warn');
        setStatus('服务端不支持 WebP，改发原图…');
        return put(got.fallback.blob, got.fallback.filename);
      }

      if (e.reason === 'too_large' && settings.autoCompress && !isGif(got.blob.type, got.filename)) {
        setStatus('服务端提示过大，正在压缩重试…');
        // WebP 走「降分辨率重转」，别用 JPEG 压，否则动图会变静态
        var retry = isWebpFile
          ? convertToWebpFitted(got.blob, settings.gifToWebp, Math.max(160, Math.round(settings.webpMaxDim * 0.6)),
            Math.max(0.5, settings.webpQuality - 0.15), 1024 * 1024)
          : compressBlob(got.blob, 1024 * 1024, settings.maxDimension).then(function (c) {
            c.filename = ensureExt('meme.jpg', c.blob.type);
            return c;
          });
        return retry.then(function (c) {
          if (c.blob && c.blob.type === WEBP_MIME) c.filename = 'meme.webp';
          return put(c.blob, c.filename);
        });
      }
      throw e;
    }).then(function (bound) {
      setProgress(0.97);
      setStatus('发送中…');
      return sendImageFrame(bound.url).then(function (res) {
        return { url: bound.url, acked: !!(res && res.acked) };
      });
    });
  }

  // v1.2.3 起面板上不再有「链接」「本地」两个入口（面板只有一百多像素高，
  // 这一行按钮太占地方）。sendOne 仍然支持 { type:'url' } / { type:'file' }，
  // 想恢复的话只要把按钮加回 paneHtml 的 .bar 并接上对应分支即可。
  function sendOne(src) {
    if (state.busy) { toast('正在处理上一张，请稍候'); return; }

    // 上传方式（v1.2.4）：auto = 能找到站点的图片上传入口就交给官方，
    // 找不到/交接失败再回落到我们自己的直连链路；official / manual 则强制只走一条。
    var mode = (settings.uploadMode === 'official' || settings.uploadMode === 'manual')
      ? settings.uploadMode : 'auto';
    var useOfficial = mode !== 'manual' && !!findComposerFileInput();
    if (mode === 'official' && !useOfficial) {
      toast('找不到站点的图片上传入口，请先打开表情面板再发', 'error');
      return;
    }

    // 官方通道是站点自己在传，不需要我们 hook 到 WS、也不需要房间 id；
    // 只有走直连链路时才校验这两样。
    var roomId = null;
    if (!useOfficial) {
      roomId = getRoomId();
      if (!roomId) { toast('请先进入一个聊天房间', 'error'); return; }
      if (!liveSocket()) { toast('聊天连接未就绪，请刷新页面', 'error'); return; }
    }

    state.busy = true;
    setSendEnabled(false);
    setProgress(0);
    setStatus('准备中…');
    // 点哪张就把「处理中」标在哪张上，面板很矮，全靠状态反馈
    if (src.cell) {
      src.cell.classList.add('busy');
      if (src.cell.querySelector && !src.cell.querySelector('.m2')) {
        var tip = document.createElement('div');
        tip.className = 'm2';
        tip.textContent = '处理中…';
        src.cell.appendChild(tip);
      }
    }
    function clearCell(state2) {
      if (!src.cell) return;
      src.cell.classList.remove('busy');
      var tip = src.cell.querySelector ? src.cell.querySelector('.m2') : null;
      if (tip) {
        if (!state2) { tip.remove(); return; }
        tip.textContent = state2;
      }
    }

    Promise.resolve()
      .then(function () {
        if (src.type === 'file') {
          return { blob: src.file, filename: src.file.name || ('meme-' + Date.now() + '.jpg') };
        }
        setStatus('下载图片…');
        return downloadImage(src.url, function (p) {
          setProgress(0.3 + p * 0.4);
        });
      })
      .then(function (got) {
        // —— GIF → WebP ——
        var mode = settings.gifToWebp;
        if (!mode || mode === 'off') return got;
        if (!isGif(got.blob.type, got.filename)) return got;
        if (!canEncodeWebp()) {
          log('内核不支持 WebP 编码，保持原 GIF');
          return got;
        }
        var over = settings.compressOverMB * 1024 * 1024;
        setStatus('GIF → WebP 转换中…');
        setProgress(0.62);
        return convertToWebpFitted(
          got.blob, mode, settings.webpMaxDim, settings.webpQuality,
          settings.autoCompress ? over : 0
        ).then(function (r) {
          log('GIF→WebP：' + (r.frames > 1 ? r.frames + ' 帧动图' : '静帧') +
            ' ' + bytesText(got.blob.size) + ' → ' + bytesText(r.blob.size) +
            (r.degraded ? '（内核不支持动图，已降级为静态首帧）' : ''));
          if (r.degraded) toast('内核不支持动图 WebP，已按静态首帧转换', 'warn');
          if (r.blob.size >= got.blob.size) {
            log('转换后反而更大（' + bytesText(r.blob.size) + '），保留原 GIF');
            return got;
          }
          // 留着原图：万一服务端不接受 webp，还能原样发出去
          return { blob: r.blob, filename: r.filename, fromGif: true, fallback: got };
        }).catch(function (e) {
          log('GIF→WebP 失败，保留原 GIF：' + e.message);
          return got;
        });
      })
      .then(function (got) {
        var over = settings.compressOverMB * 1024 * 1024;
        var isGifFile = isGif(got.blob.type, got.filename);
        // WebP 不参与 JPEG 压缩：那会把动图压成静态图，等于白转
        var isWebpFile = (got.blob.type === WEBP_MIME);
        if (settings.autoCompress && got.blob.size > over && !isGifFile && !isWebpFile) {
          setStatus('压缩图片（' + bytesText(got.blob.size) + '）…');
          setProgress(0.72);
          return compressBlob(got.blob, over, settings.maxDimension).then(function (c) {
            c.filename = ensureExt('meme.jpg', c.blob.type);
            log('压缩完成 ' + bytesText(got.blob.size) + ' → ' + bytesText(c.blob.size));
            return c;
          }).catch(function (e) {
            log('压缩失败，使用原图：' + e.message);
            return got;
          });
        }
        return got;
      })
      .then(function (got) {
        if (!useOfficial) {
          return manualUploadAndSend(got, roomId).then(function (res) {
            return { via: 'manual', res: res };
          });
        }
        // —— 官方通道：只负责把图交接过去，上传/发送由站点自己做 ——
        return ensureNonGifPayload(got).then(function (g2) {
          setStatus('交给官方上传（' + bytesText(g2.blob.size) + '）…');
          setProgress(0.86);
          return handoffToComposer(g2.blob).then(function () {
            return { via: 'official' };
          }, function (e) {
            log('官方上传入口交接失败：' + e.message);
            if (mode === 'official') throw e;
            // auto：安静回落到自己的直连链路，别让用户白等
            toast('官方通道不可用，改用直连上传', 'warn');
            var rid = getRoomId();
            if (!rid || !liveSocket()) {
              throw new Error('官方通道不可用，且聊天连接未就绪');
            }
            return manualUploadAndSend(g2, rid).then(function (res) {
              return { via: 'manual', res: res };
            });
          });
        });
      })
      .then(function (r) {
        setProgress(1);
        if (r.via === 'official') {
          toast('已交给官方上传 ✓', 'ok');
          setStatus('已交给官方上传，稍候图片出现即可');
        } else if (r.res.acked) {
          toast('已发送 ✓', 'ok');
          setStatus('已发送：' + shortUrl(r.res.url));
        } else {
          toast('已提交，但未收到回执，请确认是否送达', 'warn');
          setStatus('已提交（未收到回执）：' + shortUrl(r.res.url));
        }
        clearCell('');
        setTimeout(function () { setProgress(null); }, 700);
      })
      .catch(function (e) {
        setProgress(null);
        var msg = (e && e.message) || '发送失败';
        toast(msg, 'error');
        setStatus('失败：' + msg);
        clearCell('失败');
        log('发送失败', e);
      })
      .then(function () {
        state.busy = false;
        setSendEnabled(!!state.selected || !!settings.tapSend);
      });
  }

  /* ---------- 设置表单 ---------- */

  function syncSettingsForm() {
    var w = ui.ovRoot;
    if (!w) return;
    var inputs = w.querySelectorAll('[data-k]');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var k = el.getAttribute('data-k');
      if (k === 'log') continue;
      if (el.type === 'checkbox') { el.checked = !!settings[k]; }
      else if (k === 'sources') { el.value = JSON.stringify(settings.sources, null, 2); }
      else { el.value = settings[k] == null ? '' : settings[k]; }
    }
  }

  function commitSettings() {
    var w = ui.ovRoot;
    if (!w) return;
    var inputs = w.querySelectorAll('[data-k]');
    var next = clone(settings);
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var k = el.getAttribute('data-k');
      if (k === 'log') continue;
      if (el.type === 'checkbox') { next[k] = el.checked; continue; }
      if (el.type === 'number') {
        var n = parseFloat(el.value);
        next[k] = isNaN(n) ? settings[k] : n;
        continue;
      }
      if (k === 'sources') {
        try {
          var arr = JSON.parse(el.value);
          if (!Array.isArray(arr)) throw new Error('必须是数组');
          next.sources = arr;
        } catch (e) {
          toast('表情源 JSON 解析失败：' + e.message, 'error');
          return;
        }
        continue;
      }
      next[k] = el.value;
    }
    settings = mergeSettings(next);
    saveSettings();
    // 优先源以设置为准（选「自动」就回到列表第一个）。必须写在 renderSources 之前：
    // renderSources 只会在「当前源已失效」时才重新挑，从 A 改成 B 是不管的。
    state.sourceId = preferSourceId();
    renderSources();
    applyPaneVars();                       // 每行张数可能被改了，立刻生效
    setFootVisible(!settings.tapSend);
    if (!settings.tapSend) setSendEnabled(false);
    closeSettings();
    toast('设置已保存', 'ok');
    log('设置已保存');
  }

  function resetSources() {
    settings.sources = clone(DEFAULT_SOURCES);
    saveSettings();
    syncSettingsForm();
    renderSources();
    toast('已恢复内置表情源', 'ok');
  }

  function copyLog() {
    var text = logBuf.join('\n');
    function done() { toast('日志已复制', 'ok'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch (e) { toast('复制失败', 'error'); }
    }
  }

  /* =========================================================================
   * 12. 启动
   * =======================================================================*/

  installWsHook();

  function boot() {
    buildUI();
    setFootVisible(!settings.tapSend);
    if (typeof GM_registerMenuCommand === 'function') {
      try {
        GM_registerMenuCommand('打开梗图面板', openMemeTab);
        GM_registerMenuCommand('梗图助手设置', openSettings);
      } catch (e) { /* ignore */ }
    }
    log('梗图助手已加载 v' + VERSION, {
      mobile: isMobile(),
      gm: (typeof GM_xmlhttpRequest === 'function'),
      sources: activeSources().length,
      injected: !!ui.tab
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
