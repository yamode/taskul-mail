<script lang="ts">
  import { supabase, mail, fnUrl, authHeader } from "$lib/supabase";
  import { onMount } from "svelte";

  type Account = {
    id: string;
    label: string;
    email_address: string;
    is_shared: boolean;
    last_synced_at: string | null;
    imap_host: string;
    imap_port: number;
    smtp_host: string;
    smtp_port: number;
    username: string;
  };

  let accounts = $state<Account[]>([]);
  let label = $state("");
  let emailAddress = $state("");
  let password = $state("");
  let isShared = $state(false);
  let saving = $state(false);
  let showAdvanced = $state(false);
  let imapHost = $state("imap.xserver.jp");
  let imapPort = $state(993);
  let smtpHost = $state("smtp.xserver.jp");
  let smtpPort = $state(465);

  function resetForm() {
    label = "";
    emailAddress = "";
    password = "";
    isShared = false;
    showAdvanced = false;
    imapHost = "imap.xserver.jp";
    imapPort = 993;
    smtpHost = "smtp.xserver.jp";
    smtpPort = 465;
  }

  onMount(loadAccounts);

  async function loadAccounts() {
    const { data } = await mail
      .from("accounts")
      .select(
        "id,label,email_address,is_shared,last_synced_at,imap_host,imap_port,smtp_host,smtp_port,username",
      )
      .order("created_at");
    accounts = (data ?? []) as Account[];
  }

  // ---- 編集モーダル ----
  let editing = $state<Account | null>(null);
  let editPassword = $state("");
  let editSaving = $state(false);

  function openEdit(a: Account) {
    editing = { ...a };
    editPassword = "";
  }
  function closeEdit() {
    editing = null;
    editPassword = "";
  }
  async function saveEdit() {
    if (!editing) return;
    editSaving = true;
    try {
      // メタ情報の更新 (password 以外)
      const { error: uErr } = await mail
        .from("accounts")
        .update({
          label: editing.label,
          email_address: editing.email_address,
          username: editing.username,
          imap_host: editing.imap_host,
          imap_port: Number(editing.imap_port),
          smtp_host: editing.smtp_host,
          smtp_port: Number(editing.smtp_port),
          is_shared: editing.is_shared,
        })
        .eq("id", editing.id);
      if (uErr) throw uErr;

      // パスワードが入力されていれば Vault 経由で更新
      if (editPassword) {
        const { error: pErr } = await supabase.functions.invoke(
          "update-account-password",
          { body: { account_id: editing.id, password: editPassword } },
        );
        if (pErr) throw pErr;
      }

      closeEdit();
      await loadAccounts();
    } catch (e) {
      alert(`更新失敗: ${(e as Error).message}`);
    } finally {
      editSaving = false;
    }
  }

  async function addAccount() {
    saving = true;
    try {
      // Vault はクライアントから直接書けない。サーバ RPC で実行。
      const { error } = await supabase.functions.invoke("register-account", {
        body: {
          label,
          email_address: emailAddress,
          password,
          is_shared: isShared,
          imap_host: imapHost,
          imap_port: Number(imapPort),
          smtp_host: smtpHost,
          smtp_port: Number(smtpPort),
        },
      });
      if (error) throw error;
      resetForm();
      await loadAccounts();
    } catch (e) {
      alert(`登録失敗: ${(e as Error).message}`);
    } finally {
      saving = false;
    }
  }

  async function syncNow(id: string) {
    await fetch(fnUrl("imap-sync", { account_id: id }), {
      method: "POST",
      headers: await authHeader(),
    });
    setTimeout(loadAccounts, 3000);
  }

  async function deleteAccount(id: string, addr: string) {
    if (!confirm(`${addr} を削除しますか? 紐づく全メッセージ・スレッド・下書きも削除されます。`)) return;
    const { error } = await mail.from("accounts").delete().eq("id", id);
    if (error) { alert(`削除失敗: ${error.message}`); return; }
    await loadAccounts();
  }
</script>

<section>
  <h2>メールアカウント</h2>
  <table>
    <thead>
      <tr><th>ラベル</th><th>アドレス</th><th>共有</th><th>最終同期</th><th></th></tr>
    </thead>
    <tbody>
      {#each accounts as a}
        <tr>
          <td>{a.label}</td>
          <td>{a.email_address}</td>
          <td>{a.is_shared ? "✓" : ""}</td>
          <td>{a.last_synced_at ? new Date(a.last_synced_at).toLocaleString("ja-JP") : "-"}</td>
          <td class="row-actions">
            <button onclick={() => syncNow(a.id)}>同期</button>
            <button onclick={() => openEdit(a)}>編集</button>
            <button class="danger" onclick={() => deleteAccount(a.id, a.email_address)}>削除</button>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

  <h3>アカウント追加</h3>
  <div class="form">
    <label class="field">ラベル (例: 代表)
      <input placeholder="代表 / ひかる個人 など" bind:value={label} />
    </label>
    <label class="field">メールアドレス
      <input placeholder="info@yamado.co.jp" type="email" bind:value={emailAddress} />
    </label>
    <label class="field">パスワード
      <input placeholder="メールアカウントのパスワード" type="password" bind:value={password} />
    </label>
    <label class="checkbox">
      <input type="checkbox" bind:checked={isShared} />
      共有アカウント (チーム全員で閲覧)
    </label>

    <button type="button" class="toggle" onclick={() => (showAdvanced = !showAdvanced)}>
      {showAdvanced ? "▼" : "▶"} サーバー詳細設定 (Xserver 以外を使う場合)
    </button>

    {#if showAdvanced}
      <div class="advanced">
        <div class="row">
          <label class="field grow">IMAP ホスト
            <input bind:value={imapHost} />
          </label>
          <label class="field port">ポート
            <input type="number" bind:value={imapPort} />
          </label>
        </div>
        <div class="row">
          <label class="field grow">SMTP ホスト
            <input bind:value={smtpHost} />
          </label>
          <label class="field port">ポート
            <input type="number" bind:value={smtpPort} />
          </label>
        </div>
      </div>
    {/if}

    <button onclick={addAccount} disabled={saving}>
      {saving ? "保存中..." : "追加"}
    </button>
  </div>
  <p class="note">
    デフォルトは Xserver 用 (IMAP <code>imap.xserver.jp:993</code> / SMTP <code>smtp.xserver.jp:465</code>)。
    他のサーバーを使う場合は「サーバー詳細設定」で変更してください。
    パスワードは Supabase Vault で暗号化保管されます。
  </p>
</section>

{#if editing}
  <div class="modal-backdrop" role="presentation" onclick={closeEdit}>
    <div class="modal" role="dialog" aria-modal="true" tabindex="-1"
         onclick={(e) => e.stopPropagation()}
         onkeydown={(e) => { if (e.key === "Escape") closeEdit(); }}>
      <h3>アカウント編集</h3>
      <label class="field">ラベル
        <input bind:value={editing.label} />
      </label>
      <label class="field">メールアドレス
        <input type="email" bind:value={editing.email_address} />
      </label>
      <label class="field">ユーザー名 (通常メールアドレスと同じ)
        <input bind:value={editing.username} />
      </label>
      <label class="field">パスワード (変更する場合のみ入力)
        <input type="password" bind:value={editPassword} placeholder="変更しない場合は空欄" />
      </label>
      <div class="row">
        <label class="field grow">IMAP ホスト
          <input bind:value={editing.imap_host} />
        </label>
        <label class="field port">ポート
          <input type="number" bind:value={editing.imap_port} />
        </label>
      </div>
      <div class="row">
        <label class="field grow">SMTP ホスト
          <input bind:value={editing.smtp_host} />
        </label>
        <label class="field port">ポート
          <input type="number" bind:value={editing.smtp_port} />
        </label>
      </div>
      <label class="checkbox">
        <input type="checkbox" bind:checked={editing.is_shared} />
        共有アカウント
      </label>
      <div class="modal-actions">
        <button onclick={closeEdit}>キャンセル</button>
        <button class="primary" onclick={saveEdit} disabled={editSaving}>
          {editSaving ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  section { padding: 2rem; max-width: 800px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 2rem; background: #fff; }
  th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #e5e7eb; }
  .form { display: flex; flex-direction: column; gap: 0.6rem; max-width: 480px; }
  .form input, .form button {
    padding: 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    font-size: 0.95rem;
  }
  .field { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.8rem; color: #374151; }
  .checkbox { display: flex; align-items: center; gap: 0.4rem; font-size: 0.9rem; }
  .toggle {
    background: transparent;
    border: none;
    color: #2563eb;
    text-align: left;
    padding: 0.25rem 0;
    cursor: pointer;
    font-size: 0.85rem;
  }
  .advanced {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
  }
  .row { display: flex; gap: 0.5rem; }
  .grow { flex: 1; }
  .port { width: 100px; }
  .note { color: #666; font-size: 0.85rem; margin-top: 1rem; }
  code { background: #f3f4f6; padding: 0.1rem 0.3rem; border-radius: 3px; }
  .row-actions { display: flex; gap: 0.25rem; }
  .row-actions button { padding: 0.25rem 0.5rem; font-size: 0.85rem; }
  .danger { background: #dc2626; color: #fff; border: none; cursor: pointer; border-radius: 3px; }
  .danger:hover { background: #b91c1c; }

  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.4);
    display: flex; align-items: center; justify-content: center;
    z-index: 1000;
  }
  .modal {
    background: #fff; padding: 1.5rem; border-radius: 8px;
    max-width: 520px; width: 90%;
    display: flex; flex-direction: column; gap: 0.6rem;
    max-height: 90vh; overflow-y: auto;
  }
  .modal h3 { margin: 0 0 0.5rem 0; }
  .modal input {
    padding: 0.4rem 0.5rem; border: 1px solid #d1d5db; border-radius: 4px;
    font-size: 0.95rem;
  }
  .modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.5rem; }
  .modal-actions button { padding: 0.5rem 1rem; border: 1px solid #d1d5db; border-radius: 4px; background: #f9fafb; cursor: pointer; }
  .primary { background: #2563eb !important; color: #fff !important; border: none !important; }
</style>
