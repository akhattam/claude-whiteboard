import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.WHITEBOARD_PORT || 3737);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(ROOT, "..", "dist");
const DATA_DIR = path.join(os.homedir(), ".claude-whiteboard");
const MAX_BODY = 20 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".json": "application/json",
  ".map": "application/json",
  ".ico": "image/x-icon",
};

fs.mkdirSync(DATA_DIR, { recursive: true });

// Live browser connections (SSE). Draws posted while no board is open are
// queued and delivered when a tab connects.
const sseClients = new Set();
const pendingDraws = [];
const MAX_PENDING_DRAWS = 50;

function broadcastDraw(draw) {
  const frame = `event: draw\ndata: ${JSON.stringify(draw)}\n\n`;
  for (const client of sseClients) client.write(frame);
}

setInterval(() => {
  for (const client of sseClients) client.write(": ping\n\n");
}, 25000).unref();

// Ask Claude button: an ask is delivered to exactly one /ask/wait waiter
// (pending -> claimed), then cleared when Claude posts /respond. Deliver-once
// keeps a re-armed waiter from being re-woken by an ask it already handled.
const ASK_WAIT_HOLD_MS = 55000;
// Button pokes go stale fast; chat messages must survive until Claude re-arms
// (a claimed response can easily take minutes)
const PENDING_ASK_TTL_MS = 120000;
const PENDING_MESSAGE_TTL_MS = 30 * 60000;
const WAITER_GRACE_MS = 3000;
let askCounter = 0;
let pendingAsk = null;
let claimedAsk = null;
const askWaiters = new Set();
let lastWaiterSeenAt = 0;

function isListening() {
  return (
    askWaiters.size > 0 ||
    claimedAsk !== null ||
    Date.now() - lastWaiterSeenAt < WAITER_GRACE_MS
  );
}

function takePendingAsk() {
  if (pendingAsk) {
    const ttl =
      pendingAsk.kind === "message"
        ? PENDING_MESSAGE_TTL_MS
        : PENDING_ASK_TTL_MS;
    if (Date.now() - pendingAsk.askedAt > ttl) pendingAsk = null;
  }
  return pendingAsk;
}

function deliverAskToWaiter() {
  if (!takePendingAsk()) return;
  const waiter = askWaiters.values().next().value;
  if (!waiter) return;
  askWaiters.delete(waiter);
  clearTimeout(waiter.timer);
  claimedAsk = pendingAsk;
  pendingAsk = null;
  json(waiter.res, 200, { ask: claimedAsk });
}

// Chat transcript for the board's side panel; survives reloads and restarts
const CHAT_PATH = path.join(DATA_DIR, "chat.json");
const LEGACY_RESPONSES_PATH = path.join(DATA_DIR, "responses.json");
const MAX_CHAT = 200;
let chat = [];
try {
  chat = JSON.parse(fs.readFileSync(CHAT_PATH, "utf8"));
} catch {
  // one-time migration from the v3 responses-only store (left on disk)
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_RESPONSES_PATH, "utf8"));
    chat = legacy.map((r, i) => ({
      id: i + 1,
      role: "claude",
      text: r.markdown,
      at: r.at,
    }));
  } catch {
    chat = [];
  }
}
let chatCounter = chat.reduce((max, e) => Math.max(max, e.id ?? 0), 0);

function appendChat(role, text, extra = {}) {
  const entry = {
    id: ++chatCounter,
    role,
    text,
    at: new Date().toISOString(),
    ...extra,
  };
  chat.push(entry);
  if (chat.length > MAX_CHAT) chat.splice(0, chat.length - MAX_CHAT);
  writeAtomic(CHAT_PATH, JSON.stringify(chat, null, 2));
  const frame = `event: chat\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const client of sseClients) client.write(frame);
  return entry;
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, res, maxBytes, onBody) {
  const chunks = [];
  let size = 0;
  let rejected = false;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      rejected = true;
      json(res, 413, { error: "body too large" });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (rejected) return;
    try {
      onBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (err) {
      json(res, 400, { error: String(err) });
    }
  });
}

// tmp-then-rename so readers (Claude's Read tool) never see a partial file
function writeAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      pid: process.pid,
      clients: sseClients.size,
      listening: isListening(),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ask") {
    readJsonBody(req, res, 64 * 1024, (payload) => {
      if (!isListening()) {
        // Don't record it: an unheard ask must not wake a future session
        json(res, 200, { ok: false, listening: false });
        return;
      }
      if (takePendingAsk()) {
        pendingAsk.askedAt = Date.now();
        json(res, 200, { ok: true, coalesced: true });
        return;
      }
      // Thread marker so the panel shows why Claude responded; skip when the
      // tail is already an unanswered board-look (double-press spam)
      const tail = chat[chat.length - 1];
      if (!(tail && tail.role === "user" && tail.kind === "board-look")) {
        appendChat("user", "👁 Asked Claude to look at the board", {
          kind: "board-look",
        });
      }
      pendingAsk = {
        id: ++askCounter,
        kind: "ask",
        askedAt: Date.now(),
        elementCount: payload?.elementCount ?? null,
      };
      const busy = claimedAsk !== null;
      deliverAskToWaiter();
      json(res, 200, busy ? { ok: true, busy: true } : { ok: true });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/message") {
    readJsonBody(req, res, 256 * 1024, ({ text }) => {
      if (typeof text !== "string" || !text.trim()) {
        json(res, 400, { error: "expected {text} non-empty string" });
        return;
      }
      const entry = appendChat("user", text.trim());
      if (!isListening()) {
        // Transcript keeps it; a later session answers unanswered messages
        json(res, 200, { ok: false, listening: false, entry });
        return;
      }
      if (takePendingAsk()) {
        pendingAsk.askedAt = Date.now();
        // Upgrade so the generous message TTL applies
        pendingAsk.kind = "message";
        pendingAsk.text = entry.text;
        json(res, 200, { ok: true, coalesced: true, entry });
        return;
      }
      pendingAsk = {
        id: ++askCounter,
        kind: "message",
        askedAt: Date.now(),
        text: entry.text,
      };
      const busy = claimedAsk !== null;
      deliverAskToWaiter();
      json(res, 200, busy ? { ok: true, busy: true, entry } : { ok: true, entry });
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ask/wait") {
    lastWaiterSeenAt = Date.now();
    if (takePendingAsk()) {
      claimedAsk = pendingAsk;
      pendingAsk = null;
      json(res, 200, { ask: claimedAsk });
      return;
    }
    const waiter = { res, timer: null };
    waiter.timer = setTimeout(() => {
      askWaiters.delete(waiter);
      lastWaiterSeenAt = Date.now();
      res.writeHead(204);
      res.end();
    }, ASK_WAIT_HOLD_MS);
    askWaiters.add(waiter);
    req.on("close", () => {
      askWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      lastWaiterSeenAt = Date.now();
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/respond") {
    readJsonBody(req, res, 1024 * 1024, ({ markdown }) => {
      if (typeof markdown !== "string" || !markdown.trim()) {
        json(res, 400, { error: "expected {markdown} non-empty string" });
        return;
      }
      const entry = appendChat("claude", markdown);
      claimedAsk = null;
      json(res, 200, { ok: true, clients: sseClients.size, id: entry.id });
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/chat") {
    json(res, 200, chat);
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    sseClients.add(res);
    for (const draw of pendingDraws.splice(0)) {
      res.write(`event: draw\ndata: ${JSON.stringify(draw)}\n\n`);
    }
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "POST" && url.pathname === "/draw") {
    readJsonBody(req, res, 1024 * 1024, (payload) => {
      if (!Array.isArray(payload.elements) || payload.elements.length === 0) {
        json(res, 400, { error: "expected {elements: [...skeletons]}" });
        return;
      }
      const draw = { elements: payload.elements };
      if (sseClients.size === 0) {
        pendingDraws.push(draw);
        if (pendingDraws.length > MAX_PENDING_DRAWS) pendingDraws.shift();
        json(res, 202, {
          ok: true,
          queued: true,
          note: "no board open in a browser; elements will be drawn when one connects",
        });
      } else {
        broadcastDraw(draw);
        json(res, 200, { ok: true, clients: sseClients.size });
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/scene") {
    const scenePath = path.join(DATA_DIR, "board.excalidraw");
    if (!fs.existsSync(scenePath)) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    fs.createReadStream(scenePath).pipe(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/snapshot") {
    readJsonBody(req, res, MAX_BODY, ({ png, scene, elementCount, empty }) => {
      if (typeof png !== "string" || typeof scene !== "string") {
        json(res, 400, { error: "expected {png, scene} strings" });
        return;
      }
      writeAtomic(path.join(DATA_DIR, "board.png"), Buffer.from(png, "base64"));
      writeAtomic(path.join(DATA_DIR, "board.excalidraw"), scene);
      writeAtomic(
        path.join(DATA_DIR, "meta.json"),
        JSON.stringify(
          {
            updatedAt: new Date().toISOString(),
            elementCount: elementCount ?? null,
            empty: Boolean(empty),
          },
          null,
          2,
        ),
      );
      json(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === "GET") {
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    const filePath = path.resolve(DIST, "." + pathname);
    if (filePath !== DIST && !filePath.startsWith(DIST + path.sep)) {
      json(res, 403, { error: "forbidden" });
      return;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      json(res, 404, { error: "not found" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  json(res, 405, { error: "method not allowed" });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`Whiteboard server already running on port ${PORT}`);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Claude Whiteboard on http://localhost:${PORT}`);
  console.log(`Snapshots -> ${DATA_DIR}`);
});
