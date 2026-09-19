// ==UserScript==
// @name         零语表情包助手 · Zerotalk Meme Helper
// @namespace    https://app.zerotalk.cn/
// @version      1.0.1
// @description  悬浮窗搜索网络表情包，一键以图片消息发送到零语聊天房间。完整复刻官方上传链路（presign → OSS PUT → bind → WebSocket message），支持手机端 Via 浏览器。
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

  var VERSION = '1.0.1';
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
    }
  ];

  var SETTINGS_KEY = 'settings';

  var settings = mergeSettings(store.get(SETTINGS_KEY, {}));

  function mergeSettings(raw) {
    var base = {
      baseUrl: DEFAULT_BASE,
      skipConfirm: false,
      autoCompress: true,
      compressOverMB: 4,
      maxDimension: 1600,
      imageProxy: 'https://wsrv.nl/?url=',
      preferHookSocket: true,
      allowStandaloneSocket: false,
      showLog: false,
      theme: 'auto',
      sources: null
    };
    var out = {};
    for (var k in base) { if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k]; }
    if (raw && typeof raw === 'object') {
      for (var k2 in raw) { if (Object.prototype.hasOwnProperty.call(raw, k2)) out[k2] = raw[k2]; }
    }
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
    if (ui && ui.isOpen && ui.logBox && ui.logBox.parentNode) {
      ui.logBox.textContent = logBuf.slice(-80).join('\n');
      ui.logBox.scrollTop = ui.logBox.scrollHeight;
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
          var m0 = res.blob.type || mimeFromName(res.filename);
          if (m0 === 'application/octet-stream') m0 = mimeFromName(res.filename);
          if (m0.indexOf('image/') !== 0) throw new Error('返回内容不是图片');
          return { blob: (res.blob.type === m0) ? res.blob : res.blob.slice(0, res.blob.size, m0), filename: alignName(res.filename, m0) };
        }
        if (!res || !res.body || res.status < 200 || res.status >= 300) throw new Error('下载失败 HTTP ' + (res && res.status));
        var buf = res.body;
        if (!(buf instanceof ArrayBuffer) && !(buf instanceof Uint8Array)) throw new Error('响应体异常');
        var mime = sniffMime(res.headers) || mimeFromName(fileName);
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
    var contentType = blob.type || mimeFromName(filename) || 'image/jpeg';
    if (contentType === 'application/octet-stream') contentType = mimeFromName(filename);
    var ext = extFromName(filename, contentType);
    var size = blob.size;
    if (!size || size < 1) return Promise.reject(new Error('文件大小无效'));

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
          var e2 = new Error(msg || '格式不支持'); e2.reason = 'unsupported'; throw e2;
        }
        if (code === 'bind_failed' || /校验/.test(msg)) {
          var e3 = new Error(msg || '上传校验失败'); e3.reason = 'bind_failed'; throw e3;
        }
        throw e;
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

  var ui = {
    host: null, root: null, shadow: null, isOpen: false,
    logBox: null, els: {}
  };

  var CSS = [
    ':host{all:initial;}',
    '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}',
    /* 交互层显式声明可点，不依赖继承（宿主/包裹层可能被置为 pointer-events:none） */
    '.fab,.panel{pointer-events:auto;}',
    /* 移动端：去掉 300ms 点击延迟，控件内的手势交给浏览器原生处理 */
    '.ib,.btn,.cell,.sw input,.srch input,.row select{touch-action:manipulation;}',
    '.hd,.fab{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;}',
    '.wrap{',
    '  --bg:#ffffff; --bg2:#f6f7f9; --fg:#1c1d21; --fg2:#6b7280; --line:#e5e7eb;',
    '  --brand:#e8734a; --brand2:#ff9a6b; --ok:#16a34a; --err:#dc2626;',
    '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;',
    '  font-size:14px; line-height:1.5; color:var(--fg);',
    '}',
    '.wrap.dark{--bg:#1c1d21; --bg2:#26282d; --fg:#f2f3f5; --fg2:#9aa0a6; --line:#3a3d44;}',

    /* FAB */
    '.fab{position:fixed;z-index:2147483000;width:46px;height:46px;border-radius:23px;',
    '  background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;border:0;',
    '  box-shadow:0 6px 18px rgba(232,115,74,.42);display:flex;align-items:center;justify-content:center;',
    '  font-size:20px;cursor:pointer;touch-action:none;user-select:none;transition:transform .15s;}',
    '.fab:active{transform:scale(.92);}',
    '.fab.hidden{display:none;}',

    /* Panel */
    '.panel{position:fixed;z-index:2147483001;display:flex;flex-direction:column;',
    '  background:var(--bg);border:1px solid var(--line);border-radius:14px;overflow:hidden;',
    '  box-shadow:0 18px 48px rgba(0,0,0,.22);}',
    '.panel.hidden{display:none;}',
    '.panel.full{left:0!important;right:0!important;top:auto!important;bottom:0!important;width:auto!important;height:72vh!important;border-radius:14px 14px 0 0;}',
    /* 底部大面板时宽高由 !important 锁死，缩放手柄无意义且会挡住内容 */
    '.panel.full .rz{display:none;}',
    '.panel.full .hd{cursor:default;}',

    '.hd{display:flex;align-items:center;gap:6px;padding:9px 10px;background:var(--bg2);',
    '  border-bottom:1px solid var(--line);cursor:move;touch-action:none;flex:0 0 auto;}',
    '.hd .t{font-weight:600;font-size:13px;flex:0 0 auto;white-space:nowrap;}',
    '.hd .sp{flex:1 1 auto;min-width:4px;}',
    '.ib{width:28px;height:28px;border-radius:8px;border:1px solid transparent;background:transparent;',
    '  color:var(--fg2);font-size:15px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto;}',
    '.ib:hover{background:rgba(128,128,128,.14);color:var(--fg);}',
    '.ib.on{color:var(--brand);}',

    '.bd{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;}',

    '.srch{display:flex;gap:6px;padding:9px 10px 6px;flex:0 0 auto;}',
    '.srch input{flex:1 1 auto;min-width:0;height:34px;padding:0 10px;border-radius:9px;border:1px solid var(--line);',
    '  background:var(--bg2);color:var(--fg);font-size:14px;outline:none;}',
    '.srch input:focus{border-color:var(--brand);}',
    '.btn{height:34px;padding:0 13px;border-radius:9px;border:0;background:var(--brand);color:#fff;',
    '  font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;}',
    '.btn:disabled{opacity:.5;cursor:not-allowed;}',
    '.btn.gray{background:var(--bg2);color:var(--fg);border:1px solid var(--line);}',
    '.btn.sm{height:28px;padding:0 10px;font-size:12px;}',

    '.row{display:flex;align-items:center;gap:6px;padding:0 10px 8px;flex:0 0 auto;flex-wrap:wrap;}',
    '.row select{height:28px;border-radius:8px;border:1px solid var(--line);background:var(--bg2);color:var(--fg);',
    '  font-size:12px;padding:0 6px;outline:none;max-width:46%;}',

    '.status{padding:0 10px 6px;font-size:11.5px;color:var(--fg2);flex:0 0 auto;min-height:16px;',
    '  display:flex;align-items:center;gap:6px;}',
    '.bar{height:3px;border-radius:2px;background:var(--line);overflow:hidden;margin:0 10px 6px;flex:0 0 auto;}',
    '.bar i{display:block;height:100%;width:0;background:var(--brand);transition:width .18s;}',
    '.bar.hidden{display:none;}',

    '.grid{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:0 8px 8px;',
    '  display:grid;grid-template-columns:repeat(3,1fr);gap:6px;align-content:start;-webkit-overflow-scrolling:touch;}',
    '.grid.wide{grid-template-columns:repeat(4,1fr);}',
    '.cell{position:relative;padding-top:100%;border-radius:9px;overflow:hidden;background:var(--bg2);',
    '  border:2px solid transparent;cursor:pointer;}',
    '.cell img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;}',
    '.cell.sel{border-color:var(--brand);}',
    '.cell .badge{position:absolute;left:3px;bottom:3px;background:rgba(0,0,0,.62);color:#fff;',
    '  font-size:9.5px;padding:1px 4px;border-radius:4px;letter-spacing:.3px;}',
    '.empty{grid-column:1/-1;text-align:center;color:var(--fg2);font-size:12.5px;padding:26px 8px;}',

    '.ft{flex:0 0 auto;border-top:1px solid var(--line);background:var(--bg2);padding:7px 10px;',
    '  display:flex;align-items:center;gap:8px;}',
    '.ft .info{flex:1 1 auto;min-width:0;font-size:11.5px;color:var(--fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',

    /* settings */
    '.sheet{position:absolute;inset:0;background:var(--bg);display:flex;flex-direction:column;z-index:5;}',
    '.sheet.hidden{display:none;}',
    '.sheet .sh{display:flex;align-items:center;padding:9px 10px;border-bottom:1px solid var(--line);background:var(--bg2);}',
    '.sheet .sh .t{font-weight:600;flex:1 1 auto;font-size:13px;}',
    '.sheet .sc{flex:1 1 auto;overflow-y:auto;padding:10px 12px 20px;-webkit-overflow-scrolling:touch;}',
    '.f{margin-bottom:13px;}',
    '.f label{display:block;font-size:12px;color:var(--fg2);margin-bottom:4px;}',
    '.f input[type=text],.f input[type=number],.f textarea{width:100%;padding:7px 9px;border-radius:8px;',
    '  border:1px solid var(--line);background:var(--bg2);color:var(--fg);font-size:13px;outline:none;font-family:inherit;}',
    '.f textarea{min-height:120px;resize:vertical;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.5;}',
    '.sw{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px dashed var(--line);}',
    '.sw span{font-size:12.5px;}',
    '.sw input[type=checkbox]{width:38px;height:21px;-webkit-appearance:none;appearance:none;background:var(--line);',
    '  border-radius:11px;position:relative;outline:none;cursor:pointer;transition:background .18s;flex:0 0 auto;}',
    '.sw input[type=checkbox]:checked{background:var(--brand);}',
    '.sw input[type=checkbox]::after{content:"";position:absolute;top:2px;left:2px;width:17px;height:17px;',
    '  border-radius:50%;background:#fff;transition:transform .18s;}',
    '.sw input[type=checkbox]:checked::after{transform:translateX(17px);}',
    '.hint{font-size:11px;color:var(--fg2);margin-top:4px;line-height:1.45;}',
    '.logbox{width:100%;height:130px;overflow:auto;background:var(--bg2);border:1px solid var(--line);',
    '  border-radius:8px;padding:6px 8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;',
    '  white-space:pre-wrap;word-break:break-all;color:var(--fg2);}',

    '.rz{position:absolute;right:2px;bottom:2px;width:16px;height:16px;cursor:nwse-resize;z-index:6;opacity:.5;}',
    '.rz::after{content:"";position:absolute;right:3px;bottom:3px;width:8px;height:8px;',
    '  border-right:2px solid var(--fg2);border-bottom:2px solid var(--fg2);}',

    '.toast{position:fixed;z-index:2147483002;left:50%;bottom:78px;transform:translateX(-50%);',
    '  background:rgba(28,29,33,.93);color:#fff;font-size:12.5px;padding:8px 14px;border-radius:20px;',
    '  max-width:82vw;text-align:center;opacity:0;transition:opacity .2s;pointer-events:none;}',
    '.toast.on{opacity:1;}',
    '@media(max-width:820px){.panel{max-width:94vw;}}'
  ].join('\n');

  var toastTimer = null;

  function toast(msg, kind) {
    if (!ui.shadow) return;
    var el = ui.els.toast;
    if (!el) return;
    el.textContent = msg;
    el.style.background = kind === 'error' ? 'rgba(190,32,32,.95)'
      : kind === 'ok' ? 'rgba(20,130,60,.95)'
        : kind === 'warn' ? 'rgba(196,120,10,.95)' : 'rgba(28,29,33,.93)';
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 2400);
  }

  function setStatus(text) {
    if (ui.els.status) ui.els.status.textContent = text || '';
  }

  function setProgress(p) {
    if (!ui.els.bar) return;
    if (p == null) { ui.els.bar.classList.add('hidden'); ui.els.bar.firstChild.style.width = '0'; return; }
    ui.els.bar.classList.remove('hidden');
    ui.els.bar.firstChild.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%';
  }

  var state = {
    query: '', page: 1, results: [], selected: null, busy: false, sourceId: null
  };

  function buildUI() {
    if (ui.host) return;

    var host = document.createElement('div');
    host.id = PREFIX + '-host';
    // 挂到 <html> 而不是 <body>：站点若给 body 加了 transform/filter，
    // 会变成 fixed 的包含块，导致悬浮窗定位（进而命中区域）跑偏。
    host.style.cssText = 'all:initial;position:static;';
    (document.documentElement || document.body).appendChild(host);
    var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : null;
    if (!shadow) {
      // 极老内核没有 shadow DOM，退化为普通挂载
      shadow = host;
      var st = document.createElement('style');
      st.textContent = '#ztm-host ' + CSS.replace(/\n/g, '\n#ztm-host ');
      document.head.appendChild(st);
    } else {
      var st2 = document.createElement('style');
      st2.textContent = CSS;
      shadow.appendChild(st2);
    }

    var wrap = document.createElement('div');
    wrap.className = 'wrap' + (settings.theme === 'dark' ||
      (settings.theme === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? ' dark' : '');
    shadow.appendChild(wrap);

    wrap.innerHTML = [
      '<button class="fab" type="button" title="表情包助手">😊</button>',
      '<div class="panel hidden" role="dialog" aria-label="表情包助手">',
      '  <div class="hd">',
      '    <div class="t">表情包 <span style="opacity:.55;font-size:10.5px">v' + VERSION + '</span></div>',
      '    <div class="sp"></div>',
      '    <button class="ib" data-act="wide" title="列数">▦</button>',
      '    <button class="ib" data-act="theme" title="主题">◐</button>',
      '    <button class="ib" data-act="settings" title="设置">⚙</button>',
      '    <button class="ib" data-act="min" title="收起">—</button>',
      '  </div>',
      '  <div class="bd">',
      '    <div class="srch">',
      '      <input type="search" placeholder="搜索表情包，如：哈哈 / 猫 / 无语" autocomplete="off" enterkeyhint="search">',
      '      <button class="btn" data-act="search">搜索</button>',
      '    </div>',
      '    <div class="row">',
      '      <select data-act="source"></select>',
      '      <button class="btn gray sm" data-act="next">换一批</button>',
      '      <button class="btn gray sm" data-act="url">发链接</button>',
      '      <button class="btn gray sm" data-act="file">传本地</button>',
      '    </div>',
      '    <div class="status"></div>',
      '    <div class="bar hidden"><i></i></div>',
      '    <div class="grid"><div class="empty">输入关键词开始搜索表情包</div></div>',
      '    <div class="ft">',
      '      <div class="info">就绪</div>',
      '      <button class="btn sm" data-act="send" disabled>发送</button>',
      '    </div>',
      '  </div>',
      '  <div class="sheet hidden">',
      '    <div class="sh"><div class="t">设置</div><button class="ib" data-act="close-settings">✕</button></div>',
      '    <div class="sc">',
      '      <div class="f"><label>服务端地址</label><input type="text" data-k="baseUrl"></div>',
      '      <div class="f"><label>图片代理前缀（无 GM 通道时用于绕过跨域）</label>',
      '        <input type="text" data-k="imageProxy" placeholder="https://wsrv.nl/?url=">',
      '        <div class="hint">留空表示直连。代理会把图片转成可跨域读取的响应。</div></div>',
      '      <div class="f"><label>压缩</label>',
      '        <div class="sw"><span>自动压缩超限图片</span><input type="checkbox" data-k="autoCompress"></div>',
      '        <div class="sw"><span>超过此大小(MB)开始压缩</span><input type="number" data-k="compressOverMB" min="1" max="20" step="0.5" style="width:84px"></div>',
      '        <div class="sw"><span>最长边(px)</span><input type="number" data-k="maxDimension" min="320" max="4096" step="80" style="width:84px"></div>',
      '      </div>',
      '      <div class="f"><label>交互</label>',
      '        <div class="sw"><span>点击表情直接发送（不弹确认）</span><input type="checkbox" data-k="skipConfirm"></div>',
      '      </div>',
      '      <div class="f"><label>表情源（JSON 数组，可增删）</label>',
      '        <textarea data-k="sources"></textarea>',
      '        <div class="hint">html 源：url 支持 {kw} {page}，pattern 为正则字符串，exclude 为可选的排除正则；json 源：额外用 path（如 data.list[].url）取图。</div>',
      '        <div style="display:flex;gap:6px;margin-top:8px">',
      '          <button class="btn gray sm" data-act="reset-sources">恢复内置源</button>',
      '          <button class="btn gray sm" data-act="test-src">测试当前源</button>',
      '        </div>',
      '      </div>',
      '      <div class="f"><label>调试</label>',
      '        <div class="sw"><span>输出调试日志到控制台</span><input type="checkbox" data-k="showLog"></div>',
      '        <div class="logbox" data-k="log"></div>',
      '        <div style="display:flex;gap:6px;margin-top:8px">',
      '          <button class="btn gray sm" data-act="copy-log">复制日志</button>',
      '          <button class="btn gray sm" data-act="clear-log">清空</button>',
      '        </div>',
      '      </div>',
      '      <div class="f">',
      '        <button class="btn" style="width:100%" data-act="save">保存设置</button>',
      '      </div>',
      '      <div class="hint">上传链路：POST /api/upload/presign → PUT OSS → POST /api/upload/bind → WS message(type=image)。与官方客户端一致。</div>',
      '    </div>',
      '  </div>',
      '  <div class="rz"></div>',
      '</div>',
      '<div class="toast"></div>'
    ].join('\n');

    ui.host = host;
    ui.shadow = shadow;
    ui.root = wrap;
    ui.els.fab = wrap.querySelector('.fab');
    ui.els.panel = wrap.querySelector('.panel');
    ui.els.grid = wrap.querySelector('.grid');
    ui.els.input = wrap.querySelector('.srch input');
    ui.els.status = wrap.querySelector('.status');
    ui.els.bar = wrap.querySelector('.bar');
    ui.els.info = wrap.querySelector('.ft .info');
    ui.els.send = wrap.querySelector('[data-act="send"]');
    ui.els.sheet = wrap.querySelector('.sheet');
    ui.els.toast = wrap.querySelector('.toast');
    ui.els.logBox = wrap.querySelector('.logbox');
    ui.els.sourceSel = wrap.querySelector('[data-act="source"]');

    bindUI();
    applySavedGeometry();
    renderSources();
    syncSettingsForm();
  }

  /* ---------- 几何 / 拖拽 ---------- */

  function geomKey() { return 'geom'; }

  function defaultGeom() {
    var mob = isMobile();
    return {
      fab: { x: window.innerWidth - 58, y: Math.round(window.innerHeight * 0.42) },
      panel: {
        x: Math.max(8, window.innerWidth - (mob ? 360 : 420) - 12),
        y: Math.max(8, Math.round(window.innerHeight * 0.14)),
        w: mob ? Math.min(window.innerWidth - 16, 360) : 420,
        h: mob ? Math.min(window.innerHeight * 0.62, 560) : 560
      }
    };
  }

  var geom = store.get(geomKey(), null) || defaultGeom();

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function applySavedGeometry() {
    var g = geom;
    g.fab.x = clamp(g.fab.x, 4, window.innerWidth - 50);
    g.fab.y = clamp(g.fab.y, 40, window.innerHeight - 50);
    ui.els.fab.style.left = g.fab.x + 'px';
    ui.els.fab.style.top = g.fab.y + 'px';

    var p = g.panel;
    p.w = clamp(p.w, 260, Math.max(260, window.innerWidth - 16));
    p.h = clamp(p.h, 260, Math.max(260, window.innerHeight - 16));
    p.x = clamp(p.x, 4, Math.max(4, window.innerWidth - p.w - 4));
    p.y = clamp(p.y, 4, Math.max(4, window.innerHeight - 60));
    setPanelRect();
    store.set(geomKey(), geom);
  }

  function setPanelRect() {
    var p = geom.panel;
    var el = ui.els.panel;
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    el.style.width = p.w + 'px';
    el.style.height = p.h + 'px';
  }

  /**
   * 统一手势：鼠标 / 触摸 / 触控笔通用。
   *
   * ⚠️ 移动端最关键的一条：touchstart 里 **绝对不能** 调 preventDefault()。
   * 按 Touch Events 规范，一旦取消 touchstart，浏览器就不会再为这次轻点
   * 派发兼容鼠标事件 —— 包括 click。桌面端因为 mouse 事件不受这个规则限制，
   * 所以「电脑端正常、手机端点了没反应」正是这个坑的典型表现。
   *
   * 因此这里改成：只有在「确认已经进入拖拽」之后才阻止默认行为，
   * 轻点由 touchend 自行判定（onTap），并给拖拽结束后紧跟的那次 click
   * 加一个抑制窗口，避免一次操作被当成两次。
   */
  function dragify(handle, onMove, opts) {
    opts = opts || {};
    var SLOP = opts.slop || 8;          // 手指抖动容差(px)，超过才算拖拽
    var TAP_MS = opts.tapMs || 600;     // 超过这个时长不算轻点
    var st = null;                      // 当前手势状态
    var suppressUntil = 0;              // 抑制 click 的截止时间戳

    // 点在按钮/输入框上时不启动拖拽，否则移动端连标题栏的图标都点不动
    function isInteractive(el) {
      if (!opts.ignoreInteractive) return false;
      while (el && el !== handle) {
        var tag = el.tagName;
        if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' ||
          tag === 'TEXTAREA' || tag === 'A' || tag === 'LABEL') return true;
        el = el.parentNode;
      }
      return false;
    }

    function down(ev) {
      if (ev.type === 'touchstart' && ev.touches && ev.touches.length > 1) return;
      if (isInteractive(ev.target)) return;
      var p = point(ev);
      if (!p) return;
      st = {
        x: p.x, y: p.y, ox: p.x, oy: p.y,
        t: Date.now(), moved: false, touch: ev.type !== 'mousedown'
      };
      // 这里故意不调 preventDefault()，见函数头注释
    }

    function move(ev) {
      if (!st) return;
      if (ev.type === 'touchmove' && ev.touches && ev.touches.length > 1) { st = null; return; }
      var p = point(ev);
      if (!p) return;
      if (!st.moved) {
        if (Math.abs(p.x - st.ox) + Math.abs(p.y - st.oy) < SLOP) return;
        st.moved = true;                // 超过容差，认定为拖拽
      }
      onMove(p.x - st.x, p.y - st.y);
      st.x = p.x;
      st.y = p.y;
      // 只在确认拖拽后阻止滚动，不影响轻点派发 click
      if (ev.cancelable) ev.preventDefault();
    }

    function up(ev) {
      if (!st) return;
      var s = st;
      st = null;
      var dt = Date.now() - s.t;
      var p = point(ev);
      var dist = p ? (Math.abs(p.x - s.ox) + Math.abs(p.y - s.oy)) : 0;

      if (s.moved) {
        suppressUntil = Date.now() + 500;
        if (opts.onDragEnd) opts.onDragEnd();
        return;
      }
      if (dt <= TAP_MS && dist < SLOP) {
        suppressUntil = Date.now() + 500;
        if (opts.onTap) opts.onTap(ev);
      }
    }

    function cancel() { st = null; }

    handle.addEventListener('mousedown', down);
    // touchstart 用 passive:true（反正不阻止默认行为），
    // touchmove 必须 passive:false 才能在确认拖拽后 preventDefault
    handle.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('mousemove', move);
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('mouseup', up);
    window.addEventListener('touchend', up);
    window.addEventListener('touchcancel', cancel);

    return {
      // 供原生 click 判断：拖拽/轻点刚结束时那次合成 click 应当忽略
      suppressClick: function () { return Date.now() < suppressUntil; }
    };
  }

  function point(ev) {
    if (ev.touches && ev.touches.length) return { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
    if (ev.changedTouches && ev.changedTouches.length) return { x: ev.changedTouches[0].clientX, y: ev.changedTouches[0].clientY };
    if (typeof ev.clientX === 'number') return { x: ev.clientX, y: ev.clientY };
    return null;
  }

  /* ---------- 交互绑定 ---------- */

  function bindUI() {
    var w = ui.root;

    // FAB：拖拽移动 + 轻点打开
    var fabG = dragify(ui.els.fab, function (dx, dy) {
      var g = geom.fab;
      g.x = clamp(g.x + dx, 4, window.innerWidth - 50);
      g.y = clamp(g.y + dy, 40, window.innerHeight - 50);
      ui.els.fab.style.left = g.x + 'px';
      ui.els.fab.style.top = g.y + 'px';
    }, {
      onTap: function () { openPanel(); },
      onDragEnd: function () { store.set(geomKey(), geom); }
    });

    // 原生 click 兜底：桌面鼠标、以及移动端外接键盘/部分内核
    // （移动端的轻点已在 onTap 处理，靠 suppressClick 去重，不会开两次）
    ui.els.fab.addEventListener('click', function (ev) {
      if (fabG.suppressClick()) { ev.preventDefault(); ev.stopPropagation(); return; }
      openPanel();
    });

    // 标题栏拖拽（按钮区域跳过，否则移动端点不动 ⚙ / — 这些图标）
    dragify(w.querySelector('.hd'), function (dx, dy) {
      var p = geom.panel;
      p.x = clamp(p.x + dx, 4, Math.max(4, window.innerWidth - p.w - 4));
      p.y = clamp(p.y + dy, 0, Math.max(0, window.innerHeight - 48));
      setPanelRect();
    }, {
      ignoreInteractive: true,
      onDragEnd: function () { store.set(geomKey(), geom); }
    });

    // 缩放手柄（底部大面板下已被 CSS 隐藏）
    dragify(w.querySelector('.rz'), function (dx, dy) {
      var p = geom.panel;
      p.w = clamp(p.w + dx, 260, Math.max(260, window.innerWidth - p.x - 4));
      p.h = clamp(p.h + dy, 260, Math.max(260, window.innerHeight - p.y - 4));
      setPanelRect();
    }, {
      onDragEnd: function () { store.set(geomKey(), geom); }
    });

    // 事件委托
    w.addEventListener('click', function (ev) {
      var t = ev.target;
      var act = t && t.getAttribute ? t.getAttribute('data-act') : null;
      if (!act) return;
      switch (act) {
        case 'search': doSearch(1); break;
        case 'next': doSearch((state.page || 1) + 1); break;
        case 'settings': openSettings(); break;
        case 'close-settings': closeSettings(); break;
        case 'min': closePanel(); break;
        case 'send': sendSelected(); break;
        case 'url': sendFromUrl(); break;
        case 'file': sendFromFile(); break;
        case 'save': commitSettings(); break;
        case 'reset-sources': resetSources(); break;
        case 'test-src': testSource(); break;
        case 'copy-log': copyLog(); break;
        case 'clear-log': logBuf.length = 0; if (ui.els.logBox) ui.els.logBox.textContent = ''; break;
        case 'theme': toggleTheme(); break;
        case 'wide': ui.els.grid.classList.toggle('wide'); break;
        default: break;
      }
    });

    ui.els.input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); doSearch(1); }
    });
  }

  function toggleTheme() {
    var dark = ui.root.classList.toggle('dark');
    settings.theme = dark ? 'dark' : 'light';
    saveSettings();
  }

  function openPanel() {
    if (!ui.els.panel) return;
    ui.els.panel.classList.remove('hidden');
    ui.els.fab.classList.add('hidden');
    if (isMobile()) ui.els.panel.classList.add('full');
    ui.isOpen = true;
    if (ui.els.logBox) ui.els.logBox.textContent = logBuf.slice(-80).join('\n');
    log('面板已打开', { mobile: isMobile(), full: ui.els.panel.classList.contains('full') });
    // 移动端不自动聚焦：一点开就弹软键盘会顶飞布局，也让用户来不及看清结果
    if (!isMobile()) {
      setTimeout(function () { try { ui.els.input.focus(); } catch (e) { /* ignore */ } }, 60);
    }
  }

  function closePanel() {
    ui.els.panel.classList.add('hidden');
    ui.els.panel.classList.remove('full');
    ui.els.fab.classList.remove('hidden');
    ui.isOpen = false;
  }

  function openSettings() {
    syncSettingsForm();
    ui.els.sheet.classList.remove('hidden');
  }
  function closeSettings() { ui.els.sheet.classList.add('hidden'); }

  /* ---------- 渲染 ---------- */

  function renderSources() {
    var sel = ui.els.sourceSel;
    var list = activeSources();
    sel.innerHTML = '';
    for (var i = 0; i < list.length; i++) {
      var o = document.createElement('option');
      o.value = list[i].id;
      o.textContent = list[i].name || list[i].id;
      sel.appendChild(o);
    }
    if (!state.sourceId || !getSource(state.sourceId)) {
      state.sourceId = list[0] ? list[0].id : null;
    }
    if (state.sourceId) sel.value = state.sourceId;
    sel.onchange = function () { state.sourceId = sel.value; };
  }

  function renderResults(list) {
    var grid = ui.els.grid;
    grid.innerHTML = '';
    if (!list.length) {
      var d = document.createElement('div');
      d.className = 'empty';
      d.textContent = '没有结果，换个关键词或换一个表情源试试';
      grid.appendChild(d);
      return;
    }
    var frag = document.createDocumentFragment();
    for (var i = 0; i < list.length; i++) {
      (function (url, idx) {
        var cell = document.createElement('div');
        cell.className = 'cell';
        cell.setAttribute('data-url', url);
        cell.setAttribute('title', url);

        var img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        img.src = url;
        img.onerror = function () {
          var b = document.createElement('div');
          b.className = 'badge';
          b.textContent = '加载失败';
          cell.appendChild(b);
        };
        cell.appendChild(img);

        if (/\.gif(\?|$)/i.test(url)) {
          var g = document.createElement('div');
          g.className = 'badge';
          g.textContent = 'GIF';
          cell.appendChild(g);
        }

        cell.addEventListener('click', function () {
          var prev = grid.querySelector('.cell.sel');
          if (prev) prev.classList.remove('sel');
          if (state.selected === url) {
            state.selected = null;
            ui.els.send.disabled = true;
          } else {
            state.selected = url;
            cell.classList.add('sel');
            ui.els.send.disabled = false;
            if (settings.skipConfirm) { sendSelected(); return; }
          }
          ui.els.info.textContent = state.selected
            ? ('已选择第 ' + (idx + 1) + ' 张 · ' + shortUrl(state.selected))
            : '就绪';
        });
        frag.appendChild(cell);
      })(list[i], i);
    }
    grid.appendChild(frag);
  }

  function shortUrl(u) {
    try {
      var x = String(u).split('?')[0].split('/');
      return decodeURIComponent(x[x.length - 1] || u).slice(0, 34);
    } catch (e) { return String(u).slice(0, 34); }
  }

  /* ---------- 搜索 ---------- */

  function doSearch(page) {
    var kw = String(ui.els.input.value || '').trim();
    if (!kw) { toast('请输入关键词'); return; }
    var src = getSource(state.sourceId);
    if (!src) { toast('没有可用的表情源，请到设置里配置', 'error'); return; }
    if (state.busy) return;
    state.busy = true;
    state.query = kw;
    state.page = page || 1;
    state.selected = null;
    ui.els.send.disabled = true;
    ui.els.grid.innerHTML = '<div class="empty">搜索中…</div>';
    setStatus('正在从「' + (src.name || src.id) + '」搜索：' + kw + '（第 ' + state.page + ' 页）');

    searchSource(src, kw, state.page).then(function (urls) {
      state.results = urls;
      renderResults(urls);
      setStatus(urls.length ? ('「' + src.name + '」第 ' + state.page + ' 页 · ' + urls.length + ' 张（点击选择）')
        : '没有搜索结果');
      ui.els.info.textContent = '就绪';
    }).catch(function (e) {
      state.results = [];
      ui.els.grid.innerHTML = '<div class="empty">搜索失败：' + esc(e.message) + '</div>';
      setStatus('搜索失败：' + e.message);
      toast('搜索失败：' + e.message, 'error');
    }).then(function () {
      state.busy = false;
    });
  }

  function testSource() {
    var src = getSource(state.sourceId);
    if (!src) { toast('没有可用表情源', 'error'); return; }
    var kw = String(ui.els.input.value || '').trim() || '哈哈';
    setStatus('测试「' + src.name + '」…');
    searchSource(src, kw, 1).then(function (urls) {
      toast('可用，返回 ' + urls.length + ' 张', 'ok');
      setStatus('测试通过：' + urls.length + ' 张');
    }).catch(function (e) {
      toast('测试失败：' + e.message, 'error');
      setStatus('测试失败：' + e.message);
    });
  }

  /* ---------- 发送主流程 ---------- */

  function sendSelected() {
    if (!state.selected) { toast('先选一张表情'); return; }
    var url = state.selected;
    sendOne({ type: 'url', url: url });
  }

  function sendFromUrl() {
    var url = prompt('粘贴图片直链（http/https）', '');
    if (!url) return;
    url = String(url).trim();
    if (!/^https?:\/\//i.test(url)) { toast('请输入以 http(s) 开头的图片链接', 'error'); return; }
    sendOne({ type: 'url', url: url });
  }

  function sendFromFile() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,.gif';
    input.style.display = 'none';
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (!f) { input.remove(); return; }
      sendOne({ type: 'file', file: f });
      setTimeout(function () { input.remove(); }, 0);
    });
    ui.shadow.appendChild(input);
    input.click();
  }

  function sendOne(src) {
    var roomId = getRoomId();
    if (!roomId) { toast('请先进入一个聊天房间', 'error'); return; }
    if (!liveSocket()) { toast('聊天连接未就绪，请刷新页面', 'error'); return; }
    if (state.busy) { toast('正在处理上一张，请稍候'); return; }

    state.busy = true;
    ui.els.send.disabled = true;
    setProgress(0);
    setStatus('准备中…');

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
        var over = settings.compressOverMB * 1024 * 1024;
        var isGifFile = isGif(got.blob.type, got.filename);
        if (settings.autoCompress && got.blob.size > over && !isGifFile) {
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
        setStatus('上传中（' + bytesText(got.blob.size) + '）…');
        setProgress(0.78);
        return uploadImage(got.blob, got.filename, roomId, function (p) {
          setProgress(0.78 + p * 0.18);
        }).catch(function (e) {
          if (e.reason === 'too_large' && settings.autoCompress && !isGif(got.blob.type, got.filename)) {
            setStatus('服务端提示过大，正在压缩重试…');
            return compressBlob(got.blob, 1024 * 1024, settings.maxDimension).then(function (c) {
              c.filename = ensureExt('meme.jpg', c.blob.type);
              return uploadImage(c.blob, c.filename, roomId, function (p) {
                setProgress(0.78 + p * 0.18);
              });
            });
          }
          throw e;
        });
      })
      .then(function (bound) {
        setProgress(0.97);
        setStatus('发送中…');
        return sendImageFrame(bound.url).then(function (res) {
          return { bound: bound, acked: !!(res && res.acked) };
        });
      })
      .then(function (r) {
        setProgress(1);
        if (r.acked) {
          toast('已发送 ✓', 'ok');
          setStatus('已发送：' + shortUrl(r.bound.url));
          ui.els.info.textContent = '已发送 · ' + shortUrl(r.bound.url);
        } else {
          toast('已提交，但未收到回执，请确认是否送达', 'warn');
          setStatus('已提交（未收到回执）');
          ui.els.info.textContent = '未收到回执 · ' + shortUrl(r.bound.url);
        }
        setTimeout(function () { setProgress(null); }, 700);
      })
      .catch(function (e) {
        setProgress(null);
        var msg = (e && e.message) || '发送失败';
        toast(msg, 'error');
        setStatus('失败：' + msg);
        ui.els.info.textContent = '失败';
        log('发送失败', e);
      })
      .then(function () {
        state.busy = false;
        ui.els.send.disabled = !state.selected;
      });
  }

  /* ---------- 设置表单 ---------- */

  function syncSettingsForm() {
    var w = ui.root;
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
    var w = ui.root;
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
    renderSources();
    if (settings.theme === 'dark') ui.root.classList.add('dark');
    else if (settings.theme === 'light') ui.root.classList.remove('dark');
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
    // 站点自身的 DOM 变化不影响我们（shadow DOM 隔离），仅处理窗口尺寸变化
    window.addEventListener('resize', function () {
      applySavedGeometry();
    });
    if (typeof GM_registerMenuCommand === 'function') {
      try {
        GM_registerMenuCommand('打开表情包面板', openPanel);
        GM_registerMenuCommand('切换主题', toggleTheme);
      } catch (e) { /* ignore */ }
    }
    log('表情包助手已加载 v' + VERSION, {
      mobile: isMobile(),
      gm: (typeof GM_xmlhttpRequest === 'function'),
      sources: activeSources().length
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
