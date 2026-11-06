/**
 * ============================================================================
 *  Endoscopy Dashboard — ระบบหลังบ้าน (Google Apps Script + Google Sheets)
 * ----------------------------------------------------------------------------
 *  วางไฟล์นี้ใน Apps Script ของ Google Sheet ที่ใช้เก็บข้อมูล
 *  (ใน Sheet: ส่วนขยาย › Apps Script) แล้วทำตามขั้นตอนใน README.md
 *
 *  - ข้อมูลทั้งหมดเก็บในแผ่นงาน "_store" (1 แถว = 1 รายการข้อมูล) ห้ามแก้ด้วยมือ
 *  - รหัสผ่านตั้งจากเมนู "แดชบอร์ด" ใน Google Sheet ระบบเก็บเฉพาะค่า hash
 *  - สิทธิ์: ผู้ดูแลระบบ (admin) แก้ไขได้ทุกส่วน
 *            ผู้บันทึกข้อมูล (staff) กรอกสถิติรายเดือนได้อย่างเดียว
 *            ผู้ที่ไม่ได้เข้าสู่ระบบ ดูได้อย่างเดียว (หรือต้องใส่รหัสดูข้อมูล ถ้าตั้งไว้)
 * ============================================================================
 */

const STORE_SHEET = '_store';
const EXPORT_SHEET = 'สถิติรายเดือน';
const TOKEN_HOURS = 12;            // เข้าสู่ระบบแล้วใช้งานได้นานกี่ชั่วโมง
const MAX_DOC_CHARS = 45000;       // ขนาดสูงสุดต่อรายการ (1 เซลล์ของ Sheets เก็บได้ 50,000 ตัวอักษร)
const LOGIN_MAX_FAILS = 8;         // ใส่รหัสผิดเกินกี่ครั้งใน 15 นาทีจึงล็อกชั่วคราว

// ส่วนของข้อมูล และสิทธิ์ขั้นต่ำที่เขียนได้
const RULES = [
  { re: /^months\/\d{4}-\d{2}$/,             write: 'staff' },  // สถิติรายเดือน
  { re: /^config\/main$/,                    write: 'admin' },  // ตั้งค่ารายการ / รายชื่อแพทย์ / ปี
  { re: /^scopes\/[A-Za-z0-9_-]{1,40}$/,     write: 'admin' },  // ทะเบียนกล้อง
  { re: /^repairs\/[A-Za-z0-9_-]{1,40}$/,    write: 'admin' },  // รายการส่งซ่อม
  { re: /^service\/main$/,                   write: 'admin' },  // Scope of service
  { re: /^schedule\/main$/,                  write: 'admin' }   // ตารางแพทย์
];
const RANK = { viewer: 1, staff: 2, admin: 3 };

// ───────────────────────── Web app ─────────────────────────
function doGet() {
  return json_({ ok: true, service: 'endoscopy-dashboard', message: 'ระบบหลังบ้านทำงานอยู่ ✔', time: new Date().toISOString() });
}

function doPost(e) {
  let req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, code: 'bad_request', message: 'รูปแบบคำขอไม่ถูกต้อง' }); }
  try { return json_(route_(req)); }
  catch (err) { return json_({ ok: false, code: err.code || 'error', message: String(err.message || err) }); }
}

function route_(req) {
  const action = String(req.action || '');
  if (action === 'ping') return { ok: true };
  if (action === 'login') return login_(String(req.password || ''));
  const role = roleOf_(req.token);
  if (req.token && !role) throw err_('bad_token', 'หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่');
  if (action === 'list') return list_(role);
  if (action === 'set' || action === 'update' || action === 'delete') return write_(action, String(req.path || ''), req.data, role);
  throw err_('bad_request', 'ไม่รู้จักคำสั่ง: ' + action);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function err_(code, message) { const e = new Error(message); e.code = code; return e; }

// ───────────────────────── รหัสผ่าน / token ─────────────────────────
function props_() { return PropertiesService.getScriptProperties(); }

function hex_(bytes) { return bytes.map(function (b) { return ((b & 255) + 256).toString(16).slice(1); }).join(''); }

function hash_(pw) {
  const salt = props_().getProperty('SALT') || '';
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pw, Utilities.Charset.UTF_8));
}

function sign_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, props_().getProperty('SECRET') || ''));
}

function login_(password) {
  const cache = CacheService.getScriptCache();
  const fails = +(cache.get('login_fails') || 0);
  if (fails >= LOGIN_MAX_FAILS) throw err_('locked', 'ใส่รหัสผิดหลายครั้ง ระบบล็อกชั่วคราว 15 นาที');
  const p = props_();
  if (!p.getProperty('SECRET') || !p.getProperty('PW_ADMIN')) throw err_('not_setup', 'ยังไม่ได้ตั้งค่าระบบ: เปิด Google Sheet แล้วใช้เมนู แดชบอร์ด › ตั้งค่าครั้งแรก');
  const h = password ? hash_(password) : '';
  let role = null;
  if (h && h === p.getProperty('PW_ADMIN')) role = 'admin';
  else if (h && h === p.getProperty('PW_STAFF')) role = 'staff';
  else if (h && h === p.getProperty('PW_VIEW')) role = 'viewer';
  if (!role) {
    cache.put('login_fails', String(fails + 1), 900);
    throw err_('bad_password', 'รหัสผ่านไม่ถูกต้อง');
  }
  const exp = Date.now() + TOKEN_HOURS * 3600 * 1000;
  const payload = [role, exp, p.getProperty('TOKEN_GEN') || '1'].join('|');
  const token = Utilities.base64EncodeWebSafe(payload) + '.' + sign_(payload);
  return { ok: true, role: role, token: token, exp: exp };
}

function roleOf_(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  let payload;
  try { payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString(); } catch (e) { return null; }
  if (sign_(payload) !== parts[1]) return null;
  const f = payload.split('|');
  if (f.length !== 3 || !RANK[f[0]]) return null;
  if (+f[1] < Date.now()) return null;
  if (f[2] !== (props_().getProperty('TOKEN_GEN') || '1')) return null;
  return f[0];
}

// ───────────────────────── ข้อมูล ─────────────────────────
function sheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(STORE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(STORE_SHEET);
    sh.getRange(1, 1, 1, 4).setValues([['path', 'data (JSON)', 'แก้ไขล่าสุด', 'โดย']]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readAll_() {
  const sh = sheet_();
  const last = sh.getLastRow();
  const out = {};
  if (last < 2) return { docs: out, rows: {} };
  const vals = sh.getRange(2, 1, last - 1, 2).getValues();
  const rows = {};
  vals.forEach(function (r, i) {
    const path = String(r[0] || '');
    if (!path) return;
    try { out[path] = JSON.parse(r[1]); rows[path] = i + 2; } catch (e) { /* แถวเสีย ข้ามไป */ }
  });
  return { docs: out, rows: rows };
}

function list_(role) {
  if (props_().getProperty('PW_VIEW') && !role) throw err_('login_required', 'ต้องเข้าสู่ระบบก่อนดูข้อมูล');
  return { ok: true, docs: readAll_().docs, role: role || null, time: Date.now() };
}

function write_(action, path, data, role) {
  const rule = RULES.filter(function (r) { return r.re.test(path); })[0];
  if (!rule) throw err_('bad_path', 'ไม่อนุญาตให้บันทึกข้อมูลส่วนนี้');
  if (!role || RANK[role] < RANK[rule.write]) {
    throw err_('not_granted', rule.write === 'admin' ? 'ส่วนนี้แก้ไขได้เฉพาะผู้ดูแลระบบ' : 'กรุณาเข้าสู่ระบบก่อนบันทึก');
  }
  if (action !== 'delete' && (!data || typeof data !== 'object' || Array.isArray(data))) throw err_('bad_request', 'ข้อมูลไม่ถูกต้อง');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_();
    const all = readAll_();
    const row = all.rows[path];
    if (action === 'delete') {
      if (row) sh.deleteRow(row);
      return { ok: true };
    }
    const next = action === 'update' && all.docs[path] ? Object.assign({}, all.docs[path], data) : data;
    const text = JSON.stringify(next);
    if (text.length > MAX_DOC_CHARS) throw err_('too_large', 'ข้อมูลรายการนี้ใหญ่เกินไป');
    const line = [[path, text, new Date(), role]];
    if (row) sh.getRange(row, 1, 1, 4).setValues(line);
    else sh.getRange(sh.getLastRow() + 1, 1, 1, 4).setValues(line);
    return { ok: true, doc: next };
  } finally {
    lock.releaseLock();
  }
}

// ───────────────────────── เมนูใน Google Sheet ─────────────────────────
function onOpen() {
  SpreadsheetApp.getUi().createMenu('แดชบอร์ด')
    .addItem('① ตั้งค่าครั้งแรก', 'menuSetup')
    .addSeparator()
    .addItem('ตั้งรหัสผู้ดูแลระบบ (admin)', 'menuSetAdmin')
    .addItem('ตั้งรหัสผู้บันทึกข้อมูล (staff)', 'menuSetStaff')
    .addItem('ตั้ง / ยกเลิกรหัสสำหรับดูข้อมูล', 'menuSetView')
    .addSeparator()
    .addItem('ออกจากระบบทุกเครื่อง', 'menuLogoutAll')
    .addItem('สร้างตารางสถิติรายเดือน (อ่านใน Sheet)', 'exportMonthly')
    .addToUi();
}

function ensureKeys_() {
  const p = props_();
  if (!p.getProperty('SECRET')) p.setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());
  if (!p.getProperty('SALT')) p.setProperty('SALT', Utilities.getUuid());
  if (!p.getProperty('TOKEN_GEN')) p.setProperty('TOKEN_GEN', '1');
}

function askPassword_(title, allowEmpty) {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt(title, allowEmpty ? 'เว้นว่างแล้วกด OK เพื่อยกเลิกรหัสนี้' : 'อย่างน้อย 6 ตัวอักษร', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return null;
  const pw = r.getResponseText().trim();
  if (!pw && allowEmpty) return '';
  if (pw.length < 6) { ui.alert('รหัสสั้นเกินไป', 'กรุณาใช้อย่างน้อย 6 ตัวอักษร', ui.ButtonSet.OK); return null; }
  return pw;
}

function menuSetup() {
  ensureKeys_();
  sheet_();
  const ui = SpreadsheetApp.getUi();
  if (!props_().getProperty('PW_ADMIN')) menuSetAdmin();
  if (!props_().getProperty('PW_STAFF')) menuSetStaff();
  ui.alert('ตั้งค่าเรียบร้อย ✔',
    'ขั้นต่อไป: ใน Apps Script กด Deploy › New deployment › Web app\n' +
    'Execute as: Me · Who has access: Anyone\nแล้วคัดลอก URL ที่ลงท้ายด้วย /exec ไปใส่ในไฟล์ config.js บน GitHub',
    ui.ButtonSet.OK);
}

function setPw_(key, pw) {
  ensureKeys_();
  const p = props_();
  if (pw) p.setProperty(key, hash_(pw)); else p.deleteProperty(key);
}

function menuSetAdmin() {
  const pw = askPassword_('ตั้งรหัสผู้ดูแลระบบ (แก้ไขและตั้งค่าได้ทุกส่วน)', false);
  if (pw === null) return;
  setPw_('PW_ADMIN', pw);
  SpreadsheetApp.getActive().toast('ตั้งรหัสผู้ดูแลระบบแล้ว');
}
function menuSetStaff() {
  const pw = askPassword_('ตั้งรหัสผู้บันทึกข้อมูล (กรอกสถิติรายเดือนได้)', false);
  if (pw === null) return;
  setPw_('PW_STAFF', pw);
  SpreadsheetApp.getActive().toast('ตั้งรหัสผู้บันทึกข้อมูลแล้ว');
}
function menuSetView() {
  const pw = askPassword_('ตั้งรหัสสำหรับดูข้อมูล (ถ้าตั้ง ทุกคนต้องเข้าสู่ระบบก่อนดูแดชบอร์ด)', true);
  if (pw === null) return;
  setPw_('PW_VIEW', pw);
  SpreadsheetApp.getActive().toast(pw ? 'ตั้งรหัสดูข้อมูลแล้ว' : 'ยกเลิกรหัสดูข้อมูลแล้ว ทุกคนที่มีลิงก์ดูได้');
}
function menuLogoutAll() {
  ensureKeys_();
  const p = props_();
  p.setProperty('TOKEN_GEN', String(+(p.getProperty('TOKEN_GEN') || '1') + 1));
  SpreadsheetApp.getActive().toast('ทุกเครื่องถูกออกจากระบบแล้ว ต้องเข้าสู่ระบบใหม่');
}

/** สร้างแผ่นงาน "สถิติรายเดือน" แบบตารางยาว (เดือน / หมวด / รายการ / จำนวน) ไว้อ่านหรือทำ Pivot ใน Sheets */
function exportMonthly() {
  const all = readAll_().docs;
  let cfg = null;
  try { cfg = all['config/main'] && JSON.parse(all['config/main'].cfg); } catch (e) {}
  const catName = {}, docName = {};
  ((cfg && cfg.cats) || []).forEach(function (c) { catName[c.id] = c.name; });
  ((cfg && cfg.doctors) || []).forEach(function (d) { docName[d.id] = d.name; });
  const special = { '#cecum': 'ถึง Cecum', '#adenoma': 'พบ Adenoma', '#comp': 'ภาวะแทรกซ้อน' };
  const rows = [];
  Object.keys(all).filter(function (k) { return k.indexOf('months/') === 0; }).sort().forEach(function (k) {
    const m = all[k], v = m.v || {};
    Object.keys(v).forEach(function (key) {
      const i = key.indexOf('|'), cat = key.slice(0, i), item = key.slice(i + 1);
      const isDoc = cat.indexOf('d.') === 0;
      rows.push([m.y, m.m, isDoc ? 'รายแพทย์' : (catName[cat] || cat), isDoc ? (docName[cat.slice(2)] || cat.slice(2)) : '', special[item] || item, Number(v[key]) || 0]);
    });
  });
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(EXPORT_SHEET) || ss.insertSheet(EXPORT_SHEET);
  sh.clear();
  sh.getRange(1, 1, 1, 6).setValues([['ปี (พ.ศ.)', 'เดือน', 'หมวด', 'แพทย์', 'รายการ', 'จำนวน']]).setFontWeight('bold');
  if (rows.length) sh.getRange(2, 1, rows.length, 6).setValues(rows);
  sh.setFrozenRows(1);
  ss.toast('สร้างตาราง ' + rows.length + ' แถวแล้ว');
}
