import test, { after } from "node:test";
import os from "node:os";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { ConfigLink, rootAssignments } from "../Backend/config.mjs";
import { RoutingProxy, FrameObserver } from "../Backend/proxy.mjs";
import { normalizeLimits, Accounts } from "../Backend/accounts.mjs";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-test-"));
after(() => fs.rmSync(workspace, { recursive: true, force: true }));
function directory() {
  return fs.mkdtempSync(path.join(workspace, "test-"));
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("Condition timed out");
}

test("configuration restore is byte-for-byte exact, including the previous endpoint", () => {
  const dir = directory(),
    file = path.join(dir, "config.toml");
  const before =
    '# settings\nmodel = "gpt-5.6-sol"\nopenai_base_url = "https://example.invalid/v1" # custom\n\n[features]\napps = true\n';
  fs.writeFileSync(file, before);
  const link = new ConfigLink(file, path.join(dir, "app"));
  link.enable("http://127.0.0.1:39147/route/synthetic");
  assert.equal(
    rootAssignments(fs.readFileSync(file, "utf8"), "openai_base_url").matches
      .length,
    1,
  );
  assert.equal(link.status().connected, true);
  link.disable();
  assert.equal(fs.readFileSync(file, "utf8"), before);
});
test("configuration restore preserves edits made by the user while connected", () => {
  const dir = directory(),
    file = path.join(dir, "config.toml");
  fs.writeFileSync(file, 'model = "original"\n[features]\napps = false\n');
  const link = new ConfigLink(file, path.join(dir, "app"));
  link.enable("http://localhost/test");
  fs.appendFileSync(file, "memories = true\n");
  link.disable();
  assert.equal(
    fs.readFileSync(file, "utf8"),
    'model = "original"\n[features]\napps = false\nmemories = true\n',
  );
});
test("multiline instruction content is not treated as a root setting", () => {
  const text =
    'developer_instructions = """\nopenai_base_url = "not-a-setting"\n[fake]\n"""\nmodel = "gpt-5.6-sol"\n';
  assert.equal(rootAssignments(text, "openai_base_url").matches.length, 0);
  const dir = directory(),
    file = path.join(dir, "config.toml");
  fs.writeFileSync(file, text);
  const link = new ConfigLink(file, path.join(dir, "app"));
  link.enable("http://localhost/test");
  link.disable();
  assert.equal(fs.readFileSync(file, "utf8"), text);
});
test("conflicting managed block is never overwritten on restore", () => {
  const dir = directory(),
    file = path.join(dir, "config.toml");
  const link = new ConfigLink(file, path.join(dir, "app"));
  link.enable("http://localhost/test");
  fs.writeFileSync(file, 'model="user-edit"\n');
  assert.throws(() => link.disable(), /외부에서 변경/);
  assert.equal(fs.readFileSync(file, "utf8"), 'model="user-edit"\n');
});
test("new configuration file is removed when the connection is reverted", () => {
  const dir = directory(),
    file = path.join(dir, "config.toml");
  const link = new ConfigLink(file, path.join(dir, "app"));
  link.enable("http://localhost/test");
  link.disable();
  assert.equal(fs.existsSync(file), false);
});
test("quota parsing prefers named buckets and never treats unavailable usage as zero", () => {
  const limits = normalizeLimits({
    rateLimits: { primary: { usedPercent: 99 } },
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 72, windowDurationMins: 300, resetsAt: 42 },
        secondary: null,
      },
      other: { primary: null, secondary: { usedPercent: 150 } },
    },
  });
  assert.equal(limits[0].primary.remainingPercent, 28);
  assert.equal(limits[0].secondary, null);
  assert.equal(limits[1].secondary.remainingPercent, 0);
  assert.deepEqual(normalizeLimits({}), []);
  assert.equal(
    normalizeLimits({ rateLimits: { primary: { usedPercent: null } } })[0]
      .primary,
    null,
  );
});
test("Pro weekly-only and Plus five-hour plus weekly limits retain their actual windows", () => {
  const pro = normalizeLimits({
    rateLimits: {
      planType: "pro",
      primary: { usedPercent: 87, windowDurationMins: 10080 },
      secondary: null,
    },
  })[0];
  const plus = normalizeLimits({
    rateLimits: {
      planType: "plus",
      primary: { usedPercent: 20, windowDurationMins: 300 },
      secondary: { usedPercent: 40, windowDurationMins: 10080 },
    },
  })[0];
  assert.equal(pro.primary.durationMins, 10080);
  assert.equal(pro.secondary, null);
  assert.equal(plus.primary.durationMins, 300);
  assert.equal(plus.secondary.durationMins, 10080);
});
test("account auth is refreshed before an expired token is routed", async () => {
  const dir = directory(),
    manager = new Accounts({
      directory: dir,
      primaryHome: path.join(dir, "primary"),
      binary: "/unused",
    });
  const id = crypto.randomUUID();
  manager.items.push({ id, label: "test", status: "ready" });
  const calls = [];
  const makeToken = (exp) =>
    "synthetic." +
    Buffer.from(
      JSON.stringify({
        exp,
        "https://api.openai.com/auth": { chatgpt_account_id: "B" },
      }),
    ).toString("base64url") +
    ".signature";
  manager.clients.set(id, {
    request: async (method, p) => {
      calls.push(p.refreshToken);
      return {
        authMethod: "chatgpt",
        authToken: makeToken(Date.now() / 1000 + (p.refreshToken ? 3600 : -1)),
      };
    },
  });
  const c = await manager.credentials(id);
  assert.equal(c.accountId, "B");
  assert.deepEqual(calls, [false, true]);
});

async function servers(t, onRequest, onUpgrade) {
  const sockets = new Set();
  const upstream = http.createServer(onRequest);
  upstream.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  if (onUpgrade) upstream.on("upgrade", onUpgrade);
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const proxy = new RoutingProxy({
    port: 0,
    secret: "test-secret",
    upstream: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
    credentials: async (id, force) => ({
      token: `token-${id}${force ? "-fresh" : ""}`,
      accountId: id,
    }),
  });
  await proxy.start();
  proxy.setRoute("B", true);
  t.after(async () => {
    await proxy.stop();
    for (const s of sockets) s.destroy();
    await new Promise((r) => upstream.close(r));
  });
  return proxy;
}
function request(url, { body = '{"test":true}', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          authorization: "Bearer token-A",
          "chatgpt-account-id": "A",
          "content-type": "application/json",
          ...headers,
        },
      },
      (res) => {
        let text = "";
        const chunks = [];
        res.on("data", (c) => {
          chunks.push({ at: Date.now(), text: c.toString() });
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode, text, chunks }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
test("HTTP streaming replaces both auth fields, strips cookies, and retains streaming", async (t) => {
  const seen = [];
  const proxy = await servers(t, (req, res) => {
    seen.push(req.headers);
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    setTimeout(() => res.end("data: second\n\n"), 100);
  });
  const result = await request(proxy.baseURL + "/responses", {
    headers: { cookie: "account-A-session" },
  });
  assert.equal(result.status, 200);
  assert.equal(seen[0].authorization, "Bearer token-B");
  assert.equal(seen[0]["chatgpt-account-id"], "B");
  assert.equal(seen[0].cookie, undefined);
  assert.equal(result.chunks.length, 2);
  assert.ok(result.chunks[1].at - result.chunks[0].at >= 60);
});
test("HTTP requests keep their original selection while later requests use a new account", async (t) => {
  const seen = [];
  const proxy = await servers(t, (req, res) => {
    seen.push(req.headers["chatgpt-account-id"]);
    req.resume();
    setTimeout(() => res.end("ok"), 80);
  });
  const first = request(proxy.baseURL + "/responses");
  await until(() => seen.length === 1);
  proxy.setRoute("C", true);
  const second = request(proxy.baseURL + "/responses");
  await Promise.all([first, second]);
  assert.deepEqual(seen, ["B", "C"]);
});
test("401 refreshes only the selected account and retries before returning data", async (t) => {
  const seen = [];
  const proxy = await servers(t, (req, res) => {
    seen.push(req.headers.authorization);
    req.resume();
    res.writeHead(req.headers.authorization.endsWith("-fresh") ? 200 : 401);
    res.end("result");
  });
  const result = await request(proxy.baseURL + "/responses");
  assert.equal(result.status, 200);
  assert.deepEqual(seen, ["Bearer token-B", "Bearer token-B-fresh"]);
});
test("failed selected-account authentication does not fall back to another account", async (t) => {
  let hits = 0;
  const proxy = await servers(t, (req, res) => {
    hits++;
    res.end();
  });
  proxy.credentials = async () => {
    throw new Error("expired");
  };
  const result = await request(proxy.baseURL + "/responses");
  assert.equal(result.status, 503);
  assert.equal(hits, 0);
});
test("browser origins and non-allowlisted paths cannot spend account quota", async (t) => {
  let hits = 0;
  const proxy = await servers(t, (req, res) => {
    hits++;
    res.end();
  });
  assert.equal(
    (
      await request(proxy.baseURL + "/responses", {
        headers: { origin: "https://malicious.invalid" },
      })
    ).status,
    403,
  );
  assert.equal((await request(proxy.baseURL + "/../admin")).status, 403);
  assert.equal(hits, 0);
});
test("disabled routing preserves original caller auth", async (t) => {
  let seen;
  const proxy = await servers(t, (req, res) => {
    seen = req.headers;
    req.resume();
    res.end("ok");
  });
  proxy.setRoute("B", false);
  await request(proxy.baseURL + "/responses");
  assert.equal(seen.authorization, "Bearer token-A");
  assert.equal(seen["chatgpt-account-id"], "A");
});

function frame(value, masked = false) {
  const data = Buffer.from(JSON.stringify(value));
  const size = data.length;
  const prefix =
    size < 126
      ? Buffer.from([129, (masked ? 128 : 0) | size])
      : Buffer.from([129, (masked ? 128 : 0) | 126, size >> 8, size & 255]);
  if (!masked) return Buffer.concat([prefix, data]);
  const key = Buffer.from([1, 2, 3, 4]);
  const encoded = Buffer.from(data);
  for (let i = 0; i < encoded.length; i++) encoded[i] ^= key[i % 4];
  return Buffer.concat([prefix, key, encoded]);
}
function wsClient(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const socket = net.connect(Number(parsed.port), parsed.hostname);
    const client = {
      socket,
      messages: [],
      closed: false,
      send: (value) => socket.write(frame(value, true)),
    };
    let header = Buffer.alloc(0),
      ready = false;
    const observer = new FrameObserver((msg) => client.messages.push(msg));
    socket.on("error", reject);
    socket.on("close", () => (client.closed = true));
    socket.on("connect", () =>
      socket.write(
        `GET ${parsed.pathname} HTTP/1.1\r\nHost: ${parsed.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer token-A\r\nChatGPT-Account-Id: A\r\n\r\n`,
      ),
    );
    socket.on("data", (data) => {
      if (ready) {
        observer.push(data);
        return;
      }
      header = Buffer.concat([header, data]);
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) return;
      if (!header.toString().startsWith("HTTP/1.1 101"))
        return reject(new Error("WebSocket upgrade rejected"));
      ready = true;
      observer.push(header.subarray(end + 4));
      resolve(client);
    });
  });
}
test("WebSocket account switching drains the active response and reconnects with the new account", async (t) => {
  const seen = [];
  const proxy = await servers(
    t,
    (req, res) => {
      res.writeHead(404);
      res.end();
    },
    (req, socket, head) => {
      seen.push(req.headers["chatgpt-account-id"]);
      const accept = crypto
        .createHash("sha1")
        .update(
          req.headers["sec-websocket-key"] +
            "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
        )
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const observer = new FrameObserver((msg) => {
        if (msg.type === "response.create") {
          socket.write(
            frame({ type: "response.output_text.delta", delta: "first" }),
          );
          setTimeout(
            () => socket.write(frame({ type: "response.completed" })),
            120,
          );
        }
      });
      socket.on("data", (d) => observer.push(d));
      if (head.length) observer.push(head);
    },
  );
  const first = await wsClient(proxy.baseURL + "/responses");
  first.send({ type: "response.create" });
  await until(() => proxy.inFlight === 1);
  proxy.setRoute("C", true);
  assert.equal(first.closed, false);
  await until(() =>
    first.messages.some((m) => m.type === "response.completed"),
  );
  await until(() => first.closed);
  const second = await wsClient(proxy.baseURL + "/responses");
  second.send({ type: "response.create" });
  await until(() =>
    second.messages.some((m) => m.type === "response.completed"),
  );
  second.socket.destroy();
  assert.deepEqual(seen, ["B", "C"]);
  assert.equal(proxy.inFlight, 0);
});

test("only an explicit model completion confirms the routed account and model", async (t) => {
  const proxy = await servers(t, (req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.created"}\n\n');
    setTimeout(
      () =>
        res.end(
          'data: {"type":"response.completed","response":{"model":"gpt-5.6-sol"}}\n\n',
        ),
      50,
    );
  });
  const pending = request(proxy.baseURL + "/responses");
  await until(() => proxy.inFlight === 1);
  assert.equal(proxy.lastResponseAt, null);
  await pending;
  assert.equal(proxy.lastResponseAccount, "B");
  assert.equal(proxy.lastModel, "gpt-5.6-sol");
  assert.ok(proxy.lastResponseAt > 0);
});
test("a successful catalog or failed model stream is not a confirmed inference response", async (t) => {
  let failed = false;
  const proxy = await servers(t, (req, res) => {
    req.resume();
    if (failed) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"type":"response.failed"}\n\n');
    } else res.end('{"models":[]}');
  });
  await request(proxy.baseURL + "/models");
  assert.equal(proxy.lastResponseAt, null);
  failed = true;
  await request(proxy.baseURL + "/responses");
  assert.equal(proxy.lastResponseAt, null);
  assert.equal(proxy.lastError, "모델 응답 실패");
  assert.ok(proxy.lastErrorAt > 0);
});
test("caller cancellation does not create a server connection failure", async (t) => {
  const proxy = await servers(t, (req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.created"}\n\n');
  });
  await new Promise((resolve, reject) => {
    const req = http.request(
      proxy.baseURL + "/responses",
      { method: "POST", headers: { authorization: "Bearer local" } },
      (res) => {
        res.once("data", () => {
          res.destroy();
          resolve();
        });
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
  await until(() => proxy.inFlight === 0);
  await delay(30);
  assert.equal(proxy.lastError, null);
  assert.equal(proxy.lastResponseAt, null);
});

test("compressed SSE confirms completion while preserving the original compressed response", async (t) => {
  const { gzipSync, gunzipSync } = await import("node:zlib");
  const event =
    'data: {"type":"response.completed","response":{"model":"gpt-5.6-luna"}}\n\n';
  const compressed = gzipSync(event);
  const proxy = await servers(t, (req, res) => {
    req.resume();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "content-encoding": "gzip",
    });
    res.end(compressed);
  });
  const data = await new Promise((resolve, reject) => {
    http
      .get(
        proxy.baseURL + "/responses",
        { headers: { authorization: "Bearer local" } },
        (res) => {
          const chunks = [];
          assert.equal(res.headers["content-encoding"], "gzip");
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        },
      )
      .on("error", reject);
  });
  assert.deepEqual(data, compressed);
  assert.equal(gunzipSync(data).toString(), event);
  await until(() => proxy.lastResponseAt !== null);
  assert.equal(proxy.lastResponseAccount, "B");
  assert.equal(proxy.lastModel, "gpt-5.6-luna");
});

test("a local diagnostic does not mark the Codex desktop as connected or forward its marker", async (t) => {
  let marker;
  const proxy = await servers(t, (req, res) => {
    marker = req.headers["x-codex-switch-probe"];
    req.resume();
    res.end("ok");
  });
  await request(proxy.baseURL + "/models", {
    headers: { "x-codex-switch-probe": "true" },
  });
  assert.equal(proxy.lastCodexRequestAt, undefined);
  assert.equal(marker, undefined);
  await request(proxy.baseURL + "/responses");
  assert.ok(proxy.lastCodexRequestAt > 0);
});

test("diagnostic completion does not replace the observed Codex account or model", async (t) => {
  const proxy = await servers(t, (req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      'data: {"type":"response.completed","response":{"model":"diagnostic-model"}}\n\n',
    );
  });
  proxy.responseCompleted("B", "actual-codex-model");
  const original = proxy.lastResponseAt;
  await request(proxy.baseURL + "/responses", {
    headers: { "x-codex-switch-probe": "true" },
  });
  assert.equal(proxy.lastModel, "actual-codex-model");
  assert.equal(proxy.lastResponseAt, original);
  assert.ok(proxy.lastProbeResponseAt > 0);
  assert.equal(proxy.lastCodexRequestAt, undefined);
});

test("official image generation and edit routes preserve payload and selected account auth", async (t) => {
  const seen = [];
  const proxy = await servers(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({
      url: req.url,
      auth: req.headers.authorization,
      contentType: req.headers["content-type"],
      body,
    });
    res.end('{"data":[]}');
  });
  for (const endpoint of ["/images/generations", "/images/edits"]) {
    const result = await request(proxy.baseURL + endpoint, {
      body: "synthetic-image-payload",
      headers: { "content-type": "multipart/form-data; boundary=synthetic" },
    });
    assert.equal(result.status, 200);
  }
  assert.deepEqual(
    seen.map((x) => x.url),
    [
      "/backend-api/codex/images/generations",
      "/backend-api/codex/images/edits",
    ],
  );
  assert.ok(
    seen.every(
      (x) =>
        x.auth === "Bearer token-B" &&
        x.body === "synthetic-image-payload" &&
        x.contentType === "multipart/form-data; boundary=synthetic",
    ),
  );
  const rejected = await new Promise((resolve, reject) =>
    http
      .get(
        proxy.baseURL + "/images/generations",
        { headers: { authorization: "Bearer local" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      )
      .on("error", reject),
  );
  assert.equal(rejected, 403);
});

test("saved account metadata cannot inject private fields into UI snapshots", () => {
  const dir = directory(),
    id = crypto.randomUUID();
  fs.writeFileSync(
    path.join(dir, "accounts.json"),
    JSON.stringify([
      {
        id,
        label: "Test",
        email: "test@example.com",
        plan: "pro",
        isCurrent: true,
        authToken: "synthetic-private-token",
        loginURL: "https://example.invalid/secret",
      },
    ]),
  );
  const manager = new Accounts({
    directory: dir,
    primaryHome: path.join(dir, "primary"),
    binary: "/unused",
  });
  const added = manager.list()[1];
  assert.equal(added.id, id);
  assert.equal(added.isCurrent, undefined);
  assert.equal(added.authToken, undefined);
  assert.equal(added.loginURL, undefined);
  fs.writeFileSync(path.join(dir, "accounts.json"), "{}");
  assert.equal(
    new Accounts({ directory: dir, primaryHome: dir, binary: "/unused" }).list()
      .length,
    1,
  );
});
test("signed-out account clears stale limits and cached credentials", async (t) => {
  const dir = directory();
  const manager = new Accounts({
    directory: dir,
    primaryHome: dir,
    binary: "/unused",
  });
  t.after(() => manager.stop());
  manager.items[0].limits = [
    { id: "codex", primary: { remainingPercent: 99 } },
  ];
  manager.items[0].updatedAt = 123;
  manager.tokenCache.set("current", { token: "synthetic" });
  manager.clients.set("current", {
    request: async () => ({ account: null }),
    stop() {},
  });
  await manager.refresh("current");
  assert.equal(manager.items[0].status, "signedOut");
  assert.deepEqual(manager.items[0].limits, []);
  assert.equal(manager.items[0].updatedAt, null);
  assert.equal(manager.tokenCache.has("current"), false);
});
test("unsupported-route diagnostics never include the route secret or query", async (t) => {
  const proxy = new RoutingProxy({
    credentials: async () => {
      throw new Error("should not authenticate");
    },
    port: 0,
  });
  await proxy.start();
  t.after(() => proxy.stop());
  const response = await fetch(
    proxy.baseURL + "/unsupported?token=synthetic-query",
  );
  const body = await response.text();
  assert.equal(response.status, 403);
  assert.match(body, /GET \/unsupported/);
  assert.equal(body.includes(proxy.secret), false);
  assert.equal(body.includes("synthetic-query"), false);
  const untrusted = await fetch(proxy.baseURL + "/unsupported", {
    headers: { origin: "https://example.invalid" },
  });
  assert.equal((await untrusted.text()).includes("/unsupported"), false);
});

test("Codex web tool route forwards only POST to the fixed upstream with selected credentials", async (t) => {
  const seen = [];
  const proxy = await servers(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    res.end('{"results":[]}');
  });
  const payload = JSON.stringify({ search_query: [{ q: "synthetic query" }] });
  const response = await request(proxy.baseURL + "/alpha/search", {
    body: payload,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [
    {
      url: "/backend-api/codex/alpha/search",
      auth: "Bearer token-B",
      body: payload,
    },
  ]);
  const rejected = await fetch(proxy.baseURL + "/alpha/search", {
    headers: { authorization: "Bearer local" },
  });
  assert.equal(rejected.status, 403);
  const other = await request(proxy.baseURL + "/alpha/unknown");
  assert.equal(other.status, 403);
  assert.equal(seen.length, 1);
});
