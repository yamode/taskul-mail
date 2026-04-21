<script lang="ts">
  import { supabase, mail, fnUrl, authHeader } from "$lib/supabase";
  import { onMount } from "svelte";

  type Draft = {
    id: string;
    account_id: string;
    subject: string | null;
    body_text: string | null;
    to_addresses: string[];
    cc_addresses: string[] | null;
    status: string;
    generated_by_ai: boolean;
    updated_at: string;
    accounts?: { label: string } | null;
  };

  let drafts = $state<Draft[]>([]);
  let selected = $state<Draft | null>(null);
  let sending = $state(false);

  onMount(load);

  async function load() {
    const { data } = await mail
      .from("drafts")
      .select(
        "id,account_id,subject,body_text,to_addresses,cc_addresses,status,generated_by_ai,updated_at,accounts(label)",
      )
      .eq("status", "draft")
      .order("updated_at", { ascending: false });
    drafts = (data ?? []) as any;
  }

  async function save() {
    if (!selected) return;
    await mail
      .from("drafts")
      .update({
        subject: selected.subject,
        body_text: selected.body_text,
        to_addresses: selected.to_addresses,
        cc_addresses: selected.cc_addresses ?? [],
      })
      .eq("id", selected.id);
    await load();
  }

  async function discard(id: string) {
    if (!confirm("この下書きを破棄しますか？")) return;
    await mail.from("drafts").update({ status: "discarded" }).eq("id", id);
    if (selected?.id === id) selected = null;
    await load();
  }

  async function send() {
    if (!selected) return;
    if (!confirm("送信しますか？")) return;
    sending = true;
    try {
      await save();
      const res = await fetch(fnUrl("send-mail"), {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ draft_id: selected.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "failed");
      alert("送信しました");
      selected = null;
      await load();
    } catch (e) {
      alert(`送信失敗: ${(e as Error).message}`);
    } finally {
      sending = false;
    }
  }

  function toText(s: string[]): string { return s.join(", "); }
  function fromText(v: string): string[] {
    return v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  }
</script>

<div class="layout">
  <aside>
    <h2>下書き ({drafts.length})</h2>
    {#each drafts as d}
      <button
        class="item"
        class:selected={selected?.id === d.id}
        onclick={() => (selected = { ...d })}
      >
        <div class="meta">
          <span class="label">{d.accounts?.label ?? ""}</span>
          {#if d.generated_by_ai}<span class="ai">AI</span>{/if}
          <span class="date">{new Date(d.updated_at).toLocaleDateString("ja-JP")}</span>
        </div>
        <div class="subj">{d.subject || "(件名なし)"}</div>
        <div class="to">→ {(d.to_addresses ?? []).join(", ") || "(宛先なし)"}</div>
      </button>
    {/each}
    {#if drafts.length === 0}
      <p class="empty">下書きはありません</p>
    {/if}
  </aside>
  <section>
    {#if selected}
      <label>宛先
        <input
          type="text"
          value={toText(selected.to_addresses ?? [])}
          oninput={(e) => (selected!.to_addresses = fromText((e.target as HTMLInputElement).value))}
        />
      </label>
      <label>Cc
        <input
          type="text"
          value={toText(selected.cc_addresses ?? [])}
          oninput={(e) => (selected!.cc_addresses = fromText((e.target as HTMLInputElement).value))}
        />
      </label>
      <label>件名 <input type="text" bind:value={selected.subject} /></label>
      <label>本文 <textarea rows="18" bind:value={selected.body_text}></textarea></label>
      <div class="actions">
        <button onclick={() => discard(selected!.id)}>破棄</button>
        <button onclick={save}>保存</button>
        <button class="primary" onclick={send} disabled={sending}>
          {sending ? "送信中..." : "送信"}
        </button>
      </div>
    {:else}
      <p class="empty">下書きを選択してください</p>
    {/if}
  </section>
</div>

<style>
  .layout { display: grid; grid-template-columns: 340px 1fr; height: calc(100vh - 56px); }
  aside { overflow-y: auto; border-right: 1px solid #e5e7eb; background: #fff; }
  aside h2 { padding: 1rem; margin: 0; font-size: 0.9rem; color: #666; border-bottom: 1px solid #e5e7eb; }
  .item {
    display: block; width: 100%; text-align: left;
    padding: 0.75rem 1rem; background: transparent;
    border: none; border-bottom: 1px solid #f0f0f0; cursor: pointer;
  }
  .item:hover { background: #f9fafb; }
  .item.selected { background: #eff6ff; }
  .meta { display: flex; gap: 0.5rem; align-items: center; font-size: 0.75rem; color: #666; }
  .label { background: #e0e7ff; color: #3730a3; padding: 0.1rem 0.4rem; border-radius: 3px; }
  .ai { background: #fef3c7; color: #92400e; padding: 0.1rem 0.4rem; border-radius: 3px; }
  .date { margin-left: auto; }
  .subj { font-weight: 600; margin: 0.25rem 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .to { font-size: 0.8rem; color: #666; }
  .empty { color: #999; padding: 2rem; text-align: center; }
  section { overflow-y: auto; padding: 1.5rem; display: flex; flex-direction: column; gap: 0.75rem; }
  label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: #374151; }
  input, textarea {
    padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 4px;
    font-size: 0.95rem; font-family: inherit;
  }
  .actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
  .actions button { padding: 0.5rem 1.25rem; border: 1px solid #d1d5db; border-radius: 4px; background: #f9fafb; cursor: pointer; }
  .primary { background: #2563eb !important; color: #fff !important; border: none !important; }
</style>
