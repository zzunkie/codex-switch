import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { EventEmitter } from "node:events";

const MAX_BODY = 64 * 1024 * 1024;
const ALLOWED = new Set([
  "/responses",
  "/responses/compact",
  "/responses/lite",
  "/responses/input_tokens",
  "/models",
  "/images/generations",
  "/images/edits",
  "/alpha/search",
]);
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export class FrameObserver {
  constructor(onMessage) {
    this.buffer = Buffer.alloc(0);
    this.parts = [];
    this.opcode = null;
    this.onMessage = onMessage;
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b = this.buffer;
      const fin = !!(b[0] & 128),
        opcode = b[0] & 15,
        masked = !!(b[1] & 128);
      let length = b[1] & 127,
        offset = 2;
      if (length === 126) {
        if (b.length < 4) return;
        length = b.readUInt16BE(2);
        offset = 4;
      }
      if (length === 127) {
        if (b.length < 10) return;
        const size = b.readBigUInt64BE(2);
        if (size > BigInt(MAX_BODY)) {
          this.buffer = Buffer.alloc(0);
          this.parts = [];
          return;
        }
        length = Number(size);
        offset = 10;
      }
      const key = masked ? b.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (b.length < offset + length) return;
      let payload = Buffer.from(b.subarray(offset, offset + length));
      this.buffer = b.subarray(offset + length);
      if (masked)
        for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
      if (opcode >= 8) continue;
      if (opcode !== 0) {
        this.parts = [];
        this.opcode = opcode;
      }
      this.parts.push(payload);
      if (this.parts.reduce((n, p) => n + p.length, 0) > MAX_BODY) {
        this.parts = [];
        this.opcode = null;
        continue;
      }
      if (fin) {
        if (this.opcode === 1)
          try {
            this.onMessage(
              JSON.parse(Buffer.concat(this.parts).toString("utf8")),
            );
          } catch {}
        this.parts = [];
        this.opcode = null;
      }
    }
  }
}

function safeHeaders(incoming, credentials, websocket = false) {
  const result = {};
  const extra = new Set(
    (incoming.connection ?? "").split(",").map((x) => x.trim().toLowerCase()),
  );
  for (const [k, v] of Object.entries(incoming)) {
    if (
      k === "host" ||
      k === "cookie" ||
      k === "origin" ||
      k === "x-codex-switch-probe" ||
      HOP.has(k) ||
      extra.has(k) ||
      k === "sec-websocket-extensions"
    )
      continue;
    if (
      credentials &&
      [
        "authorization",
        "chatgpt-account-id",
        "openai-organization",
        "openai-project",
        "x-oai-account-id",
        "x-openai-account-id",
        "x-oai-user-id",
      ].includes(k)
    )
      continue;
    result[k] = v;
  }
  if (credentials) {
    result.authorization = "Bearer " + credentials.token;
    result["chatgpt-account-id"] = credentials.accountId;
  }
  if (websocket) {
    result.connection = "Upgrade";
    result.upgrade = "websocket";
    result["sec-websocket-version"] = incoming["sec-websocket-version"];
    result["sec-websocket-key"] = incoming["sec-websocket-key"];
  }
  return result;
}

export class RoutingProxy extends EventEmitter {
  constructor({
    credentials,
    port = 39147,
    secret = crypto.randomBytes(24).toString("hex"),
    upstream = "https://chatgpt.com/backend-api/codex",
  }) {
    super();
    this.credentials = credentials;
    this.port = port;
    this.secret = secret;
    this.upstream = new URL(upstream);
    this.selected = "current";
    this.enabled = false;
    this.sockets = new Set();
    this.websockets = new Set();
    this.inFlight = 0;
    this.total = 0;
    this.lastError = null;
    this.lastErrorAt = null;
    this.lastResponseAt = null;
    this.lastResponseAccount = null;
    this.lastModel = null;
    this.server = http.createServer((req, res) => this.handleHTTP(req, res));
    this.server.on("upgrade", (req, socket, head) =>
      this.handleUpgrade(req, socket, head),
    );
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    this.server.on("clientError", (_, socket) =>
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"),
    );
    this.server.requestTimeout = 120000;
    this.server.headersTimeout = 15000;
  }
  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        this.port = this.server.address().port;
        resolve();
      });
    });
  }
  get baseURL() {
    return `http://127.0.0.1:${this.port}/route/${this.secret}`;
  }
  route(req) {
    if (req.headers.origin) throw new Error("Forbidden");
    if (!req.url?.startsWith(`/route/${this.secret}/`))
      throw new Error("Forbidden");
    const raw = req.url.slice(`/route/${this.secret}`.length);
    const parsed = new URL(raw, "http://localhost");
    if (
      !ALLOWED.has(parsed.pathname) ||
      !["GET", "POST"].includes(req.method)
    ) {
      const error = new Error("Forbidden");
      if (
        ["GET", "POST"].includes(req.method) &&
        /^\/[a-z_/-]{1,80}$/.test(parsed.pathname)
      )
        error.publicMessage = `Unsupported Codex endpoint: ${req.method} ${parsed.pathname}`;
      throw error;
    }
    if (
      req.method === "GET" &&
      parsed.pathname !== "/models" &&
      parsed.pathname !== "/responses"
    )
      throw new Error("Forbidden");
    const target = new URL(this.upstream);
    target.pathname =
      this.upstream.pathname.replace(/\/$/, "") + parsed.pathname;
    target.search = parsed.search;
    return target;
  }
  setRoute(selected, enabled) {
    const changed = this.selected !== selected || this.enabled !== enabled;
    this.selected = selected;
    this.enabled = enabled;
    if (changed)
      for (const session of this.websockets) {
        session.retiring = true;
        if (session.active === 0) session.close();
      }
    this.emit("changed");
  }
  selectedForRequest() {
    return this.enabled ? this.selected : "current";
  }
  fail(res, status, message) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(
      JSON.stringify({
        error: {
          message,
          type: "codex_switch_error",
          code: "route_unavailable",
        },
      }),
    );
  }
  notifyError(message) {
    this.lastError = message;
    this.lastErrorAt = Date.now() / 1000;
    this.emit("changed");
  }
  responseCompleted(account, model, probe = false) {
    if (probe) {
      this.lastProbeResponseAt = Date.now() / 1000;
      this.emit("changed");
      return;
    }
    this.lastResponseAt = Date.now() / 1000;
    this.lastResponseAccount = account;
    this.lastModel =
      typeof model === "string" && /^[a-zA-Z0-9._/-]{1,100}$/.test(model)
        ? model
        : null;
    this.lastError = null;
    this.lastErrorAt = null;
    this.emit("changed");
  }
  observeCaller(req) {
    if (req.headers["x-codex-switch-probe"] !== "true")
      this.lastCodexRequestAt = Date.now() / 1000;
  }
  async handleHTTP(req, res) {
    let target;
    try {
      target = this.route(req);
    } catch (error) {
      return this.fail(
        res,
        403,
        error.publicMessage ?? "Local route is not available.",
      );
    }
    if (!req.headers.authorization)
      return this.fail(res, 401, "Codex authentication is required.");
    this.observeCaller(req);
    const selected = this.selectedForRequest();
    let data;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) {
          this.fail(res, 413, "Request exceeds the local 64 MB limit.");
          return;
        }
        chunks.push(chunk);
      }
      data = Buffer.concat(chunks);
    } catch {
      return;
    }
    let model = null;
    try {
      model = JSON.parse(data).model;
    } catch {}
    this.inFlight++;
    this.total++;
    this.emit("changed");
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.inFlight--;
      this.emit("complete", selected);
      this.emit("changed");
    };
    res.once("close", finish);
    const execute = async (force = false) => {
      if (res.destroyed) return finish();
      let auth;
      try {
        auth =
          selected === "current"
            ? null
            : await this.credentials(selected, force);
      } catch {
        this.notifyError("선택한 계정의 인증을 확인해 주세요.");
        this.fail(res, 503, "Selected account needs sign-in.");
        return finish();
      }
      const headers = safeHeaders(req.headers, auth);
      headers["content-length"] = String(data.length);
      const upstream = (target.protocol === "https:" ? https : http).request(
        target,
        { method: req.method, headers },
        (reply) => {
          if (reply.statusCode === 401 && selected !== "current" && !force) {
            reply.resume();
            execute(true).catch(() =>
              this.fail(res, 502, "Account refresh failed."),
            );
            return;
          }
          const responseHeaders = {};
          for (const [k, v] of Object.entries(reply.headers))
            if (!HOP.has(k) && k !== "set-cookie" && v !== undefined)
              responseHeaders[k] = v;
          responseHeaders["cache-control"] = "no-store";
          res.writeHead(reply.statusCode ?? 502, responseHeaders);
          if ((reply.statusCode ?? 0) >= 400)
            this.notifyError(
              `선택한 계정의 요청이 거절됐습니다. (HTTP ${reply.statusCode})`,
            );
          else this.lastError = null;
          // Observe only completion metadata; never keep or log request/response contents.
          if (
            (reply.headers["content-type"] ?? "").includes("text/event-stream")
          ) {
            let buffer = "";
            const decoder = new TextDecoder();
            const encoding = (
              reply.headers["content-encoding"] ?? "identity"
            ).toLowerCase();
            const decompressor =
              encoding === "gzip"
                ? createGunzip()
                : encoding === "br"
                  ? createBrotliDecompress()
                  : encoding === "deflate"
                    ? createInflate()
                    : null;
            const observed = decompressor ? reply.pipe(decompressor) : reply;
            if (decompressor) {
              decompressor.on("error", () => decompressor.destroy());
              reply.once("error", () => decompressor.destroy());
              res.once("close", () => {
                if (!reply.complete) decompressor.destroy();
              });
            }
            observed.on("data", (chunk) => {
              buffer += decoder.decode(chunk, { stream: true });
              let end;
              while ((end = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, end).trim();
                buffer = buffer.slice(end + 1);
                if (line.startsWith("data:"))
                  try {
                    const event = JSON.parse(line.slice(5));
                    if (event.type === "response.completed")
                      this.responseCompleted(
                        selected,
                        event.response?.model ?? model,
                        req.headers["x-codex-switch-probe"] === "true",
                      );
                    else if (
                      event.type === "response.failed" ||
                      event.type === "error"
                    )
                      this.notifyError("모델 응답 실패");
                  } catch {}
              }
              if (buffer.length > 1024 * 1024) buffer = "";
            });
          }
          reply.pipe(res);
          reply.once("end", finish);
          reply.once("error", () => {
            res.destroy();
            finish();
          });
        },
      );
      upstream.setTimeout(180000, () => upstream.destroy(new Error("idle")));
      upstream.once("error", (e) => {
        if (!res.destroyed) {
          this.notifyError(
            e.code === "ETIMEDOUT" ? "서버 응답 시간 초과" : "서버 연결 실패",
          );
          this.fail(res, 502, "Upstream connection failed.");
        }
        finish();
      });
      res.once("close", () => upstream.destroy());
      upstream.end(data);
    };
    execute().catch(() => {
      this.fail(res, 502, "Route failed.");
      finish();
    });
  }
  async handleUpgrade(req, client, head) {
    let target;
    try {
      target = this.route(req);
    } catch {
      return client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
    if (!req.headers.authorization)
      return client.end(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n",
      );
    this.observeCaller(req);
    const selected = this.selectedForRequest();
    const execute = async (force = false) => {
      let auth;
      try {
        auth =
          selected === "current"
            ? null
            : await this.credentials(selected, force);
      } catch {
        this.notifyError("선택한 계정에 다시 로그인해 주세요.");
        return client.end(
          "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
        );
      }
      if (client.destroyed) return;
      const upstream = (target.protocol === "https:" ? https : http).request(
        target,
        { method: "GET", headers: safeHeaders(req.headers, auth, true) },
      );
      upstream.once("upgrade", (reply, server, upstreamHead) => {
        const lines = [`HTTP/1.1 101 Switching Protocols`];
        for (const [k, v] of Object.entries(reply.headers))
          if (k !== "set-cookie" && v !== undefined) lines.push(`${k}: ${v}`);
        client.write(lines.join("\r\n") + "\r\n\r\n");
        const session = {
          selected,
          model: null,
          active: 0,
          retiring: false,
          closed: false,
          close: () => {
            client.end();
            server.end();
            setTimeout(() => {
              client.destroy();
              server.destroy();
            }, 200).unref();
          },
        };
        const cleanup = () => {
          if (session.closed) return;
          session.closed = true;
          this.inFlight -= session.active;
          session.active = 0;
          this.websockets.delete(session);
          this.emit("changed");
          client.destroy();
          server.destroy();
        };
        this.websockets.add(session);
        const inbound = new FrameObserver((msg) => {
          if (msg.type === "response.create") {
            session.model = msg.model ?? null;
            session.active++;
            this.inFlight++;
            this.total++;
            this.emit("changed");
          }
        });
        const outbound = new FrameObserver((msg) => {
          if (
            [
              "response.completed",
              "response.failed",
              "response.incomplete",
              "error",
            ].includes(msg.type)
          ) {
            if (msg.type === "response.completed")
              this.responseCompleted(
                selected,
                msg.response?.model ?? session.model,
                req.headers["x-codex-switch-probe"] === "true",
              );
            else if (msg.type === "response.failed" || msg.type === "error")
              this.notifyError("모델 응답 실패");
            if (session.active > 0) {
              session.active--;
              this.inFlight--;
            }
            this.emit("complete", selected);
            this.emit("changed");
            if (session.retiring && session.active === 0)
              setTimeout(session.close, 75).unref();
          }
        });
        client.on("data", (chunk) => inbound.push(chunk));
        server.on("data", (chunk) => outbound.push(chunk));
        client.on("error", cleanup);
        server.on("error", cleanup);
        client.on("close", cleanup);
        server.on("close", cleanup);
        if (head.length) {
          inbound.push(head);
          server.write(head);
        }
        if (upstreamHead.length) {
          outbound.push(upstreamHead);
          client.write(upstreamHead);
        }
        client.pipe(server);
        server.pipe(client);
        if (this.selectedForRequest() !== selected) {
          session.retiring = true;
          if (!session.active) session.close();
        }
      });
      upstream.once("response", (reply) => {
        if (reply.statusCode === 401 && selected !== "current" && !force) {
          reply.resume();
          execute(true).catch(() => client.destroy());
          return;
        }
        this.notifyError(`연결 거절 (HTTP ${reply.statusCode ?? 502})`);
        reply.resume();
        client.end(
          `HTTP/1.1 ${reply.statusCode ?? 502} Upstream Response\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
      });
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.once("error", () => {
        if (!client.destroyed) this.notifyError("서버 연결 실패");
        client.destroy();
      });
      client.once("close", () => upstream.destroy());
      upstream.end();
    };
    execute().catch(() => client.destroy());
  }
  async stop() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(() => resolve()));
  }
}
