// relay-stub-server.js — 本地联机测试中转（模拟生产 relay-server 的最小子集）
// 用法：node relay-stub-server.js  （依赖 ../app/node_modules/ws，用 NODE_PATH 解析）
const PORT = 8124;
let ws;
try { ws = require('ws'); } catch (e) {
  try { ws = require('/Users/wulart/tianye/app/node_modules/ws'); } catch (e2) { console.error('need ws module'); process.exit(1); }
}
const { WebSocketServer } = ws;
let nextId = 0;
const clients = new Map();   // id -> ws
const wss = new WebSocketServer({ port: PORT }, () => console.log('relay-stub on :' + PORT));
const send = (c, m) => { try { if (c.readyState === 1) c.send(JSON.stringify(m)); } catch (e) {} };
wss.on('connection', (c) => {
  let id = null;
  c.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (m.type === 'hello') {
      id = nextId++;
      clients.set(id, c);
      send(c, { type: 'your-id', id });
      for (const [oid, oc] of clients) if (oid !== id) { send(oc, { type: 'player-join', id, name: m.name || ('P' + id) }); send(c, { type: 'player-join', id: oid, name: m.name2 || ('P' + oid) }); }
    } else if (m.type === 'list') {
      send(c, { type: 'player-list', players: [...clients.keys()].map((i) => ({ id: i, name: 'P' + i })) });
    } else if (m.type === 'relay') {
      const out = { ...m.data, id };
      for (const [oid, oc] of clients) if (oid !== id) send(oc, out);
    }
  });
  c.on('close', () => { if (id != null) { clients.delete(id); for (const [oid, oc] of clients) send(oc, { type: 'player-leave', id }); } });
});
