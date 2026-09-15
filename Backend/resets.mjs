import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWrite } from "./config.mjs";

export function resetSummary(result) {
  const count = result?.rateLimitResetCredits?.availableCount;
  const buckets = result?.rateLimitsByLimitId;
  const core =
    buckets && Object.keys(buckets).length ? buckets.codex : result?.rateLimits;
  const eligible =
    (!core?.limitId || core.limitId === "codex") &&
    [core?.primary, core?.secondary].some(
      (w) =>
        [300, 10080].includes(w?.windowDurationMins) &&
        Number.isFinite(w?.usedPercent) &&
        w.usedPercent >= 90,
    );
  return {
    availableCount: Number.isSafeInteger(count) && count >= 0 ? count : null,
    eligible,
  };
}

const outcomes = new Set([
  "reset",
  "alreadyRedeemed",
  "noCredit",
  "nothingToReset",
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// The UI receives a short-lived confirmation challenge, never a general-purpose
// redeem button endpoint. One durable key represents one approved attempt.
export class ResetCredits {
  constructor({
    directory,
    read,
    redeem,
    onResolved = () => {},
    changed = () => {},
    now = Date.now,
    persist = atomicWrite,
  }) {
    this.file = path.join(directory, "reset-attempts.json");
    this.read = read;
    this.redeem = redeem;
    this.onResolved = onResolved;
    this.changed = changed;
    this.now = now;
    this.persist = persist;
    this.attempts = new Map();
    this.notes = new Map();
    this.challenge = null;
    this.busy = false;
    this.storageError = false;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved.version !== 1 || !Array.isArray(saved.attempts))
        throw new Error("invalid journal");
      for (const row of saved.attempts) {
        if (
          typeof row.identity !== "string" ||
          !row.identity ||
          !uuid.test(row.key) ||
          !["pending", "complete"].includes(row.phase) ||
          (row.phase === "complete" && !outcomes.has(row.outcome))
        )
          throw new Error("invalid attempt");
        if (this.attempts.has(row.identity))
          throw new Error("duplicate identity");
        this.attempts.set(row.identity, row);
      }
    } catch (error) {
      if (error.code !== "ENOENT") this.storageError = true;
    }
  }
  status(identity) {
    const note = this.notes.get(identity);
    return {
      pending: this.attempts.get(identity)?.phase === "pending",
      outcome: note && this.now() - note.at < 120000 ? note.outcome : null,
    };
  }
  write(attempt) {
    const next = new Map(this.attempts);
    next.set(attempt.identity, attempt);
    this.persist(
      this.file,
      JSON.stringify({ version: 1, attempts: [...next.values()] }),
    );
    this.attempts = next;
  }
  async exclusive(action) {
    if (this.busy) throw new Error("리셋 요청을 처리 중입니다.");
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async snapshot(id) {
    const value = await this.read(id);
    if (
      !value ||
      typeof value.identity !== "string" ||
      !value.identity ||
      typeof value.email !== "string" ||
      !value.email
    )
      throw new Error(
        "리셋할 계정 정보를 확인하지 못했습니다. 새로고침해 주세요.",
      );
    return value;
  }
  assertEligible(snapshot) {
    if (snapshot.availableCount == null)
      throw new Error(
        "리셋권 정보를 확인하지 못했습니다. Codex 업데이트 또는 새로고침이 필요합니다.",
      );
    if (snapshot.availableCount < 1)
      throw new Error("사용할 리셋권이 없습니다.");
    if (!snapshot.eligible)
      throw new Error(
        "기본 5시간 또는 주간 한도가 10% 이하로 남았을 때 사용할 수 있습니다.",
      );
  }
  prepare(id) {
    return this.exclusive(async () => {
      if (this.storageError)
        throw new Error(
          "이전 리셋 기록을 읽지 못했습니다. 중복 사용을 막기 위해 사용을 중단했습니다.",
        );
      const current = await this.snapshot(id);
      const pending = this.attempts.get(current.identity);
      const retry = pending?.phase === "pending";
      if (!retry) this.assertEligible(current);
      const token = crypto.randomUUID();
      this.challenge = {
        id,
        identity: current.identity,
        email: current.email,
        token,
        key: retry ? pending.key : crypto.randomUUID(),
        retry,
        expires: this.now() + 120000,
      };
      return {
        token,
        email: current.email,
        availableCount: current.availableCount,
        retry,
      };
    });
  }
  cancel(token) {
    if (this.challenge?.token === token) this.challenge = null;
  }
  consume(id, token) {
    return this.exclusive(async () => {
      const approved = this.challenge;
      if (
        !approved ||
        approved.id !== id ||
        approved.token !== token ||
        approved.expires < this.now()
      )
        throw new Error(
          "사용 확인이 만료됐습니다. 리셋권 사용 버튼을 다시 눌러 주세요.",
        );
      this.challenge = null;
      const current = await this.snapshot(id);
      if (
        current.identity !== approved.identity ||
        current.email !== approved.email
      )
        throw new Error(
          "로그인 계정이 변경됐습니다. 대상 계정을 다시 확인해 주세요.",
        );
      // A retry reconciles the same approved attempt even if its first response
      // was lost and the windows now look recovered. It never creates a new key.
      if (!approved.retry) this.assertEligible(current);
      const attempt = {
        identity: approved.identity,
        key: approved.key,
        phase: "pending",
      };
      try {
        this.write(attempt);
      } catch {
        throw new Error("리셋 요청 기록을 저장하지 못해 사용하지 않았습니다.");
      }
      let result;
      try {
        result = await this.redeem(id, { idempotencyKey: approved.key });
      } catch {
        throw new Error(
          "리셋 결과를 확인하지 못했습니다. 결과 확인으로 같은 요청을 다시 확인해 주세요.",
        );
      }
      if (!outcomes.has(result?.outcome))
        throw new Error(
          "리셋 결과를 확인하지 못했습니다. 결과 확인으로 같은 요청을 다시 확인해 주세요.",
        );
      const complete = {
        ...attempt,
        phase: "complete",
        outcome: result.outcome,
      };
      try {
        this.write(complete);
      } catch {
        this.attempts.set(complete.identity, complete);
      }
      this.notes.set(current.identity, {
        outcome: result.outcome,
        at: this.now(),
      });
      // Refresh is independent: a confirmed redemption remains successful even
      // when the following read fails. A persisted pending key stays retry-safe.
      queueMicrotask(() => {
        Promise.resolve()
          .then(() => this.onResolved(id, result.outcome))
          .catch(() => {});
      });
      return { outcome: result.outcome };
    });
  }
}
