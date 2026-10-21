// DUSTBORNE 協力プレイ用サーバー
// 部屋（ルームコード）を作って最大5人まで入れる。ゲームの計算はホストのブラウザが行い、
// サーバーは部屋の管理とメッセージの中継だけを担当する。
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const MAX_MEMBERS = 5;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 見間違えやすい I/O/0/1 は使わない

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

/** @type {Map<string,{code:string,host:string,inGame:boolean,members:{id:string,name:string}[]}>} */
const rooms = new Map();

function newCode() {
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(c));
  return c;
}
function cleanName(n) {
  n = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
  return n || '名無し';
}
function roomInfo(r) {
  return { code: r.code, host: r.host, inGame: r.inGame, members: r.members.map(m => ({ id: m.id, name: m.name })) };
}

io.on('connection', socket => {
  let room = null;

  socket.on('create', (d, ack) => {
    if (typeof ack !== 'function') return;
    if (room) return ack({ ok: false, err: 'すでに部屋に入っています' });
    const code = newCode();
    room = { code, host: socket.id, inGame: false, members: [{ id: socket.id, name: cleanName(d && d.name) }] };
    rooms.set(code, room);
    socket.join(code);
    ack({ ok: true, id: socket.id, room: roomInfo(room) });
  });

  socket.on('join', (d, ack) => {
    if (typeof ack !== 'function') return;
    if (room) return ack({ ok: false, err: 'すでに部屋に入っています' });
    const code = String((d && d.code) || '').toUpperCase().trim();
    const r = rooms.get(code);
    if (!r) return ack({ ok: false, err: '部屋が見つかりません' });
    if (r.members.length >= MAX_MEMBERS) return ack({ ok: false, err: '満員です（最大' + MAX_MEMBERS + '人）' });
    room = r;
    r.members.push({ id: socket.id, name: cleanName(d && d.name) });
    socket.join(code);
    ack({ ok: true, id: socket.id, room: roomInfo(r) });
    socket.to(code).emit('room', roomInfo(r));
  });

  // ホストだけが出撃・ロビーへ戻すを決められる
  socket.on('start', () => {
    if (!room || room.host !== socket.id) return;
    room.inGame = true;
    io.to(room.code).emit('start', roomInfo(room));
  });
  socket.on('lobby', () => {
    if (!room || room.host !== socket.id) return;
    room.inGame = false;
    io.to(room.code).emit('room', roomInfo(room));
  });

  // 確実に届けたいメッセージ（敵の出現・撃破・ダメージなど）。to があればその人だけに送る
  socket.on('m', msg => {
    if (!room || !msg || typeof msg.t !== 'string') return;
    const out = { t: msg.t, d: msg.d, from: socket.id };
    if (msg.to) {
      if (room.members.some(m => m.id === msg.to)) io.to(msg.to).emit('m', out);
    } else socket.to(room.code).emit('m', out);
  });
  // 落としてもいい高頻度のメッセージ（位置・敵のスナップショット）
  socket.on('v', msg => {
    if (!room || !msg || typeof msg.t !== 'string') return;
    socket.to(room.code).volatile.emit('v', { t: msg.t, d: msg.d, from: socket.id });
  });

  function leave() {
    if (!room) return;
    const r = room;
    room = null;
    socket.leave(r.code);
    r.members = r.members.filter(m => m.id !== socket.id);
    if (!r.members.length) { rooms.delete(r.code); return; }
    if (r.host === socket.id) r.host = r.members[0].id; // ホストが抜けたら一番古い人に引き継ぐ
    io.to(r.code).emit('left', { id: socket.id });
    io.to(r.code).emit('room', roomInfo(r));
  }
  socket.on('leave', leave);
  socket.on('disconnect', leave);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('DUSTBORNE server: http://localhost:' + PORT));
