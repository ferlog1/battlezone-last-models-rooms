const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { WebSocketServer } = require('ws');
const os = require('os');



process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
});

const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  if (filePath === '/favicon.ico') filePath = '/icon.png';
  
  const ext = path.extname(filePath).toLowerCase();
  
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.obj': 'text/plain',
    '.mtl': 'text/plain',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ico': 'image/x-icon',
    '.glb': 'model/gltf-binary'
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';
  const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
  const absolutePath = path.join(__dirname, safePath);

  fs.readFile(absolutePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('404 Not Found');
      } else {
        res.writeHead(500);
        res.end('500 Internal Server Error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, ext === '.html' ? 'utf-8' : undefined);
    }
  });
});

const wss = new WebSocketServer({ server });

// rooms[roomId] = { players: {}, nextId: 1 }
const rooms = {};
const MAX_PLAYERS = 32; // per room
const MAX_ROOM_ID_LEN = 20;

function sanitizeRoomId(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .substring(0, MAX_ROOM_ID_LEN) || 'LOBBY';
}

function broadcastToRoom(roomId, data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1 && client._room === roomId && client !== excludeWs) {
      client.send(msg);
    }
  });
}

function cleanupRoomIfEmpty(roomId) {
  const room = rooms[roomId];
  if (room && Object.keys(room.players).length === 0) {
    delete rooms[roomId];
  }
}

const WEAPONS_VALIDATION = {
  'АКС-74У': { maxDmg: 35, maxDist: 90 },
  'M4': { maxDmg: 35, maxDist: 90 },
  'СВД': { maxDmg: 100, maxDist: 150 },
  'ДРОБОВИК': { maxDmg: 30, maxDist: 30 },
  'ПМ': { maxDmg: 45, maxDist: 60 },
  'НОЖ': { maxDmg: 80, maxDist: 6.0 }
};


function heartbeat() {
  this.isAlive = true;
}
const interval = setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    if (ws.isAlive === false) {
      const room = ws._room && rooms[ws._room];
      if (room && ws._playerId && room.players[ws._playerId]) {
        delete room.players[ws._playerId];
        broadcastToRoom(ws._room, { type: 'playerLeft', id: ws._playerId });
        cleanupRoomIfEmpty(ws._room);
      }
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on('close', function close() {
  clearInterval(interval);
});

wss.on('connection', (ws, req) => {
  const query = url.parse(req.url, true).query || {};
  const roomId = sanitizeRoomId(query.room);
  const action = query.action === 'create' ? 'create' : 'join';

  const roomExists = !!rooms[roomId];
  if (action === 'create' && roomExists) {
    ws.send(JSON.stringify({ type: 'roomError', reason: 'exists', room: roomId }));
    ws.close(4001, 'Room already exists');
    return;
  }
  if (action === 'join' && !roomExists) {
    ws.send(JSON.stringify({ type: 'roomError', reason: 'notfound', room: roomId }));
    ws.close(4004, 'Room not found');
    return;
  }

  const room = rooms[roomId] || (rooms[roomId] = { players: {}, nextId: 1 });

  if (Object.keys(room.players).length >= MAX_PLAYERS) {
    ws.send(JSON.stringify({ type: 'roomError', reason: 'full', room: roomId }));
    ws.close(1013, 'Room full');
    return;
  }

  ws.isAlive = true;
  ws.on('pong', heartbeat);

  const id = room.nextId++;
  ws._playerId = id;
  ws._room = roomId;
  room.players[id] = { id, x: 0, y: 0, z: 0, yaw: 0, team: 'red', hp: 100, weapon: 0, alive: true, name: 'Player ' + id, kills: 0, deaths: 0 };

  const safePlayers = {};
  for (const pid in room.players) {
    safePlayers[pid] = { id: room.players[pid].id, name: room.players[pid].name, team: room.players[pid].team };
  }
  ws.send(JSON.stringify({ type: 'init', id, room: roomId, players: safePlayers }));

  let msgCount = 0;
  let lastSec = Date.now();
  setInterval(() => { msgCount = 0; lastSec = Date.now(); }, 1000);

  ws.on('message', (message) => {
    if (++msgCount > 200) { ws.close(1009, 'Rate limited'); return; }
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'join': {
          const allowedTeams = ['red', 'blue'];
          room.players[id].team = allowedTeams.includes(data.team) ? data.team : 'red';
          room.players[id].hp = 100;
          room.players[id].alive = true;
          room.players[id].name = (typeof data.name === 'string' ? data.name.substring(0, 24) : '') || ('Player ' + id);
          broadcastToRoom(roomId, { type: 'playerJoined', player: { id: room.players[id].id, name: room.players[id].name, team: room.players[id].team } });
          break;
        }
        case 'state':
          if (room.players[id]) {
            room.players[id].x = Math.max(-54, Math.min(54, Number(data.x) || 0));
            room.players[id].y = Number(data.y) || 0;
            room.players[id].z = Math.max(-54, Math.min(54, Number(data.z) || 0));
            room.players[id].yaw = Number(data.yaw) || 0;
            room.players[id].hp = Math.max(0, Number(data.hp) || 0);
            room.players[id].weapon = Number.isInteger(data.weapon) && data.weapon >= 0 && data.weapon <= 4 ? data.weapon : 0;
            room.players[id].godmode = !!data.godmode;
          }
          break;
        case 'shoot':
          broadcastToRoom(roomId, { type: 'playerShot', id, weapon: data.weapon }, ws);
          break;
        case 'hit':
          if (room.players[data.targetId] && room.players[id] && data.targetId !== id) {
            const target = room.players[data.targetId];
            const shooter = room.players[id];

            if (target.godmode || !target.alive) break;

            // Anti-cheat: Validate distance and damage
            let maxDmg = 100;
            let maxDist = 150;
            
            if (data.weapon && WEAPONS_VALIDATION[data.weapon]) {
              maxDmg = WEAPONS_VALIDATION[data.weapon].maxDmg;
              maxDist = WEAPONS_VALIDATION[data.weapon].maxDist;
            }

            const dx = shooter.x - target.x;
            const dy = shooter.y - target.y;
            const dz = shooter.z - target.z;
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            
            // Allow 8 units of latency/lag compensation tolerance
            if (dist > maxDist + 8) {
              console.log(`[AntiCheat] Blocked hit from ${shooter.name} to ${target.name} (weapon: ${data.weapon}, dist: ${dist.toFixed(1)}, max allowed: ${maxDist})`);
              break; 
            }

            const dmg = Math.min(Math.max(0, Number(data.damage) || 0), maxDmg);
            target.hp -= dmg;
            
            if (target.hp <= 0) {
              target.hp = 0;
              target.alive = false;
              target.deaths = (target.deaths || 0) + 1;
              shooter.kills = (shooter.kills || 0) + 1;
              broadcastToRoom(roomId, { type: 'kill', killer: id, victim: data.targetId, isJump: data.isJump, isNoscope: data.isNoscope, weaponName: data.weapon });
            } else {
              broadcastToRoom(roomId, { type: 'playerHit', id: data.targetId, hp: target.hp });
            }
          }
          break;
        case 'chat':
          if (data.msg && data.msg.trim().length > 0) {
            broadcastToRoom(roomId, { type: 'chat', id, msg: data.msg.substring(0, 100) });
          }
          break;
        case 'respawn':
          if (room.players[id] && !room.players[id].alive) {
            const sp = room.players[id].team === 'red' ? {x:-48,z:-48} : {x:48,z:48};
            room.players[id].x = sp.x + (Math.random() - 0.5) * 6;
            room.players[id].z = sp.z + (Math.random() - 0.5) * 6;
            room.players[id].y = 0;
            room.players[id].hp = 100;
            room.players[id].alive = true;
          }
          break;
        case 'botSync':
          // Host sends bot data, forward to others in the same room
          broadcastToRoom(roomId, { type: 'botSync', bots: data.bots }, ws);
          break;
      }
    } catch (e) {
      console.error(e);
    }
  });

  ws.on('close', () => {
    delete room.players[id];
    broadcastToRoom(roomId, { type: 'playerLeft', id });
    cleanupRoomIfEmpty(roomId);
  });

  ws.on('error', (e) => {
    console.error('Socket error for player', id, ':', e.message);
  });
});

setInterval(() => {
  for (const roomId in rooms) {
    broadcastToRoom(roomId, { type: 'sync', players: rooms[roomId].players });
  }
}, 50); // 20 tick rate

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
