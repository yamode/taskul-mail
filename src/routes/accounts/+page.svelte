<script lang="ts">
  import { supabase, mail, fnUrl, authHeader } from "$lib/supabase";
  import { onMount } from "svelte";

  type Account = {
    id: string;
    label: string;
    email_address: string;
    is_shared: boolean;
    last_synced_at: string | null;
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
      .select("id,label,email_address,is_shared,last_synced_at")
      .order("created_at");
    accounts = (data ?? []) as Account[];
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
    alert("同期を開始しました (数秒〜数十秒)");
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
</style>
