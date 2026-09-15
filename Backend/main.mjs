import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline";
import { Accounts } from "./accounts.mjs";
import { ResetCredits } from "./resets.mjs";
import { RoutingProxy } from "./proxy.mjs";
import { ConfigLink, atomicWrite } from "./config.mjs";

const demo = process.argv.includes("--demo");
const stateArg = process.argv.find((a) => a.startsWith("--state-directory="));
const directory = stateArg
  ? stateArg.slice("--state-directory=".length)
  : path.join(os.homedir(), "Library/Application Support/Codex Switch");
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const lockFile = path.join(directory, "helper.lock");
if (fs.existsSync(lockFile)) {
  let prior = null;
  try {
    prior = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {}
  let alive = false;
  if (Number.isInteger(prior?.pid) && prior.pid > 0)
    try {
      process.kill(prior.pid, 0);
      alive = true;
    } catch (e) {
      alive = e.code !== "ESRCH";
    }
  if (alive) process.exit(73);
  fs.rmSync(lockFile, { force: true });
}
try {
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), {
    flag: "wx",
    mode: 0o600,
  });
} catch {
  process.exit(73);
}
function releaseLock() {
  try {
    if (JSON.parse(fs.readFileSync(lockFile, "utf8")).pid === process.pid)
      fs.rmSync(lockFile, { force: true });
  } catch {}
}
process.on("exit", releaseLock);
const primaryHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const binaryCandidates = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
];
const binary = binaryCandidates.find((p) => fs.existsSync(p));
const settingsFile = path.join(directory, "settings.json");
let settings = {
  selected: "current",
  port: 39147,
  secret: crypto.randomBytes(24).toString("hex"),
  desiredEnabled: false,
};
try {
  settings = {
    ...settings,
    ...JSON.parse(fs.readFileSync(settingsFile, "utf8")),
  };
} catch {}
if (!/^[a-f0-9]{48}$/.test(settings.secret))
  settings.secret = crypto.randomBytes(24).toString("hex");
if (
  !Number.isInteger(settings.port) ||
  settings.port < 1024 ||
  settings.port > 65535
)
  settings.port = 39147;
const save = () => {
  if (!demo) atomicWrite(settingsFile, JSON.stringify(settings));
};
const accounts = new Accounts({ directory, primaryHome, binary });
const link = new ConfigLink(path.join(primaryHome, "config.toml"), directory);
const proxy = new RoutingProxy({
  credentials: (id, force) => accounts.credentials(id, force),
  port: demo ? 0 : settings.port,
  secret: settings.secret,
});
let ready = false,
  enabled = false,
  notice = null,
  closing = false;
let emitTimer = null;
function write(value) {
  if (process.stdout.writable)
    process.stdout.write(JSON.stringify(value) + "\n");
}
const resets = new ResetCredits({
  directory,
  read: async (id) => {
    if (!demo) return accounts.readResetSnapshot(id);
    const item = accounts.items.find((a) => a.id === id);
    if (!item) throw new Error("계정을 찾을 수 없습니다.");
    return { ...item.resetCredits, identity: id, email: item.email };
  },
  redeem: async (id, params) => {
    if (!demo)
      return accounts
        .client(id)
        .request("account/rateLimitResetCredit/consume", params, 30000);
    const item = accounts.items.find((a) => a.id === id);
    item.resetCredits = {
      availableCount: Math.max(0, item.resetCredits.availableCount - 1),
      eligible: false,
    };
    for (const w of [item.limits[0]?.primary, item.limits[0]?.secondary].filter(
      Boolean,
    )) {
      w.usedPercent = 0;
      w.remainingPercent = 100;
    }
    return { outcome: "reset" };
  },
  onResolved: async (id) => {
    if (!demo) {
      const item = accounts.items.find((a) => a.id === id);
      if (item) item.resetCredits = { availableCount: null, eligible: false };
      await accounts.refreshes.get(id);
      await accounts.refresh(id);
    }
    changed();
  },
  changed,
});
function snapshot() {
  return {
    ready,
    enabled,
    selected: settings.selected,
    port: proxy.port,
    binaryAvailable: !!binary,
    accounts: accounts.list().map((a) => ({
      ...a,
      resetCredits: {
        ...a.resetCredits,
        ...resets.status(demo ? a.id : accounts.resetIdentities.get(a.id)),
      },
    })),
    activeRequests: proxy.inFlight,
    totalRequests: proxy.total,
    lastResponseAt: proxy.lastResponseAt,
    lastResponseAccount: proxy.lastResponseAccount,
    lastModel: proxy.lastModel,
    lastErrorAt: proxy.lastErrorAt,
    lastCodexRequestAt: proxy.lastCodexRequestAt ?? null,
    lastProbeResponseAt: proxy.lastProbeResponseAt ?? null,
    lastError: notice ?? proxy.lastError,
    configConflict: demo ? false : link.status().conflict,
    demo,
  };
}
function changed() {
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    write({ event: "state", data: snapshot() });
  }, 40);
}
accounts.on("changed", changed);
accounts.on("notice", (message) => {
  notice = message;
  changed();
});
proxy.on("changed", changed);
const recentlyRefreshed = new Map();
proxy.on("complete", (id) => {
  if (demo || Date.now() - (recentlyRefreshed.get(id) ?? 0) < 30000) return;
  recentlyRefreshed.set(id, Date.now());
  const t = setTimeout(() => accounts.refresh(id).catch(() => {}), 2500);
  t.unref();
});

async function action(method, p = {}) {
  if (method === "state") return snapshot();
  if (method === "prepareReset") return resets.prepare(p.id);
  if (method === "consumeReset") return resets.consume(p.id, p.token);
  if (method === "cancelReset") {
    resets.cancel(p.token);
    return {};
  }
  if (method === "dismissError") {
    notice = null;
    proxy.lastError = null;
    changed();
    return {};
  }
  if (method === "refresh") {
    if (!demo) await accounts.refreshAll();
    return snapshot();
  }
  if (method === "login") {
    if (demo) throw new Error("미리보기에서는 로그인하지 않습니다.");
    if (!binary) throw new Error("Codex 앱 또는 CLI를 먼저 설치해 주세요.");
    return accounts.startLogin(p.mode);
  }
  if (method === "cancelLogin") {
    if (!demo) await accounts.cancelLogin();
    return {};
  }
  if (method === "select") {
    const item = accounts.items.find((a) => a.id === p.id);
    if (!item || item.status === "loggingIn")
      throw new Error("사용할 계정을 선택해 주세요.");
    if (p.id !== "current" && !["ready", "idle"].includes(item.status))
      throw new Error("계정 로그인을 확인한 뒤 선택해 주세요.");
    settings.selected = p.id;
    save();
    proxy.setRoute(p.id, enabled);
    changed();
    return {};
  }
  if (method === "remove") {
    if (settings.selected === p.id) {
      settings.selected = "current";
      proxy.setRoute("current", enabled);
      save();
    }
    if (!demo) await accounts.remove(p.id);
    else accounts.items = accounts.items.filter((a) => a.id !== p.id);
    changed();
    return {};
  }
  if (method === "enable") {
    if (!ready) throw new Error("로컬 프록시가 준비되지 않았습니다.");
    if (!binary && !demo) throw new Error("Codex 앱 또는 CLI가 필요합니다.");
    if (!demo) {
      if (settings.selected !== "current")
        await accounts.credentials(settings.selected);
      link.enable(proxy.baseURL);
    }
    enabled = true;
    settings.desiredEnabled = true;
    save();
    proxy.setRoute(settings.selected, true);
    notice = null;
    changed();
    return {};
  }
  if (method === "disable") {
    if (!demo) link.disable();
    enabled = false;
    settings.desiredEnabled = false;
    save();
    proxy.setRoute(settings.selected, false);
    changed();
    return {};
  }
  if (method === "quit") {
    await shutdown();
    return {};
  }
  throw new Error("지원하지 않는 작업입니다.");
}

async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    if (!demo) link.disable();
  } catch {}
  accounts.stop();
  await proxy.stop().catch(() => {});
  process.exit(0);
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof m.id !== "number" || typeof m.method !== "string") return;
  action(m.method, m.params)
    .then((result) => write({ id: m.id, result }))
    .catch((e) => {
      const message = e?.message || "작업을 완료하지 못했습니다.";
      write({ id: m.id, error: message });
    });
});
input.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

if (demo) {
  const now = Date.now() / 1000;
  const weekly = (used) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    durationMins: 10080,
    resetsAt: now + 172800,
  });
  const pro = (used) => [
    { id: "codex", name: "Codex", primary: weekly(used), secondary: null },
  ];
  const plus = (p, s) => [
    {
      id: "codex",
      name: "Codex",
      primary: {
        usedPercent: p,
        remainingPercent: 100 - p,
        durationMins: 300,
        resetsAt: now + 7200,
      },
      secondary: weekly(s),
    },
  ];
  accounts.items = [
    {
      id: "current",
      isCurrent: true,
      label: "현재 Codex 계정",
      email: "main@example.com",
      plan: "pro",
      status: "ready",
      limits: [
        ...pro(92),
        {
          id: "codex_spark",
          name: "Codex Spark",
          primary: weekly(64),
          secondary: null,
        },
      ],
      updatedAt: now,
    },
    {
      id: "demo-work",
      label: "업무 계정",
      email: "work@example.com",
      plan: "pro",
      status: "ready",
      limits: pro(41),
      updatedAt: now,
    },
    {
      id: "demo-personal",
      label: "개인 계정",
      email: "personal@example.com",
      plan: "plus",
      status: "ready",
      limits: plus(48, 17),
      updatedAt: now,
    },
  ];
  accounts.items[0].resetCredits = { availableCount: 2, eligible: true };
  accounts.items[1].resetCredits = { availableCount: 3, eligible: false };
  accounts.items[2].resetCredits = { availableCount: 0, eligible: false };
  settings.selected = "demo-work";
}
try {
  await proxy.start();
  ready = true;
  if (!demo && settings.desiredEnabled) {
    if (!accounts.items.some((a) => a.id === settings.selected))
      settings.selected = "current";
    link.enable(proxy.baseURL);
    enabled = true;
    proxy.setRoute(settings.selected, true);
  } else if (!demo && link.record()) link.disable();
} catch {
  notice =
    "로컬 프록시를 시작하지 못했습니다. 다른 Codex Switch가 실행 중인지 확인해 주세요.";
}
save();
changed();
if (!demo && binary) accounts.refreshAll().catch(() => {});
const poll = setInterval(() => {
  if (enabled && !demo) accounts.refresh(settings.selected).catch(() => {});
}, 120000);
poll.unref();
