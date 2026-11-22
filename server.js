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
if (!KEY) { console.error("Missing OPENROUTER_API_KEY. Copy .env.example to .env and add your key."); process.exit(1); }

const TOKEN = PIN ? crypto.createHash("sha256").update("pc:" + PIN).digest("hex") : "";
const OR = "https://openrouter.ai/api/v1";
const types = { ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

const authed = (req) => !PIN || (req.headers.cookie || "").includes("pc_token=" + TOKEN);
const body = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

const handler = async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/login" && req.method === "POST") {
      const { pin } = JSON.parse(await body(req) || "{}");
      if (pin !== PIN) { res.writeHead(401).end(); return; }
      res.writeHead(200, { "Set-Cookie": `pc_token=${TOKEN}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax` }).end("ok");
      return;
    }
    if (url.pathname === "/api/status") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ authed: authed(req) })); return; }

    if (url.pathname.startsWith("/api/")) {
      if (!authed(req)) { res.writeHead(401).end(); return; }
      if (url.pathname === "/api/models") {
        const r = await fetch(OR + "/models", { headers: { Authorization: "Bearer " + KEY } });
        const j = await r.json();
        const free = (j.data || []).filter((m) => m.id.endsWith(":free") || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0))
          .map((m) => ({ id: m.id, name: m.name, ctx: m.context_length, vision: (m.architecture?.input_modalities || []).includes("image") }));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(free));
        return;
      }
      if (url.pathname === "/api/chat" && req.method === "POST") {
        const ctrl = new AbortController();
        res.on("close", () => ctrl.abort());
        const up = await fetch(OR + "/chat/completions", {
          method: "POST", signal: ctrl.signal,
          headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json", "X-Title": "PocketChat" },
          body: await body(req),
        });
        res.writeHead(up.status, { "Content-Type": up.headers.get("content-type") || "text/event-stream", "Cache-Control": "no-cache" });
        for await (const chunk of up.body) res.write(chunk);
        res.end();
        return;
      }
      res.writeHead(404).end(); return;
    }

    // Static files
    let f = url.pathname === "/" ? "/index.html" : url.pathname;
    const full = path.join(__dirname, "public", path.normalize(f).replace(/^(\.\.[/\\])+/, ""));
    if (!full.startsWith(path.join(__dirname, "public")) || !fs.existsSync(full)) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(full)] || "application/octet-stream" }).end(fs.readFileSync(full));
  } catch (e) {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(e.message || e));
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
start();
