<script lang="ts">
  import { mail } from "$lib/supabase";
  import { onMount } from "svelte";

  type Account = {
    id: string;
    label: string;
    email_address: string;
    is_shared: boolean;
    default_tone?: string;
  };

  let accounts = $state<Account[]>([]);
  let editing = $state<Account | null>(null);
  let draft = $state("");
  let saving = $state(false);

  onMount(load);

  async function load() {
    const { data, error } = await mail
      .from("accounts")
      .select("id,label,email_address,is_shared,default_tone")
      .order("sort_order")
      .order("created_at");
    if (error && /default_tone/.test(error.message ?? "")) {
      alert("default_tone カラムが未適用です。SQL Editor で以下を実行してください:\nalter table mail.accounts add column if not exists default_tone text not null default '';");
      return;
    }
    accounts = (data ?? []) as Account[];
  }

  function openEdit(a: Account) {
    editing = a;
    draft = a.default_tone ?? "";
  }

  async function save() {
    if (!editing) return;
    saving = true;
    try {
      const { error } = await mail
        .from("accounts")
        .update({ default_tone: draft })
        .eq("id", editing.id);
      if (error) throw error;
      await load();
      editing = null;
    } catch (e) {
      alert(`保存失敗: ${(e as Error).message}`);
    } finally {
      saving = false;
    }
  }
</script>

<section>
  <h2>AI 返信トーン設定</h2>
  <p class="note">
    各メールアカウントで「✨ Claude 再生成」した際に使われる基本トーン指示を登録できます。<br>
    返信コンポーズ画面では、この基本トーンに加えて「今回の追加指示」を個別に入力できます。
  </p>

  <div class="account-list">
    {#each accounts as a (a.id)}
      <div class="item">
        <div class="item-head">
          <div class="item-title">
            {#if a.is_shared}<span class="shared">共</span>{/if}
            <strong>{a.label}</strong>
            <span class="addr">{a.email_address}</span>
          </div>
          <button onclick={() => openEdit(a)}>編集</button>
        </div>
        <div class="tone-preview" class:empty={!a.default_tone}>
          {a.default_tone || "(未設定)"}
        </div>
      </div>
    {/each}
    {#if accounts.length === 0}
      <p class="empty">アカウントが登録されていません</p>
    {/if}
  </div>
</section>

{#if editing}
  <div class="modal-backdrop" role="presentation" onclick={() => (editing = null)}>
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => { if (e.key === "Escape") editing = null; }}
    >
      <h3>AI 返信トーン設定</h3>
      <p class="sub">
        <strong>{editing.label}</strong> ({editing.email_address})
      </p>
      <label class="field">
        <span>基本トーン指示</span>
        <textarea
          rows="6"
          bind:value={draft}
          placeholder="例: 丁寧・簡潔に、宿の担当者として応対。返答は短めに、ですます調で。"
        ></textarea>
        <small>
          空欄なら汎用トーン。個別メールの「追加指示」は返信画面でも入力できます。
        </small>
      </label>
      <div class="actions">
        <button onclick={() => (editing = null)}>キャンセル</button>
        <button class="primary" onclick={save} disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  section { padding: 2rem; max-width: 760px; }
  h2 { margin-top: 0; }
  .note { color: #6b7280; font-size: 0.88rem; line-height: 1.6; }
  .account-list { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1rem; }
  .item {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .item-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .item-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .item-title strong { font-size: 0.95rem; }
  .addr { color: #6b7280; font-size: 0.82rem; overflow: hidden; text-overflow: ellipsis; }
  .shared { background: #dbeafe; color: #1e40af; font-size: 0.7rem; padding: 0.1rem 0.3rem; border-radius: 3px; }
  .item-head button {
    padding: 0.3rem 0.75rem;
    border: 1px solid #d1d5db;
    background: #fff;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85rem;
  }
  .item-head button:hover { background: #f3f4f6; }
  .tone-preview {
    background: #f9fafb;
    border-left: 3px solid #e5e7eb;
    padding: 0.5rem 0.75rem;
    font-size: 0.88rem;
    line-height: 1.6;
    color: #374151;
    white-space: pre-wrap;
    word-break: break-word;
    border-radius: 0 4px 4px 0;
  }
  .tone-preview.empty { color: #9ca3af; font-style: italic; }
  .empty { color: #999; padding: 1rem; text-align: center; }

  .modal-backdrop {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center;
    z-index: 1200;
  }
  .modal {
    background: #fff;
    border-radius: 10px;
    padding: 1.5rem;
    width: min(540px, 92vw);
    max-height: 90vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    box-shadow: 0 12px 40px rgba(0,0,0,0.25);
  }
  .modal h3 { margin: 0; font-size: 1.05rem; }
  .sub { margin: 0; color: #6b7280; font-size: 0.85rem; }
  .field { display: flex; flex-direction: column; gap: 0.35rem; }
  .field > span { font-size: 0.82rem; color: #374151; font-weight: 600; }
  .field textarea {
    border: 1px solid #d1d5db;
    border-radius: 6px;
    padding: 0.6rem 0.7rem;
    font-family: inherit;
    font-size: 0.92rem;
    line-height: 1.5;
    resize: vertical;
  }
  .field textarea:focus { outline: 2px solid #bfdbfe; border-color: #60a5fa; }
  .field small { color: #6b7280; font-size: 0.76rem; line-height: 1.5; }
  .actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 0.25rem; }
  .actions button {
    padding: 0.5rem 1rem;
    border: 1px solid #d1d5db;
    background: #fff;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
  }
  .actions button:hover:not(:disabled) { background: #f3f4f6; }
  .actions button:disabled { opacity: 0.5; cursor: not-allowed; }
  .actions .primary { background: #2563eb; color: #fff; border: none; }
  .actions .primary:hover:not(:disabled) { background: #1d4ed8; }
</style>
