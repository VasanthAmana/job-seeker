/**
 * Secrets (design 5.5): API keys and tokens go in the OS keychain through a
 * maintained native binding (`@napi-rs/keyring`), or, where no keychain
 * backend exists, in an encrypted file whose key file sits outside the data
 * directory with mode 0600. That fallback protects against accidental
 * copies and backups, not against someone using the same OS account.
 *
 * Secrets are entered only through the CLI and never pass through MCP. The
 * database keeps only each secret's name and backend (`secret_refs`), never
 * a value. The redactor masks every stored value in text bound for logs,
 * reports and error messages.
 *
 * Tests never touch the real keychain: under Vitest the keychain backend
 * refuses to load, and the file backend's key path must be given.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const KEYCHAIN_SERVICE = "job-seeker";
export const SECRETS_FILE = "secrets.enc";

export type BackendName = "keychain" | "file";

export interface SecretBackend {
  readonly name: BackendName;
  get(name: string): string | null;
  set(name: string, value: string): void;
  delete(name: string): boolean;
}

export class SecretsError extends Error {
  override name = "SecretsError";
}

// ---------------------------------------------------------------- keychain

interface KeyringEntry {
  setPassword(password: string): void;
  getPassword(): string | null;
  deleteCredential(): boolean;
}

const require = createRequire(import.meta.url);

function keyringModule(): { Entry: new (service: string, account: string) => KeyringEntry } | null {
  try {
    return require("@napi-rs/keyring") as { Entry: new (service: string, account: string) => KeyringEntry };
  } catch {
    return null;
  }
}

export class KeychainBackend implements SecretBackend {
  readonly name = "keychain" as const;
  private readonly Entry: new (service: string, account: string) => KeyringEntry;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    if (env.VITEST || env.JOB_SEEKER_NO_KEYCHAIN === "1") {
      throw new SecretsError("the OS keychain is disabled in this environment");
    }
    const mod = keyringModule();
    if (!mod) throw new SecretsError("no keychain binding is installed for this platform");
    this.Entry = mod.Entry;
  }

  private entry(name: string): KeyringEntry {
    return new this.Entry(KEYCHAIN_SERVICE, name);
  }

  get(name: string): string | null {
    return this.entry(name).getPassword() ?? null;
  }

  set(name: string, value: string): void {
    this.entry(name).setPassword(value);
  }

  delete(name: string): boolean {
    try {
      return this.entry(name).deleteCredential();
    } catch {
      return false;
    }
  }

  /** Round-trip a throwaway entry, to tell a working keychain from a stub. */
  probe(): void {
    const probeName = `probe-${randomBytes(4).toString("hex")}`;
    this.set(probeName, "probe");
    const back = this.get(probeName);
    this.delete(probeName);
    if (back !== "probe") throw new SecretsError("the keychain did not return what was stored");
  }
}

// ---------------------------------------------------------------- encrypted file

/** The key file's default home: the user's config folder, never the data directory. */
export function defaultKeyFile(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.JOB_SEEKER_SECRET_KEY_FILE) return resolve(env.JOB_SEEKER_SECRET_KEY_FILE);
  if (platform === "win32") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "job-seeker", "secret.key");
  if (platform === "darwin") return join(homedir(), "Library", "Preferences", "job-seeker", "secret.key");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "job-seeker", "secret.key");
}

function within(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`);
}

export class FileBackend implements SecretBackend {
  readonly name = "file" as const;
  private readonly file: string;

  constructor(
    private readonly dataDir: string,
    private readonly keyFile: string,
  ) {
    if (within(keyFile, dataDir)) {
      throw new SecretsError("the secrets key file must sit outside the data directory");
    }
    this.file = join(dataDir, SECRETS_FILE);
  }

  private key(create: boolean): Buffer | null {
    if (!existsSync(this.keyFile)) {
      if (!create) return null;
      mkdirSync(dirname(this.keyFile), { recursive: true, mode: 0o700 });
      writeFileSync(this.keyFile, randomBytes(32).toString("base64"), { mode: 0o600 });
    }
    try {
      chmodSync(this.keyFile, 0o600);
    } catch {
      // not every filesystem has POSIX modes (Windows)
    }
    const key = Buffer.from(readFileSync(this.keyFile, "utf8").trim(), "base64");
    if (key.length !== 32) throw new SecretsError(`the secrets key file ${this.keyFile} is not a 32-byte key`);
    return key;
  }

  private load(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    const key = this.key(false);
    if (!key) throw new SecretsError(`the secrets file exists but its key file ${this.keyFile} is missing`);
    const blob = JSON.parse(readFileSync(this.file, "utf8")) as { v: number; iv: string; tag: string; data: string };
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
    decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
    try {
      const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, "base64")), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as Record<string, string>;
    } catch {
      throw new SecretsError("the secrets file could not be decrypted with its key file");
    }
  }

  private save(values: Record<string, string>): void {
    const key = this.key(true) as Buffer;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
    const blob = { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(blob), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get(name: string): string | null {
    return this.load()[name] ?? null;
  }

  set(name: string, value: string): void {
    const values = this.load();
    values[name] = value;
    this.save(values);
  }

  delete(name: string): boolean {
    const values = this.load();
    if (!(name in values)) return false;
    delete values[name];
    this.save(values);
    return true;
  }
}

// ---------------------------------------------------------------- selection

export interface BackendChoice {
  backend: SecretBackend;
  detail: string;
}

/**
 * The backend config.json asks for: `keychain`, `file`, or `auto` (the
 * keychain when it works, else the encrypted file). JOB_SEEKER_SECRETS_BACKEND
 * overrides it.
 */
export function chooseBackend(dataDir: string, wanted: string, env: NodeJS.ProcessEnv = process.env): BackendChoice {
  const choice = env.JOB_SEEKER_SECRETS_BACKEND || wanted;
  const file = () => new FileBackend(dataDir, defaultKeyFile(env));
  if (choice === "file") {
    return { backend: file(), detail: "encrypted file; it protects against accidental copies, not against someone using this OS account" };
  }
  try {
    const keychain = new KeychainBackend(env);
    if (choice === "auto") keychain.probe();
    return { backend: keychain, detail: "OS keychain" };
  } catch (error) {
    if (choice === "keychain") throw error;
    return {
      backend: file(),
      detail: `encrypted file (no usable keychain: ${(error as Error).message}); it protects against accidental copies, not against someone using this OS account`,
    };
  }
}

// ---------------------------------------------------------------- redaction

const MASK = "[redacted]";

/** Masks every known secret value, and authorization and cookie headers. */
export class Redactor {
  private values: string[] = [];

  constructor(values: Iterable<string> = []) {
    for (const value of values) this.add(value);
  }

  add(value: string | null | undefined): void {
    if (!value || value.length < 4) return;
    if (!this.values.includes(value)) {
      this.values.push(value);
      this.values.sort((a, b) => b.length - a.length);
    }
  }

  redact(text: string): string {
    let out = text;
    for (const value of this.values) out = out.split(value).join(MASK);
    out = out.replace(/((?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, `$1${MASK}`);
    return out;
  }
}
