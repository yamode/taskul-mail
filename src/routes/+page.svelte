<script lang="ts">
  import { supabase, mail, fnUrl, authHeader } from "$lib/supabase";
  import { onMount, onDestroy } from "svelte";

  type Thread = {
    id: string;
    account_id: string;
    subject_normalized: string;
    participants: string[];
    last_message_at: string;
    message_count: number;
    account_label?: string;
    unread_count?: number;
  };
  type Message = {
    id: string;
    account_id?: string;
    thread_id?: string | null;
    from_address: string | null;
    from_name: string | null;
    to_addresses?: string[];
    cc_addresses?: string[];
    subject: string | null;
    body_text: string | null;
    received_at: string;
    direction: string;
  };
  type Account = { id: string; label: string; is_shared: boolean; sort_order?: number; unread_count?: number };

  let threads = $state<Thread[]>([]);
  let accounts = $state<Account[]>([]);
  let filterAccountId = $state<string>("all");
  let selectedThreadId = $state<string | null>(null);
  let messages = $state<Message[]>([]);
  let selectedMessageId = $state<string | null>(null);
  let draft = $state<{ subject: string; body_text: string; id: string } | null>(null);
  let generating = $state(false);
  let sending = $state(false);
  let hint = $state("");
  let userId = $state<string | null>(null);

  let filtered = $derived(
    filterAccountId === "all"
      ? threads
      : threads.filter((t) => t.account_id === filterAccountId),
  );

  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let syncing = $state(false);

  async function syncTick() {
    if (typeof document !== "undefined" && document.hidden) return;
    if (syncing) return;
    syncing = true;
    try {
      await fetch(fnUrl("imap-sync"), {
        method: "POST",
        headers: await authHeader(),
      });
      await loadThreads();
      if (selectedThreadId) await loadMessages(selectedThreadId);
    } catch (e) {
      console.error("sync tick failed", e);
    } finally {
      syncing = false;
    }
  }

  function onVisibility() {
    if (!document.hidden) void syncTick();
  }

  onMount(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    userId = user?.id ?? null;
    await Promise.all([loadAccounts(), loadThreads()]);

    // 受信トレイを開いている間は 60 秒ごとに IMAP 同期 → スレッド再読込。
    // タブが非アクティブな間はスキップし、フォーカスが戻ったら即 1 回同期する。
    syncTimer = setInterval(syncTick, 60_000);
    document.addEventListener("visibilitychange", onVisibility);
    void syncTick();
  });

  onDestroy(() => {
    if (syncTimer) clearInterval(syncTimer);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
  });

  async function loadAccounts() {
    const { data } = await mail
      .from("accounts")
      .select("id,label,is_shared,sort_order")
      .order("sort_order")
      .order("created_at");
    accounts = (data ?? []) as Account[];
  }

  // D&D 並び替え: sort_order をまとめて更新。楽観的に UI を先に更新し、失敗したら再読込。
  let dragId = $state<string | null>(null);
  async function onDropAccount(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const reordered = [...accounts];
    const from = reordered.findIndex((a) => a.id === dragId);
    const to = reordered.findIndex((a) => a.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    accounts = reordered;
    dragId = null;
    try {
      await Promise.all(
        reordered.map((a, i) =>
          mail.from("accounts").update({ sort_order: i + 1 }).eq("id", a.id),
        ),
      );
    } catch (e) {
      console.error("reorder failed", e);
      await loadAccounts();
    }
  }

  // 新着スレッド検出用: 前回ロード時のスレッドIDセット。
  // ここにない ID が新たに出現したらアニメーション対象とする。
  let knownThreadIds = new Set<string>();
  let newThreadIds = $state<Set<string>>(new Set());

  async function loadThreads() {
    const { data, error } = await mail
      .from("threads")
      .select(
        "id,account_id,subject_normalized,participants,last_message_at,message_count,accounts(label)",
      )
      .order("last_message_at", { ascending: false })
      .limit(100);
    if (error) { console.error(error); return; }
    const base: Thread[] = (data ?? []).map((t: any) => ({
      ...t,
      account_label: t.accounts?.label,
    }));

    // 未読カウント: inbound メッセージ数 - 自分の既読数
    const perAccount = new Map<string, number>();
    if (base.length > 0 && userId) {
      const threadIds = base.map((t) => t.id);
      const [{ data: inbound }, { data: reads }] = await Promise.all([
        mail
          .from("messages")
          .select("id,thread_id,account_id")
          .in("thread_id", threadIds)
          .eq("direction", "inbound"),
        mail
          .from("message_reads")
          .select("message_id")
          .eq("user_id", userId),
      ]);
      const readSet = new Set((reads ?? []).map((r: any) => r.message_id));
      const counts = new Map<string, number>();
      for (const m of (inbound ?? []) as any[]) {
        if (!readSet.has(m.id)) {
          counts.set(m.thread_id, (counts.get(m.thread_id) ?? 0) + 1);
          perAccount.set(m.account_id, (perAccount.get(m.account_id) ?? 0) + 1);
        }
      }
      for (const t of base) t.unread_count = counts.get(t.id) ?? 0;
    }

    // 未読カウントをアカウントに反映
    accounts = accounts.map((a) => ({
      ...a,
      unread_count: perAccount.get(a.id) ?? 0,
    }));

    // 新着スレッド検出 (初回ロード時はアニメなし)
    const justArrived = new Set<string>();
    if (knownThreadIds.size > 0) {
      for (const t of base) {
        if (!knownThreadIds.has(t.id)) justArrived.add(t.id);
      }
    }
    knownThreadIds = new Set(base.map((t) => t.id));
    if (justArrived.size > 0) {
      newThreadIds = justArrived;
      // 3 秒後にアニメーション対象から外す
      setTimeout(() => { newThreadIds = new Set(); }, 3000);
    }
    threads = base;
  }

  async function loadMessages(threadId: string) {
    const { data } = await mail
      .from("messages")
      .select(
        "id,account_id,thread_id,from_address,from_name,to_addresses,cc_addresses,subject,body_text,received_at,direction",
      )
      .eq("thread_id", threadId)
      .order("received_at", { ascending: true });
    messages = (data ?? []) as Message[];
  }

  async function openThread(t: Thread) {
    selectedThreadId = t.id;
    selectedMessageId = null;
    draft = null;
    await loadMessages(t.id);
    if (messages.length > 0) {
      const last = [...messages].reverse().find((m) => m.direction === "inbound");
      if (last) {
        selectedMessageId = last.id;
        markRead(last.id);
      }
    }
  }

  async function startManualReply(replyAll = false) {
    if (!selectedMessageId) return;
    const src = messages.find((m) => m.id === selectedMessageId);
    if (!src || !src.account_id) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const subject = src.subject?.match(/^\s*re\s*:/i) ? src.subject : `Re: ${src.subject ?? ""}`;
    const to = src.from_address ? [src.from_address] : [];
    const cc = replyAll
      ? [...(src.to_addresses ?? []), ...(src.cc_addresses ?? [])]
          .filter((a) => a && a !== src.from_address)
      : [];
    const quoted = (src.body_text ?? "")
      .split("\n").map((l) => `> ${l}`).join("\n");
    const body = `\n\n--- ${new Date(src.received_at).toLocaleString("ja-JP")} ${src.from_name ?? src.from_address ?? ""} さんが書きました ---\n${quoted}`;

    const { data, error } = await mail
      .from("drafts")
      .insert({
        account_id: src.account_id,
        author_id: user.id,
        in_reply_to_message_id: src.id,
        thread_id: src.thread_id ?? null,
        to_addresses: to,
        cc_addresses: cc,
        subject,
        body_text: body,
        generated_by_ai: false,
        status: "draft",
      })
      .select("id,subject,body_text")
      .single();
    if (error) { alert(`下書き作成失敗: ${error.message}`); return; }
    draft = { id: data!.id, subject: data!.subject ?? subject, body_text: data!.body_text ?? body };
  }

  async function startForward() {
    if (!selectedMessageId) return;
    const src = messages.find((m) => m.id === selectedMessageId);
    if (!src || !src.account_id) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const subject = src.subject?.match(/^\s*fwd?\s*:/i) ? src.subject : `Fwd: ${src.subject ?? ""}`;
    const header =
      `\n\n--- 転送メッセージ ---\n` +
      `From: ${src.from_name ? `${src.from_name} <${src.from_address}>` : src.from_address ?? ""}\n` +
      `Date: ${new Date(src.received_at).toLocaleString("ja-JP")}\n` +
      `Subject: ${src.subject ?? ""}\n` +
      `To: ${(src.to_addresses ?? []).join(", ")}\n\n`;
    const body = header + (src.body_text ?? "");

    const { data, error } = await mail
      .from("drafts")
      .insert({
        account_id: src.account_id,
        author_id: user.id,
        in_reply_to_message_id: null,
        thread_id: null,
        to_addresses: [],
        cc_addresses: [],
        subject,
        body_text: body,
        generated_by_ai: false,
        status: "draft",
      })
      .select("id,subject,body_text")
      .single();
    if (error) { alert(`下書き作成失敗: ${error.message}`); return; }
    draft = { id: data!.id, subject: data!.subject ?? subject, body_text: data!.body_text ?? body };
  }

  async function generateDraft() {
    if (!selectedMessageId) return;
    generating = true;
    draft = null;
    try {
      const res = await fetch(fnUrl("generate-draft"), {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ message_id: selectedMessageId, hint: hint || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "failed");
      draft = { id: json.draft_id, subject: json.subject, body_text: json.body_text };
    } catch (e) {
      alert(`下書き生成失敗: ${(e as Error).message}`);
    } finally {
      generating = false;
    }
  }

  async function saveDraftEdits() {
    if (!draft) return;
    await mail
      .from("drafts")
      .update({ subject: draft.subject, body_text: draft.body_text })
      .eq("id", draft.id);
  }

  async function sendDraft() {
    if (!draft) return;
    if (!confirm("この下書きで送信しますか？")) return;
    sending = true;
    try {
      await saveDraftEdits();
      const res = await fetch(fnUrl("send-mail"), {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ draft_id: draft.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "failed");
      alert("送信しました");
      draft = null;
      if (selectedThreadId) {
        const t = threads.find((x) => x.id === selectedThreadId);
        if (t) await openThread(t);
      }
    } catch (e) {
      alert(`送信失敗: ${(e as Error).message}`);
    } finally {
      sending = false;
    }
  }

  async function markRead(messageId: string) {
    if (!userId) return;
    // upsert でなく insert + 重複無視 (mail.message_reads は UPDATE ポリシー未定義)
    await mail
      .from("message_reads")
      .upsert(
        { message_id: messageId, user_id: userId },
        { onConflict: "message_id,user_id", ignoreDuplicates: true },
      );
    // ローカル未読カウントをスレッド・アカウントの両方で即座に減らす
    const msg = messages.find((m) => m.id === messageId);
    const accountId = msg?.account_id;
    if (selectedThreadId) {
      threads = threads.map((t) =>
        t.id === selectedThreadId && (t.unread_count ?? 0) > 0
          ? { ...t, unread_count: (t.unread_count ?? 0) - 1 }
          : t,
      );
    }
    if (accountId) {
      accounts = accounts.map((a) =>
        a.id === accountId && (a.unread_count ?? 0) > 0
          ? { ...a, unread_count: (a.unread_count ?? 0) - 1 }
          : a,
      );
    }
  }
</script>

<div class="layout">
  <aside class="accounts">
    <button
      class="account"
      class:selected={filterAccountId === "all"}
      onclick={() => (filterAccountId = "all")}
    >
      <span class="account-label">すべて</span>
    </button>
    {#each accounts as a (a.id)}
      <button
        class="account"
        class:selected={filterAccountId === a.id}
        class:shared={a.is_shared}
        draggable="true"
        ondragstart={() => (dragId = a.id)}
        ondragover={(e) => e.preventDefault()}
        ondrop={() => onDropAccount(a.id)}
        onclick={() => (filterAccountId = a.id)}
      >
        <span class="grip" title="ドラッグで並び替え">⋮⋮</span>
        {#if a.is_shared}
          <span class="shared-badge" title="共有アカウント">共</span>
        {/if}
        <span class="account-label">{a.label}</span>
        {#if (a.unread_count ?? 0) > 0}
          <span class="account-unread">{a.unread_count}</span>
        {/if}
      </button>
    {/each}
    <div class="accounts-footer">
      <button class="reload" onclick={() => { void syncTick(); loadThreads(); }} title="再同期">
        {syncing ? "同期中..." : "↻ 再同期"}
      </button>
    </div>
  </aside>
  <aside class="threads">
    {#each filtered as t (t.id)}
      <button
        class="thread"
        class:selected={selectedThreadId === t.id}
        class:unread={(t.unread_count ?? 0) > 0}
        class:arrived={newThreadIds.has(t.id)}
        onclick={() => openThread(t)}
      >
        <div class="meta">
          <span class="label">{t.account_label ?? ""}</span>
          <span class="date">
            {new Date(t.last_message_at).toLocaleDateString("ja-JP")}
          </span>
        </div>
        <div class="subject">
          {#if (t.unread_count ?? 0) > 0}
            <span class="badge">{t.unread_count}</span>
          {/if}
          {t.subject_normalized || "(件名なし)"}
        </div>
        <div class="participants">{t.participants.slice(0, 2).join(", ")}</div>
      </button>
    {/each}
    {#if filtered.length === 0}
      <p class="empty-list">スレッドがありません</p>
    {/if}
  </aside>

  <section class="detail">
    {#if messages.length === 0}
      <p class="empty">スレッドを選択してください</p>
    {:else}
      <header class="detail-toolbar">
        <button onclick={() => startManualReply(false)} disabled={!selectedMessageId}>
          ↩ 返信
        </button>
        <button onclick={() => startManualReply(true)} disabled={!selectedMessageId}>
          ↩↩ 全員に返信
        </button>
        <button onclick={startForward} disabled={!selectedMessageId}>
          → 転送
        </button>
        <span class="spacer"></span>
        <button onclick={generateDraft} disabled={generating || !selectedMessageId}>
          {generating ? "生成中..." : "✨ Claude 下書き"}
        </button>
      </header>
      {#each messages as m}
        <div
          class="message"
          class:outbound={m.direction === "outbound"}
          class:active={m.id === selectedMessageId}
          role="button"
          tabindex="0"
          onclick={() => { selectedMessageId = m.id; markRead(m.id); }}
          onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { selectedMessageId = m.id; markRead(m.id); } }}
        >
          <header>
            <strong>{m.from_name || m.from_address || "(不明)"}</strong>
            <span>{new Date(m.received_at).toLocaleString("ja-JP")}</span>
          </header>
          <h3>{m.subject ?? ""}</h3>
          <pre>{m.body_text ?? ""}</pre>
        </div>
      {/each}

      <div class="draft-panel">
        <details>
          <summary>Claude の下書きにトーン指示を渡す</summary>
          <input
            type="text"
            placeholder="トーン指示 (例: 丁寧に、簡潔に、提案を含めて)"
            bind:value={hint}
          />
        </details>

        {#if draft}
          <input type="text" bind:value={draft.subject} />
          <textarea rows="12" bind:value={draft.body_text}></textarea>
          <div class="actions">
            <button onclick={saveDraftEdits}>保存</button>
            <button class="primary" onclick={sendDraft} disabled={sending}>
              {sending ? "送信中..." : "送信"}
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </section>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 200px 340px 1fr;
    height: calc(100vh - 56px);
  }
  .accounts {
    overflow-y: auto;
    background: #f3f4f6;
    border-right: 1px solid #e5e7eb;
    padding: 0.5rem 0.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .account {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 0.45rem 0.5rem;
    cursor: pointer;
    text-align: left;
    font-size: 0.88rem;
    color: #374151;
  }
  .account:hover { background: #e5e7eb; }
  .account.selected {
    background: #fff;
    border-color: #d1d5db;
    font-weight: 600;
    color: #111;
  }
  .account .grip {
    color: #9ca3af;
    font-size: 0.7rem;
    cursor: grab;
    user-select: none;
  }
  .account-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .shared-badge {
    background: #dbeafe;
    color: #1e40af;
    font-size: 0.7rem;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
  }
  .account-unread {
    background: #ef4444;
    color: #fff;
    font-size: 0.7rem;
    font-weight: 700;
    padding: 0.1rem 0.4rem;
    border-radius: 9px;
    min-width: 1.4rem;
    text-align: center;
  }
  .accounts-footer { margin-top: auto; padding-top: 0.5rem; }
  .accounts-footer .reload {
    width: 100%;
    background: #fff;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    padding: 0.4rem;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .accounts-footer .reload:hover { background: #f9fafb; }
  .threads {
    overflow-y: auto;
    border-right: 1px solid #e5e7eb;
    background: #fff;
  }
  .thread {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.75rem 1rem;
    background: transparent;
    border: none;
    border-bottom: 1px solid #f0f0f0;
    cursor: pointer;
  }
  .thread:hover { background: #f9fafb; }
  .thread.selected { background: #eff6ff; }
  .thread.unread .subject { font-weight: 700; }
  /* Outlook 風の新着アニメーション: 上からスライドイン + 黄色ハイライトがフェードアウト */
  .thread.arrived {
    animation: threadArrive 600ms ease-out, threadHighlight 2.8s ease-out 600ms;
  }
  @keyframes threadArrive {
    from { transform: translateY(-12px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
  @keyframes threadHighlight {
    0% { background: #fef3c7; }
    100% { background: transparent; }
  }
  .badge {
    display: inline-block;
    background: #2563eb;
    color: #fff;
    font-size: 0.7rem;
    padding: 0 0.35rem;
    border-radius: 10px;
    margin-right: 0.25rem;
  }
  .meta {
    display: flex;
    justify-content: space-between;
    font-size: 0.75rem;
    color: #666;
  }
  .label {
    background: #e0e7ff;
    color: #3730a3;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }
  .subject {
    font-weight: 600;
    margin: 0.25rem 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .participants { font-size: 0.8rem; color: #666; }
  .empty-list { color: #999; padding: 1rem; text-align: center; font-size: 0.9rem; }
  .detail { overflow-y: auto; padding: 0; }
  .detail .message,
  .detail .draft-panel { margin-left: 1rem; margin-right: 1rem; }
  .detail .message:first-of-type { margin-top: 1rem; }
  .empty { color: #999; text-align: center; margin-top: 4rem; padding: 0 1rem; }
  .detail-toolbar {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 1rem;
    background: #fff;
    border-bottom: 1px solid #e5e7eb;
  }
  .detail-toolbar button {
    padding: 0.4rem 0.75rem;
    border: 1px solid #d1d5db;
    background: #fff;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
  }
  .detail-toolbar button:hover:not(:disabled) { background: #f3f4f6; }
  .detail-toolbar button:disabled { opacity: 0.4; cursor: not-allowed; }
  .detail-toolbar .spacer { flex: 1; }
  .message {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 1rem;
    margin-bottom: 0.75rem;
    cursor: pointer;
  }
  .message.outbound { background: #f0f9ff; }
  .message.active { border-color: #2563eb; }
  .message header {
    display: flex;
    justify-content: space-between;
    font-size: 0.85rem;
    color: #666;
  }
  .message h3 { margin: 0.5rem 0; font-size: 1rem; }
  .message pre {
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
    margin: 0;
    font-size: 0.92rem;
    line-height: 1.6;
  }
  .draft-panel {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 1rem;
    margin-top: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .draft-panel h3 { margin: 0; }
  .reply-buttons { display: flex; gap: 0.5rem; }
  .reply-buttons button { padding: 0.5rem 1rem; }
  .draft-panel details { background: #f9fafb; padding: 0.5rem 0.75rem; border-radius: 4px; }
  .draft-panel details summary { cursor: pointer; font-size: 0.85rem; color: #374151; }
  .draft-panel details > input,
  .draft-panel details > button { margin-top: 0.5rem; width: 100%; }
  .draft-panel input, .draft-panel textarea {
    padding: 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    font-size: 0.95rem;
    font-family: inherit;
  }
  .actions { display: flex; gap: 0.5rem; }
  .actions button { padding: 0.5rem 1rem; }
  .primary { background: #2563eb; color: #fff; border: none; }
</style>
