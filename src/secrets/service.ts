/**
 * The secrets operations behind `job-seeker secrets set|list|delete`.
 * Values go to the chosen backend; the database records only the name and
 * which backend holds it.
 */
import { emitEvent, EngineError, nowIso, type CoreContext } from "../core/context.js";
import { chooseBackend, defaultKeyFile, FileBackend, KeychainBackend, Redactor, type BackendName, type SecretBackend } from "./secrets.js";

const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

function backendByName(ctx: CoreContext, name: BackendName, env: NodeJS.ProcessEnv): SecretBackend {
  return name === "keychain" ? new KeychainBackend(env) : new FileBackend(ctx.dataDir, defaultKeyFile(env));
}

export function setSecret(ctx: CoreContext, name: string, value: string, env: NodeJS.ProcessEnv = process.env) {
  if (!NAME.test(name)) throw new EngineError("a secret name is lowercase letters, digits, dots, dashes and underscores, such as adzuna.app_key");
  if (!value) throw new EngineError("the secret value is empty");
  const existing = ctx.db.prepare("SELECT backend FROM secret_refs WHERE name = ?").get(name) as { backend: BackendName } | undefined;
  const { backend } = chooseBackend(ctx.dataDir, ctx.settings.secrets.backend, env);
  backend.set(name, value);
  if (existing && existing.backend !== backend.name) {
    // Moved backends: drop the old copy so only one place holds the value.
    try {
      backendByName(ctx, existing.backend, env).delete(name);
    } catch {
      // the old backend is gone; nothing to clean up
    }
  }
  const at = nowIso(ctx);
  ctx.db
    .prepare(
      "INSERT INTO secret_refs (name, backend, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET backend = excluded.backend, updated_at = excluded.updated_at",
    )
    .run(name, backend.name, at, at);
  emitEvent(ctx, "secret.set", "secret", name, { backend: backend.name });
  return { name, backend: backend.name, replaced: Boolean(existing) };
}

export function listSecrets(ctx: CoreContext, env: NodeJS.ProcessEnv = process.env) {
  const rows = ctx.db.prepare("SELECT name, backend, updated_at FROM secret_refs ORDER BY name").all() as Array<{
    name: string;
    backend: string;
    updated_at: string;
  }>;
  const wanted = env.JOB_SEEKER_SECRETS_BACKEND || ctx.settings.secrets.backend;
  return {
    backend: wanted,
    detail: wanted === "file" ? "encrypted file outside the data directory's key" : "OS keychain when available, else the encrypted file",
    results: rows.map((r) => ({ ...r })),
  };
}

export function deleteSecret(ctx: CoreContext, name: string, env: NodeJS.ProcessEnv = process.env) {
  const ref = ctx.db.prepare("SELECT backend FROM secret_refs WHERE name = ?").get(name) as { backend: BackendName } | undefined;
  if (!ref) return { name, deleted: false };
  backendByName(ctx, ref.backend, env).delete(name);
  ctx.db.prepare("DELETE FROM secret_refs WHERE name = ?").run(name);
  emitEvent(ctx, "secret.deleted", "secret", name, {});
  return { name, deleted: true };
}

/** A redactor loaded with every stored secret value. */
export function loadRedactor(ctx: CoreContext, env: NodeJS.ProcessEnv = process.env): Redactor {
  const redactor = new Redactor();
  const rows = ctx.db.prepare("SELECT name, backend FROM secret_refs").all() as Array<{ name: string; backend: BackendName }>;
  for (const row of rows) {
    try {
      redactor.add(backendByName(ctx, row.backend, env).get(row.name));
    } catch {
      // an unreadable backend has nothing this process could leak
    }
  }
  return redactor;
}
