import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function atomicWrite(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + ".switch-" + crypto.randomBytes(6).toString("hex");
  const fd = fs.openSync(temporary, "wx", mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

// Only edits scalar root assignments. Multiline TOML strings are tracked so
// text inside instructions is never mistaken for a configuration key/table.
export function rootAssignments(text, key) {
  const lines = text.split(/(?<=\n)/);
  let table = false,
    multi = null;
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!multi && /^\s*\[/.test(line)) table = true;
    if (
      !multi &&
      !table &&
      new RegExp(`^\\s*(?:${key}|"${key}"|'${key}')\\s*=`).test(line)
    )
      matches.push({ index: i, line });
    let quote = null;
    for (let j = 0; j < line.length; j++) {
      if (multi) {
        if (
          line.slice(j, j + 3) === multi &&
          !(multi === '"""' && line[j - 1] === "\\")
        ) {
          multi = null;
          j += 2;
        }
        continue;
      }
      if (quote) {
        if (line[j] === quote && !(quote === '"' && line[j - 1] === "\\"))
          quote = null;
        continue;
      }
      if (line[j] === "#") break;
      if (line.slice(j, j + 3) === '"""' || line.slice(j, j + 3) === "'''") {
        multi = line.slice(j, j + 3);
        j += 2;
        continue;
      }
      if (line[j] === '"' || line[j] === "'") quote = line[j];
    }
  }
  return { lines, matches };
}

export class ConfigLink {
  constructor(file, stateDirectory) {
    this.file = file;
    this.journal = path.join(stateDirectory, "config-link.json");
    this.backups = path.join(stateDirectory, "config-backups");
  }
  read() {
    return fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8") : "";
  }
  record() {
    try {
      return JSON.parse(fs.readFileSync(this.journal, "utf8"));
    } catch {
      return null;
    }
  }
  status() {
    const record = this.record();
    if (!record) return { connected: false, conflict: false };
    return {
      connected: this.read().includes(record.block),
      conflict: !this.read().includes(record.block),
    };
  }
  enable(url) {
    const old = this.record();
    if (old) {
      if (this.read().includes(old.block)) return;
      throw new Error(
        "Codex 설정이 외부에서 변경됐습니다. 기존 설정을 보존하기 위해 연결을 멈췄습니다.",
      );
    }
    const exists = fs.existsSync(this.file);
    const text = this.read();
    const provider = rootAssignments(text, "model_provider").matches;
    if (
      provider.length &&
      !/^\s*(?:model_provider|"model_provider"|'model_provider')\s*=\s*["']openai["']\s*(?:#.*)?(?:\r?\n)?$/.test(
        provider[0].line,
      )
    )
      throw new Error(
        "현재 Codex가 다른 모델 제공자를 사용 중입니다. 기본 OpenAI 제공자로 바꾼 뒤 연결해 주세요.",
      );
    const { lines, matches } = rootAssignments(text, "openai_base_url");
    if (matches.length > 1)
      throw new Error(
        "Codex 설정에 요청 주소가 중복되어 있습니다. 설정을 확인해 주세요.",
      );
    const originalLine = matches[0]?.line ?? null;
    if (
      originalLine &&
      !/^\s*(?:openai_base_url|"openai_base_url"|'openai_base_url')\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*')\s*(?:#.*)?(?:\r?\n)?$/.test(
        originalLine,
      )
    )
      throw new Error("기존 요청 주소 설정을 안전하게 편집할 수 없습니다.");
    const block = `# BEGIN CODEX SWITCH MANAGED ROUTE\nopenai_base_url = ${JSON.stringify(url)}\n# END CODEX SWITCH MANAGED ROUTE\n`;
    fs.mkdirSync(this.backups, { recursive: true, mode: 0o700 });
    const backup = path.join(this.backups, Date.now() + "-config.toml");
    atomicWrite(backup, text);
    if (matches.length) lines.splice(matches[0].index, 1);
    const installedText = block + lines.join("");
    const record = {
      block,
      originalLine,
      existed: exists,
      backup,
      installedHash: crypto
        .createHash("sha256")
        .update(installedText)
        .digest("hex"),
      mode: exists ? fs.statSync(this.file).mode & 0o777 : 0o600,
    };
    atomicWrite(this.journal, JSON.stringify(record));
    try {
      atomicWrite(this.file, installedText, record.mode);
    } catch (e) {
      fs.rmSync(this.journal, { force: true });
      throw e;
    }
  }
  disable() {
    const record = this.record();
    if (!record) return;
    const text = this.read();
    if (!text.includes(record.block))
      throw new Error(
        "연결 설정이 외부에서 변경됐습니다. 다른 변경을 보존하기 위해 자동 복원을 중단했습니다.",
      );
    let result = text.replace(record.block, "");
    if (record.originalLine)
      result = record.originalLine.replace(/\n?$/, "\n") + result;
    if (
      crypto.createHash("sha256").update(text).digest("hex") ===
      record.installedHash
    )
      result = fs.readFileSync(record.backup, "utf8");
    if (!record.existed && !result.trim())
      fs.rmSync(this.file, { force: true });
    else atomicWrite(this.file, result, record.mode);
    fs.rmSync(this.journal, { force: true });
  }
}
