/* ============================================================
 *  現場情報共有システム 本体
 *  ・ログイン／新規登録（管理者の承認制）
 *  ・現場一覧（着工前／施工中／完工、検索）
 *  ・現場詳細（基本情報／現場資料／施工計画書／産廃契約状況）
 *  ・工程表
 *  ・利用者管理（管理者のみ）
 *  データはFirebase（Googleのサービス）に保存します。
 *  config.js が未設定のときは「デモモード」（このブラウザ内だけに保存）で動きます。
 * ============================================================ */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var FBCFG = CFG.firebase || {};
  var IS_DEMO = !FBCFG.apiKey || /ここに/.test(FBCFG.apiKey);
  var MAX_MB = CFG.maxFileMB || 100;
  var FIREBASE_VERSION = '10.12.2';

  var STAGES = [
    { key: 'before', label: '着工前' },
    { key: 'during', label: '施工中' },
    { key: 'done', label: '完工' }
  ];
  var FILE_CATS = { docs: '現場資料', plans: '施工計画書' };
  var DETAIL_TABS = ['basic', 'docs', 'plans', 'waste'];
  var DAY = 86400000;

  /* ---------------- 共通の小道具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseYmd(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    var p = s.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }
  function fmtYmd(s) {
    var d = parseYmd(s);
    return d ? d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) : '';
  }
  function fmtMd(s) {
    var d = parseYmd(s);
    return d ? (d.getMonth() + 1) + '/' + d.getDate() : '';
  }
  function fmtPeriod(a, b) {
    if (!a && !b) return '未設定';
    return (fmtYmd(a) || '未定') + ' 〜 ' + (fmtYmd(b) || '未定');
  }
  function toDate(v) {
    if (!v) return null;
    if (typeof v === 'number') return new Date(v);
    if (typeof v.toDate === 'function') return v.toDate();
    if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
    var d = new Date(v);
    return isNaN(d) ? null : d;
  }
  function fmtDateTime(v) {
    var d = toDate(v);
    if (!d) return '';
    return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtSize(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function today0() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function daysBetween(a, b) { return Math.round((b - a) / DAY); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function stageLabel(k) {
    for (var i = 0; i < STAGES.length; i++) if (STAGES[i].key === k) return STAGES[i].label;
    return '着工前';
  }
  function norm(s) { return String(s || '').normalize('NFKC').toLowerCase(); }

  var toastTimer = null;
  function toast(msg, isErr) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, isErr ? 6000 : 2500);
  }

  function errMsg(e) {
    var code = (e && e.code) || '';
    var wrong = 'メールアドレスまたはパスワードが違います。';
    var map = {
      'auth/invalid-credential': wrong,
      'auth/invalid-login-credentials': wrong,
      'auth/wrong-password': wrong,
      'auth/user-not-found': wrong,
      'auth/email-already-in-use': 'このメールアドレスはすでに登録されています。',
      'auth/invalid-email': 'メールアドレスの形式が正しくありません。',
      'auth/weak-password': 'パスワードは6文字以上にしてください。',
      'auth/missing-password': 'パスワードを入力してください。',
      'auth/too-many-requests': '失敗が続いたため一時的にロックされています。しばらくしてから再度お試しください。',
      'auth/network-request-failed': 'ネットワークに接続できません。',
      'auth/operation-not-allowed': 'メールアドレスでのログインが有効になっていません（Firebaseの設定を確認してください）。',
      'permission-denied': '権限がありません（承認されていないか、利用が停止されています）。',
      'storage/unauthorized': 'ファイルを扱う権限がありません。',
      'storage/canceled': 'アップロードを中止しました。',
      'storage/quota-exceeded': '保存容量の上限に達しました。管理者に連絡してください。',
      'storage/object-not-found': 'ファイルが見つかりません（削除された可能性があります）。',
      'storage/retry-limit-exceeded': '通信が不安定なためアップロードできませんでした。'
    };
    return map[code] || (e && e.message) || '不明なエラーが発生しました。';
  }

  /* ============================================================
   *  データの保存先（Firebase版）
   * ============================================================ */
  function createFirebaseBackend(cfg) {
    var base = 'https://www.gstatic.com/firebasejs/' + FIREBASE_VERSION + '/';
    return Promise.all([
      import(base + 'firebase-app.js'),
      import(base + 'firebase-auth.js'),
      import(base + 'firebase-firestore.js'),
      import(base + 'firebase-storage.js')
    ]).then(function (mods) {
      var AppM = mods[0], A = mods[1], F = mods[2], St = mods[3];
      var app = AppM.initializeApp(cfg);
      var auth = A.getAuth(app);
      var db = F.getFirestore(app);
      var storage = St.getStorage(app);
      // ブラウザ（タブ）を閉じるとログアウト → 開くたびにログイン画面
      return A.setPersistence(auth, A.browserSessionPersistence).then(function () {
        function siteRef(id) { return F.doc(db, 'sites', id); }
        return {
          mode: 'firebase',
          onAuth: function (cb) {
            return A.onAuthStateChanged(auth, function (u) { cb(u ? { uid: u.uid, email: u.email } : null); });
          },
          login: function (email, pw) { return A.signInWithEmailAndPassword(auth, email.trim(), pw); },
          register: function (name, email, pw) {
            return A.createUserWithEmailAndPassword(auth, email.trim(), pw).then(function (c) {
              return F.setDoc(F.doc(db, 'users', c.user.uid), {
                name: name, email: c.user.email, status: 'pending', role: 'user', createdAt: F.serverTimestamp()
              });
            });
          },
          logout: function () { return A.signOut(auth); },
          resetPassword: function (email) { return A.sendPasswordResetEmail(auth, email.trim()); },
          watchProfile: function (uid, cb) {
            return F.onSnapshot(F.doc(db, 'users', uid), function (s) {
              cb(s.exists() ? Object.assign({ uid: uid }, s.data()) : null);
            }, function (err) { cb(null, err); });
          },
          watchSites: function (cb, onErr) {
            return F.onSnapshot(F.collection(db, 'sites'), function (qs) {
              cb(qs.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }));
            }, onErr);
          },
          addSite: function (data) {
            var d = Object.assign({}, data, { createdAt: F.serverTimestamp(), updatedAt: F.serverTimestamp() });
            return F.addDoc(F.collection(db, 'sites'), d).then(function (r) { return r.id; });
          },
          updateSite: function (id, patch) {
            return F.updateDoc(siteRef(id), Object.assign({}, patch, { updatedAt: F.serverTimestamp() }));
          },
          deleteSite: function (id, site) {
            var files = [];
            Object.keys(FILE_CATS).forEach(function (cat) {
              ((site.files && site.files[cat]) || []).forEach(function (m) { files.push(m); });
            });
            return Promise.all(files.map(function (m) {
              return St.deleteObject(St.ref(storage, m.path)).catch(function () { /* 既に無い場合は無視 */ });
            })).then(function () { return F.deleteDoc(siteRef(id)); });
          },
          uploadFile: function (siteId, cat, file, onProgress, by) {
            var safe = file.name.replace(/[\/\\#?\[\]*]/g, '_');
            var path = 'sites/' + siteId + '/' + cat + '/' + Date.now() + '_' + safe;
            var task = St.uploadBytesResumable(St.ref(storage, path), file, {
              contentType: file.type || 'application/octet-stream',
              contentDisposition: "inline; filename*=UTF-8''" + encodeURIComponent(file.name)
            });
            return new Promise(function (res, rej) {
              task.on('state_changed', function (s) {
                onProgress(s.totalBytes ? s.bytesTransferred / s.totalBytes : 0);
              }, rej, res);
            }).then(function () {
              var meta = {
                id: newId(), name: file.name, path: path, size: file.size, type: file.type || '',
                uploadedAt: Date.now(), uploadedBy: by || ''
              };
              var patch = { updatedAt: F.serverTimestamp() };
              patch['files.' + cat] = F.arrayUnion(meta);
              return F.updateDoc(siteRef(siteId), patch).then(function () { return meta; });
            });
          },
          fileUrl: function (meta) { return St.getDownloadURL(St.ref(storage, meta.path)); },
          deleteFile: function (siteId, cat, meta) {
            return St.deleteObject(St.ref(storage, meta.path)).catch(function (e) {
              if (e.code !== 'storage/object-not-found') throw e;
            }).then(function () {
              var patch = { updatedAt: F.serverTimestamp() };
              patch['files.' + cat] = F.arrayRemove(meta);
              return F.updateDoc(siteRef(siteId), patch);
            });
          },
          watchUsers: function (cb, onErr) {
            return F.onSnapshot(F.collection(db, 'users'), function (qs) {
              cb(qs.docs.map(function (d) { return Object.assign({ uid: d.id }, d.data()); }));
            }, onErr);
          },
          setUser: function (uid, patch) { return F.updateDoc(F.doc(db, 'users', uid), patch); }
        };
      });
    });
  }

  /* ============================================================
   *  データの保存先（デモ版：このブラウザの中だけ）
   * ============================================================ */
  function createDemoBackend() {
    var KEY = 'genba-share-demo-v1';
    var blobs = {};
    var data = null;
    try { data = JSON.parse(localStorage.getItem(KEY)); } catch (e) { data = null; }
    if (!data || !data.users || !data.sites) data = seedDemo();
    function save() { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* 保存できなくても動作は続ける */ } }
    save();

    var L = { auth: [], profile: [], sites: [], users: [] };
    function pub(u) { var c = clone(u); delete c.pw; return c; }
    function findProfile(uid) {
      for (var i = 0; i < data.users.length; i++) if (data.users[i].uid === uid) return pub(data.users[i]);
      return null;
    }
    function emitSites() { L.sites.forEach(function (cb) { cb(clone(data.sites)); }); }
    function emitUsers() {
      L.users.forEach(function (cb) { cb(data.users.map(pub)); });
      L.profile.forEach(function (p) { p.cb(findProfile(p.uid)); });
    }
    var current = null;
    try { current = sessionStorage.getItem(KEY + '-uid'); } catch (e) { current = null; }
    if (current && !findProfile(current)) current = null;
    function authUser() { var u = findProfile(current); return u ? { uid: u.uid, email: u.email } : null; }
    function setCurrent(id) {
      current = id;
      try { if (id) sessionStorage.setItem(KEY + '-uid', id); else sessionStorage.removeItem(KEY + '-uid'); } catch (e) { /* 無視 */ }
      L.auth.forEach(function (cb) { cb(authUser()); });
    }
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms || 150); }); }
    function site(id) { for (var i = 0; i < data.sites.length; i++) if (data.sites[i].id === id) return data.sites[i]; return null; }

    return Promise.resolve({
      mode: 'demo',
      onAuth: function (cb) { L.auth.push(cb); setTimeout(function () { cb(authUser()); }, 0); return function () {}; },
      login: function (email, pw) {
        return wait().then(function () {
          var e = email.trim().toLowerCase();
          var u = data.users.filter(function (x) { return x.email === e; })[0];
          if (!u || u.pw !== pw) throw { code: 'auth/invalid-credential' };
          setCurrent(u.uid);
        });
      },
      register: function (name, email, pw) {
        return wait().then(function () {
          var e = email.trim().toLowerCase();
          if (!/^[^@\s]+@[^@\s]+$/.test(e)) throw { code: 'auth/invalid-email' };
          if (pw.length < 6) throw { code: 'auth/weak-password' };
          if (data.users.some(function (x) { return x.email === e; })) throw { code: 'auth/email-already-in-use' };
          var u = { uid: newId(), name: name, email: e, pw: pw, status: 'pending', role: 'user', createdAt: Date.now() };
          data.users.push(u); save();
          setCurrent(u.uid);
          emitUsers();
        });
      },
      logout: function () { setCurrent(null); return Promise.resolve(); },
      resetPassword: function () { return wait(); },
      watchProfile: function (uid, cb) {
        var ent = { uid: uid, cb: cb };
        L.profile.push(ent);
        setTimeout(function () { cb(findProfile(uid)); }, 0);
        return function () { L.profile = L.profile.filter(function (x) { return x !== ent; }); };
      },
      watchSites: function (cb) {
        L.sites.push(cb);
        setTimeout(function () { cb(clone(data.sites)); }, 0);
        return function () { L.sites = L.sites.filter(function (x) { return x !== cb; }); };
      },
      addSite: function (d) {
        return wait().then(function () {
          var s = Object.assign(clone(d), { id: newId(), createdAt: Date.now(), updatedAt: Date.now() });
          data.sites.push(s); save(); emitSites();
          return s.id;
        });
      },
      updateSite: function (id, patch) {
        return wait().then(function () {
          var s = site(id);
          if (!s) throw new Error('現場が見つかりません。');
          Object.assign(s, clone(patch), { updatedAt: Date.now() });
          save(); emitSites();
        });
      },
      deleteSite: function (id) {
        return wait().then(function () {
          data.sites = data.sites.filter(function (x) { return x.id !== id; });
          save(); emitSites();
        });
      },
      uploadFile: function (siteId, cat, file, onProgress, by) {
        var step = 0;
        return new Promise(function (res) {
          var t = setInterval(function () {
            step++; onProgress(step / 6);
            if (step >= 6) { clearInterval(t); res(); }
          }, 90);
        }).then(function () {
          var path = 'demo/' + newId();
          blobs[path] = URL.createObjectURL(file);
          var meta = { id: newId(), name: file.name, path: path, size: file.size, type: file.type || '', uploadedAt: Date.now(), uploadedBy: by || '' };
          var s = site(siteId);
          s.files = s.files || {};
          s.files[cat] = s.files[cat] || [];
          s.files[cat].push(meta);
          s.updatedAt = Date.now();
          save(); emitSites();
          return meta;
        });
      },
      fileUrl: function (meta) {
        if (blobs[meta.path]) return Promise.resolve(blobs[meta.path]);
        return Promise.reject(new Error('デモモードでは、ページを再読み込みするとファイルの中身は消えます（一覧だけ残ります）。'));
      },
      deleteFile: function (siteId, cat, meta) {
        return wait().then(function () {
          var s = site(siteId);
          s.files[cat] = (s.files[cat] || []).filter(function (m) { return m.id !== meta.id; });
          save(); emitSites();
        });
      },
      watchUsers: function (cb) {
        L.users.push(cb);
        setTimeout(function () { cb(data.users.map(pub)); }, 0);
        return function () { L.users = L.users.filter(function (x) { return x !== cb; }); };
      },
      setUser: function (uid, patch) {
        return wait().then(function () {
          var u = data.users.filter(function (x) { return x.uid === uid; })[0];
          Object.assign(u, patch); save(); emitUsers();
        });
      }
    });
  }

  function seedDemo() {
    var t = today0();
    function rel(n) { return ymd(new Date(t.getTime() + n * DAY)); }
    function s(name, customer, stage, a, b, work, contractors, waste, memo) {
      return {
        id: newId(), name: name, customer: customer, stage: stage, startDate: rel(a), endDate: rel(b),
        work: work, contractors: contractors, memo: memo || '', waste: waste, wasteNote: '',
        files: { docs: [], plans: [] }, createdAt: Date.now(), updatedAt: Date.now(), createdBy: 'デモ管理者', updatedBy: 'デモ管理者'
      };
    }
    return {
      users: [
        { uid: 'demo-admin', name: 'デモ管理者', email: 'admin@demo', pw: 'demo1234', status: 'approved', role: 'admin', createdAt: Date.now() },
        { uid: 'demo-user1', name: '営業 太郎（サンプル）', email: 'eigyo@demo', pw: 'demo1234', status: 'pending', role: 'user', createdAt: Date.now() }
      ],
      sites: [
        s('サンプルビル 外壁改修工事', '株式会社サンプル建設', 'during', -20, 25, '外壁改修、足場設置', 'サンプル足場工業\nサンプル塗装', 'complete', '搬入は東側ゲートから'),
        s('サンプル小学校 耐震補強工事', 'サンプル市 教育委員会', 'during', -5, 60, '耐震補強、内装解体', 'サンプル解体', 'incomplete'),
        s('サンプル邸 解体工事', '個人（サンプル様）', 'before', 10, 40, '木造2階建て 解体', 'サンプル重機', 'incomplete', '近隣挨拶 着工1週間前'),
        s('サンプル工場 屋根改修', '株式会社サンプル製作所', 'before', 35, 80, 'スレート屋根 撤去・葺き替え', 'サンプル板金', 'complete'),
        s('サンプルマンション 内装解体', 'サンプル不動産株式会社', 'done', -90, -30, '内装解体（3〜5階）', 'サンプル解体', 'complete')
      ]
    };
  }

  /* ============================================================
   *  アプリの状態
   * ============================================================ */
  var S = {
    api: null,
    authUser: null,
    profile: null,
    profileLoaded: false,
    registering: false,
    sites: [],
    sitesLoaded: false,
    users: [],
    unsubProfile: null,
    unsubSites: null,
    unsubUsers: null,
    authView: 'login',
    authMsg: null,
    listStage: 'before',
    search: '',
    ganttStage: 'active',
    ganttScale: 'day',
    ganttSearch: '',
    ganttScrollToday: true,
    editing: false,
    uploads: {}
  };

  function isApproved() { return S.profile && S.profile.status === 'approved'; }
  function isAdmin() { return isApproved() && S.profile.role === 'admin'; }
  function myName() { return (S.profile && (S.profile.name || S.profile.email)) || ''; }
  function findSite(id) {
    for (var i = 0; i < S.sites.length; i++) if (S.sites[i].id === id) return S.sites[i];
    return null;
  }
  function pendingCount() { return S.users.filter(function (u) { return u.status === 'pending'; }).length; }

  function route() {
    var h = location.hash.replace(/^#\/?/, '');
    var p = h.split('/').map(function (x) { try { return decodeURIComponent(x); } catch (e) { return x; } });
    if (p[0] === 'site' && p[1]) return { name: 'site', id: p[1], tab: DETAIL_TABS.indexOf(p[2]) >= 0 ? p[2] : 'basic' };
    if (p[0] === 'new') return { name: 'new' };
    if (p[0] === 'schedule') return { name: 'schedule' };
    if (p[0] === 'admin') return { name: 'admin' };
    var st = ['before', 'during', 'done', 'all'].indexOf(p[1]) >= 0 ? p[1] : S.listStage;
    return { name: 'list', stage: st };
  }

  /* ============================================================
   *  画面：ログイン／新規登録／承認待ち
   * ============================================================ */
  function demoBanner() {
    if (!IS_DEMO) return '';
    return '<div class="demo-banner">デモモードで動いています（データはこのブラウザの中だけに保存されます）。' +
      'お試しログイン：admin@demo ／ demo1234</div>';
  }

  function authNotice() {
    if (!S.authMsg) return '';
    return '<div class="notice notice-' + S.authMsg.type + '">' + esc(S.authMsg.text) + '</div>';
  }

  function loginHtml() {
    return demoBanner() +
      '<div class="auth-wrap"><div class="auth-card">' +
      '<h1 class="auth-title">' + esc(CFG.appName || '現場情報共有システム') + '</h1>' +
      '<p class="auth-sub">営業・施工管理 現場情報共有</p>' +
      authNotice() +
      '<form id="login-form" autocomplete="on">' +
      '<div class="field"><label for="li-email">メールアドレス</label>' +
      '<input id="li-email" class="input" type="email" name="email" autocomplete="username" required></div>' +
      '<div class="field"><label for="li-pw">パスワード</label>' +
      '<input id="li-pw" class="input" type="password" name="password" autocomplete="current-password" required></div>' +
      '<button class="btn btn-primary btn-block" type="submit">ログイン</button>' +
      '</form>' +
      '<p style="text-align:right;margin:10px 0 0;font-size:13px"><button class="link-btn" data-act="go-reset">パスワードを忘れた方</button></p>' +
      '<div class="auth-divider"></div>' +
      '<div class="auth-foot">アカウントをお持ちでない方<br>' +
      '<button class="btn btn-block" data-act="go-register">新規登録</button>' +
      '<div class="hint" style="margin-top:6px">新規登録は管理者の承認後に利用できます</div></div>' +
      '</div></div>';
  }

  function registerHtml() {
    return demoBanner() +
      '<div class="auth-wrap"><div class="auth-card">' +
      '<h1 class="auth-title">新規登録</h1>' +
      '<p class="auth-sub">登録後、管理者が承認すると利用できるようになります</p>' +
      authNotice() +
      '<form id="register-form">' +
      '<div class="field"><label for="rg-name">お名前<span class="req">必須</span></label>' +
      '<input id="rg-name" class="input" type="text" autocomplete="name" placeholder="例：山田 太郎" required></div>' +
      '<div class="field"><label for="rg-email">メールアドレス<span class="req">必須</span></label>' +
      '<input id="rg-email" class="input" type="email" autocomplete="email" required></div>' +
      '<div class="field"><label for="rg-pw">パスワード（6文字以上）<span class="req">必須</span></label>' +
      '<input id="rg-pw" class="input" type="password" autocomplete="new-password" minlength="6" required></div>' +
      '<div class="field"><label for="rg-pw2">パスワード（確認）<span class="req">必須</span></label>' +
      '<input id="rg-pw2" class="input" type="password" autocomplete="new-password" minlength="6" required></div>' +
      '<button class="btn btn-primary btn-block" type="submit">登録を申請する</button>' +
      '</form>' +
      '<div class="auth-divider"></div>' +
      '<div class="auth-foot"><button class="link-btn" data-act="go-login">← ログイン画面に戻る</button></div>' +
      '</div></div>';
  }

  function resetHtml() {
    return demoBanner() +
      '<div class="auth-wrap"><div class="auth-card">' +
      '<h1 class="auth-title">パスワードの再設定</h1>' +
      '<p class="auth-sub">登録したメールアドレスに再設定用のメールを送ります</p>' +
      authNotice() +
      '<form id="reset-form">' +
      '<div class="field"><label for="rs-email">メールアドレス</label>' +
      '<input id="rs-email" class="input" type="email" autocomplete="email" required></div>' +
      '<button class="btn btn-primary btn-block" type="submit">再設定メールを送る</button>' +
      '</form>' +
      '<div class="auth-divider"></div>' +
      '<div class="auth-foot"><button class="link-btn" data-act="go-login">← ログイン画面に戻る</button></div>' +
      '</div></div>';
  }

  function statusHtml(icon, title, body) {
    return demoBanner() +
      '<div class="auth-wrap"><div class="auth-card">' +
      '<div class="status-icon">' + icon + '</div>' +
      '<h1 class="auth-title">' + esc(title) + '</h1>' +
      '<p class="auth-sub" style="margin-bottom:16px">' + body + '</p>' +
      '<p class="auth-sub">' + esc(S.authUser ? S.authUser.email : '') + '</p>' +
      '<button class="btn btn-block" data-act="logout">ログアウト</button>' +
      '</div></div>';
  }

  /* ============================================================
   *  画面：共通ヘッダー
   * ============================================================ */
  function headerHtml(r) {
    function nav(href, label, active, extra) {
      return '<a href="' + href + '"' + (active ? ' class="active"' : '') + '>' + label + (extra || '') + '</a>';
    }
    var pc = pendingCount();
    return demoBanner() +
      '<header class="header">' +
      '<div class="logo">' + esc(CFG.appName || '現場情報共有システム') + '</div>' +
      '<nav class="nav">' +
      nav('#/list/' + S.listStage, '現場一覧', r.name === 'list' || r.name === 'site' || r.name === 'new') +
      nav('#/schedule', '工程表', r.name === 'schedule') +
      (isAdmin() ? nav('#/admin', '利用者管理', r.name === 'admin',
        '<span class="badge-count" id="pending-badge"' + (pc ? '' : ' hidden') + '>' + pc + '</span>') : '') +
      '</nav>' +
      '<div class="user-box"><span class="uname">' + esc(myName()) + ' さん' + (isAdmin() ? '（管理者）' : '') + '</span>' +
      '<button class="btn btn-small" data-act="logout">ログアウト</button></div>' +
      '</header>';
  }

  /* ============================================================
   *  画面：現場一覧
   * ============================================================ */
  function matchSite(s, q) {
    if (!q) return true;
    var hay = norm([s.name, s.customer, s.work, s.contractors, s.memo].join(' '));
    return norm(q).split(/\s+/).filter(Boolean).every(function (w) { return hay.indexOf(w) >= 0; });
  }
  function sortSites(list, stage) {
    var order = { before: 0, during: 1, done: 2 };
    return list.slice().sort(function (a, b) {
      if (stage === 'all' && a.stage !== b.stage) return (order[a.stage] || 0) - (order[b.stage] || 0);
      var st = stage === 'all' ? a.stage : stage;
      if (st === 'done') return String(b.endDate || '').localeCompare(String(a.endDate || ''));
      var ka = (st === 'during' ? a.endDate : a.startDate) || '9999';
      var kb = (st === 'during' ? b.endDate : b.startDate) || '9999';
      return ka.localeCompare(kb) || String(a.name).localeCompare(String(b.name), 'ja');
    });
  }

  function listShellHtml(r) {
    return '<main class="main">' +
      '<div class="page-head"><h1>現場一覧</h1>' +
      '<a class="btn btn-primary" href="#/new">＋ 新規現場登録</a></div>' +
      '<div class="page-head"><div class="search-box">' +
      '<input id="search" class="input" type="search" placeholder="現場名・顧客名・作業内容・協力業者・メモで検索" value="' + esc(S.search) + '">' +
      '</div></div>' +
      '<div class="stage-tabs" id="stage-tabs"></div>' +
      '<div id="list-area"></div>' +
      '</main>';
  }

  function updateList() {
    var r = route();
    var tabs = $('#stage-tabs'), area = $('#list-area');
    if (!tabs || !area) return;
    var matched = S.sites.filter(function (s) { return matchSite(s, S.search); });
    var counts = { before: 0, during: 0, done: 0, all: matched.length };
    matched.forEach(function (s) { counts[s.stage in counts ? s.stage : 'before']++; });
    var defs = STAGES.concat([{ key: 'all', label: 'すべて' }]);
    tabs.innerHTML = defs.map(function (d) {
      return '<button class="stage-tab st-' + d.key + (r.stage === d.key ? ' active' : '') + '" data-act="stage-tab" data-v="' + d.key + '">' +
        esc(d.label) + '<span class="num">' + counts[d.key] + '</span></button>';
    }).join('');

    if (!S.sitesLoaded) { area.innerHTML = '<div class="empty">読み込み中…</div>'; return; }
    var list = matched.filter(function (s) {
      var st = s.stage || 'before';
      return r.stage === 'all' || st === r.stage;
    });
    list = sortSites(list, r.stage);
    if (!list.length) {
      area.innerHTML = '<div class="empty">' + (S.search ? '検索条件に合う現場はありません。' :
        (r.stage === 'all' ? 'まだ現場が登録されていません。' : stageLabel(r.stage) + 'の現場はありません。')) + '</div>';
      return;
    }
    area.innerHTML = '<div class="site-list">' + list.map(function (s) { return siteCardHtml(s, r.stage === 'all'); }).join('') + '</div>';
  }

  function wasteChip(s) {
    return s.waste === 'complete'
      ? '<span class="chip chip-green">産廃 完了</span>'
      : '<span class="chip chip-red">産廃 未完了</span>';
  }

  function siteCardHtml(s, showStage) {
    var files = s.files || {};
    var nd = (files.docs || []).length, np = (files.plans || []).length;
    var ng = s.waste !== 'complete';
    return '<a class="site-card ' + (ng ? 'waste-ng' : 'waste-ok') + '" href="#/site/' + encodeURIComponent(s.id) + '/basic">' +
      '<div class="name"><span>' + esc(s.name) + '</span>' + wasteChip(s) + '</div>' +
      '<dl>' +
      '<dt>顧客名</dt><dd>' + (esc(s.customer) || '—') + '</dd>' +
      '<dt>工期</dt><dd>' + esc(fmtPeriod(s.startDate, s.endDate)) + '</dd>' +
      '<dt>作業内容</dt><dd>' + (esc(s.work) || '—') + '</dd>' +
      '<dt>協力業者</dt><dd>' + (esc(String(s.contractors || '').replace(/\n+/g, '、')) || '—') + '</dd>' +
      '</dl>' +
      '<div class="foot">' +
      (showStage ? '<span class="chip chip-' + esc(s.stage || 'before') + '">' + stageLabel(s.stage) + '</span>' : '') +
      '<span class="chip">現場資料 ' + nd + '</span><span class="chip">施工計画書 ' + np + '</span>' +
      '</div></a>';
  }

  /* ============================================================
   *  画面：現場の登録・編集フォーム
   * ============================================================ */
  function siteFormFields(s, withStage) {
    s = s || {};
    var stageSel = withStage
      ? '<div class="field"><label for="f-stage">格納場所</label><select id="f-stage" class="select">' +
        STAGES.map(function (st) {
          return '<option value="' + st.key + '"' + ((s.stage || 'before') === st.key ? ' selected' : '') + '>' + st.label + '</option>';
        }).join('') + '</select></div>'
      : '';
    return '<div class="field"><label for="f-name">現場名<span class="req">必須</span></label>' +
      '<input id="f-name" class="input" type="text" value="' + esc(s.name) + '" required></div>' +
      '<div class="field"><label for="f-customer">顧客名</label>' +
      '<input id="f-customer" class="input" type="text" value="' + esc(s.customer) + '"></div>' +
      '<div class="row2">' +
      '<div class="field"><label for="f-start">工期（開始）</label><input id="f-start" class="input" type="date" value="' + esc(s.startDate) + '"></div>' +
      '<div class="field"><label for="f-end">工期（終了）</label><input id="f-end" class="input" type="date" value="' + esc(s.endDate) + '"></div>' +
      '</div>' +
      '<div class="field"><label for="f-work">作業内容</label>' +
      '<textarea id="f-work" class="textarea">' + esc(s.work) + '</textarea></div>' +
      '<div class="field"><label for="f-contractors">協力業者名</label>' +
      '<textarea id="f-contractors" class="textarea" style="min-height:70px">' + esc(s.contractors) + '</textarea>' +
      '<div class="hint">複数ある場合は改行して入力してください</div></div>' +
      '<div class="field"><label for="f-memo">その他メモ</label>' +
      '<textarea id="f-memo" class="textarea">' + esc(s.memo) + '</textarea></div>' +
      stageSel;
  }

  function readSiteForm() {
    function v(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
    var d = {
      name: v('f-name'), customer: v('f-customer'), startDate: v('f-start'), endDate: v('f-end'),
      work: v('f-work'), contractors: v('f-contractors'), memo: v('f-memo')
    };
    if (document.getElementById('f-stage')) d.stage = v('f-stage');
    if (!d.name) throw new Error('現場名を入力してください。');
    if (d.startDate && d.endDate && d.endDate < d.startDate) throw new Error('工期の終了日が開始日より前になっています。');
    return d;
  }

  function newSiteHtml() {
    var stage = S.listStage === 'all' ? 'before' : S.listStage;
    return '<main class="main" style="max-width:760px">' +
      '<a class="back-link" href="#/list/' + S.listStage + '">← 現場一覧に戻る</a>' +
      '<div class="card"><h2>新規現場登録</h2>' +
      '<form id="new-site-form">' + siteFormFields({ stage: stage }, true) +
      '<div class="actions-row"><a class="btn" href="#/list/' + S.listStage + '">キャンセル</a>' +
      '<button class="btn btn-primary" type="submit">登録する</button></div>' +
      '</form></div></main>';
  }

  /* ============================================================
   *  画面：現場詳細（タブ）
   * ============================================================ */
  function siteHtml(r) {
    var s = findSite(r.id);
    if (!S.sitesLoaded) return '<main class="main"><div class="empty">読み込み中…</div></main>';
    if (!s) {
      return '<main class="main"><a class="back-link" href="#/list/' + S.listStage + '">← 現場一覧に戻る</a>' +
        '<div class="empty">この現場は見つかりません（削除された可能性があります）。</div></main>';
    }
    var files = s.files || {};
    var ng = s.waste !== 'complete';
    var stage = s.stage || 'before';
    function tab(key, label, extra) {
      return '<a class="tab' + (r.tab === key ? ' active' : '') + '" href="#/site/' + encodeURIComponent(s.id) + '/' + key + '">' + label + (extra || '') + '</a>';
    }
    var body;
    if (r.tab === 'docs' || r.tab === 'plans') body = filesTabHtml(s, r.tab);
    else if (r.tab === 'waste') body = wasteTabHtml(s);
    else body = S.editing ? editBasicHtml(s) : basicTabHtml(s);

    return '<main class="main">' +
      '<a class="back-link" href="#/list/' + stage + '">← 現場一覧（' + stageLabel(stage) + '）に戻る</a>' +
      '<div class="detail-head">' +
      '<div class="title-row"><h1>' + esc(s.name) + '</h1>' +
      '<div class="stage-move"><label for="stage-sel">格納場所</label><select id="stage-sel" class="select">' +
      STAGES.map(function (st) {
        return '<option value="' + st.key + '"' + (stage === st.key ? ' selected' : '') + '>' + st.label + '</option>';
      }).join('') + '</select></div></div>' +
      '<nav class="tabs">' +
      tab('basic', '基本情報') +
      tab('docs', '現場資料', '<span class="num">' + (files.docs || []).length + '</span>') +
      tab('plans', '施工計画書', '<span class="num">' + (files.plans || []).length + '</span>') +
      tab('waste', '産廃契約状況', ng ? '<span class="dot-red" title="未完了"></span>' : '') +
      '</nav></div>' +
      '<div class="detail-body">' + body + '</div>' +
      '</main>';
  }

  function basicTabHtml(s) {
    function row(label, val) { return '<tr><th>' + label + '</th><td>' + (esc(val) || '<span style="color:#9aa5b1">—</span>') + '</td></tr>'; }
    return '<table class="info-table">' +
      row('現場名', s.name) +
      row('顧客名', s.customer) +
      row('工期', fmtPeriod(s.startDate, s.endDate)) +
      row('作業内容', s.work) +
      row('協力業者名', s.contractors) +
      row('その他メモ', s.memo) +
      '</table>' +
      '<div class="actions-row">' +
      (isAdmin() ? '<button class="btn btn-danger" data-act="delete-site">この現場を削除</button>' : '') +
      '<span class="spacer"></span>' +
      '<button class="btn btn-primary" data-act="edit-basic">編集する</button></div>' +
      '<div class="meta-line">登録：' + esc(fmtDateTime(s.createdAt)) + (s.createdBy ? '（' + esc(s.createdBy) + '）' : '') +
      '　最終更新：' + esc(fmtDateTime(s.updatedAt)) + (s.updatedBy ? '（' + esc(s.updatedBy) + '）' : '') + '</div>';
  }

  function editBasicHtml(s) {
    return '<form id="edit-site-form">' + siteFormFields(s, false) +
      '<div class="actions-row"><button class="btn" type="button" data-act="cancel-edit">キャンセル</button>' +
      '<button class="btn btn-primary" type="submit">保存する</button></div></form>';
  }

  function fileKind(name) {
    var ext = (String(name).split('.').pop() || '').toLowerCase();
    if (ext === 'pdf') return ['pdf', 'PDF'];
    if (['xls', 'xlsx', 'xlsm', 'csv'].indexOf(ext) >= 0) return ['xls', 'XLS'];
    if (['doc', 'docx'].indexOf(ext) >= 0) return ['doc', 'DOC'];
    if (['jpg', 'jpeg', 'png', 'gif', 'heic', 'webp', 'bmp'].indexOf(ext) >= 0) return ['img', 'IMG'];
    return ['', (ext || 'FILE').slice(0, 4).toUpperCase()];
  }

  function filesTabHtml(s, cat) {
    var list = ((s.files && s.files[cat]) || []).slice().sort(function (a, b) { return (b.uploadedAt || 0) - (a.uploadedAt || 0); });
    var ups = S.uploads[s.id + '/' + cat] || [];
    var upHtml = ups.map(function (u) {
      var k = fileKind(u.name);
      return '<li class="file-item"><div class="file-icon ' + k[0] + '">' + k[1] + '</div><div class="file-info">' +
        '<div class="file-name">' + esc(u.name) + '</div><div class="file-meta">アップロード中…</div>' +
        '<div class="progress"><div id="prog-' + u.key + '" style="width:' + Math.round(u.p * 100) + '%"></div></div></div></li>';
    }).join('');
    var items = list.map(function (m) {
      var k = fileKind(m.name);
      return '<li class="file-item"><div class="file-icon ' + k[0] + '">' + k[1] + '</div>' +
        '<div class="file-info"><div class="file-name">' + esc(m.name) + '</div>' +
        '<div class="file-meta">' + esc(fmtSize(m.size)) + '・' + esc(fmtDateTime(m.uploadedAt)) + (m.uploadedBy ? '・' + esc(m.uploadedBy) : '') + '</div></div>' +
        '<div class="file-ops"><button class="btn btn-small" data-act="open-file" data-cat="' + cat + '" data-fid="' + esc(m.id) + '">開く</button>' +
        '<button class="btn btn-small btn-danger" data-act="del-file" data-cat="' + cat + '" data-fid="' + esc(m.id) + '">削除</button></div></li>';
    }).join('');
    return '<div class="file-head"><h2>' + FILE_CATS[cat] + '</h2>' +
      '<button class="plus-btn" data-act="pick-file" title="ファイルを追加" aria-label="ファイルを追加">+</button></div>' +
      '<input type="file" id="file-input" data-cat="' + cat + '" multiple hidden>' +
      '<div class="drop-zone" id="drop-zone" data-act="pick-file">ここにファイルをドラッグ＆ドロップ、または「＋」を押して追加（1ファイル' + MAX_MB + 'MBまで・複数可）</div>' +
      ((upHtml || items) ? '<ul class="file-list">' + upHtml + items + '</ul>' : '<div class="empty" style="padding:30px">まだファイルが登録されていません。</div>');
  }

  function wasteTabHtml(s) {
    var ng = s.waste !== 'complete';
    return '<div class="waste-status-big ' + (ng ? 'ng' : 'ok') + '">現在の状況：' + (ng ? '未完了' : '完了') + '</div>' +
      '<div class="hint">産廃（産業廃棄物）の契約状況を選んでください。未完了の現場は一覧で赤く表示されます。</div>' +
      '<div class="waste-choice">' +
      '<button class="waste-opt' + (ng ? ' sel-ng' : '') + '" data-act="set-waste" data-v="incomplete">未完了</button>' +
      '<button class="waste-opt' + (!ng ? ' sel-ok' : '') + '" data-act="set-waste" data-v="complete">完了</button>' +
      '</div>' +
      '<div class="field"><label for="waste-note">備考（契約先・契約日など）</label>' +
      '<textarea id="waste-note" class="textarea">' + esc(s.wasteNote) + '</textarea></div>' +
      '<div class="actions-row"><button class="btn btn-primary" data-act="save-waste-note">備考を保存</button></div>';
  }

  /* ============================================================
   *  画面：工程表
   * ============================================================ */
  function scheduleShellHtml() {
    function seg(id, cur, opts) {
      return '<div class="seg" id="' + id + '">' + opts.map(function (o) {
        return '<button data-act="' + id + '" data-v="' + o[0] + '"' + (cur === o[0] ? ' class="active"' : '') + '>' + o[1] + '</button>';
      }).join('') + '</div>';
    }
    return '<main class="main wide">' +
      '<div class="page-head"><h1>工程表</h1><button class="btn no-print" data-act="print">印刷</button></div>' +
      '<div class="gantt-toolbar no-print">' +
      seg('g-stage', S.ganttStage, [['before', '着工前'], ['during', '施工中'], ['active', 'すべて（着工前＋施工中）']]) +
      seg('g-scale', S.ganttScale, [['day', '日'], ['week', '週'], ['month', '月']]) +
      '<button class="btn btn-small" data-act="g-today">今日へ</button>' +
      '<div class="search-box"><input id="g-search" class="input" type="search" placeholder="現場名・顧客名などで絞り込み" value="' + esc(S.ganttSearch) + '"></div>' +
      '</div>' +
      '<div class="legend"><span><i style="background:var(--blue)"></i>着工前</span>' +
      '<span><i style="background:var(--orange)"></i>施工中</span>' +
      '<span><i style="background:#fff;box-shadow:inset 0 -4px 0 var(--red);border:1px solid #ccc"></i>下線が赤＝産廃契約 未完了</span>' +
      '<span><i style="background:var(--red);width:2px;height:14px"></i>今日</span>' +
      '<span>バーをクリックすると現場の詳細を開きます</span></div>' +
      '<div id="gantt-area"></div></main>';
  }

  function updateGantt() {
    var area = $('#gantt-area');
    if (!area) return;
    if (!S.sitesLoaded) { area.innerHTML = '<div class="empty">読み込み中…</div>'; return; }
    var stages = S.ganttStage === 'active' ? ['before', 'during'] : [S.ganttStage];
    var list = S.sites.filter(function (s) {
      return stages.indexOf(s.stage || 'before') >= 0 && matchSite(s, S.ganttSearch);
    });
    var dated = [], nodate = [];
    list.forEach(function (s) {
      var a = parseYmd(s.startDate), b = parseYmd(s.endDate);
      if (a && b && b >= a) dated.push({ s: s, a: a, b: b }); else nodate.push(s);
    });
    dated.sort(function (x, y) {
      if (S.ganttStage === 'active' && x.s.stage !== y.s.stage) return x.s.stage === 'during' ? -1 : 1;
      return (x.a - y.a) || (x.b - y.b);
    });

    var old = $('.gantt', area);
    var keep = old ? { l: old.scrollLeft, t: old.scrollTop } : null;

    if (!dated.length) {
      area.innerHTML = '<div class="empty">表示できる現場がありません。' +
        (list.length ? '（工期が未設定の現場があります）' : '') + '</div>' + nodateHtml(nodate);
      return;
    }

    var t = today0();
    var minD = t, maxD = t;
    dated.forEach(function (x) { if (x.a < minD) minD = x.a; if (x.b > maxD) maxD = x.b; });
    var start = new Date(minD.getFullYear(), minD.getMonth(), 1);
    var end = new Date(maxD.getFullYear(), maxD.getMonth() + 1, 0);
    var px = { day: 28, week: 10, month: 3 }[S.ganttScale] || 28;
    var ndays = daysBetween(start, end) + 1;
    var W = ndays * px;
    var LW = window.innerWidth < 720 ? 130 : 240, ROW = 44;
    var headH = S.ganttScale === 'month' ? 26 : 52;

    // 見出し：月
    var months = '';
    var m = new Date(start);
    while (m <= end) {
      var mEnd = new Date(m.getFullYear(), m.getMonth() + 1, 0);
      var left = daysBetween(start, m) * px;
      var w = (daysBetween(m, mEnd) + 1) * px;
      var label = S.ganttScale === 'month' ? (m.getMonth() === 0 || left === 0 ? m.getFullYear() + '/' : '') + (m.getMonth() + 1) + '月'
        : m.getFullYear() + '年' + (m.getMonth() + 1) + '月';
      months += '<div class="m" style="left:' + left + 'px;width:' + w + 'px"><span>' + label + '</span></div>';
      m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
    }
    // 見出し：日 or 週
    var days = '';
    if (S.ganttScale !== 'month') {
      for (var i = 0; i < ndays; i++) {
        var d = new Date(start.getTime() + i * DAY);
        d = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        var wd = d.getDay();
        if (S.ganttScale === 'day') {
          days += '<div class="d' + (wd === 6 ? ' sat' : wd === 0 ? ' sun' : '') + (d.getTime() === t.getTime() ? ' today' : '') + '" style="left:' + (i * px) + 'px;width:' + px + 'px">' + d.getDate() + '</div>';
        } else if (wd === 1) {
          days += '<div class="d" style="left:' + (i * px) + 'px;width:' + (7 * px) + 'px">' + (d.getMonth() + 1) + '/' + d.getDate() + '</div>';
        }
      }
    }
    var todayLeft = daysBetween(start, t) * px;

    // 背景（週末の色・罫線・今日の線）
    var bg = '';
    if (S.ganttScale === 'day') {
      for (var j = 0; j < ndays; j++) {
        var dd = new Date(start.getFullYear(), start.getMonth(), start.getDate() + j);
        var w2 = dd.getDay();
        if (w2 === 0 || w2 === 6) bg += '<div style="position:absolute;top:0;bottom:0;left:' + (j * px) + 'px;width:' + px + 'px;background:' + (w2 === 0 ? '#fdf4f4' : '#f3f8fe') + '"></div>';
      }
    }
    var gridUnit = S.ganttScale === 'day' ? px : S.ganttScale === 'week' ? 7 * px : 0;
    var lines = gridUnit ? 'background-image:linear-gradient(to right,#e9edf1 1px,transparent 1px);background-size:' + gridUnit + 'px 100%;' : '';
    // 月の区切り線
    var mlines = '';
    m = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    while (m <= end) {
      mlines += '<div style="position:absolute;top:0;bottom:0;width:1px;background:#c9d1da;left:' + (daysBetween(start, m) * px) + 'px"></div>';
      m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
    }

    var rows = dated.map(function (x) {
      var s = x.s;
      var l = daysBetween(start, x.a) * px;
      var w = (daysBetween(x.a, x.b) + 1) * px;
      var ng = s.waste !== 'complete';
      var tip = s.name + (s.customer ? '（' + s.customer + '）' : '') + '\n' + fmtPeriod(s.startDate, s.endDate) +
        '\n' + stageLabel(s.stage) + '／産廃契約 ' + (ng ? '未完了' : '完了');
      var href = '#/site/' + encodeURIComponent(s.id) + '/basic';
      return '<a class="g-label" href="' + href + '" style="text-decoration:none;color:inherit">' +
        '<div class="n">' + esc(s.name) + '</div>' +
        '<div class="s">' + esc(stageLabel(s.stage)) + '・' + esc(fmtMd(s.startDate)) + '〜' + esc(fmtMd(s.endDate)) + (s.customer ? '・' + esc(s.customer) : '') + '</div></a>' +
        '<div class="g-track"><a class="g-bar ' + esc(s.stage || 'before') + (ng ? ' ng' : '') + '" href="' + href + '" title="' + esc(tip) + '" style="left:' + l + 'px;width:' + w + 'px">' +
        (w >= 40 ? '<span>' + esc(s.name) + '</span>' : '') + '</a></div>';
    }).join('');

    var todayInRange = todayLeft >= 0 && todayLeft <= W;
    area.innerHTML =
      '<div class="gantt" id="gantt" style="--lw:' + LW + 'px"><div class="g-grid" style="grid-template-columns:' + LW + 'px ' + W + 'px;width:' + (LW + W) + 'px">' +
      '<div class="g-corner" style="height:' + headH + 'px">現場名（' + dated.length + '件）</div>' +
      '<div class="g-head" style="height:' + headH + 'px"><div class="months">' + months + '</div>' +
      (S.ganttScale !== 'month' ? '<div class="days">' + days + '</div>' : '') +
      (todayInRange && S.ganttScale !== 'day' ? '<div class="g-today-label" style="left:' + (todayLeft + px / 2) + 'px;top:' + (headH - 14) + 'px">今日</div>' : '') +
      '</div>' +
      '<div style="position:absolute;left:' + LW + 'px;top:' + headH + 'px;width:' + W + 'px;height:' + (dated.length * ROW) + 'px;z-index:0;' + lines + '">' +
      bg + mlines +
      (todayInRange ? '<div class="g-today" style="left:' + (todayLeft + Math.floor(px / 2) - 1) + 'px"></div>' : '') +
      '</div>' +
      rows +
      '</div></div>' + nodateHtml(nodate);

    var g = $('#gantt');
    if (S.ganttScrollToday) {
      g.scrollLeft = Math.max(0, todayLeft - Math.min(7 * px, Math.max(0, g.clientWidth - LW) * 0.25));
      S.ganttScrollToday = false;
    } else if (keep) {
      g.scrollLeft = keep.l; g.scrollTop = keep.t;
    }
  }

  function nodateHtml(list) {
    if (!list.length) return '';
    return '<div class="nodate"><b>工期が未設定の現場（' + list.length + '件）</b>：' +
      list.map(function (s) {
        return '<a href="#/site/' + encodeURIComponent(s.id) + '/basic">' + esc(s.name) + '</a>';
      }).join('') + '</div>';
  }

  /* ============================================================
   *  画面：利用者管理（管理者のみ）
   * ============================================================ */
  function adminHtml() {
    if (!isAdmin()) return '<main class="main"><div class="empty">管理者のみ利用できます。</div></main>';
    var me = S.authUser.uid;
    var users = S.users.slice().sort(function (a, b) {
      return (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0);
    });
    var pending = users.filter(function (u) { return u.status === 'pending'; });
    var active = users.filter(function (u) { return u.status === 'approved'; });
    var stopped = users.filter(function (u) { return u.status !== 'pending' && u.status !== 'approved'; });
    function table(list, ops) {
      if (!list.length) return '<div class="hint">該当する人はいません。</div>';
      return '<table class="user-table"><thead><tr><th>お名前</th><th>メールアドレス</th><th class="hide-sm">登録日</th><th>権限</th><th></th></tr></thead><tbody>' +
        list.map(function (u) {
          return '<tr><td>' + esc(u.name || '') + (u.uid === me ? '（あなた）' : '') + '</td><td>' + esc(u.email) + '</td>' +
            '<td class="hide-sm">' + esc(fmtDateTime(u.createdAt)) + '</td>' +
            '<td>' + (u.role === 'admin' ? '<span class="chip chip-before">管理者</span>' : '一般') + '</td>' +
            '<td class="ops">' + ops(u) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    function btn(act, uid, label, cls) {
      return '<button class="btn btn-small ' + (cls || '') + '" data-act="' + act + '" data-uid="' + esc(uid) + '">' + label + '</button>';
    }
    return '<main class="main">' +
      '<div class="page-head"><h1>利用者管理</h1></div>' +
      '<div class="card"><h2>承認待ち（' + pending.length + '人）</h2>' +
      '<div class="hint" style="margin-bottom:8px">心当たりのある人だけ承認してください。承認すると現場情報を見られるようになります。</div>' +
      table(pending, function (u) { return btn('approve', u.uid, '承認する', 'btn-primary') + btn('reject', u.uid, '却下', 'btn-danger'); }) +
      '</div>' +
      '<div class="card"><h2>利用中（' + active.length + '人）</h2>' +
      table(active, function (u) {
        if (u.uid === me) return '';
        return (u.role === 'admin' ? btn('make-user', u.uid, '一般に戻す') : btn('make-admin', u.uid, '管理者にする')) +
          btn('suspend', u.uid, '利用停止', 'btn-danger');
      }) + '</div>' +
      '<div class="card"><h2>停止・却下（' + stopped.length + '人）</h2>' +
      table(stopped, function (u) { return btn('approve', u.uid, '利用を許可する'); }) +
      '</div></main>';
  }

  /* ============================================================
   *  画面の描画
   * ============================================================ */
  function render() {
    var app = $('#app');
    if (!S.api) return;
    if (!S.authUser) {
      app.innerHTML = S.authView === 'register' ? registerHtml() : S.authView === 'reset' ? resetHtml() : loginHtml();
      var first = app.querySelector('input');
      if (first && window.innerWidth > 720) first.focus();
      return;
    }
    if (!S.profileLoaded) { app.innerHTML = '<div class="boot">確認中…</div>'; return; }
    if (!S.profile) {
      if (S.registering) { app.innerHTML = '<div class="boot">登録しています…</div>'; return; }
      app.innerHTML = statusHtml('⚠️', '登録情報が見つかりません', '登録が途中で止まった可能性があります。管理者に連絡してください。');
      return;
    }
    if (S.profile.status === 'pending') {
      app.innerHTML = statusHtml('⏳', '承認待ちです', '登録を受け付けました。<br>管理者が承認すると利用できるようになります。<br>承認されると、この画面は自動で切り替わります。');
      return;
    }
    if (S.profile.status !== 'approved') {
      app.innerHTML = statusHtml('🔒', '利用が許可されていません', 'このアカウントは利用が停止されているか、承認されませんでした。<br>必要な場合は管理者に連絡してください。');
      return;
    }

    var r = route();
    if (r.name === 'list') S.listStage = r.stage;
    var html;
    if (r.name === 'site') html = siteHtml(r);
    else if (r.name === 'new') html = newSiteHtml();
    else if (r.name === 'schedule') html = scheduleShellHtml();
    else if (r.name === 'admin') html = adminHtml();
    else html = listShellHtml(r);
    app.innerHTML = headerHtml(r) + html;

    if (r.name === 'list') updateList();
    if (r.name === 'schedule') updateGantt();
  }

  function onSitesChanged() {
    var r = route();
    if (!isApproved()) return;
    if (r.name === 'list') return updateList();
    if (r.name === 'schedule') return updateGantt();
    if (r.name === 'new') return;
    if (r.name === 'site') {
      if (S.editing) return;
      var ae = document.activeElement;
      if (ae && ae.id === 'waste-note') return;
    }
    render();
  }

  function onUsersChanged() {
    var r = route();
    if (r.name === 'admin') return render();
    var b = $('#pending-badge');
    if (b) { var n = pendingCount(); b.textContent = n; b.hidden = !n; }
  }

  /* ============================================================
   *  ログイン状態の監視
   * ============================================================ */
  function stopWatches() {
    ['unsubProfile', 'unsubSites', 'unsubUsers'].forEach(function (k) {
      if (S[k]) { try { S[k](); } catch (e) { /* 無視 */ } S[k] = null; }
    });
    S.sites = []; S.sitesLoaded = false; S.users = [];
  }

  function onProfile() {
    var ok = isApproved();
    if (ok && !S.unsubSites) {
      S.unsubSites = S.api.watchSites(function (sites) {
        S.sites = sites; S.sitesLoaded = true; onSitesChanged();
      }, function (e) { toast(errMsg(e), true); });
    }
    if (!ok && S.unsubSites) { S.unsubSites(); S.unsubSites = null; S.sites = []; S.sitesLoaded = false; }
    var admin = isAdmin();
    if (admin && !S.unsubUsers) {
      S.unsubUsers = S.api.watchUsers(function (users) { S.users = users; onUsersChanged(); },
        function (e) { toast(errMsg(e), true); });
    }
    if (!admin && S.unsubUsers) { S.unsubUsers(); S.unsubUsers = null; S.users = []; }
  }

  function startAuth() {
    S.api.onAuth(function (user) {
      stopWatches();
      S.authUser = user;
      S.profile = null;
      S.profileLoaded = false;
      S.editing = false;
      if (user) {
        S.unsubProfile = S.api.watchProfile(user.uid, function (p, err) {
          if (err) toast(errMsg(err), true);
          S.profile = p;
          S.profileLoaded = true;
          onProfile();
          render();
        });
      }
      render();
    });
  }

  /* ============================================================
   *  操作（クリック・入力）
   * ============================================================ */
  function setBusy(form, busy) {
    if (!form) return;
    Array.prototype.forEach.call(form.querySelectorAll('button, input, textarea, select'), function (el) { el.disabled = busy; });
  }

  function handleSubmit(e) {
    var f = e.target;
    if (!f || !f.id) return;
    e.preventDefault();
    if (f.id === 'login-form') {
      setBusy(f, true);
      S.authMsg = null;
      S.api.login($('#li-email').value, $('#li-pw').value).catch(function (err) {
        S.authMsg = { type: 'err', text: errMsg(err) };
        var email = $('#li-email') ? $('#li-email').value : '';
        render();
        if ($('#li-email')) { $('#li-email').value = email; $('#li-pw').focus(); }
      });
    } else if (f.id === 'register-form') {
      var name = $('#rg-name').value.trim(), email = $('#rg-email').value.trim();
      var pw = $('#rg-pw').value, pw2 = $('#rg-pw2').value;
      var showErr = function (text) {
        var box = f.parentNode.querySelector('.notice');
        if (!box) { box = document.createElement('div'); f.parentNode.insertBefore(box, f); }
        box.className = 'notice notice-err'; box.textContent = text;
      };
      if (!name) return showErr('お名前を入力してください。');
      if (pw.length < 6) return showErr('パスワードは6文字以上にしてください。');
      if (pw !== pw2) return showErr('確認用パスワードが一致しません。');
      setBusy(f, true);
      S.registering = true;
      S.api.register(name, email, pw).then(function () {
        S.registering = false;
        S.authMsg = null;
        render();
      }).catch(function (err) {
        S.registering = false;
        if (S.authUser) { toast(errMsg(err), true); render(); return; }
        setBusy(f, false);
        showErr(errMsg(err));
      });
    } else if (f.id === 'reset-form') {
      setBusy(f, true);
      S.api.resetPassword($('#rs-email').value).then(function () {
        S.authMsg = { type: 'ok', text: '再設定用のメールを送りました。メール内のリンクから新しいパスワードを設定してください（届かない場合は迷惑メールフォルダもご確認ください）。' };
        S.authView = 'login';
        render();
      }).catch(function (err) {
        S.authMsg = { type: 'err', text: errMsg(err) };
        render();
      });
    } else if (f.id === 'new-site-form') {
      var d;
      try { d = readSiteForm(); } catch (err) { return toast(err.message, true); }
      d.stage = d.stage || 'before';
      d.waste = 'incomplete';
      d.wasteNote = '';
      d.files = { docs: [], plans: [] };
      d.createdBy = myName();
      d.updatedBy = myName();
      setBusy(f, true);
      S.api.addSite(d).then(function (id) {
        toast('現場を登録しました');
        location.hash = '#/site/' + encodeURIComponent(id) + '/basic';
      }).catch(function (err) { setBusy(f, false); toast(errMsg(err), true); });
    } else if (f.id === 'edit-site-form') {
      var r = route();
      var d2;
      try { d2 = readSiteForm(); } catch (err) { return toast(err.message, true); }
      d2.updatedBy = myName();
      setBusy(f, true);
      S.api.updateSite(r.id, d2).then(function () {
        S.editing = false;
        toast('保存しました');
        render();
      }).catch(function (err) { setBusy(f, false); toast(errMsg(err), true); });
    }
  }

  function openFile(meta) {
    // ポップアップブロック対策：先に空のタブを開いてから行き先を入れる
    var w = window.open('', '_blank');
    if (w) { try { w.document.title = '読み込み中…'; w.document.body.innerHTML = '<p style="font-family:sans-serif;padding:20px">読み込み中…</p>'; } catch (e) { /* 無視 */ } }
    S.api.fileUrl(meta).then(function (url) {
      if (w) { w.location.href = url; } else { location.href = url; }
    }).catch(function (err) {
      if (w) w.close();
      toast(errMsg(err), true);
    });
  }

  function uploadFiles(siteId, cat, fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var key = siteId + '/' + cat;
    S.uploads[key] = S.uploads[key] || [];
    files.forEach(function (file) {
      if (file.size > MAX_MB * 1024 * 1024) {
        toast('「' + file.name + '」は' + MAX_MB + 'MBを超えているため登録できません。', true);
        return;
      }
      var u = { key: newId(), name: file.name, p: 0 };
      S.uploads[key].push(u);
      S.api.uploadFile(siteId, cat, file, function (p) {
        u.p = p;
        var bar = document.getElementById('prog-' + u.key);
        if (bar) bar.style.width = Math.round(p * 100) + '%';
      }, myName()).then(function () {
        toast('「' + file.name + '」を登録しました');
      }).catch(function (err) {
        toast('「' + file.name + '」：' + errMsg(err), true);
      }).then(function () {
        S.uploads[key] = S.uploads[key].filter(function (x) { return x !== u; });
        var r = route();
        if (r.name === 'site' && r.id === siteId && r.tab === cat) render();
      });
    });
    render();
  }

  function findFile(site, cat, fid) {
    var list = (site.files && site.files[cat]) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === fid) return list[i];
    return null;
  }

  function confirmUser(uid, msg, patch, okMsg) {
    var u = S.users.filter(function (x) { return x.uid === uid; })[0];
    if (!u) return;
    if (msg && !confirm(msg.replace('{name}', u.name || u.email))) return;
    S.api.setUser(uid, patch).then(function () { toast(okMsg); }).catch(function (e) { toast(errMsg(e), true); });
  }

  function handleClick(e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    var r = route();
    var site = r.name === 'site' ? findSite(r.id) : null;

    switch (act) {
      case 'go-register': S.authView = 'register'; S.authMsg = null; render(); break;
      case 'go-login': S.authView = 'login'; S.authMsg = null; render(); break;
      case 'go-reset': S.authView = 'reset'; S.authMsg = null; render(); break;
      case 'logout':
        S.authView = 'login'; S.authMsg = null;
        S.api.logout();
        location.hash = '';
        break;
      case 'stage-tab': location.hash = '#/list/' + el.getAttribute('data-v'); break;
      case 'edit-basic': S.editing = true; render(); var n = $('#f-name'); if (n) n.focus(); break;
      case 'cancel-edit': S.editing = false; render(); break;
      case 'delete-site':
        if (!site) return;
        if (!confirm('「' + site.name + '」を削除します。\n登録されたファイルもすべて削除され、元に戻せません。よろしいですか？')) return;
        el.disabled = true;
        S.api.deleteSite(site.id, site).then(function () {
          toast('削除しました');
          location.hash = '#/list/' + (site.stage || 'before');
        }).catch(function (err) { el.disabled = false; toast(errMsg(err), true); });
        break;
      case 'pick-file':
        var inp = $('#file-input');
        if (inp) inp.click();
        break;
      case 'open-file':
        if (!site) return;
        var m = findFile(site, el.getAttribute('data-cat'), el.getAttribute('data-fid'));
        if (m) openFile(m);
        break;
      case 'del-file':
        if (!site) return;
        var cat = el.getAttribute('data-cat');
        var mf = findFile(site, cat, el.getAttribute('data-fid'));
        if (!mf) return;
        if (!confirm('「' + mf.name + '」を削除します。元に戻せません。よろしいですか？')) return;
        el.disabled = true;
        S.api.deleteFile(site.id, cat, mf).then(function () { toast('削除しました'); })
          .catch(function (err) { el.disabled = false; toast(errMsg(err), true); });
        break;
      case 'set-waste':
        if (!site) return;
        var v = el.getAttribute('data-v');
        if ((site.waste === 'complete') === (v === 'complete')) return;
        S.api.updateSite(site.id, { waste: v, updatedBy: myName() })
          .then(function () { toast('産廃契約状況を「' + (v === 'complete' ? '完了' : '未完了') + '」にしました'); })
          .catch(function (err) { toast(errMsg(err), true); });
        break;
      case 'save-waste-note':
        if (!site) return;
        var note = $('#waste-note').value;
        el.disabled = true;
        S.api.updateSite(site.id, { wasteNote: note, updatedBy: myName() })
          .then(function () { toast('備考を保存しました'); render(); })
          .catch(function (err) { el.disabled = false; toast(errMsg(err), true); });
        break;
      case 'g-stage': S.ganttStage = el.getAttribute('data-v'); S.ganttScrollToday = true; setSeg('g-stage', S.ganttStage); updateGantt(); break;
      case 'g-scale': S.ganttScale = el.getAttribute('data-v'); S.ganttScrollToday = true; setSeg('g-scale', S.ganttScale); updateGantt(); break;
      case 'g-today': S.ganttScrollToday = true; updateGantt(); break;
      case 'print': window.print(); break;
      case 'approve': confirmUser(el.getAttribute('data-uid'), null, { status: 'approved' }, '承認しました'); break;
      case 'reject': confirmUser(el.getAttribute('data-uid'), '{name} さんの登録を却下します。よろしいですか？', { status: 'rejected' }, '却下しました'); break;
      case 'suspend': confirmUser(el.getAttribute('data-uid'), '{name} さんの利用を停止します。よろしいですか？', { status: 'suspended' }, '利用を停止しました'); break;
      case 'make-admin': confirmUser(el.getAttribute('data-uid'), '{name} さんを管理者にします（利用者の承認や現場の削除ができるようになります）。よろしいですか？', { role: 'admin' }, '管理者にしました'); break;
      case 'make-user': confirmUser(el.getAttribute('data-uid'), '{name} さんを一般利用者に戻します。よろしいですか？', { role: 'user' }, '一般利用者に戻しました'); break;
    }
  }

  function setSeg(id, v) {
    var box = document.getElementById(id);
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-v') === v);
    });
  }

  function handleChange(e) {
    var t = e.target;
    var r = route();
    if (t.id === 'file-input' && r.name === 'site') {
      uploadFiles(r.id, t.getAttribute('data-cat'), t.files);
      t.value = '';
    } else if (t.id === 'stage-sel' && r.name === 'site') {
      var v = t.value;
      S.api.updateSite(r.id, { stage: v, updatedBy: myName() })
        .then(function () { S.listStage = v; toast('「' + stageLabel(v) + '」に移動しました'); })
        .catch(function (err) { toast(errMsg(err), true); });
    }
  }

  function handleInput(e) {
    var t = e.target;
    if (e.isComposing) return;
    if (t.id === 'search') { S.search = t.value; updateList(); }
    if (t.id === 'g-search') { S.ganttSearch = t.value; updateGantt(); }
  }

  function bindGlobal() {
    var app = $('#app');
    app.addEventListener('submit', handleSubmit);
    app.addEventListener('click', handleClick);
    app.addEventListener('change', handleChange);
    app.addEventListener('input', handleInput);
    app.addEventListener('compositionend', handleInput);
    // ドラッグ＆ドロップでファイル登録
    app.addEventListener('dragover', function (e) {
      var z = e.target.closest && e.target.closest('#drop-zone');
      if (!z) return;
      e.preventDefault(); z.classList.add('over');
    });
    app.addEventListener('dragleave', function (e) {
      var z = e.target.closest && e.target.closest('#drop-zone');
      if (z) z.classList.remove('over');
    });
    app.addEventListener('drop', function (e) {
      var z = e.target.closest && e.target.closest('#drop-zone');
      if (!z) return;
      e.preventDefault(); z.classList.remove('over');
      var r = route(), inp = $('#file-input');
      if (r.name === 'site' && inp) uploadFiles(r.id, inp.getAttribute('data-cat'), e.dataTransfer.files);
    });
    // ドロップ場所の外にファイルを落としてもブラウザがファイルを開かないようにする
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    window.addEventListener('hashchange', function () {
      var r = route();
      S.editing = false;
      if (r.name === 'schedule') S.ganttScrollToday = true;
      render();
      window.scrollTo(0, 0);
    });
    window.addEventListener('beforeunload', function (e) {
      var busy = Object.keys(S.uploads).some(function (k) { return S.uploads[k].length; });
      if (busy) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /* ============================================================
   *  起動
   * ============================================================ */
  bindGlobal();
  (IS_DEMO ? createDemoBackend() : createFirebaseBackend(FBCFG)).then(function (api) {
    S.api = api;
    startAuth();
  }).catch(function (e) {
    $('#app').innerHTML = '<div class="auth-wrap"><div class="auth-card"><h1 class="auth-title">起動できませんでした</h1>' +
      '<p class="auth-sub">インターネット接続を確認して、ページを再読み込みしてください。</p>' +
      '<div class="notice notice-err">' + esc(e && e.message || e) + '</div></div></div>';
  });
})();
