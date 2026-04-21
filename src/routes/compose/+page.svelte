<script lang="ts">
  import { supabase, fnUrl, authHeader } from "$lib/supabase";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";

  type Account = { id: string; label: string; email_address: string };

  let accounts = $state<Account[]>([]);
  let accountId = $state<string>("");
  let to = $state("");
  let cc = $state("");
  let bcc = $state("");
  let subject = $state("");
  let bodyText = $state("");
  let saving = $state(false);
  let sending = $state(false);
  let draftId = $state<string | null>(null);

  onMount(async () => {
    const { data } = await supabase
      .from("mail_accounts")
      .select("id,label,email_address")
      .order("created_at");
    accounts = (data ?? []) as Account[];
    if (accounts.length > 0 && !accountId) accountId = accounts[0].id;
  });

  function splitAddrs(s: string): string[] {
    return s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  }

  async function saveDraft(): Promise<string | null> {
    if (!accountId) { alert("送信元アカウントを選択してください"); return null; }
    saving = true;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("not signed in");
      const payload = {
        account_id: accountId,
        author_id: user.id,
        to_addresses: splitAddrs(to),
        cc_addresses: splitAddrs(cc),
        bcc_addresses: splitAddrs(bcc),
        subject,
        body_text: bodyText,
        generated_by_ai: false,
        status: "draft" as const,
      };
      if (draftId) {
        const { error } = await supabase
          .from("mail_drafts")
          .update(payload)
          .eq("id", draftId);
        if (error) throw error;
        return draftId;
      } else {
        const { data, error } = await supabase
          .from("mail_drafts")
          .insert(payload)
          .select("id")
          .single();
        if (error) throw error;
        draftId = data!.id;
        return draftId;
      }
    } catch (e) {
      alert(`保存失敗: ${(e as Error).message}`);
      return null;
    } finally {
      saving = false;
    }
  }

  async function send() {
    if (!confirm("この内容で送信しますか？")) return;
    const id = await saveDraft();
    if (!id) return;
    sending = true;
    try {
      const res = await fetch(fnUrl("send-mail"), {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ draft_id: id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "failed");
      alert("送信しました");
      goto("/");
    } catch (e) {
      alert(`送信失敗: ${(e as Error).message}`);
    } finally {
      sending = false;
    }
  }
</script>

<section>
  <h2>新規メール作成</h2>
  <div class="form">
    <label>
      送信元
      <select bind:value={accountId}>
        {#each accounts as a}
          <option value={a.id}>{a.label} ({a.email_address})</option>
        {/each}
      </select>
    </label>
    <label>宛先 (To) <input type="text" bind:value={to} placeholder="a@example.com, b@example.com" /></label>
    <label>Cc <input type="text" bind:value={cc} /></label>
    <label>Bcc <input type="text" bind:value={bcc} /></label>
    <label>件名 <input type="text" bind:value={subject} /></label>
    <label>本文
      <textarea rows="18" bind:value={bodyText}></textarea>
    </label>
    <div class="actions">
      <button onclick={saveDraft} disabled={saving}>
        {saving ? "保存中..." : "下書き保存"}
      </button>
      <button class="primary" onclick={send} disabled={sending || saving}>
        {sending ? "送信中..." : "送信"}
      </button>
    </div>
  </div>
</section>

<style>
  section { padding: 2rem; max-width: 720px; margin: 0 auto; }
  .form { display: flex; flex-direction: column; gap: 0.75rem; }
  label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: #374151; }
  input, select, textarea {
    padding: 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    font-size: 0.95rem;
    font-family: inherit;
  }
  .actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
  .actions button { padding: 0.5rem 1.25rem; border: 1px solid #d1d5db; border-radius: 4px; background: #f9fafb; cursor: pointer; }
  .primary { background: #2563eb !important; color: #fff !important; border: none !important; }
</style>
