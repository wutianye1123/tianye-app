// relay-store.js — JSON 持久化：用户档案 / 好友关系 / 好友请求
// 单进程 Node，用 promise 链串行化写盘，避免并发写覆盖。
// presence（在线状态）与 rooms 不在这里持久化，仍在 relay-server.js 内存里。
const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, 'relay-store.json');
let writeChain = Promise.resolve();

// 内存镜像，每次修改后落盘
let db = { profiles: {}, friendships: [], requests: [] };

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    db.profiles = parsed.profiles || {};
    db.friendships = parsed.friendships || [];
    db.requests = parsed.requests || [];
  } catch (e) {
    /* 首次运行或文件损坏：用空库 */
  }
}

function persist() {
  writeChain = writeChain.then(() =>
    fs.promises.writeFile(STORE_FILE, JSON.stringify(db, null, 2), 'utf8')
  ).catch(() => {});
}

load();

// ---- profiles: { [code]: { name, createdAt } } ----
function getProfile(code) {
  return db.profiles[code] || null;
}
function setProfile(code, name) {
  const existing = db.profiles[code];
  db.profiles[code] = { name, createdAt: (existing && existing.createdAt) || Date.now() };
  persist();
  return db.profiles[code];
}
// 按昵称查找已占用的好友码（"一个名字只能注册一个账号"唯一性校验用）
function findCodeByName(name) {
  for (const code in db.profiles) {
    if (db.profiles[code].name === name) return code;
  }
  return null;
}
function updateName(code, name) {
  if (!db.profiles[code]) return false;
  db.profiles[code].name = name;
  persist();
  return true;
}

// ---- friendships: [ {a, b, since} ] 规范化为 a < b 以去重 ----
function canon(a, b) { return a < b ? [a, b] : [b, a]; }
function areFriends(c1, c2) {
  const [a, b] = canon(c1, c2);
  return db.friendships.some(f => f.a === a && f.b === b);
}
function addFriend(c1, c2) {
  if (areFriends(c1, c2)) return;
  const [a, b] = canon(c1, c2);
  db.friendships.push({ a, b, since: Date.now() });
  persist();
}
function removeFriend(c1, c2) {
  const [a, b] = canon(c1, c2);
  db.friendships = db.friendships.filter(f => !(f.a === a && f.b === b));
  persist();
}
function listFriends(code) {
  return db.friendships
    .filter(f => f.a === code || f.b === code)
    .map(f => (f.a === code ? f.b : f.a));
}

// ---- requests: [ {from, to, ts} ] 仅保留未处理 ----
// addRequest 返回 {ok} / {ok, mutual} / {ok:false, msg}
function addRequest(from, to) {
  if (from === to) return { ok: false, msg: '不能加自己为好友' };
  if (areFriends(from, to)) return { ok: false, msg: '已经是好友了' };
  if (db.requests.some(r => r.from === from && r.to === to)) {
    return { ok: false, msg: '请求已发送，等待对方同意' };
  }
  // 反向请求已存在：自动成为好友
  if (db.requests.some(r => r.from === to && r.to === from)) {
    addFriend(from, to);
    db.requests = db.requests.filter(r => !(r.from === to && r.to === from));
    persist();
    return { ok: true, mutual: true };
  }
  db.requests.push({ from, to, ts: Date.now() });
  persist();
  return { ok: true };
}
function getPendingRequests(code) {
  return db.requests.filter(r => r.to === code).map(r => ({ from: r.from, ts: r.ts }));
}
function acceptRequest(from, to) {
  db.requests = db.requests.filter(r => !(r.from === from && r.to === to));
  addFriend(from, to);
}
function rejectRequest(from, to) {
  db.requests = db.requests.filter(r => !(r.from === from && r.to === to));
  persist();
}

// 删除账号：清除档案、所有好友关系、所有相关请求
function deleteAccount(code) {
  delete db.profiles[code];
  db.friendships = db.friendships.filter(f => f.a !== code && f.b !== code);
  db.requests = db.requests.filter(r => r.from !== code && r.to !== code);
  persist();
}

// 注册或认领（给老账号补设密码）：昵称唯一。profiles[code] = {name, passHash, salt, createdAt}
// 返回 {ok, code} 或 {ok:false, msg}
function registerAccount(name, passHash, salt) {
  const existing = findCodeByName(name);
  if (existing) {
    if (db.profiles[existing].passHash) return { ok: false, msg: '该昵称已注册' };
    db.profiles[existing].passHash = passHash;
    db.profiles[existing].salt = salt;
    persist();
    return { ok: true, code: existing };
  }
  let code;
  do { code = String(10000000 + Math.floor(Math.random() * 90000000)); } while (db.profiles[code]);
  db.profiles[code] = { name, passHash, salt, createdAt: Date.now() };
  persist();
  return { ok: true, code };
}

module.exports = {
  getProfile, setProfile, updateName, findCodeByName, deleteAccount, registerAccount,
  areFriends, addFriend, removeFriend, listFriends,
  addRequest, getPendingRequests, acceptRequest, rejectRequest,
};
