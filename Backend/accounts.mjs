import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { CodexRPC } from "./rpc.mjs";
import { atomicWrite } from "./config.mjs";

export function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch {
    return {};
  }
}
export function normalizeLimits(result) {
  const source = result?.rateLimitsByLimitId;
  const buckets =
    source && Object.keys(source).length
      ? Object.entries(source)
      : [["codex", result?.rateLimits]];
  return buckets
    .filter(([, v]) => v)
    .map(([id, v]) => ({
      id,
      name: v.limitName || (id === "codex" ? "Codex" : id),
      primary: window(v.primary),
      secondary: window(v.secondary),
      blocked: !!v.rateLimitReachedType || v.spendControlReached === true,
      credits: v.credits?.unlimited ? "무제한" : (v.credits?.balance ?? null),
    }));
}
function window(w) {
  return w && Number.isFinite(w.usedPercent)
    ? {
        usedPercent: Math.max(0, Math.min(100, w.usedPercent)),
        remainingPercent: Math.max(0, Math.min(100, 100 - w.usedPercent)),
        durationMins: w.windowDurationMins ?? null,
        resetsAt: w.resetsAt ?? null,
      }
    : null;
}

export class Accounts extends EventEmitter {
  constructor({ directory, primaryHome, binary }) {
    super();
    this.directory = directory;
    this.primaryHome = primaryHome;
    this.binary = binary;
    this.file = path.join(directory, "accounts.json");
    this.clients = new Map();
    this.tokenCache = new Map();
    this.refreshes = new Map();
    this.idleTimers = new Map();
    this.pending = null;
    let saved = [];
    try {
      saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {}
    this.items = [
      {
        id: "current",
        label: "현재 Codex 계정",
        isCurrent: true,
        email: null,
        plan: null,
        status: "loading",
        limits: [],
        updatedAt: null,
      },
      ...(Array.isArray(saved) ? saved : [])
        .filter((a) => a && /^[a-f0-9-]{36}$/.test(a.id))
        .map(({ id, label, email, plan }) => ({
          id,
          label: typeof label === "string" ? label : "추가 계정",
          email: typeof email === "string" ? email : null,
          plan: typeof plan === "string" ? plan : null,
          status: "idle",
          limits: [],
          updatedAt: null,
        })),
    ];
  }
  list() {
    return this.items.map((a) => ({ ...a }));
  }
  save() {
    atomicWrite(
      this.file,
      JSON.stringify(
        this.items
          .filter((a) => !a.isCurrent && a.status !== "loggingIn")
          .map(({ id, label, email, plan }) => ({ id, label, email, plan })),
        null,
        2,
      ),
    );
  }
  changed() {
    this.emit("changed");
  }
  home(id) {
    if (id === "current") return this.primaryHome;
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("알 수 없는 계정입니다.");
    return path.join(this.directory, "accounts", id);
  }
  client(id) {
    if (!this.items.some((a) => a.id === id))
      throw new Error("계정을 찾을 수 없습니다.");
    this.armIdle(id);
    let client = this.clients.get(id);
    if (client) return client;
    const home = this.home(id);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    client = new CodexRPC(this.binary, home, { primary: id === "current" });
    client.on("account/login/completed", (p) => {
      if (this.pending?.id === id) this.finishLogin(id, p).catch(() => {});
    });
    this.clients.set(id, client);
    return client;
  }
  armIdle(id) {
    clearTimeout(this.idleTimers.get(id));
    const timer = setTimeout(() => {
      if (this.pending?.id === id || this.refreshes.has(id)) {
        this.armIdle(id);
        return;
      }
      this.clients.get(id)?.stop();
      this.clients.delete(id);
      this.idleTimers.delete(id);
    }, 90000);
    timer.unref();
    this.idleTimers.set(id, timer);
  }
  async refresh(id) {
    if (this.refreshes.has(id)) return this.refreshes.get(id);
    const promise = this._refresh(id).finally(() => this.refreshes.delete(id));
    this.refreshes.set(id, promise);
    return promise;
  }
  async _refresh(id) {
    const item = this.items.find((a) => a.id === id);
    if (!item || item.status === "loggingIn") return;
    item.refreshing = true;
    this.changed();
    try {
      const client = this.client(id);
      const data = await client.request("account/read", {
        refreshToken: false,
      });
      if (data?.account?.type !== "chatgpt") {
        item.status = "signedOut";
        item.limits = [];
        item.updatedAt = null;
        item.ordinaryUsageAllowed = null;
        this.tokenCache.delete(id);
        item.error = "ChatGPT 로그인이 필요합니다.";
        return;
      }
      item.email = data.account.email;
      item.plan = data.account.planType;
      item.status = "ready";
      item.error = null;
      try {
        const limits = await client.request("account/rateLimits/read", {});
        item.limits = normalizeLimits(limits);
        item.ordinaryUsageAllowed = limits.ordinaryUsageAllowed ?? null;
        item.updatedAt = Date.now() / 1000;
      } catch {
        item.error = "사용량을 조회하지 못했습니다. 잠시 후 새로고침해 주세요.";
      }
      if (id !== "current") this.save();
    } catch {
      item.status = "error";
      item.error =
        "계정에 연결하지 못했습니다. Codex 설치 또는 로그인을 확인해 주세요.";
    } finally {
      item.refreshing = false;
      this.changed();
    }
  }
  async refreshAll() {
    for (let i = 0; i < this.items.length; i += 2)
      await Promise.allSettled(
        this.items
          .slice(i, i + 2)
          .filter((a) => a.status !== "loggingIn")
          .map((a) => this.refresh(a.id)),
      );
  }
  async startLogin(mode = "chatgpt") {
    if (this.pending)
      throw new Error("진행 중인 로그인을 완료하거나 취소해 주세요.");
    const id = crypto.randomUUID();
    const item = {
      id,
      label: "새 계정",
      email: null,
      plan: null,
      status: "loggingIn",
      limits: [],
      updatedAt: null,
    };
    this.items.push(item);
    this.pending = { id, loginId: null };
    this.changed();
    try {
      const result = await this.client(id).request("account/login/start", {
        type: mode === "device" ? "chatgptDeviceCode" : "chatgpt",
      });
      if (this.pending?.id !== id) return {};
      this.pending.loginId = result.loginId;
      item.loginURL = result.authUrl ?? result.verificationUrl;
      item.userCode = result.userCode ?? null;
      const url = new URL(item.loginURL);
      if (
        url.protocol !== "https:" ||
        !["auth.openai.com", "chatgpt.com", "openai.com"].includes(url.hostname)
      )
        throw new Error("로그인 주소를 확인하지 못했습니다.");
      this.changed();
      return { url: item.loginURL, userCode: item.userCode, id };
    } catch (e) {
      await this.cancelLogin();
      throw new Error(
        "로그인을 시작하지 못했습니다. 다른 로그인 창을 닫거나 기기 코드 로그인을 사용해 주세요.",
      );
    }
  }
  async finishLogin(id, p) {
    if (!p.success) {
      await this.cancelLogin();
      this.emit("notice", "로그인이 완료되지 않았습니다. 다시 시도해 주세요.");
      return;
    }
    this.pending = null;
    const item = this.items.find((a) => a.id === id);
    if (!item) return;
    delete item.loginURL;
    delete item.userCode;
    item.status = "idle";
    await this.refresh(id);
    if (item.email) {
      item.label = item.email;
      this.save();
    }
    this.changed();
  }
  async cancelLogin() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const client = this.clients.get(p.id);
    if (p.loginId)
      try {
        await client.request(
          "account/login/cancel",
          { loginId: p.loginId },
          5000,
        );
      } catch {}
    client?.stop();
    clearTimeout(this.idleTimers.get(p.id));
    this.idleTimers.delete(p.id);
    this.clients.delete(p.id);
    this.items = this.items.filter((a) => a.id !== p.id);
    fs.rmSync(this.home(p.id), { recursive: true, force: true });
    this.changed();
  }
  async remove(id) {
    if (id === "current")
      throw new Error("기존 Codex 계정은 이 앱에서 삭제하지 않습니다.");
    if (this.pending?.id === id) return this.cancelLogin();
    if (!this.items.some((a) => a.id === id)) return;
    this.clients.get(id)?.stop();
    clearTimeout(this.idleTimers.get(id));
    this.idleTimers.delete(id);
    this.clients.delete(id);
    this.tokenCache.delete(id);
    this.items = this.items.filter((a) => a.id !== id);
    this.save();
    fs.rmSync(this.home(id), { recursive: true, force: true });
    this.changed();
  }
  async credentials(id, force = false) {
    const cached = this.tokenCache.get(id);
    if (!force && cached && cached.expiresAt > Date.now() + 90000)
      return cached;
    const client = this.client(id);
    const data = await client.request("getAuthStatus", {
      includeToken: true,
      refreshToken: force,
    });
    if (
      !["chatgpt", "chatgptAuthTokens"].includes(data?.authMethod) ||
      !data.authToken
    )
      throw new Error("선택한 계정에 다시 로그인해 주세요.");
    const claims = jwtClaims(data.authToken);
    const auth = claims["https://api.openai.com/auth"] ?? {};
    const accountId = auth.chatgpt_account_id;
    if (!accountId)
      throw new Error("선택한 계정의 식별 정보를 확인하지 못했습니다.");
    const entry = {
      token: data.authToken,
      accountId,
      expiresAt: Number(claims.exp ?? 0) * 1000,
    };
    if (entry.expiresAt < Date.now() + 60000 && !force)
      return this.credentials(id, true);
    this.tokenCache.set(id, entry);
    return entry;
  }
  stop() {
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
    for (const c of this.clients.values()) c.stop();
    this.clients.clear();
    this.tokenCache.clear();
  }
}
