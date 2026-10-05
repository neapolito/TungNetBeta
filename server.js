// TungNet server
// Serves the TungNet app, the Ultraviolet proxy engine files, and the Wisp
// socket the engine tunnels through. No web framework needed: just Node.

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(ROOT, "public");
const PKG = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const PORT = Number.parseInt(process.env.PORT ?? "", 10) || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const started = Date.now();

// ---------------------------------------------------------------------------
// Engine packages
// ---------------------------------------------------------------------------

async function vendor(name, key, { required = true } = {}) {
  try {
    const mod = await import(name);
    return key ? mod[key] : mod;
  } catch (err) {
    if (required) {
      console.error(`\n  [TungNet] Missing engine package "${name}".`);
      console.error("  Run `npm install` in the project folder, then `npm start` again.\n");
      console.error(`  (${err.code || err.message})\n`);
      process.exit(1);
    }
    console.warn(`  [TungNet] Optional engine "${name}" not available, skipping it.`);
    return null;
  }
}

const uvPath = await vendor("@titaniumnetwork-dev/ultraviolet", "uvPath");
const baremuxPath = await vendor("@mercuryworkshop/bare-mux/node", "baremuxPath");
const epoxyPath = await vendor("@mercuryworkshop/epoxy-transport", "epoxyPath");
const libcurlPath = await vendor("@mercuryworkshop/libcurl-transport", "libcurlPath", { required: false });
const wispModule = await vendor("@mercuryworkshop/wisp-js/server");
const wisp = wispModule.server;

// Wisp settings. Private/loopback destinations are blocked by default so the
// proxy can't be used to poke at services inside your Codespace.
if (wispModule.logging) {
  wispModule.logging.set_level(process.env.DEBUG ? wispModule.logging.DEBUG : wispModule.logging.WARN);
}
if (process.env.ALLOW_LOCAL === "1") {
  wisp.options.allow_private_ips = true;
  wisp.options.allow_loopback_ips = true;
  console.warn("  [TungNet] ALLOW_LOCAL=1: proxy can reach local/private addresses.");
}

// Order matters: /public wins, so our uv.config.js and sw.js override the stock ones.
const mounts = [
  ["/", PUBLIC],
  ["/uv/", uvPath],
  ["/baremux/", baremuxPath],
  ["/epoxy/", epoxyPath],
  ...(libcurlPath ? [["/libcurl/", libcurlPath]] : []),
];

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

async function findFile(pathname) {
  for (const [prefix, dir] of mounts) {
    if (!pathname.startsWith(prefix)) continue;
    const rel = pathname.slice(prefix.length);
    const base = resolve(dir);
    let file = resolve(base, "." + sep + rel);
    if (file !== base && !file.startsWith(base + sep)) continue; // no ../ escapes
    try {
      let info = await stat(file);
      if (info.isDirectory()) {
        file = join(file, "index.html");
        info = await stat(file);
      }
      if (info.isFile()) return { file, info };
    } catch {
      /* try next mount */
    }
  }
  return null;
}

function sendFile(req, res, { file, info }, status = 200) {
  const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const isImage = type.startsWith("image/") || type.startsWith("font/");
  res.setHeader("Content-Type", type);
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", isImage ? "public, max-age=86400" : "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (status === 200 && req.headers["if-none-match"] === etag) {
    res.writeHead(304).end();
    return;
  }
  res.setHeader("Content-Length", info.size);
  res.writeHead(status);
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

async function sendPage(req, res, name, status) {
  const found = await findFile("/" + name);
  if (found) return sendFile(req, res, found, status);
  res.writeHead(status, { "Content-Type": "text/plain" }).end(String(status));
}

function sendJSON(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Small helper APIs (search suggestions + YouTube info for the Theater)
// ---------------------------------------------------------------------------

const cache = new Map();
function remember(key, value, ttlMs) {
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(key, { value, until: Date.now() + ttlMs });
  return value;
}
function recall(key) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  cache.delete(key);
  return undefined;
}

async function fetchWithTimeout(url, ms = 4000, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (TungNet)", ...(init.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

async function apiSuggest(url, res) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
  if (!q) return sendJSON(res, 200, { q, suggestions: [] });
  const key = "s:" + q.toLowerCase();
  const cached = recall(key);
  if (cached) return sendJSON(res, 200, { q, suggestions: cached });
  try {
    const r = await fetchWithTimeout(
      "https://duckduckgo.com/ac/?type=list&q=" + encodeURIComponent(q),
      2500,
    );
    const data = await r.json();
    // type=list gives ["q", ["a","b"]]; the default format gives [{phrase}]
    let list = Array.isArray(data?.[1]) ? data[1] : Array.isArray(data) ? data.map((d) => d?.phrase) : [];
    list = list.filter((s) => typeof s === "string").slice(0, 7);
    sendJSON(res, 200, { q, suggestions: remember(key, list, 10 * 60e3) });
  } catch {
    sendJSON(res, 200, { q, suggestions: [] });
  }
}

async function apiYouTubeInfo(url, res) {
  const id = url.searchParams.get("id") || "";
  if (!YT_ID.test(id)) return sendJSON(res, 400, { error: "That isn't a YouTube video id." });
  const key = "yt:" + id;
  const cached = recall(key);
  if (cached) return sendJSON(res, 200, cached);
  try {
    const r = await fetchWithTimeout(
      "https://www.youtube.com/oembed?format=json&url=" +
        encodeURIComponent("https://www.youtube.com/watch?v=" + id),
    );
    if (!r.ok) throw new Error("oembed " + r.status);
    const d = await r.json();
    sendJSON(res, 200, remember(key, { id, title: d.title || "", channel: d.author_name || "" }, 6 * 3600e3));
  } catch {
    sendJSON(res, 200, { id, title: "", channel: "" });
  }
}

async function apiYouTubeThumb(id, req, res) {
  if (!YT_ID.test(id)) return sendJSON(res, 400, { error: "That isn't a YouTube video id." });
  try {
    const r = await fetchWithTimeout(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`, 5000);
    if (!r.ok) throw new Error("thumb " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, {
      "Content-Type": r.headers.get("content-type") || "image/jpeg",
      "Content-Length": buf.length,
      "Cache-Control": "public, max-age=86400",
    });
    res.end(req.method === "HEAD" ? undefined : buf);
  } catch {
    // Fall back to Tung's face so the list never shows a broken image.
    const found = await findFile("/img/tung-face.png");
    if (found) return sendFile(req, res, found);
    res.writeHead(404).end();
  }
}

function apiHealth(res) {
  sendJSON(res, 200, {
    name: "TungNet",
    version: PKG.version,
    uptimeSeconds: Math.round((Date.now() - started) / 1000),
    engines: { epoxy: Boolean(epoxyPath), libcurl: Boolean(libcurlPath) },
    node: process.version,
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, "http://tungnet.local");
  } catch {
    return sendJSON(res, 400, { error: "Bad request" });
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJSON(res, 400, { error: "Bad request" });
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  if (pathname === "/api/health") return apiHealth(res);
  if (pathname === "/api/suggest") return apiSuggest(url, res);
  if (pathname === "/api/yt/info") return apiYouTubeInfo(url, res);
  if (pathname.startsWith("/api/yt/thumb/")) return apiYouTubeThumb(pathname.slice(14), req, res);

  // A proxied URL only reaches the server when the service worker wasn't in
  // control (first visit, hard reload, opened in a real new tab). The warm-up
  // page starts the engine and reloads.
  if (pathname.startsWith("/uv/service/")) return sendPage(req, res, "warmup.html", 200);

  const found = await findFile(pathname);
  if (found) return sendFile(req, res, found);
  return sendPage(req, res, "404.html", 404);
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("  [TungNet] request failed:", err);
    if (!res.headersSent) sendJSON(res, 500, { error: "Server error" });
    else res.destroy();
  });
});

server.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.endsWith("/wisp/")) {
    wisp.routeRequest(req, socket, head);
    return;
  }
  socket.destroy();
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  [TungNet] Port ${PORT} is already in use. TungNet may already be running.`);
    console.error(`  Stop the other copy, or start on another port: PORT=3000 npm start\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const lines = [
    "",
    "   ┌───────────────────────────────────────────┐",
    "   │  TungNet is up. Tung tung tung...          │",
    "   └───────────────────────────────────────────┘",
    `     Local:    http://localhost:${PORT}`,
    `     Network:  http://${hostname()}:${PORT}`,
  ];
  if (process.env.CODESPACE_NAME) {
    const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || "app.github.dev";
    lines.push(`     Codespace: https://${process.env.CODESPACE_NAME}-${PORT}.${domain}`);
  }
  lines.push(`     Engines:  epoxy${libcurlPath ? " + libcurl" : ""}`, "");
  console.log(lines.join("\n"));
});

function shutdown() {
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
