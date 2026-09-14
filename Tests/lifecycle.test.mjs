import test, { after } from "node:test";
import os from "node:os";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-lifecycle-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const main = fileURLToPath(new URL("../Backend/main.mjs", import.meta.url));
function launch(directory) {
  const proc = spawn(
    process.execPath,
    [main, "--demo", "--state-directory=" + directory],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending = new Map();
  let id = 0;
  let firstResolve;
  const initial = new Promise((r) => (firstResolve = r));
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    const m = JSON.parse(line);
    if (m.event === "state") firstResolve(m.data);
    if ("id" in m && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const request = async (method) =>
    new Promise((resolve) => {
      const rid = ++id;
      pending.set(rid, resolve);
      proc.stdin.write(
        JSON.stringify({
          id: rid,
          method: typeof method === "string" ? method : method.method,
          params: method.params ?? {},
        }) + "\n",
      );
    });
  return { proc, initial, request };
}
test("packaged helper protocol supports selection, connection and clean shutdown without real login", async (t) => {
  const dir = fs.mkdtempSync(path.join(root, "lifecycle-"));
  const helper = launch(dir);
  t.after(() => helper.proc.kill());
  const state = await helper.initial;
  assert.equal(state.ready, true);
  assert.equal(state.enabled, false);
  assert.equal(state.accounts[0].limits[0].primary.durationMins, 10080);
  assert.equal(state.accounts[2].limits[0].primary.durationMins, 300);
  await helper.request({ method: "select", params: { id: "demo-personal" } });
  await helper.request("enable");
  const active = (await helper.request("state")).result;
  assert.equal(active.selected, "demo-personal");
  assert.equal(active.enabled, true);
  await helper.request("disable");
  assert.equal((await helper.request("state")).result.enabled, false);
  const exited = once(helper.proc, "exit");
  helper.proc.stdin.end();
  assert.equal((await exited)[0], 0);
  assert.equal(fs.existsSync(path.join(dir, "helper.lock")), false);
  assert.equal(fs.existsSync(path.join(dir, "config-link.json")), false);
});
test("a second helper cannot take ownership of the same state or stop the active helper", async (t) => {
  const dir = fs.mkdtempSync(path.join(root, "lock-"));
  const first = launch(dir);
  t.after(() => first.proc.kill());
  await first.initial;
  const second = launch(dir);
  const [code] = await once(second.proc, "exit");
  assert.equal(code, 73);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "helper.lock"), "utf8")).pid,
    first.proc.pid,
  );
  assert.equal((await first.request("state")).result.ready, true);
  const exited = once(first.proc, "exit");
  first.proc.stdin.end();
  await exited;
});
