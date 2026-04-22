// supabase/functions/_shared/raw-imap.ts
// Deno TLS ソケットによる最小限の IMAP クライアント。
//
// 目的: Courier-IMAP 上で imapflow の fetchOne({source:true}) / download() が
// 1 通応答後に次の応答を待って hang する現象を回避するため、本文取得だけ
// 生プロトコルで話す。AUTHENTICATE PLAIN (SASL-IR) を使うので LOGIN コマンドで
// 拒否されるパスワード (`}` 等を含むもの) でも認証が通る。
//
// できること: 指定 UID の `BODY.PEEK[]` を Uint8Array で返す。
// それ以外 (envelope 取得・検索) は従来通り imapflow を使う。

/** TLS ソケットからラインや指定バイト数を取り出すバッファ付きリーダ。 */
class IMAPReader {
  private buf = new Uint8Array(0);
  constructor(private conn: Deno.TlsConn) {}

  private async readMore(): Promise<void> {
    const chunk = new Uint8Array(65536);
    const n = await this.conn.read(chunk);
    if (n === null) throw new Error("imap connection closed");
    const merged = new Uint8Array(this.buf.length + n);
    merged.set(this.buf);
    merged.set(chunk.subarray(0, n), this.buf.length);
    this.buf = merged;
  }

  /** `\n` までを (終端含めて) 文字列で返す。 */
  async readLine(): Promise<string> {
    while (true) {
      const idx = this.buf.indexOf(0x0a);
      if (idx >= 0) {
        const out = this.buf.subarray(0, idx + 1);
        this.buf = this.buf.subarray(idx + 1);
        return new TextDecoder("utf-8", { fatal: false }).decode(out);
      }
      await this.readMore();
    }
  }

  /** 指定バイト数を正確に読み取る (literal 本体用)。 */
  async readBytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) await this.readMore();
    const out = new Uint8Array(n);
    out.set(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} (${ms}ms)`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export type RawFetchOptions = {
  host: string;
  port: number;
  user: string;
  pass: string;
  uid: number;
  mailbox?: string;
  timeoutMs?: number;
};

/** 生 IMAP で 1 通の RFC822 ソースを取得する。 */
export async function fetchSourceRawImap(opts: RawFetchOptions): Promise<Uint8Array> {
  const mailbox = opts.mailbox ?? "INBOX";
  const timeout = opts.timeoutMs ?? 60_000;
  const conn = await Deno.connectTls({ hostname: opts.host, port: opts.port });
  const reader = new IMAPReader(conn);
  const enc = new TextEncoder();
  const write = async (s: string) => { await conn.write(enc.encode(s)); };

  // 単一タグまでの応答を全部読み切り、途中の literal を拾って返す。
  // 返値は「その FETCH で受け取った literal のうち最後のもの」と、タグ付き応答文字列。
  const readUntilTagged = async (tag: string): Promise<{ literal: Uint8Array | null; final: string }> => {
    let lastLiteral: Uint8Array | null = null;
    while (true) {
      const line = await reader.readLine();
      if (line.startsWith(tag + " ")) return { literal: lastLiteral, final: line };
      const m = line.match(/\{(\d+)\}\r?\n$/);
      if (m) {
        const size = parseInt(m[1], 10);
        lastLiteral = await reader.readBytes(size);
        // literal 後は行境界じゃないので追いかけでもう 1 行読む
        await reader.readLine();
      }
      // untagged continuation 行 (`+ ...`) や `* ...` はそのまま捨てる
    }
  };

  const run = async (): Promise<Uint8Array> => {
    // greeting
    await reader.readLine();

    // auth (SASL-IR; Courier-IMAP は対応)
    const payload = btoa(`\u0000${opts.user}\u0000${opts.pass}`);
    await write(`a1 AUTHENTICATE PLAIN ${payload}\r\n`);
    const auth = await readUntilTagged("a1");
    if (!/^a1 OK/i.test(auth.final)) {
      throw new Error(`raw-imap auth failed: ${auth.final.trim()}`);
    }

    // SELECT
    await write(`a2 SELECT ${mailbox}\r\n`);
    const sel = await readUntilTagged("a2");
    if (!/^a2 OK/i.test(sel.final)) {
      throw new Error(`raw-imap select failed: ${sel.final.trim()}`);
    }

    // FETCH
    await write(`a3 UID FETCH ${opts.uid} BODY.PEEK[]\r\n`);
    const fetched = await readUntilTagged("a3");
    if (!/^a3 OK/i.test(fetched.final)) {
      throw new Error(`raw-imap fetch failed: ${fetched.final.trim()}`);
    }
    if (!fetched.literal) {
      throw new Error(`raw-imap fetch returned no BODY[] for uid=${opts.uid}`);
    }

    // LOGOUT (best-effort)
    try { await write(`a4 LOGOUT\r\n`); } catch { /* ignore */ }
    try { await reader.readLine(); } catch { /* ignore */ }

    return fetched.literal;
  };

  try {
    return await withTimeout(run(), timeout, `raw-imap timeout uid=${opts.uid}`);
  } finally {
    try { conn.close(); } catch { /* ignore */ }
  }
}

export type TrashOptions = {
  host: string;
  port: number;
  user: string;
  pass: string;
  uids: number[];
  mailbox?: string;
  /** 明示的な Trash フォルダ名 (未指定なら LIST で自動検出 → 一般的な名前で推定) */
  trashMailbox?: string;
  timeoutMs?: number;
};

export type TrashResult = {
  trashMailbox: string;
  moved: number[];
  method: "move" | "copy-expunge";
};

/** 生 IMAP で複数 UID を Trash フォルダへ移動する (RFC 6851 MOVE 優先、未対応なら COPY+STORE+EXPUNGE)。 */
export async function moveToTrashRawImap(opts: TrashOptions): Promise<TrashResult> {
  const mailbox = opts.mailbox ?? "INBOX";
  const timeout = opts.timeoutMs ?? 45_000;
  if (opts.uids.length === 0) {
    return { trashMailbox: opts.trashMailbox ?? "Trash", moved: [], method: "move" };
  }

  const conn = await Deno.connectTls({ hostname: opts.host, port: opts.port });
  const reader = new IMAPReader(conn);
  const enc = new TextEncoder();
  const write = async (s: string) => { await conn.write(enc.encode(s)); };

  let seq = 0;
  const nextTag = () => `a${++seq}`;

  /** untagged レスポンス行 (buffered) を含め、指定 tag の最終応答まで読み進める。 */
  const readUntilTagged = async (tag: string): Promise<{ lines: string[]; final: string }> => {
    const lines: string[] = [];
    while (true) {
      const line = await reader.readLine();
      if (line.startsWith(tag + " ")) return { lines, final: line };
      // literal が来たら読み飛ばす
      const m = line.match(/\{(\d+)\}\r?\n$/);
      if (m) {
        const size = parseInt(m[1], 10);
        await reader.readBytes(size);
        await reader.readLine();
        continue;
      }
      lines.push(line);
    }
  };

  const run = async (): Promise<TrashResult> => {
    // greeting
    await reader.readLine();

    // AUTH
    const payload = btoa(`\u0000${opts.user}\u0000${opts.pass}`);
    const authTag = nextTag();
    await write(`${authTag} AUTHENTICATE PLAIN ${payload}\r\n`);
    const auth = await readUntilTagged(authTag);
    if (!/OK/i.test(auth.final.split(" ")[1] ?? "")) {
      throw new Error(`raw-imap auth failed: ${auth.final.trim()}`);
    }

    // CAPABILITY
    const capTag = nextTag();
    await write(`${capTag} CAPABILITY\r\n`);
    const cap = await readUntilTagged(capTag);
    const caps = cap.lines.join(" ").toUpperCase();
    const hasMove = /\sMOVE\b/.test(caps);

    // Trash フォルダを決定 (明示指定 > SPECIAL-USE > 名前推定)
    let trashName = opts.trashMailbox ?? "";
    if (!trashName) {
      const listTag = nextTag();
      await write(`${listTag} LIST "" "*"\r\n`);
      const list = await readUntilTagged(listTag);
      // * LIST (\HasNoChildren \Trash) "/" "INBOX.Trash"
      for (const line of list.lines) {
        if (/\\Trash/i.test(line)) {
          const m = line.match(/"([^"]+)"\s*$/) || line.match(/\s(\S+)\s*\r?\n?$/);
          if (m) { trashName = m[1]; break; }
        }
      }
      if (!trashName) {
        // 名前推定フォールバック
        const lower = list.lines.map((l) => l.toLowerCase()).join("\n");
        const candidates = ["INBOX.Trash", "Trash", "ゴミ箱", "Deleted Messages", "Deleted Items"];
        for (const c of candidates) {
          if (lower.includes(c.toLowerCase())) { trashName = c; break; }
        }
      }
      if (!trashName) trashName = "Trash";
    }

    // SELECT INBOX (read-write)
    const selTag = nextTag();
    await write(`${selTag} SELECT ${mailbox}\r\n`);
    const sel = await readUntilTagged(selTag);
    if (!/OK/i.test(sel.final.split(" ")[1] ?? "")) {
      throw new Error(`raw-imap select failed: ${sel.final.trim()}`);
    }

    const uidSet = opts.uids.join(",");
    let method: "move" | "copy-expunge";

    if (hasMove) {
      const mvTag = nextTag();
      await write(`${mvTag} UID MOVE ${uidSet} "${trashName}"\r\n`);
      const mv = await readUntilTagged(mvTag);
      if (!/OK/i.test(mv.final.split(" ")[1] ?? "")) {
        throw new Error(`raw-imap UID MOVE failed: ${mv.final.trim()}`);
      }
      method = "move";
    } else {
      // COPY → STORE \Deleted → EXPUNGE
      const cpTag = nextTag();
      await write(`${cpTag} UID COPY ${uidSet} "${trashName}"\r\n`);
      const cp = await readUntilTagged(cpTag);
      if (!/OK/i.test(cp.final.split(" ")[1] ?? "")) {
        throw new Error(`raw-imap UID COPY failed: ${cp.final.trim()}`);
      }
      const stTag = nextTag();
      await write(`${stTag} UID STORE ${uidSet} +FLAGS.SILENT (\\Deleted)\r\n`);
      const st = await readUntilTagged(stTag);
      if (!/OK/i.test(st.final.split(" ")[1] ?? "")) {
        throw new Error(`raw-imap UID STORE failed: ${st.final.trim()}`);
      }
      const exTag = nextTag();
      await write(`${exTag} EXPUNGE\r\n`);
      const ex = await readUntilTagged(exTag);
      if (!/OK/i.test(ex.final.split(" ")[1] ?? "")) {
        throw new Error(`raw-imap EXPUNGE failed: ${ex.final.trim()}`);
      }
      method = "copy-expunge";
    }

    // LOGOUT (best-effort)
    try { await write(`${nextTag()} LOGOUT\r\n`); } catch { /* ignore */ }

    return { trashMailbox: trashName, moved: opts.uids, method };
  };

  try {
    return await withTimeout(run(), timeout, `raw-imap trash timeout`);
  } finally {
    try { conn.close(); } catch { /* ignore */ }
  }
}
