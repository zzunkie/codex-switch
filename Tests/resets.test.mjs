import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ResetCredits, resetSummary } from "../Backend/resets.mjs";
import { Accounts } from "../Backend/accounts.mjs";

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-switch-resets-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = {
    identity: "account-A",
    email: "a@example.com",
    availableCount: 2,
    eligible: true,
  };
  const calls = [];
  const defaults = {
    directory,
    read: async () => ({ ...state }),
    redeem: async (id, params) => {
      calls.push({ id, ...params });
      return { outcome: "reset" };
    },
  };
  return {
    directory,
    state,
    calls,
    make: (extra) => new ResetCredits({ ...defaults, ...options, ...extra }),
  };
}

test("reset count distinguishes unavailable data from zero; only core 5h/week windows qualify", () => {
  assert.deepEqual(resetSummary({}), { availableCount: null, eligible: false });
  assert.equal(
    resetSummary({ rateLimitResetCredits: { availableCount: 0 } })
      .availableCount,
    0,
  );
  for (const count of [-1, 1.5, "3", null])
    assert.equal(
      resetSummary({ rateLimitResetCredits: { availableCount: count } })
        .availableCount,
      null,
    );
  assert.equal(
    resetSummary({
      rateLimits: {
        limitId: "codex_spark",
        primary: { usedPercent: 100, windowDurationMins: 300 },
      },
    }).eligible,
    false,
  );
  const w = (used, duration = 10080) => ({
    usedPercent: used,
    windowDurationMins: duration,
  });
  assert.equal(resetSummary({ rateLimits: { primary: w(90) } }).eligible, true);
  assert.equal(
    resetSummary({ rateLimits: { primary: w(89.9), secondary: w(90, 300) } })
      .eligible,
    true,
  );
  assert.equal(
    resetSummary({ rateLimits: { primary: w(89.9) } }).eligible,
    false,
  );
  assert.equal(
    resetSummary({ rateLimits: { primary: w(100, 60) } }).eligible,
    false,
  );
  assert.equal(
    resetSummary({
      rateLimits: { primary: w(100) },
      rateLimitsByLimitId: { spark: { primary: w(100) } },
    }).eligible,
    false,
  );
  assert.equal(
    resetSummary({
      rateLimitsByLimitId: {
        codex: { primary: w(50) },
        spark: { primary: w(100) },
      },
    }).eligible,
    false,
  );
});

test("prepare and cancel never redeem; one confirmed account-bound attempt is sent", async (t) => {
  const f = fixture(t),
    service = f.make();
  const preview = await service.prepare("local-A");
  assert.equal(preview.availableCount, 2);
  assert.equal(preview.email, "a@example.com");
  assert.equal(f.calls.length, 0);
  service.cancel(preview.token);
  await assert.rejects(service.consume("local-A", preview.token));
  assert.equal(f.calls.length, 0);
  const second = await service.prepare("local-A");
  await assert.rejects(service.consume("local-B", second.token));
  const result = await service.consume("local-A", second.token);
  assert.equal(result.outcome, "reset");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].id, "local-A");
  assert.match(f.calls[0].idempotencyKey, /^[a-f0-9-]{36}$/);
  await assert.rejects(service.consume("local-A", second.token));
  assert.equal(f.calls.length, 1);
  const saved = JSON.parse(
    fs.readFileSync(path.join(f.directory, "reset-attempts.json"), "utf8"),
  );
  assert.equal(saved.attempts[0].phase, "complete");
  assert.equal(JSON.stringify(saved).includes("a@example.com"), false);
  if (process.platform !== "win32")
    assert.equal(
      fs.statSync(path.join(f.directory, "reset-attempts.json")).mode & 0o777,
      0o600,
    );
});

test("zero, unknown, and ineligible credits are refused without a redemption", async (t) => {
  const f = fixture(t),
    service = f.make();
  for (const count of [0, null]) {
    f.state.availableCount = count;
    await assert.rejects(service.prepare("a"));
  }
  f.state.availableCount = 3;
  f.state.eligible = false;
  await assert.rejects(service.prepare("a"));
  assert.equal(f.calls.length, 0);
});

test("fresh usage and identity are checked again after confirmation", async (t) => {
  const f = fixture(t),
    service = f.make();
  const first = await service.prepare("a");
  f.state.eligible = false;
  await assert.rejects(service.consume("a", first.token));
  f.state.eligible = true;
  const second = await service.prepare("a");
  f.state.identity = "account-B";
  await assert.rejects(service.consume("a", second.token));
  f.state.identity = "account-A";
  const third = await service.prepare("a");
  f.state.availableCount = 0;
  await assert.rejects(service.consume("a", third.token));
  assert.equal(f.calls.length, 0);
});

test("expired confirmations cannot redeem", async (t) => {
  let now = 1000;
  const f = fixture(t, { now: () => now }),
    service = f.make();
  const preview = await service.prepare("a");
  now += 120001;
  await assert.rejects(service.consume("a", preview.token));
  assert.equal(f.calls.length, 0);
});

test("an unknown response survives restart and reconciles with the identical key", async (t) => {
  const f = fixture(t);
  const used = new Set();
  let spent = 0;
  const redeem = async (id, params) => {
    f.calls.push(params.idempotencyKey);
    if (used.has(params.idempotencyKey)) return { outcome: "alreadyRedeemed" };
    used.add(params.idempotencyKey);
    spent++;
    f.state.availableCount = 0;
    f.state.eligible = false;
    throw new Error("synthetic lost response");
  };
  const service = f.make({ redeem });
  const preview = await service.prepare("a");
  await assert.rejects(service.consume("a", preview.token));
  assert.equal(service.status("account-A").pending, true);
  const restarted = f.make({ redeem });
  const retry = await restarted.prepare("a");
  assert.equal(retry.retry, true);
  assert.equal(
    (await restarted.consume("a", retry.token)).outcome,
    "alreadyRedeemed",
  );
  assert.equal(spent, 1);
  assert.equal(f.calls[0], f.calls[1]);
  assert.equal(restarted.status("account-A").pending, false);
});

test("pending keys cannot cross account identities", async (t) => {
  const f = fixture(t, {
      redeem: async () => {
        throw new Error("offline");
      },
    }),
    service = f.make();
  const preview = await service.prepare("a");
  await assert.rejects(service.consume("a", preview.token));
  f.state.identity = "account-B";
  f.state.email = "b@example.com";
  const other = await service.prepare("a");
  assert.equal(other.retry, false);
  assert.equal(service.status("account-A").pending, true);
});

test("reset/no-op outcomes remain definitive when the follow-up refresh fails", async (t) => {
  for (const outcome of [
    "reset",
    "alreadyRedeemed",
    "noCredit",
    "nothingToReset",
  ]) {
    const f = fixture(t),
      service = f.make({
        redeem: async () => ({ outcome }),
        onResolved: async () => {
          throw new Error("refresh failed");
        },
      });
    const preview = await service.prepare("a");
    assert.equal((await service.consume("a", preview.token)).outcome, outcome);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.status("account-A").pending, false);
    assert.equal(service.status("account-A").outcome, outcome);
  }
});

test("malformed outcomes remain pending and are not automatically retried", async (t) => {
  const f = fixture(t),
    service = f.make({
      redeem: async (id, params) => {
        f.calls.push(params);
        return {};
      },
    });
  const preview = await service.prepare("a");
  await assert.rejects(service.consume("a", preview.token));
  assert.equal(f.calls.length, 1);
  assert.equal(service.status("account-A").pending, true);
});

test("a journal write failure prevents the request; a post-success write failure cannot undo success", async (t) => {
  const f = fixture(t),
    blocked = f.make({
      persist: () => {
        throw new Error("disk full");
      },
    });
  const preview = await blocked.prepare("a");
  await assert.rejects(blocked.consume("a", preview.token));
  assert.equal(f.calls.length, 0);
  let writes = 0;
  const { atomicWrite } = await import("../Backend/config.mjs");
  const service = f.make({
    persist: (...args) => {
      if (++writes === 2) throw new Error("disk full");
      atomicWrite(...args);
    },
  });
  const next = await service.prepare("a");
  assert.equal((await service.consume("a", next.token)).outcome, "reset");
  assert.equal(service.status("account-A").pending, false);
  assert.equal(f.make().status("account-A").pending, true);
});

test("a corrupted journal fails closed before preparing a new reset", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, "reset-attempts.json"), "broken");
  await assert.rejects(f.make().prepare("a"));
  assert.equal(f.calls.length, 0);
});

test("concurrent clicks cannot submit two redemptions", async (t) => {
  let finish;
  const f = fixture(t),
    service = f.make({ redeem: async () => new Promise((r) => (finish = r)) });
  const preview = await service.prepare("a");
  const pending = service.consume("a", preview.token);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(service.consume("a", preview.token));
  await assert.rejects(service.prepare("a"));
  finish({ outcome: "reset" });
  assert.equal((await pending).outcome, "reset");
});

test("Accounts reads fresh reset data through the intended official account client only", async (t) => {
  const f = fixture(t),
    accounts = new Accounts({
      directory: f.directory,
      primaryHome: f.directory,
      binary: "/unused",
    });
  t.after(() => accounts.stop());
  const calls = [];
  accounts.clients.set("current", {
    stop() {},
    request: async (method, params) => {
      calls.push({ method, params });
      return method === "account/read"
        ? {
            account: {
              type: "chatgpt",
              email: "a@example.com",
              planType: "pro",
            },
          }
        : {
            accountId: "account-A",
            rateLimitResetCredits: { availableCount: 3 },
            rateLimits: {
              primary: { usedPercent: 92, windowDurationMins: 10080 },
            },
          };
    },
  });
  const snapshot = await accounts.readResetSnapshot("current");
  assert.equal(snapshot.identity, "account-A");
  assert.equal(snapshot.availableCount, 3);
  assert.equal(snapshot.eligible, true);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["account/read", "account/rateLimits/read"],
  );
  assert.equal(calls[1].params.excludeResetCreditDetails, true);
});
