const http = require("http");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 10000);
const MAX_PLAYERS_PER_ROOM = Number(process.env.MAX_PLAYERS_PER_ROOM || 10);
const TRANSFORM_RATE_LIMIT = Number(process.env.TRANSFORM_RATE_LIMIT || 45);
const ROOM_CODE_LENGTH = 4;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const rooms = new Map();
const clients = new Map();

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function makeRoomCode() {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error("Could not allocate room code");
}

function cleanName(value) {
  if (typeof value !== "string") return "GORILLA";
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9 _-]/g, "").trim().slice(0, 20);
  return cleaned || "GORILLA";
}

function cleanColor(value) {
  if (!value || typeof value !== "object") return { r: 0.4, g: 0.7, b: 1.0 };
  const clamp = n => Math.max(0, Math.min(1, Number(n) || 0));
  return { r: clamp(value.r), g: clamp(value.g), b: clamp(value.b) };
}

function validVec3(v) {
  return v && [v.x, v.y, v.z].every(Number.isFinite);
}

function validQuat(q) {
  return q && [q.x, q.y, q.z, q.w].every(Number.isFinite);
}

function validPose(p) {
  return p && validVec3(p.position) && validQuat(p.rotation);
}

function send(ws, type, data = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

function broadcast(room, type, data, except = null) {
  for (const id of room.players) {
    const c = clients.get(id);
    if (c && c.ws !== except) send(c.ws, type, data);
  }
}

function roomSnapshot(room) {
  return [...room.players]
    .map(id => clients.get(id))
    .filter(Boolean)
    .map(c => ({
      id: c.id,
      name: c.name,
      color: c.color,
      tagged: c.tagged
    }));
}

function leaveRoom(client) {
  if (!client.room) return;
  const room = rooms.get(client.room);
  const oldCode = client.room;
  client.room = null;

  if (!room) return;
  room.players.delete(client.id);
  broadcast(room, "player_left", { id: client.id });

  if (room.players.size === 0) rooms.delete(oldCode);
}

function joinRoom(client, code) {
  code = String(code || "").toUpperCase().trim();
  const room = rooms.get(code);
  if (!room) return { ok: false, error: "ROOM_NOT_FOUND" };
  if (room.players.size >= MAX_PLAYERS_PER_ROOM) return { ok: false, error: "ROOM_FULL" };

  leaveRoom(client);
  client.room = code;
  room.players.add(client.id);

  send(client.ws, "room_joined", {
    code,
    selfId: client.id,
    players: roomSnapshot(room),
    maxPlayers: MAX_PLAYERS_PER_ROOM
  });

  broadcast(room, "player_joined", {
    player: { id: client.id, name: client.name, color: client.color, tagged: client.tagged }
  }, client.ws);

  return { ok: true };
}

function createRoom(client) {
  const code = makeRoomCode();
  rooms.set(code, { code, players: new Set(), createdAt: Date.now() });
  joinRoom(client, code);
}

function joinRandom(client) {
  const candidates = [...rooms.values()].filter(r => r.players.size < MAX_PLAYERS_PER_ROOM);
  if (!candidates.length) return createRoom(client);
  const room = candidates[crypto.randomInt(candidates.length)];
  joinRoom(client, room.code);
}

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/status") {
    const playerCount = [...rooms.values()].reduce((n, r) => n + r.players.size, 0);
    return json(res, 200, {
      service: "Beta Tag Server",
      online: true,
      rooms: rooms.size,
      players: playerCount,
      maxPlayersPerRoom: MAX_PLAYERS_PER_ROOM,
      uptimeSeconds: Math.floor(process.uptime())
    });
  }
  json(res, 404, { error: "NOT_FOUND" });
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });

wss.on("connection", ws => {
  const client = {
    id: crypto.randomUUID(),
    ws,
    room: null,
    name: "GORILLA",
    color: { r: 0.4, g: 0.7, b: 1.0 },
    tagged: false,
    lastTransformAt: 0,
    alive: true
  };
  clients.set(client.id, client);

  send(ws, "hello", {
    id: client.id,
    protocol: 1,
    maxPlayersPerRoom: MAX_PLAYERS_PER_ROOM
  });

  ws.on("pong", () => { client.alive = true; });

  ws.on("message", raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, "error", { error: "INVALID_JSON" });
    }

    switch (msg.type) {
      case "profile":
        client.name = cleanName(msg.name);
        client.color = cleanColor(msg.color);
        if (client.room) {
          const room = rooms.get(client.room);
          if (room) broadcast(room, "profile", {
            id: client.id, name: client.name, color: client.color
          }, ws);
        }
        break;

      case "create_room":
        createRoom(client);
        break;

      case "join_room": {
        const result = joinRoom(client, msg.code);
        if (!result.ok) send(ws, "join_failed", { error: result.error });
        break;
      }

      case "join_random":
        joinRandom(client);
        break;

      case "leave_room":
        leaveRoom(client);
        send(ws, "room_left");
        break;

      case "transform": {
        if (!client.room) break;
        const now = Date.now();
        if (now - client.lastTransformAt < 1000 / TRANSFORM_RATE_LIMIT) break;
        if (!validPose(msg.head) || !validPose(msg.leftHand) || !validPose(msg.rightHand)) break;
        client.lastTransformAt = now;

        const room = rooms.get(client.room);
        if (room) broadcast(room, "transform", {
          id: client.id,
          seq: Number.isFinite(msg.seq) ? msg.seq : 0,
          head: msg.head,
          leftHand: msg.leftHand,
          rightHand: msg.rightHand
        }, ws);
        break;
      }

      case "tag_state": {
        if (!client.room || typeof msg.tagged !== "boolean") break;
        client.tagged = msg.tagged;
        const room = rooms.get(client.room);
        if (room) broadcast(room, "tag_state", {
          id: client.id,
          tagged: client.tagged
        });
        break;
      }

      case "ping":
        send(ws, "pong", { t: msg.t ?? Date.now() });
        break;

      default:
        send(ws, "error", { error: "UNKNOWN_MESSAGE" });
    }
  });

  ws.on("close", () => {
    leaveRoom(client);
    clients.delete(client.id);
  });

  ws.on("error", () => {});
});

const heartbeat = setInterval(() => {
  for (const client of clients.values()) {
    if (!client.alive) {
      client.ws.terminate();
      continue;
    }
    client.alive = false;
    if (client.ws.readyState === WebSocket.OPEN) client.ws.ping();
  }
}, 30000);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Beta Tag server listening on 0.0.0.0:${PORT}`);
});
