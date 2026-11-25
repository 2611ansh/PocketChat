// PocketChat: zero-dependency Node server (Node 18+).
// Serves the web app and proxies chat requests to OpenRouter so your API key never reaches the phone.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Load .env
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const KEY = process.env.OPENROUTER_API_KEY;
const PIN = process.env.ACCESS_PIN || "";
const PORT = Number(process.env.PORT || 3000);

const TOKEN = PIN ? crypto.createHash("sha256").update("pc:" + PIN).digest("hex") : "";
const OR = "https://openrouter.ai/api/v1";
const PUBLIC_DIR = path.join(__dirname, "Public");
const types = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
};

const authed = (req) => {
  if (!PIN) return true;
  const cookies = (req.headers.cookie || "").split(";").map((part) => part.trim());
  const cookie = cookies.find((part) => part.startsWith("pc_token="));
  if (!cookie) return false;
  const provided = Buffer.from(cookie.slice("pc_token=".length));
  const expected = Buffer.from(TOKEN);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
};
const body = (req, limit = 1024 * 1024) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  let tooLarge = false;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > limit) {
      tooLarge = true;
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (tooLarge) {
      const err = new Error("Request body is too large.");
      err.status = 413;
      reject(err);
      return;
    }
    resolve(Buffer.concat(chunks).toString("utf8"));
  });
  req.on("error", reject);
});
const json = (res, status, value) => res.writeHead(status, {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
}).end(JSON.stringify(value));
const noContentTypeSniff = (res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
};

async function upstream(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeout || 60000);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const handler = async (req, res) => {
  noContentTypeSniff(res);
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/login" && req.method === "POST") {
      let payload;
      try { payload = JSON.parse(await body(req, 4096) || "{}"); }
      catch (e) { if (e.status) throw e; return json(res, 400, { error: "Invalid JSON." }); }
      const supplied = typeof payload.pin === "string" ? payload.pin : "";
      const suppliedHash = crypto.createHash("sha256").update("pc:" + supplied).digest();
      const expectedHash = crypto.createHash("sha256").update("pc:" + PIN).digest();
      if (!PIN || supplied.length !== PIN.length || !crypto.timingSafeEqual(suppliedHash, expectedHash)) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { "Set-Cookie": `pc_token=${TOKEN}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax` }).end("ok");
      return;
    }
    if (url.pathname === "/api/status") { return json(res, 200, { authed: authed(req) }); }

    if (url.pathname.startsWith("/api/")) {
      if (!KEY) throw Object.assign(new Error("Server is missing OPENROUTER_API_KEY."), { status: 500 });
      if (!authed(req)) { return json(res, 401, { error: "Authentication required." }); }
      if (url.pathname === "/api/models") {
        const r = await upstream(OR + "/models", { headers: { Authorization: "Bearer " + KEY } });
        if (!r.ok) return json(res, r.status, { error: "Could not load models." });
        const j = await r.json();
        const free = (j.data || []).filter((m) => m.id.endsWith(":free") || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0))
          .map((m) => ({ id: m.id, name: m.name, ctx: m.context_length, vision: (m.architecture?.input_modalities || []).includes("image") }));
        return json(res, 200, free);
        return;
      }
      if (url.pathname === "/api/chat" && req.method === "POST") {
        const ctrl = new AbortController();
        res.on("close", () => ctrl.abort());
        const requestBody = await body(req, 1024 * 1024);
        let payload;
        try { payload = JSON.parse(requestBody || "{}"); }
        catch { return json(res, 400, { error: "Invalid JSON." }); }
        if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages)) {
          return json(res, 400, { error: "Request must contain a messages array." });
        }
        const timer = setTimeout(() => ctrl.abort(), 10 * 60 * 1000);
        try {
          const up = await fetch(OR + "/chat/completions", {
            method: "POST", signal: ctrl.signal,
            headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json", "X-Title": "PocketChat" },
            body: requestBody,
          });
          res.writeHead(up.status, {
            "Content-Type": up.headers.get("content-type") || "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
          });
          for await (const chunk of up.body) res.write(chunk);
          res.end();
        } finally {
          clearTimeout(timer);
        }
        return;
      }
      res.writeHead(404).end();
      return;
    }

    // Static files
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { "Allow": "GET, HEAD" }).end(); return; }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { res.writeHead(400).end("Bad request"); return; }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const full = path.resolve(PUBLIC_DIR, relative);
    if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403).end("Forbidden"); return; }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, {
      "Content-Type": types[path.extname(full).toLowerCase()] || "application/octet-stream",
      "Cache-Control": pathname === "/index.html" || pathname === "/" ? "no-cache" : "public, max-age=3600",
    });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(full).pipe(res);
  } catch (e) {
    if (!res.headersSent) {
      const status = e.status || 500;
      json(res, status, { error: status === 500 ? "Internal server error." : e.message });
    } else {
      res.end();
    }
  }
};

// Listen only on the Tailscale address (and this Mac's own localhost), never on the home/public network.
function tailscaleIP() {
  for (const i of Object.values(require("os").networkInterfaces()).flat()) {
    if (i.family !== "IPv4" && i.family !== 4) continue;
    const [a, b] = i.address.split(".").map(Number);
    if (a === 100 && b >= 64 && b <= 127) return i.address; // Tailscale range 100.64.0.0/10
  }
  return null;
}

function start() {
  if (!KEY) {
    console.error("Missing OPENROUTER_API_KEY. Copy .env.example to .env and add your key.");
    process.exit(1);
  }
  const host = process.env.BIND_HOST || tailscaleIP();
  if (!host) {
    console.log("Tailscale not detected. Open the Tailscale app and turn it on. Retrying in 5s...");
    return setTimeout(start, 5000);
  }
  http.createServer(handler).listen(PORT, host, () => {
    console.log("PocketChat running (private).\n  Tailscale: http://" + host + ":" + PORT);
  });
  if (host !== "127.0.0.1") {
    http.createServer(handler).listen(PORT, "127.0.0.1", () => console.log("  This Mac:  http://localhost:" + PORT));
  }
  if (!PIN) console.log("  Tip: set ACCESS_PIN in .env so only you can use it.");
}

module.exports = { handler, start, PUBLIC_DIR };
if (require.main === module) start();
