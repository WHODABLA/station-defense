// Station Defense - authoritative multiplayer server. Rooms of up to 8 pilots, bots fill empty seats.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const W = 2000, H = 2000, CX = 1000, CY = 1000, DT = 1 / 30, MAXP = 8, SKINS = 5, SEATS = 4;
const rnd = Math.random, cl = v => Math.max(10, Math.min(W - 10, v));
const num = v => Math.max(-1, Math.min(1, Number.isFinite(+v) ? +v : 0));
const BOTS = ['Nova', 'Rex', 'Zed', 'Kira'];
const page = fs.readFileSync(path.join(__dirname, 'game.html'));
let nid = 1, pubN = 0;
const rooms = new Map();

const server = http.createServer((q, s) => {
  if (q.url === '/health') { s.writeHead(200); return s.end('ok'); }
  s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  s.end(page);
});

const mk = (name, bot, skin) => ({ id: nid++, name, bot, skin, x: CX, y: CY, hp: 100, dead: 0, cool: 0, scrap: 0, lvl: 0,
  score: 0, dx: 0, dy: 0, ang: 0, fire: 0, side: rnd() < .5 ? 1 : -1, tb: 0, rb: 0, ws: null });
const humans = r => r.units.filter(u => !u.bot);
function spawn(u) { const a = rnd() * 6.283; u.x = CX + Math.cos(a) * 120; u.y = CY + Math.sin(a) * 120; u.hp = 100; u.dead = 0; }

function newRoom(code, pub) { const r = { code, pub, units: [] }; reset(r); rooms.set(code, r); return r; }
function reset(r) {
  r.core = { hp: 1000, max: 1000 }; r.wave = 0; r.aliens = []; r.bullets = []; r.scraps = []; r.turrets = [];
  r.over = false; r.why = ''; r.overT = 0; r.toSpawn = 0; r.spawnT = 0; r.delay = 4;
  for (const u of r.units) { u.scrap = 0; u.lvl = 0; u.score = 0; u.tb = 0; u.rb = 0; spawn(u); }
  fill(r);
}
function fill(r) {  // bots take whatever seats the humans leave empty
  const want = Math.max(0, SEATS - humans(r).length);
  r.units = humans(r).concat(r.units.filter(u => u.bot).slice(0, want));
  const used = new Set(r.units.map(u => u.skin));
  while (r.units.filter(u => u.bot).length < want) {
    let skin = [...Array(SKINS).keys()].find(i => !used.has(i));
    if (skin === undefined) skin = rnd() * SKINS | 0;
    used.add(skin);
    const b = mk(BOTS.find(n => !r.units.some(u => u.name === n)) || 'Bot', 1, skin);
    spawn(b); r.units.push(b);
  }
}

function spawnAlien(r) {
  const e = rnd() * 4 | 0, t = rnd(), x = e == 0 ? 0 : e == 1 ? W : t * W, y = e == 2 ? 0 : e == 3 ? H : t * H;
  const big = r.wave >= 3 && rnd() < .15, hp = big ? 60 + r.wave * 6 : 20 + r.wave * 2;
  r.aliens.push({ id: nid++, x, y, hp, max: hp, big, speed: big ? 55 : 75 + Math.min(r.wave * 3, 50) });
}
function ai(r, u) {
  u.lvl = Math.min(5, r.wave / 3 | 0);
  let t = null, b = 380;
  for (const a of r.aliens) { const d = Math.hypot(a.x - u.x, a.y - u.y); if (d < b) { b = d; t = a; } }
  if (t) {
    u.ang = Math.atan2(t.y - u.y, t.x - u.x); u.fire = b < 320 ? 1 : 0;
    const f = b > 170 ? 1 : b < 110 ? -1 : 0, s = .4 * u.side;
    u.dx = Math.cos(u.ang) * f + Math.cos(u.ang + 1.57) * s; u.dy = Math.sin(u.ang) * f + Math.sin(u.ang + 1.57) * s;
  } else {
    u.fire = 0; const dx = CX - u.x, dy = CY - u.y, d = Math.hypot(dx, dy);
    if (d > 140) { u.dx = dx / d; u.dy = dy / d; } else { u.dx = 0; u.dy = 0; }
  }
}

function step(r, dt) {
  if (r.over) { if ((r.overT -= dt) <= 0) reset(r); return; }
  for (const u of r.units) {
    if (u.dead) continue;
    if (u.bot) ai(r, u);
    const l = Math.max(1, Math.hypot(u.dx, u.dy)), s = u.bot ? 190 : 230;
    u.x = cl(u.x + u.dx / l * s * dt); u.y = cl(u.y + u.dy / l * s * dt);
    u.cool -= dt;
    if (u.fire && u.cool <= 0) {
      u.cool = (u.bot ? .4 : .18) * (1 - .1 * u.lvl);
      r.bullets.push({ x: u.x, y: u.y, vx: Math.cos(u.ang) * 700, vy: Math.sin(u.ang) * 700, life: 1, dmg: 10 + 4 * u.lvl, own: u });
    }
  }
  if (r.toSpawn > 0) { if ((r.spawnT -= dt) <= 0) { spawnAlien(r); r.toSpawn--; r.spawnT = Math.max(.25, 1 - r.wave * .04); } }
  else if (!r.aliens.length && (r.delay -= dt) <= 0) {
    r.wave++; r.toSpawn = Math.round((8 + r.wave * 3) * 1.3 * (1 + .35 * (Math.max(1, humans(r).length) - 1))); r.spawnT = 0; r.delay = 5;
  }
  for (const t of r.turrets) {
    t.cool -= dt; t.rec = Math.max(0, t.rec - dt); if (t.cool > 0) continue;
    let g = null, b = 320;
    for (const a of r.aliens) { const d = Math.hypot(a.x - t.x, a.y - t.y); if (d < b) { b = d; g = a; } }
    if (g) { t.ang = Math.atan2(g.y - t.y, g.x - t.x); t.cool = .5; t.rec = .12;
      r.bullets.push({ x: t.x, y: t.y, vx: Math.cos(t.ang) * 700, vy: Math.sin(t.ang) * 700, life: .6, dmg: 8, own: null }); }
  }
  for (const b of r.bullets) {
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    for (const a of r.aliens) if (a.hp > 0 && Math.hypot(a.x - b.x, a.y - b.y) < (a.big ? 28 : 16)) {
      a.hp -= b.dmg; b.life = 0; if (a.hp <= 0 && b.own) b.own.score += a.big ? 5 : 1; break;
    }
  }
  r.bullets = r.bullets.filter(b => b.life > 0);
  for (const a of r.aliens) if (a.hp <= 0 && (a.big || rnd() < .35)) r.scraps.push({ x: a.x, y: a.y, v: a.big ? 15 : 6, life: 12 });
  r.aliens = r.aliens.filter(a => a.hp > 0);
  for (const s of r.scraps) s.life -= dt;
  for (const u of r.units) if (!u.bot && !u.dead)
    for (const s of r.scraps) if (s.life > 0 && Math.hypot(u.x - s.x, u.y - s.y) < 26) { u.scrap += s.v; s.life = 0; }
  r.scraps = r.scraps.filter(s => s.life > 0);
  for (const a of r.aliens) {
    let tx = CX, ty = CY, tg = null, best = 220;
    for (const u of r.units) { if (u.dead) continue; const d = Math.hypot(u.x - a.x, u.y - a.y); if (d < best) { best = d; tg = u; tx = u.x; ty = u.y; } }
    const dx = tx - a.x, dy = ty - a.y, d = Math.hypot(dx, dy) || 1;
    if (tg || d > 50) { a.x += dx / d * a.speed * dt; a.y += dy / d * a.speed * dt; }
    for (const t of r.turrets) if (Math.hypot(t.x - a.x, t.y - a.y) < 26) t.hp -= (a.big ? 20 : 10) * dt;
    if (tg && d < 24) { tg.hp -= (a.big ? 25 : 12) * dt * 2; if (tg.hp <= 0) { tg.hp = 0; tg.dead = 1; } }
    else if (!tg && Math.hypot(CX - a.x, CY - a.y) < 60) r.core.hp -= (a.big ? 12 : 6) * dt;
  }
  r.turrets = r.turrets.filter(t => t.hp > 0);
  const hs = humans(r);
  if (r.core.hp <= 0) { r.core.hp = 0; r.over = true; r.why = 'core'; r.overT = 8; }
  else if (hs.length && hs.every(u => u.dead)) { r.over = true; r.why = 'down'; r.overT = 8; }
}

function act(r, u, a) {
  if (r.over || u.dead) return;
  const cost = { turret: 60 + 30 * u.tb, repair: 70 + 15 * u.rb, upgrade: 50 * (u.lvl + 1) }[a];
  if (!cost || u.scrap < cost) return;
  if (a === 'turret') {
    if (r.turrets.length >= 12) return;
    r.turrets.push({ id: nid++, x: cl(u.x + Math.cos(u.ang) * 45), y: cl(u.y + Math.sin(u.ang) * 45), hp: 60, cool: 0, ang: 0, rec: 0 }); u.tb++;
  } else if (a === 'repair') {
    if (r.core.hp >= r.core.max) return; r.core.hp = Math.min(r.core.max, r.core.hp + 150); u.rb++;
  } else { if (u.lvl >= 5) return; u.lvl++; }
  u.scrap -= cost;
}

const R = Math.round;
function snap(r) {
  return JSON.stringify({ t: 's', w: r.wave, ov: r.over ? Math.ceil(r.overT) : 0, why: r.why, c: R(r.core.hp), rm: r.code,
    nx: !r.toSpawn && !r.aliens.length ? Math.ceil(r.delay) : 0,
    u: r.units.map(u => [u.id, R(u.x), R(u.y), R(u.hp), u.dead, u.name, u.score, +u.ang.toFixed(2), u.scrap, u.lvl, u.skin, u.bot ? 1 : 0, u.tb, u.rb]),
    a: r.aliens.map(a => [a.id, R(a.x), R(a.y), R(a.hp), a.max, a.big ? 1 : 0]),
    tu: r.turrets.map(t => [t.id, R(t.x), R(t.y), R(t.hp), +t.ang.toFixed(2), +t.rec.toFixed(2)]),
    b: r.bullets.map(b => [R(b.x), R(b.y)]), s: r.scraps.map(s => [R(s.x), R(s.y)]) });
}

const wss = new WebSocketServer({ server, maxPayload: 512 });
wss.on('connection', ws => {
  let r = null, u = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join' && !u) {
      const name = String(m.name || '').replace(/[<>&"']/g, '').trim().slice(0, 12) || 'Pilot' + (nid % 100);
      const skin = Number.isInteger(m.skin) && m.skin >= 0 && m.skin < SKINS ? m.skin : 0;
      const code = String(m.room || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12);
      r = code ? rooms.get(code) || newRoom(code, false)
               : [...rooms.values()].find(x => x.pub && humans(x).length < MAXP) || newRoom('P' + (++pubN), true);
      if (humans(r).length >= MAXP) { ws.send(JSON.stringify({ t: 'err', m: 'That room is full.' })); r = null; return ws.close(); }
      u = mk(name, 0, skin); u.ws = ws; spawn(u); r.units.push(u); fill(r);
      ws.send(JSON.stringify({ t: 'init', id: u.id }));
    } else if (u && m.t === 'in') {
      u.dx = num(m.dx); u.dy = num(m.dy); u.ang = Number.isFinite(m.a) ? m.a : 0; u.fire = m.f ? 1 : 0;
    } else if (u && m.t === 'act') act(r, u, m.a);
  });
  ws.on('close', () => {
    if (!u || !r) return;
    r.units = r.units.filter(x => x !== u);
    if (!humans(r).length) rooms.delete(r.code); else fill(r);
  });
});

setInterval(() => {
  for (const r of rooms.values()) {
    step(r, DT);
    const s = snap(r);
    for (const u of r.units) if (u.ws && u.ws.readyState === 1) u.ws.send(s);
  }
}, 1000 / 30);

server.listen(PORT, () => console.log('Station Defense multiplayer on port ' + PORT));
