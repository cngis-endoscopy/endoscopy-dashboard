/*
 * backend.js — เชื่อมหน้าแดชบอร์ดกับ Google Sheets (ผ่าน Apps Script Web app)
 * ไม่ต้องแก้ไฟล์นี้ ตั้งค่าที่ config.js
 *
 * หน้าแดชบอร์ดเรียกใช้ window.claude.use('db' | 'user' | 'downloads')
 * ไฟล์นี้จัดเตรียมทั้งสามส่วนโดยเก็บข้อมูลไว้ที่ Google Sheets
 */
(function () {
  'use strict';
  var CFG = window.ENDO_CONFIG || {};
  var API = String(CFG.apiUrl || '').trim();
  var REFRESH_MS = Math.max(10, +CFG.refreshSeconds || 30) * 1000;
  var AUTH_KEY = 'endo-auth';

  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }

  /* ---------- การเข้าสู่ระบบ ---------- */
  var auth = null;
  try {
    auth = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
    if (!auth || !auth.token || auth.exp < Date.now()) auth = null;
  } catch (e) { auth = null; }

  function setAuth(a) {
    auth = a;
    try { a ? localStorage.setItem(AUTH_KEY, JSON.stringify(a)) : localStorage.removeItem(AUTH_KEY); } catch (e) {}
    window.dispatchEvent(new Event('endo-auth'));
  }
  function role() { return auth && auth.exp > Date.now() ? auth.role : null; }

  /* ---------- เรียก Apps Script ---------- */
  function call(action, payload) {
    if (!API) return Promise.reject(err('not_configured', 'ยังไม่ได้ใส่ apiUrl ในไฟล์ config.js'));
    var body = Object.assign({ action: action, token: auth ? auth.token : null }, payload || {});
    // ส่งเป็น text/plain เพื่อไม่ให้เบราว์เซอร์ต้องขออนุญาต CORS ก่อน (Apps Script ไม่รองรับ)
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' })
      .catch(function () { throw err('network', 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบอินเทอร์เน็ต'); })
      .then(function (res) {
        return res.json().catch(function () { throw err('bad_response', 'เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง ตรวจสอบการ Deploy Apps Script (Who has access: Anyone)'); });
      })
      .then(function (j) {
        if (j && j.ok) return j;
        var code = (j && j.code) || 'error';
        if (code === 'bad_token') setAuth(null);
        throw err(code, (j && j.message) || 'เกิดข้อผิดพลาด');
      });
  }

  /* ---------- ที่เก็บข้อมูลในหน้า + การแจ้งเปลี่ยนแปลง ---------- */
  var docs = {}, loaded = false, lastError = null;
  var subs = [];
  function clone(x) { return x == null ? undefined : JSON.parse(JSON.stringify(x)); }
  function emit() { subs.slice().forEach(function (f) { try { f(); } catch (e) { console.error(e); } }); }

  function refresh() {
    return call('list').then(function (j) {
      docs = j.docs || {}; loaded = true; lastError = null; emit();
      window.dispatchEvent(new CustomEvent('endo-sync', { detail: { ok: true } }));
    }, function (e) {
      lastError = e;
      if (e.code === 'login_required') { docs = {}; loaded = true; emit(); }
      window.dispatchEvent(new CustomEvent('endo-sync', { detail: { ok: false, code: e.code, message: e.message } }));
      throw e;
    });
  }

  function snapDoc(path) {
    var d = docs[path];
    return { exists: d !== undefined, id: path.split('/').pop(), data: function () { return clone(d); } };
  }
  function snapCol(col) {
    var depth = col.split('/').length + 1;
    var list = Object.keys(docs).filter(function (k) { return k.indexOf(col + '/') === 0 && k.split('/').length === depth; })
      .sort().map(snapDoc);
    return { docs: list, size: list.length, empty: !list.length };
  }
  function subscribe(fn) {
    subs.push(fn);
    if (loaded) setTimeout(fn, 0);
    return function () { subs = subs.filter(function (f) { return f !== fn; }); };
  }

  function docRef(path) {
    return {
      id: path.split('/').pop(), path: path,
      get: function () { return Promise.resolve(snapDoc(path)); },
      set: function (data) {
        return call('set', { path: path, data: data }).then(function (j) { docs[path] = j.doc || data; emit(); });
      },
      update: function (data) {
        return call('update', { path: path, data: data }).then(function (j) { docs[path] = j.doc || Object.assign({}, docs[path], data); emit(); });
      },
      delete: function () {
        return call('delete', { path: path }).then(function () { delete docs[path]; emit(); });
      },
      onSnapshot: function (next) { return subscribe(function () { next(snapDoc(path)); }); }
    };
  }
  function colRef(col) {
    return {
      doc: function (id) { return docRef(col + '/' + id); },
      get: function () { return Promise.resolve(snapCol(col)); },
      onSnapshot: function (next) { return subscribe(function () { next(snapCol(col)); }); }
    };
  }
  var db = { doc: docRef, collection: colRef };

  /* ---------- ผู้ใช้ ---------- */
  var user = {
    isOwner: function () { return Promise.resolve(role() === 'admin'); },
    canEdit: function () { return Promise.resolve(role() === 'admin'); },
    can: function (name) { return Promise.resolve(name === 'data.write' ? (role() === 'admin' || role() === 'staff') : null); },
    id: function () { return Promise.resolve(role() ? 'role:' + role() : null); },
    me: function () { return Promise.resolve({ id: role() ? 'role:' + role() : null, name: '', email: null }); }
  };

  /* ---------- ดาวน์โหลดไฟล์ ---------- */
  var downloads = {
    save: function (o) {
      var blob = o.data instanceof Blob ? o.data : new Blob([o.data], { type: 'application/octet-stream' });
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = o.filename || 'download'; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
      return Promise.resolve();
    }
  };

  /* ---------- จุดเชื่อมให้หน้าแดชบอร์ด ---------- */
  var ready = null;
  window.claude = {
    use: function (name) {
      if (name === 'user') return Promise.resolve(user);
      if (name === 'downloads') return Promise.resolve(downloads);
      if (name !== 'db') return Promise.resolve(null);
      if (!API) return Promise.resolve(null);
      if (!ready) ready = refresh().then(function () { return db; }, function (e) { return e.code === 'login_required' ? db : null; });
      return ready;
    }
  };

  window.endoBackend = {
    configured: !!API,
    role: role,
    lastError: function () { return lastError; },
    login: function (password) {
      return call('login', { password: password }).then(function (j) {
        setAuth({ role: j.role, token: j.token, exp: j.exp });
        return refresh().catch(function () {}).then(function () { return j.role; });
      });
    },
    logout: function () { setAuth(null); return refresh().catch(function () {}); },
    refresh: refresh
  };

  // ดึงข้อมูลใหม่เป็นระยะ และเมื่อกลับมาที่แท็บนี้
  if (API) {
    setInterval(function () { if (document.visibilityState === 'visible' && loaded) refresh().catch(function () {}); }, REFRESH_MS);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && loaded) refresh().catch(function () {}); });
    setInterval(function () { if (auth && auth.exp < Date.now()) setAuth(null); }, 60000);
  }
})();
