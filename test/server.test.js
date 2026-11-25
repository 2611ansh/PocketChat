const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { handler } = require("../server");

async function withServer(run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("serves the app from the Public directory", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    assert.match(await response.text(), /<title>PocketChat<\/title>/);
  });
});

test("supports HEAD without a response body", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/manifest.json", { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
  });
});

test("blocks traversal and unsupported methods", async () => {
  await withServer(async (base) => {
    const traversal = await fetch(base + "/../package.json");
    assert.ok(traversal.status === 403 || traversal.status === 404);

    const post = await fetch(base + "/", { method: "POST" });
    assert.equal(post.status, 405);
  });
});

test("returns JSON status and rejects malformed login JSON", async () => {
  await withServer(async (base) => {
    const status = await fetch(base + "/api/status");
    assert.equal(status.status, 200);
    assert.equal(typeof (await status.json()).authed, "boolean");

    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(login.status, 400);
  });
});

