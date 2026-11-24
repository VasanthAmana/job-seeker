/**
 * Secrets (design 5.5): the encrypted-file fallback, the CLI-facing
 * operations and the redactor. The real keychain is never touched here.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeCtx, type TestContext } from "../../test/support/core.js";
import { chooseBackend, FileBackend, KeychainBackend, Redactor, SECRETS_FILE, SecretsError } from "./secrets.js";
import { deleteSecret, listSecrets, loadRedactor, setSecret } from "./service.js";

let ctx: TestContext;
let keyDir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  ctx = makeCtx();
  keyDir = mkdtempSync(join(tmpdir(), "job-seeker-key-"));
  env = { VITEST: "true", JOB_SEEKER_SECRET_KEY_FILE: join(keyDir, "secret.key") };
});
afterEach(() => {
  ctx.close();
  rmSync(keyDir, { recursive: true, force: true });
});

describe("encrypted file backend", () => {
  it("round-trips values without writing them in clear", () => {
    const backend = new FileBackend(ctx.dataDir, join(keyDir, "secret.key"));
    backend.set("adzuna.app_key", "fictional-key-123456");
    expect(backend.get("adzuna.app_key")).toBe("fictional-key-123456");
    expect(readFileSync(join(ctx.dataDir, SECRETS_FILE), "utf8")).not.toContain("fictional-key-123456");
    if (process.platform !== "win32") expect(statSync(join(keyDir, "secret.key")).mode & 0o777).toBe(0o600);
    expect(backend.delete("adzuna.app_key")).toBe(true);
    expect(backend.get("adzuna.app_key")).toBeNull();
  });

  it("refuses a key file inside the data directory", () => {
    expect(() => new FileBackend(ctx.dataDir, join(ctx.dataDir, "secret.key"))).toThrow(SecretsError);
  });

  it("refuses to decrypt with the wrong key", () => {
    new FileBackend(ctx.dataDir, join(keyDir, "a.key")).set("x.y", "fictional-value");
    expect(() => new FileBackend(ctx.dataDir, join(keyDir, "b.key")).get("x.y")).toThrow(SecretsError);
  });
});

describe("backend choice", () => {
  it("never loads the keychain under tests", () => {
    expect(() => new KeychainBackend(env)).toThrow(/disabled/);
    expect(() => chooseBackend(ctx.dataDir, "keychain", env)).toThrow(SecretsError);
  });

  it("falls back to the encrypted file on auto, saying why", () => {
    const choice = chooseBackend(ctx.dataDir, "auto", env);
    expect(choice.backend.name).toBe("file");
    expect(choice.detail).toMatch(/not against someone using this OS account/);
  });
});

describe("secrets operations", () => {
  it("set, list (names only), redact and delete", () => {
    expect(setSecret(ctx, "notion.token", "fictional-token-abcdef", env)).toEqual({ name: "notion.token", backend: "file", replaced: false });
    expect(setSecret(ctx, "notion.token", "fictional-token-ghijkl", env).replaced).toBe(true);
    const listed = listSecrets(ctx, env);
    expect(listed.results.map((r) => r.name)).toEqual(["notion.token"]);
    expect(JSON.stringify(listed)).not.toContain("fictional-token");
    expect(JSON.stringify(ctx.db.prepare("SELECT * FROM secret_refs").all())).not.toContain("fictional-token");
    const redactor = loadRedactor(ctx, env);
    expect(redactor.redact("calling with fictional-token-ghijkl now")).toBe("calling with [redacted] now");
    expect(deleteSecret(ctx, "notion.token", env)).toEqual({ name: "notion.token", deleted: true });
    expect(deleteSecret(ctx, "notion.token", env)).toEqual({ name: "notion.token", deleted: false });
    expect(existsSync(join(ctx.dataDir, SECRETS_FILE))).toBe(true);
  });

  it("refuses a malformed name", () => {
    expect(() => setSecret(ctx, "Has Spaces", "value", env)).toThrow(/secret name/);
  });
});

describe("redactor", () => {
  it("masks values and authorization and cookie headers", () => {
    const redactor = new Redactor(["s3cr3t-value"]);
    expect(redactor.redact("token=s3cr3t-value")).toBe("token=[redacted]");
    expect(redactor.redact("Authorization: Bearer abc.def")).toBe("Authorization: [redacted]");
    expect(redactor.redact("Cookie: li_at=xyz")).toBe("Cookie: [redacted]");
  });
});
