import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function catalog(language) {
  const source = fs.readFileSync(
    new URL(
      `../Resources/${language}.lproj/Localizable.strings`,
      import.meta.url,
    ),
    "utf8",
  );
  return new Map(
    [...source.matchAll(/("(?:\\.|[^"\\])*")\s*=\s*("(?:\\.|[^"\\])*");/g)].map(
      ([, key, value]) => [JSON.parse(key), JSON.parse(value)],
    ),
  );
}
const english = catalog("en"),
  korean = catalog("ko");
test("English and Korean catalogs have matching keys and format arguments", () => {
  assert.deepEqual([...english.keys()], [...korean.keys()]);
  for (const [key, value] of english) {
    assert.ok(value.trim(), key);
    assert.deepEqual(
      value.match(/%[@d]/g) ?? [],
      key.match(/%[@d]/g) ?? [],
      key,
    );
    assert.equal(korean.get(key), key);
  }
});
test("all Korean UI literals and static helper messages have English translations", () => {
  for (const filename of [
    "../Sources/CodexSwitch.swift",
    "../Sources/MenuContent.swift",
    "../Backend/accounts.mjs",
    "../Backend/config.mjs",
    "../Backend/main.mjs",
    "../Backend/proxy.mjs",
    "../Backend/rpc.mjs",
    "../Backend/resets.mjs",
  ]) {
    const source = fs.readFileSync(new URL(filename, import.meta.url), "utf8");
    for (const [quoted] of source.matchAll(/"(?:\\.|[^"\\])*"/g)) {
      if (!/[가-힣]/.test(quoted)) continue;
      const key = JSON.parse(quoted);
      assert.ok(english.has(key), `${filename}: missing ${key}`);
    }
  }
});
