// taskul-mail IMAP IDLE worker
//
// 各 mail.accounts レコードに対して IMAP 接続を張り、IDLE で新着 EXISTS を監視。
// 新着を検知したら Supabase imap-sync Function を叩いて取り込みを走らせる。
//
// 落ちても Supabase Cron (5 分毎) がフォールバックで走るので、取りこぼしは発生しない。

import { ImapFlow } from "imapflow";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pino from "pino";
import http from "node:http";

const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.NODE_ENV === "production"
    ? undefined
    : { target: "pino/file", options: { destination: 1 } },
});

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const IMAP_SYNC_URL = `${SUPABASE_URL}/functions/v1/imap-sync`;
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? "3099");
const ACCOUNT_POLL_MS = Number(process.env.ACCOUNT_POLL_MS ?? "60000");
const IDLE_REFRESH_MS = Number(process.env.IDLE_REFRESH_MS ?? String(24 * 60 * 1000));
const SYNC_DEBOUNCE_MS = Number(process.env.SYNC_DEBOUNCE_MS ?? "3000");

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing env: ${key}`);
    process.exit(1);
  }
  return v;
}

const sb: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  db: { schema: "mail" },
});

type Account = {
  id: string;
  email_address: string;
  imap_host: string;
  imap_port: number;
  username: string;
  password_secret_id: string;
};

type WorkerState = {
  account: Account;
  client: ImapFlow | null;
  connected: boolean;
  lastIdleAt: number | null;
  lastSyncAt: number | null;
  lastError: string | null;
  reconnectAttempts: number;
  stopping: boolean;
};

const workers = new Map<string, WorkerState>();

async function readSecret(secretId: string): Promise<string> {
  const { data, error } = await sb.rpc("vault_read_secret", { p_id: secretId });
  if (error) throw new Error(`vault read failed: ${error.message}`);
  if (!data) throw new Error("vault read failed: secret not found");
  return String(data).replace(/[\x00-\x1f\x7f]/g, "").trim();
}

async function listAccounts(): Promise<Account[]> {
  const { data, error } = await sb
    .from("accounts")
    .select("id,email_address,imap_host,imap_port,username,password_secret_id");
  if (error) throw new Error(`accounts fetch failed: ${error.message}`);
  return (data ?? []) as Account[];
}

async function triggerSync(accountId: string, email: string): Promise<void> {
  const state = workers.get(accountId);
  if (state) {
    const now = Date.now();
    if (state.lastSyncAt && now - state.lastSyncAt < SYNC_DEBOUNCE_MS) {
      log.debug({ email }, "sync debounced");
      return;
    }
    state.lastSyncAt = now;
  }
  const url = `${IMAP_SYNC_URL}?account_id=${encodeURIComponent(accountId)}&trigger=idle`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.warn({ email, status: res.status, body: body.slice(0, 200) }, "imap-sync non-2xx");
      return;
    }
    log.info({ email }, "imap-sync triggered");
  } catch (e) {
    log.error({ email, err: (e as Error).message }, "imap-sync fetch failed");
  }
}

function backoffMs(attempts: number): number {
  return Math.min(300_000, 1000 * Math.pow(2, Math.min(attempts, 8)));
}

async function runWorker(account: Account): Promise<void> {
  const state: WorkerState = {
    account,
    client: null,
    connected: false,
    lastIdleAt: null,
    lastSyncAt: null,
    lastError: null,
    reconnectAttempts: 0,
    stopping: false,
  };
  workers.set(account.id, state);

  while (!state.stopping) {
    try {
      const password = await readSecret(account.password_secret_id);
      const client = new ImapFlow({
        host: account.imap_host,
        port: account.imap_port,
        secure: true,
        auth: { user: account.username, pass: password },
        logger: false,
        emitLogs: false,
      });
      state.client = client;

      client.on("error", (err: Error) => {
        log.warn({ email: account.email_address, err: err.message }, "imap client error");
      });

      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      state.connected = true;
      state.reconnectAttempts = 0;
      log.info({ email: account.email_address }, "imap connected, starting IDLE");

      // 接続直後にも 1 回同期 (IDLE を逃している間の新着を拾う)
      void triggerSync(account.id, account.email_address);

      client.on("exists", (data: { count: number; prevCount: number }) => {
        if (data.count > data.prevCount) {
          log.info(
            { email: account.email_address, count: data.count, prev: data.prevCount },
            "EXISTS push received",
          );
          void triggerSync(account.id, account.email_address);
        }
      });

      try {
        // imapflow は mailbox lock を保持中は自動で IDLE を張る。
        // ここでは disconnect を待つだけ。NOOP を定期的に打って回線健全性を確認する。
        const disconnected = new Promise<void>((resolve) => {
          client.once("close", () => resolve());
          client.once("end", () => resolve());
        });
        const refreshTimer = setInterval(() => {
          client.noop().catch((e) => {
            log.warn(
              { email: account.email_address, err: (e as Error).message },
              "noop failed",
            );
          });
          state.lastIdleAt = Date.now();
        }, IDLE_REFRESH_MS);

        try {
          await disconnected;
        } finally {
          clearInterval(refreshTimer);
        }
      } finally {
        lock.release();
      }
    } catch (e) {
      state.lastError = (e as Error).message;
      log.error(
        { email: account.email_address, err: state.lastError },
        "worker loop error",
      );
    } finally {
      state.connected = false;
      try {
        await state.client?.logout();
      } catch {
        // ignore
      }
      state.client = null;
    }

    if (state.stopping) break;
    state.reconnectAttempts++;
    const wait = backoffMs(state.reconnectAttempts);
    log.info(
      { email: account.email_address, wait, attempt: state.reconnectAttempts },
      "reconnecting after backoff",
    );
    await sleep(wait);
  }

  log.info({ email: account.email_address }, "worker stopped");
  workers.delete(account.id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function stopWorker(accountId: string): Promise<void> {
  const state = workers.get(accountId);
  if (!state) return;
  state.stopping = true;
  try {
    await state.client?.logout();
  } catch {
    // ignore
  }
}

async function syncWorkers(): Promise<void> {
  let accounts: Account[];
  try {
    accounts = await listAccounts();
  } catch (e) {
    log.error({ err: (e as Error).message }, "listAccounts failed");
    return;
  }
  const currentIds = new Set(accounts.map((a) => a.id));

  for (const a of accounts) {
    if (!workers.has(a.id)) {
      log.info({ email: a.email_address, id: a.id }, "spawning worker");
      void runWorker(a);
    }
  }
  for (const id of workers.keys()) {
    if (!currentIds.has(id)) {
      log.info({ id }, "removing worker (account deleted)");
      void stopWorker(id);
    }
  }
}

function startHealthServer(): void {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/") {
      const payload = {
        ok: true,
        workers: [...workers.values()].map((w) => ({
          account_id: w.account.id,
          email: w.account.email_address,
          connected: w.connected,
          last_idle_at: w.lastIdleAt,
          last_sync_at: w.lastSyncAt,
          last_error: w.lastError,
          reconnect_attempts: w.reconnectAttempts,
        })),
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload, null, 2));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(HEALTH_PORT, "0.0.0.0", () => {
    log.info({ port: HEALTH_PORT }, "health server listening");
  });
}

async function main(): Promise<void> {
  log.info("taskul-mail-idle starting");
  startHealthServer();
  await syncWorkers();
  setInterval(() => void syncWorkers(), ACCOUNT_POLL_MS);

  const shutdown = async (sig: string) => {
    log.info({ sig }, "shutting down");
    await Promise.all([...workers.keys()].map((id) => stopWorker(id)));
    await sleep(500);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  log.error({ err: (e as Error).message }, "fatal");
  process.exit(1);
});
