<script lang="ts">
  import { supabase, mail, fnUrl, authHeader } from "$lib/supabase";
  import { onMount } from "svelte";

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
    from_address: string | null;
    from_name: string | null;
    subject: string | null;
    body_text: string | null;
    received_at: string;
    direction: string;
  };
  type Account = { id: string; label: string; is_shared: boolean };

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

  onMount(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    userId = user?.id ?? null;
    await Promise.all([loadAccounts(), loadThreads()]);
  });

  async function loadAccounts() {
    const { data } = await mail
      .from("accounts")
      .select("id,label,is_shared")
      .order("created_at");
    accounts = (data ?? []) as Account[];
  }

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
    if (base.length > 0 && userId) {
      const threadIds = base.map((t) => t.id);
      const [{ data: inbound }, { data: reads }] = await Promise.all([
        mail
          .from("messages")
          .select("id,thread_id")
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
        }
      }
      for (const t of base) t.unread_count = counts.get(t.id) ?? 0;
    }
    threads = base;
  }

  async function openThread(t: Thread) {
    selectedThreadId = t.id;
    selectedMessageId = null;
    draft = null;
    const { data } = await mail
      .from("messages")
      .select("id,from_address,from_name,subject,body_text,received_at,direction")
      .eq("thread_id", t.id)
      .order("received_at", { ascending: true });
    messages = (data ?? []) as Message[];
    if (messages.length > 0) {
      const last = [...messages].reverse().find((m) => m.direction === "inbound");
      if (last) {
        selectedMessageId = last.id;
        markRead(last.id);
      }
    }
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
    await mail
      .from("message_reads")
      .upsert({ message_id: messageId, user_id: userId });
    // ローカル未読カウントを即座に減らす
    if (selectedThreadId) {
      threads = threads.map((t) =>
        t.id === selectedThreadId && (t.unread_count ?? 0) > 0
          ? { ...t, unread_count: (t.unread_count ?? 0) - 1 }
          : t,
      );
    }
  }
</script>

<div class="layout">
  <aside class="threads">
    <div class="filter">
      <select bind:value={filterAccountId}>
        <option value="all">すべてのアカウント</option>
        {#each accounts as a}
          <option value={a.id}>{a.label}</option>
        {/each}
      </select>
      <button class="reload" onclick={loadThreads} title="再読込">↻</button>
    </div>
    {#each filtered as t}
      <button
        class="thread"
        class:selected={selectedThreadId === t.id}
        class:unread={(t.unread_count ?? 0) > 0}
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
        <h3>返信下書き</h3>
        <input
          type="text"
          placeholder="トーン指示 (例: 丁寧に、簡潔に、提案を含めて)"
          bind:value={hint}
        />
        <button onclick={generateDraft} disabled={generating || !selectedMessageId}>
          {generating ? "生成中..." : "Claude で下書き生成"}
        </button>

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
    grid-template-columns: 340px 1fr;
    height: calc(100vh - 56px);
  }
  .threads {
    overflow-y: auto;
    border-right: 1px solid #e5e7eb;
    background: #fff;
  }
  .filter {
    display: flex;
    gap: 0.5rem;
    padding: 0.75rem;
    border-bottom: 1px solid #e5e7eb;
    position: sticky;
    top: 0;
    background: #fff;
    z-index: 1;
  }
  .filter select {
    flex: 1;
    padding: 0.4rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
  }
  .reload {
    padding: 0.4rem 0.6rem;
    background: #f3f4f6;
    color: #374151;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    cursor: pointer;
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
  .detail { overflow-y: auto; padding: 1rem; }
  .empty { color: #999; text-align: center; margin-top: 4rem; }
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
