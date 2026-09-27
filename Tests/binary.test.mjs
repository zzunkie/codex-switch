import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_BINARY_CANDIDATES, findCodexBinary } from "../Backend/binary.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-binary-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("bundled Codex CLI path precedes older app and Homebrew paths", () => {
  assert.equal(
    CODEX_BINARY_CANDIDATES[0],
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  );
  assert.ok(
    CODEX_BINARY_CANDIDATES.indexOf("/opt/homebrew/bin/codex") > 0,
  );
});

test("binary lookup recovers when an app update moves the executable", () => {
  const oldPath = path.join(root, "old", "codex");
  const newPath = path.join(root, "new", "codex");
  fs.mkdirSync(path.dirname(oldPath), { recursive: true });
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.writeFileSync(oldPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const candidates = [newPath, oldPath];
  assert.equal(findCodexBinary(candidates), oldPath);
  fs.writeFileSync(newPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.equal(findCodexBinary(candidates), newPath);
  fs.rmSync(newPath);
  fs.chmodSync(oldPath, 0o600);
  assert.equal(findCodexBinary(candidates), null);
});
