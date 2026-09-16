import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export class CodexRPC extends EventEmitter {
  constructor(binary, home, { primary = false } = {}) {
    super();
    this.binary = binary;
    this.home = home;
    this.primary = primary;
    this.pending = new Map();
    this.seq = 0;
    this.child = null;
    this.starting = null;
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this._start().catch((e) => {
      this.stop();
      throw e;
    });
    return this.starting;
  }
  async _start() {
    const env = Object.fromEntries(
      ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"]
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    );
    env.CODEX_HOME = this.home;
    const args = [
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      'model_provider="openai"',
      "-c",
      'openai_base_url="https://chatgpt.com/backend-api/codex"',
      "-c",
      'chatgpt_base_url="https://chatgpt.com"',
      "-c",
      "analytics.enabled=false",
      "-c",
      "features.apps=false",
      "-c",
      "features.memories=false",
      "-c",
      "check_for_update_on_startup=false",
    ];
    if (!this.primary) args.push("-c", 'cli_auth_credentials_store="file"');
    this.child = spawn(this.binary, args, {
      env,
      cwd: this.home,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 20 * 1024 * 1024) {
        this.stop();
        return;
      }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          this.receive(JSON.parse(line));
        } catch {}
      }
    });
    this.child.on("error", () =>
      this.failAll(new Error("Codex 실행 파일을 시작하지 못했습니다.")),
    );
    this.child.on("exit", () => {
      this.child = null;
      this.starting = null;
      this.failAll(new Error("Codex 계정 연결이 종료됐습니다."));
      this.emit("closed");
    });
    await this.call(
      "initialize",
      {
        clientInfo: {
          name: "codex_switch",
          title: "Codex Switch",
          version: "0.7.0",
        },
      },
      20000,
    );
    this.send({ method: "initialized", params: {} });
  }
  receive(msg) {
    if ("id" in msg && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error)
        p.reject(
          new Error(
            `Codex 계정 요청을 완료하지 못했습니다. (${msg.error.code ?? "오류"})`,
          ),
        );
      else p.resolve(msg.result);
    } else if ("id" in msg && msg.method) {
      this.send({
        id: msg.id,
        error: { code: -32601, message: "Unsupported account-client request" },
      });
    } else if (msg.method) this.emit(msg.method, msg.params ?? {});
  }
  send(msg) {
    if (!this.child?.stdin.writable)
      throw new Error("Codex 계정 연결이 준비되지 않았습니다.");
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }
  call(method, params = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error("계정 서버 응답 시간이 초과됐습니다. 다시 시도해 주세요."),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  async request(method, params = {}, timeout) {
    await this.start();
    return this.call(method, params, timeout);
  }
  failAll(e) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
  stop() {
    const c = this.child;
    this.child = null;
    this.starting = null;
    this.failAll(new Error("계정 연결을 종료했습니다."));
    if (c) {
      c.stdin.end();
      c.kill("SIGTERM");
      const t = setTimeout(() => c.kill("SIGKILL"), 2000);
      t.unref();
    }
  }
}
