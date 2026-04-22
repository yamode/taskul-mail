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
    trashed_at?: string | null;
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

  // 返信/転送時のインラインコンポーズ状態。
  // gmail のように本文エリアを返信レイアウトに入れ替える。
  type Compose = {
    id: string;
    mode: "reply" | "forward";
    sourceMessageId: string;
    subject: string;
    to: string[];
    cc: string[];
    userBody: string;    // ユーザが書く部分
    quotedBody: string;  // 引用本文 (divider 以降)
    showQuoted: boolean;
  };

  let threads = $state<Thread[]>([]);
  let accounts = $state<Account[]>([]);
  let filterAccountId = $state<string>("all");
  let selectedThreadId = $state<string | null>(null);
  let messages = $state<Message[]>([]);
  let selectedMessageId = $state<string | null>(null);
  let compose = $state<Compose | null>(null);
  let generating = $state(false);
  let sending = $state(false);
  let hint = $state("");
  let userId = $state<string | null>(null);
  let hoverThreadId = $state<string | null>(null);

  let filtered = $derived(
    filterAccountId === "all"
      ? threads
      : threads.filter((t) => t.account_id === filterAccountId),
  );

  // 同期状態: アカウントごとに独立管理する。
  // 1 つの遅い/ハングしたアカウントが他のアカウントの反映を待たせないようにする。
  type AcctSync = { syncing: boolean; lastSyncedAt: number | null; error: string | null };
  let acctSync = $state<Record<string, AcctSync>>({});
  let nowTick = $state(Date.now());

  // "いま"の再計算用タイマ
  let clockTimer: ReturnType<typeof setInterval> | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let realtimeChannel: ReturnType<typeof supabase.channel> | null = null;

  // 集計済みの同期状態 (derived)
  let anySyncing = $derived(Object.values(acctSync).some((s) => s.syncing));
  let syncProgress = $derived.by(() => {
    const total = accounts.length;
    if (total === 0) return { total: 0, done: 0, syncing: 0, errored: 0 };
    let done = 0, syncing = 0, errored = 0;
    for (const a of accounts) {
      const s = acctSync[a.id];
      if (!s) continue;
      if (s.syncing) syncing++;
      else if (s.error) errored++;
      else if (s.lastSyncedAt) done++;
    }
    return { total, done, syncing, errored };
  });
  let oldestSyncedAt = $derived.by(() => {
    void nowTick;
    let min: number | null = null;
    for (const a of accounts) {
      const s = acctSync[a.id];
      if (!s?.lastSyncedAt) return null; // 未同期のアカウントが 1 つでもあれば null
      if (min === null || s.lastSyncedAt < min) min = s.lastSyncedAt;
    }
    return min;
  });
  let aggregateError = $derived(
    accounts.map((a) => acctSync[a.id]?.error).find((e) => !!e) ?? null,
  );

  // Gmail ライクなリアルタイム性:
  //   (a) Supabase Realtime で mail.messages INSERT を購読し、即座に反映
  //   (b) 15 秒ごとに threads テーブルだけを軽量 poll するフォールバック
  //   (c) 60 秒ごとに IMAP sync を実行 (重いので頻度は維持)
  const IMAP_SYNC_INTERVAL = 60_000;
  const DB_POLL_INTERVAL = 15_000;
  const IMAP_SYNC_TIMEOUT = 45_000;

  function setAcctSync(id: string, patch: Partial<AcctSync>) {
    const prev = acctSync[id] ?? { syncing: false, lastSyncedAt: null, error: null };
    acctSync = { ...acctSync, [id]: { ...prev, ...patch } };
  }

  // アカウント 1 つだけ同期する。並列呼び出し前提。
  async function syncOneAccount(accountId: string) {
    if (acctSync[accountId]?.syncing) return;
    setAcctSync(accountId, { syncing: true, error: null });
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), IMAP_SYNC_TIMEOUT);
    try {
      const res = await fetch(fnUrl("imap-sync", { account_id: accountId }), {
        method: "POST",
        headers: await authHeader(),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAcctSync(accountId, { syncing: false, lastSyncedAt: Date.now(), error: null });
      // 完了ごとに threads を再読込 (他のアカウントを待たずに新着が反映される)
      await loadThreads();
      if (selectedThreadId) await loadMessages(selectedThreadId);
    } catch (e) {
      const err = (e as Error).name === "AbortError" ? "タイムアウト" : (e as Error).message;
      setAcctSync(accountId, { syncing: false, error: err });
      console.warn(`sync failed for account ${accountId}`, e);
    } finally {
      clearTimeout(to);
    }
  }

  // 全アカウントを並列で同期。既に syncing のアカウントはスキップ。
  async function syncTick() {
    if (typeof document !== "undefined" && document.hidden) return;
    if (accounts.length === 0) return;
    await Promise.all(accounts.map((a) => syncOneAccount(a.id)));
  }

  // 軽量 poll: threads テーブルを見て新着があれば UI 更新。
  async function lightPoll() {
    if (typeof document !== "undefined" && document.hidden) return;
    await loadThreads();
    if (selectedThreadId) await loadMessages(selectedThreadId);
  }

  function onVisibility() {
    if (!document.hidden) {
      void lightPoll();
      void syncTick();
    }
  }

  onMount(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    userId = user?.id ?? null;
    await Promise.all([loadAccounts(), loadThreads()]);

    // IMAP 同期は 60 秒に 1 回 (重いので頻度据え置き)
    syncTimer = setInterval(syncTick, IMAP_SYNC_INTERVAL);
    // DB poll は 15 秒に 1 回 (軽量・gmail ライク)
    pollTimer = setInterval(lightPoll, DB_POLL_INTERVAL);
    // 相対時刻表示の更新 (30 秒に 1 回)
    clockTimer = setInterval(() => (nowTick = Date.now()), 30_000);

    document.addEventListener("visibilitychange", onVisibility);

    // Realtime: mail.messages INSERT を購読 (publication に登録済みの場合のみ届く)
    try {
      realtimeChannel = supabase
        .channel("mail-inbox")
        .on(
          // @ts-ignore — schema を 'mail' に指定
          "postgres_changes",
          { event: "INSERT", schema: "mail", table: "messages" },
          (payload: any) => {
            void loadThreads();
            if (selectedThreadId && payload?.new?.thread_id === selectedThreadId) {
              void loadMessages(selectedThreadId);
            }
          },
        )
        .subscribe();
    } catch (e) {
      console.warn("realtime subscribe failed (fallback to polling)", e);
    }

    void syncTick();
  });

  onDestroy(() => {
    if (syncTimer) clearInterval(syncTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (clockTimer) clearInterval(clockTimer);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
    if (realtimeChannel) {
      supabase.removeChannel(realtimeChannel);
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

  let knownThreadIds = new Set<string>();
  let newThreadIds = $state<Set<string>>(new Set());

  async function loadThreads() {
    // trashed_at is null のみ表示 (migration 未適用環境では全件取れる)
    const { data, error } = await mail
      .from("threads")
      .select(
        "id,account_id,subject_normalized,participants,last_message_at,message_count,trashed_at,accounts(label)",
      )
      .is("trashed_at", null)
      .order("last_message_at", { ascending: false })
      .limit(100);
    if (error) {
      // migration 未適用で trashed_at カラムが無い環境のフォールバック
      if (/trashed_at/.test(error.message ?? "")) {
        const { data: data2 } = await mail
          .from("threads")
          .select(
            "id,account_id,subject_normalized,participants,last_message_at,message_count,accounts(label)",
          )
          .order("last_message_at", { ascending: false })
          .limit(100);
        return applyThreads((data2 ?? []) as any[]);
      }
      console.error(error);
      return;
    }
    applyThreads((data ?? []) as any[]);
  }

  async function applyThreads(rows: any[]) {
    const base: Thread[] = rows.map((t: any) => ({
      ...t,
      account_label: t.accounts?.label,
    }));

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

    accounts = accounts.map((a) => ({
      ...a,
      unread_count: perAccount.get(a.id) ?? 0,
    }));

    const justArrived = new Set<string>();
    if (knownThreadIds.size > 0) {
      for (const t of base) {
        if (!knownThreadIds.has(t.id)) justArrived.add(t.id);
      }
    }
    knownThreadIds = new Set(base.map((t) => t.id));
    if (justArrived.size > 0) {
      newThreadIds = justArrived;
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
    compose = null;
    await loadMessages(t.id);
    if (messages.length > 0) {
      const last = [...messages].reverse().find((m) => m.direction === "inbound");
      if (last) {
        selectedMessageId = last.id;
        markRead(last.id);
      }
    }
  }

  // ------------------------------------------------------------
  // 返信・転送 (インライン展開)
  // ------------------------------------------------------------

  function buildQuoted(src: Message): string {
    const quoted = (src.body_text ?? "")
      .split("\n").map((l) => `> ${l}`).join("\n");
    const header = `--- ${new Date(src.received_at).toLocaleString("ja-JP")} ${src.from_name ?? src.from_address ?? ""} さんが書きました ---`;
    return `${header}\n${quoted}`;
  }

  function buildForwardHeader(src: Message): string {
    return (
      `--- 転送メッセージ ---\n` +
      `From: ${src.from_name ? `${src.from_name} <${src.from_address}>` : src.from_address ?? ""}\n` +
      `Date: ${new Date(src.received_at).toLocaleString("ja-JP")}\n` +
      `Subject: ${src.subject ?? ""}\n` +
      `To: ${(src.to_addresses ?? []).join(", ")}\n\n` +
      (src.body_text ?? "")
    );
  }

  function assembleBody(c: Compose): string {
    const u = (c.userBody ?? "").replace(/\s+$/, "");
    const q = c.quotedBody ?? "";
    return q ? `${u}\n\n${q}` : u;
  }

  async function startReply(replyAll = false) {
    const srcId = selectedMessageId;
    const src = messages.find((m) => m.id === srcId);
    if (!src || !src.account_id) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const subject = src.subject?.match(/^\s*re\s*:/i) ? src.subject : `Re: ${src.subject ?? ""}`;
    const to = src.from_address ? [src.from_address] : [];
    const cc = replyAll
      ? [...(src.to_addresses ?? []), ...(src.cc_addresses ?? [])]
          .filter((a) => a && a !== src.from_address)
      : [];
    const quotedBody = buildQuoted(src);
    const bodyText = assembleBody({
      id: "",
      mode: "reply",
      sourceMessageId: src.id,
      subject,
      to,
      cc,
      userBody: "",
      quotedBody,
      showQuoted: false,
    });

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
        body_text: bodyText,
        generated_by_ai: false,
        status: "draft",
      })
      .select("id")
      .single();
    if (error) { alert(`下書き作成失敗: ${error.message}`); return; }

    compose = {
      id: data!.id,
      mode: "reply",
      sourceMessageId: src.id,
      subject,
      to,
      cc,
      userBody: "",
      quotedBody,
      showQuoted: false,
    };
  }

  async function startForward(fromMessageId?: string) {
    const srcId = fromMessageId ?? selectedMessageId;
    const src = messages.find((m) => m.id === srcId);
    if (!src || !src.account_id) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const subject = src.subject?.match(/^\s*fwd?\s*:/i) ? src.subject : `Fwd: ${src.subject ?? ""}`;
    const quotedBody = buildForwardHeader(src);
    const bodyText = assembleBody({
      id: "",
      mode: "forward",
      sourceMessageId: src.id,
      subject,
      to: [],
      cc: [],
      userBody: "",
      quotedBody,
      showQuoted: false,
    });

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
        body_text: bodyText,
        generated_by_ai: false,
        status: "draft",
      })
      .select("id")
      .single();
    if (error) { alert(`下書き作成失敗: ${error.message}`); return; }

    compose = {
      id: data!.id,
      mode: "forward",
      sourceMessageId: src.id,
      subject,
      to: [],
      cc: [],
      userBody: "",
      quotedBody,
      showQuoted: true,
    };
  }

  // スレッドホバー時の「転送」: スレッドを開かずに最後の inbound メッセージを転送
  async function forwardThread(t: Thread, e: Event) {
    e.stopPropagation();
    await openThread(t);
    const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound");
    if (lastInbound) {
      await startForward(lastInbound.id);
    }
  }

  async function trashThread(t: Thread, e: Event) {
    e.stopPropagation();
    if (!confirm(`「${t.subject_normalized || "(件名なし)"}」をゴミ箱へ移動しますか？`)) return;
    // 楽観的に UI から消す
    const prev = threads;
    threads = threads.filter((x) => x.id !== t.id);
    if (selectedThreadId === t.id) {
      selectedThreadId = null;
      messages = [];
      compose = null;
    }
    const { error } = await mail
      .from("threads")
      .update({ trashed_at: new Date().toISOString() })
      .eq("id", t.id);
    if (error) {
      alert(`削除失敗: ${error.message}\n(migration 20260422000007 を SQL Editor で適用してください)`);
      threads = prev;
    }
  }

  async function cancelCompose() {
    if (!compose) return;
    if (compose.userBody.trim() !== "") {
      if (!confirm("編集中の内容を破棄しますか？")) return;
    }
    await mail.from("drafts").update({ status: "discarded" }).eq("id", compose.id);
    compose = null;
  }

  async function generateDraft() {
    if (!selectedMessageId) return;
    generating = true;
    try {
      const res = await fetch(fnUrl("generate-draft"), {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ message_id: selectedMessageId, hint: hint || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "failed");
      // AI 下書きは返信モードとして inline 展開する
      const src = messages.find((m) => m.id === selectedMessageId);
      const quotedBody = src ? buildQuoted(src) : "";
      compose = {
        id: json.draft_id,
        mode: "reply",
        sourceMessageId: selectedMessageId!,
        subject: json.subject ?? "",
        to: src?.from_address ? [src.from_address] : [],
        cc: [],
        userBody: json.body_text ?? "",
        quotedBody,
        showQuoted: false,
      };
    } catch (e) {
      alert(`下書き生成失敗: ${(e as Error).message}`);
    } finally {
      generating = false;
    }
  }

  async function saveCompose() {
    if (!compose) return;
    await mail
      .from("drafts")
      .update({
        subject: compose.subject,
        body_text: assembleBody(compose),
        to_addresses: compose.to,
        cc_addresses: compose.cc,
      })
      .eq("id", compose.id);
  }

  async function sendCompose() {
    if (!compose) return;
    if (compose.to.length === 0) { alert("宛先を入力してください"); return; }
    if (!confirm("この内容で送信しますか？")) return;
    sending = true;
    try {
      await saveCompose();
      const res = await fetch(fnUrl("send-mail"), {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ draft_id: compose.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "failed");
      alert("送信しました");
      compose = null;
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
      .upsert(
        { message_id: messageId, user_id: userId },
        { onConflict: "message_id,user_id", ignoreDuplicates: true },
      );
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

  // 相対時刻表示 ("1 分前", "たった今")。nowTick を参照して 30s 毎に更新。
  function formatRelative(ts: number | null): string {
    if (!ts) return "未同期";
    void nowTick;
    const diff = Math.max(0, Date.now() - ts);
    if (diff < 10_000) return "たった今";
    if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分前`;
    return `${Math.floor(diff / 3600_000)} 時間前`;
  }

  // 宛先入力のパース
  function parseAddrs(s: string): string[] {
    return s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
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
      {@const s = acctSync[a.id]}
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
        {#if s?.syncing}
          <span class="acct-spin" title="同期中" aria-hidden="true"></span>
        {:else if s?.error}
          <span
            class="acct-err"
            title={`前回エラー: ${s.error} — クリックで再試行`}
            role="button"
            tabindex="0"
            onclick={(e) => { e.stopPropagation(); void syncOneAccount(a.id); }}
            onkeydown={(e) => { if (e.key === "Enter") { e.stopPropagation(); void syncOneAccount(a.id); } }}
          >⚠</span>
        {/if}
        {#if (a.unread_count ?? 0) > 0}
          <span class="account-unread">{a.unread_count}</span>
        {/if}
      </button>
    {/each}
    <div class="accounts-footer">
      <button
        class="reload"
        onclick={() => { void syncTick(); }}
        disabled={anySyncing}
        title={aggregateError ? `エラーあり: ${aggregateError}` : "全アカウントを同期"}
      >
        {#if anySyncing}
          <span class="spinner" aria-hidden="true"></span>
          同期中… ({syncProgress.done}/{syncProgress.total})
        {:else if aggregateError && syncProgress.errored === syncProgress.total}
          ⚠ 全アカウント同期エラー
        {:else if aggregateError}
          ⚠ 一部エラー ({syncProgress.errored}件) — 再試行
        {:else}
          ↻ 全アカウント再同期
        {/if}
      </button>
      <div class="sync-info" class:error={!!aggregateError}>
        最終同期: {formatRelative(oldestSyncedAt)}
      </div>
    </div>
  </aside>

  <aside class="threads">
    {#each filtered as t (t.id)}
      <div
        class="thread-row"
        class:selected={selectedThreadId === t.id}
        class:unread={(t.unread_count ?? 0) > 0}
        class:arrived={newThreadIds.has(t.id)}
        onmouseenter={() => (hoverThreadId = t.id)}
        onmouseleave={() => (hoverThreadId = null)}
        role="presentation"
      >
        <button class="thread" onclick={() => openThread(t)}>
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
        {#if hoverThreadId === t.id}
          <div class="thread-actions">
            <button
              class="act-btn"
              title="転送"
              onclick={(e) => forwardThread(t, e)}
            >→</button>
            <button
              class="act-btn danger"
              title="削除"
              onclick={(e) => trashThread(t, e)}
            >🗑</button>
          </div>
        {/if}
      </div>
    {/each}
    {#if filtered.length === 0}
      <p class="empty-list">スレッドがありません</p>
    {/if}
  </aside>

  <section class="detail">
    {#if messages.length === 0 && !compose}
      <p class="empty">スレッドを選択してください</p>
    {:else if compose}
      <!-- ===== 返信/転送インライン展開 ===== -->
      <header class="compose-header">
        <div class="compose-header-row">
          <button class="back" onclick={cancelCompose} title="キャンセル">← 戻る</button>
          <span class="compose-mode">
            {compose.mode === "reply" ? "↩ 返信を作成" : "→ 転送を作成"}
          </span>
          <span class="spacer"></span>
          <button class="ghost" onclick={cancelCompose} title="下書きを破棄">破棄</button>
          <button class="ghost" onclick={saveCompose} title="下書きとして保存">下書き保存</button>
          <button class="primary" onclick={sendCompose} disabled={sending}>
            {sending ? "送信中…" : "▶ 送信"}
          </button>
        </div>
        <div class="compose-header-row tone-row">
          <label class="tone-inline">
            <span>Claude トーン</span>
            <input
              type="text"
              placeholder="例: 丁寧に、簡潔に、提案を含めて (空欄可)"
              bind:value={hint}
            />
          </label>
          <button
            class="ai"
            onclick={generateDraft}
            disabled={generating || compose.mode !== "reply"}
            title="Claude で再生成"
          >
            {generating ? "生成中…" : "✨ 再生成"}
          </button>
        </div>
      </header>
      <div class="compose">
        <div class="field-row">
          <label class="field">
            <span>To</span>
            <input
              type="text"
              value={compose.to.join(", ")}
              oninput={(e) => (compose!.to = parseAddrs((e.target as HTMLInputElement).value))}
              placeholder="宛先を入力 (カンマ区切り)"
            />
          </label>
        </div>
        <div class="field-row">
          <label class="field">
            <span>Cc</span>
            <input
              type="text"
              value={compose.cc.join(", ")}
              oninput={(e) => (compose!.cc = parseAddrs((e.target as HTMLInputElement).value))}
              placeholder="Cc (任意)"
            />
          </label>
        </div>
        <div class="field-row">
          <label class="field">
            <span>件名</span>
            <input type="text" bind:value={compose.subject} />
          </label>
        </div>
        <textarea
          class="user-body"
          rows="10"
          bind:value={compose.userBody}
          placeholder={compose.mode === "reply" ? "返信を入力…" : "転送コメントを入力 (任意)"}
        ></textarea>

        {#if compose.quotedBody}
          <div class="quoted-toggle">
            <button
              type="button"
              class="qbtn"
              onclick={() => (compose!.showQuoted = !compose!.showQuoted)}
            >
              {compose.showQuoted ? "▲ 引用を隠す" : "▼ 引用を表示 (全文付きで送信されます)"}
            </button>
          </div>
          {#if compose.showQuoted}
            <pre class="quoted-body">{compose.quotedBody}</pre>
          {/if}
        {/if}
      </div>
    {:else}
      <!-- ===== スレッド表示 ===== -->
      <header class="detail-toolbar">
        <button onclick={() => startReply(false)} disabled={!selectedMessageId}>
          ↩ 返信
        </button>
        <button onclick={() => startReply(true)} disabled={!selectedMessageId}>
          ↩↩ 全員に返信
        </button>
        <button onclick={() => startForward()} disabled={!selectedMessageId}>
          → 転送
        </button>
        <span class="spacer"></span>
        <button onclick={generateDraft} disabled={generating || !selectedMessageId}>
          {generating ? "生成中…" : "✨ Claude 下書き"}
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
  .account .grip { color: #9ca3af; font-size: 0.7rem; cursor: grab; user-select: none; }
  .account-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .shared-badge { background: #dbeafe; color: #1e40af; font-size: 0.7rem; padding: 0.1rem 0.3rem; border-radius: 3px; }
  .account-unread {
    background: #ef4444; color: #fff; font-size: 0.7rem; font-weight: 700;
    padding: 0.1rem 0.4rem; border-radius: 9px; min-width: 1.4rem; text-align: center;
  }
  .acct-spin {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid #d1d5db;
    border-top-color: #2563eb;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  .acct-err {
    color: #b45309;
    font-size: 0.8rem;
    cursor: pointer;
    flex-shrink: 0;
  }
  .acct-err:hover { color: #92400e; }
  .accounts-footer { margin-top: auto; padding-top: 0.5rem; }
  .accounts-footer .reload {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    background: #fff;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    padding: 0.4rem;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .accounts-footer .reload:hover:not(:disabled) { background: #f9fafb; }
  .accounts-footer .reload:disabled { opacity: 0.7; cursor: wait; }
  .sync-info {
    font-size: 0.7rem;
    color: #6b7280;
    text-align: center;
    margin-top: 0.25rem;
  }
  .sync-info.error { color: #b45309; }
  .spinner {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid #d1d5db;
    border-top-color: #2563eb;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .threads {
    overflow-y: auto;
    border-right: 1px solid #e5e7eb;
    background: #fff;
  }
  .thread-row {
    position: relative;
    border-bottom: 1px solid #f0f0f0;
  }
  .thread {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.75rem 1rem;
    padding-right: 4.5rem; /* hover ボタン分の余白 */
    background: transparent;
    border: none;
    cursor: pointer;
  }
  .thread-row:hover { background: #f9fafb; }
  .thread-row.selected { background: #eff6ff; }
  .thread-row.unread .subject { font-weight: 700; }
  .thread-row.arrived {
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
  .thread-actions {
    position: absolute;
    top: 50%;
    right: 0.5rem;
    transform: translateY(-50%);
    display: flex;
    gap: 0.25rem;
    z-index: 1;
  }
  .act-btn {
    width: 28px;
    height: 28px;
    border-radius: 4px;
    border: 1px solid #d1d5db;
    background: #fff;
    font-size: 0.85rem;
    cursor: pointer;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 1px 2px rgba(0,0,0,0.05);
  }
  .act-btn:hover { background: #f3f4f6; border-color: #9ca3af; }
  .act-btn.danger:hover { background: #fee2e2; border-color: #fca5a5; color: #b91c1c; }

  .badge {
    display: inline-block;
    background: #2563eb;
    color: #fff;
    font-size: 0.7rem;
    padding: 0 0.35rem;
    border-radius: 10px;
    margin-right: 0.25rem;
  }
  .meta { display: flex; justify-content: space-between; font-size: 0.75rem; color: #666; }
  .label { background: #e0e7ff; color: #3730a3; padding: 0.1rem 0.4rem; border-radius: 3px; }
  .subject { font-weight: 600; margin: 0.25rem 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .participants { font-size: 0.8rem; color: #666; }
  .empty-list { color: #999; padding: 1rem; text-align: center; font-size: 0.9rem; }

  .detail { overflow-y: auto; padding: 0; }
  .detail .message { margin-left: 1rem; margin-right: 1rem; }
  .detail .message:first-of-type { margin-top: 1rem; }
  .empty { color: #999; text-align: center; margin-top: 4rem; padding: 0 1rem; }
  .detail-toolbar {
    position: sticky; top: 0; z-index: 2;
    display: flex; align-items: center; gap: 0.5rem;
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
  .message header { display: flex; justify-content: space-between; font-size: 0.85rem; color: #666; }
  .message h3 { margin: 0.5rem 0; font-size: 1rem; }
  .message pre {
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
    margin: 0;
    font-size: 0.92rem;
    line-height: 1.6;
  }

  /* ===== Compose (inline reply/forward) ===== */
  .compose-header {
    position: sticky; top: 0; z-index: 2;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.55rem 1rem;
    background: #fff;
    border-bottom: 1px solid #e5e7eb;
    box-shadow: 0 1px 2px rgba(0,0,0,0.03);
  }
  .compose-header-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .compose-header .back {
    padding: 0.35rem 0.6rem;
    border: 1px solid #d1d5db;
    background: #fff; border-radius: 4px; cursor: pointer;
    font-size: 0.85rem;
  }
  .compose-header .back:hover { background: #f3f4f6; }
  .compose-header .compose-mode {
    font-size: 0.95rem;
    font-weight: 600;
    color: #111;
  }
  .compose-header .spacer { flex: 1; min-width: 0.5rem; }
  .compose-header .ghost {
    padding: 0.35rem 0.75rem;
    border: 1px solid #d1d5db;
    background: #fff;
    color: #374151;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85rem;
  }
  .compose-header .ghost:hover:not(:disabled) { background: #f3f4f6; }
  .compose-header .primary {
    padding: 0.4rem 1rem;
    border: none;
    background: #2563eb;
    color: #fff;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.88rem;
    font-weight: 600;
  }
  .compose-header .primary:hover:not(:disabled) { background: #1d4ed8; }
  .compose-header .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .compose-header .ai {
    padding: 0.35rem 0.7rem;
    border: 1px solid #c7d2fe;
    background: #eef2ff;
    color: #3730a3;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .compose-header .ai:hover:not(:disabled) { background: #e0e7ff; }
  .compose-header .ai:disabled { opacity: 0.5; cursor: not-allowed; }

  .tone-row { background: #f9fafb; border-radius: 4px; padding: 0.3rem 0.5rem; }
  .tone-inline {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
  }
  .tone-inline > span {
    font-size: 0.78rem;
    color: #6b7280;
    white-space: nowrap;
  }
  .tone-inline > input {
    flex: 1;
    min-width: 0;
    border: 1px solid #e5e7eb;
    background: #fff;
    border-radius: 4px;
    padding: 0.3rem 0.5rem;
    font-size: 0.85rem;
    font-family: inherit;
  }
  .tone-inline > input:focus { outline: 2px solid #bfdbfe; border-color: #60a5fa; }

  .compose {
    padding: 1rem 1.25rem 2rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    max-width: 880px;
  }
  .field-row { display: flex; }
  .field {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 0.5rem;
    border-bottom: 1px solid #e5e7eb;
    padding: 0.35rem 0;
  }
  .field > span {
    width: 3rem;
    font-size: 0.8rem;
    color: #6b7280;
    flex-shrink: 0;
  }
  .field > input {
    flex: 1;
    border: none;
    padding: 0.35rem 0;
    font-size: 0.95rem;
    font-family: inherit;
    outline: none;
    background: transparent;
  }
  .user-body {
    border: 1px solid #d1d5db;
    border-radius: 6px;
    padding: 0.75rem;
    font-size: 0.95rem;
    font-family: inherit;
    line-height: 1.6;
    resize: vertical;
    min-height: 160px;
    margin-top: 0.5rem;
  }
  .user-body:focus { outline: 2px solid #bfdbfe; border-color: #60a5fa; }

  .quoted-toggle { margin-top: 0.25rem; }
  .qbtn {
    background: transparent;
    border: none;
    color: #6b7280;
    font-size: 0.8rem;
    cursor: pointer;
    padding: 0.25rem 0;
  }
  .qbtn:hover { color: #374151; }
  .quoted-body {
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
    font-size: 0.88rem;
    line-height: 1.6;
    color: #6b7280;
    border-left: 3px solid #e5e7eb;
    padding: 0.5rem 0.75rem;
    margin: 0;
    background: #fafafa;
    border-radius: 0 4px 4px 0;
  }

</style>
