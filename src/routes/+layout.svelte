<script lang="ts">
  import { supabase } from "$lib/supabase";
  import ReleaseNotesModal from "$lib/components/ReleaseNotesModal.svelte";
  import { version } from "../../package.json";
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";

  let { children } = $props();
  let session = $state<any>(null);
  let loading = $state(true);
  let email = $state("");
  let password = $state("");
  let showReleaseNotes = $state(false);
  let searchInput = $state("");

  // URL の ?q= を入力欄へ反映 (ブラウザバック等で同期)
  $effect(() => {
    const q = $page.url.searchParams.get("q") ?? "";
    if (q !== searchInput && $page.url.pathname === "/") searchInput = q;
  });

  function onSearchInput(value: string) {
    searchInput = value;
    if ($page.url.pathname !== "/") {
      // 検索は受信トレイ画面のみ対象
      void goto(value ? `/?q=${encodeURIComponent(value)}` : "/", { keepFocus: true, replaceState: true });
      return;
    }
    const url = new URL($page.url);
    if (value) url.searchParams.set("q", value);
    else url.searchParams.delete("q");
    void goto(url.pathname + url.search, { keepFocus: true, replaceState: true, noScroll: true });
  }

  onMount(async () => {
    const { data } = await supabase.auth.getSession();
    session = data.session;
    loading = false;
    supabase.auth.onAuthStateChange((_, s) => (session = s));
  });

  async function signIn() {
    await supabase.auth.signInWithPassword({ email, password });
  }
  async function signOut() {
    await supabase.auth.signOut();
  }
</script>

<svelte:head>
  <title>TASKUL Mail</title>
</svelte:head>

<main>
  {#if loading}
    <p>読み込み中...</p>
  {:else if !session}
    <section class="auth">
      <h1>TASKUL Mail</h1>
      <input type="email" placeholder="email" bind:value={email} />
      <input type="password" placeholder="password" bind:value={password} />
      <button onclick={signIn}>ログイン</button>
    </section>
  {:else}
    <header>
      <strong>TASKUL Mail</strong>
      <button class="header-version" onclick={() => (showReleaseNotes = true)}>
        v{version}
      </button>
      <nav>
        <a href="/">受信トレイ</a>
        <a href="/accounts">アカウント</a>
        <a href="/ai-settings">AI 設定</a>
      </nav>
      <input
        class="header-search"
        type="search"
        placeholder="🔍 件名・差出人で検索"
        value={searchInput}
        oninput={(e) => onSearchInput((e.currentTarget as HTMLInputElement).value)}
      />
      <span>{session.user.email}</span>
      <button onclick={signOut}>ログアウト</button>
    </header>
    {@render children()}
    <ReleaseNotesModal bind:open={showReleaseNotes} />
  {/if}
</main>

<style>
  :global(html) {
    overscroll-behavior-x: none;
  }
  :global(body) {
    margin: 0;
    font-family:
      -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN",
      "Noto Sans JP", sans-serif;
    background: #f6f7f9;
    color: #222;
    overscroll-behavior-x: none;
  }
  main { min-height: 100vh; }
  header {
    display: flex;
    gap: 1rem;
    align-items: center;
    padding: 0.75rem 1rem;
    background: #fff;
    border-bottom: 1px solid #e5e7eb;
  }
  header strong { flex: 0; }
  .header-version {
    background: rgba(0,0,0,0.05);
    border: none;
    color: #6b7280;
    font-size: 0.72rem;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
  }
  .header-version:hover { color: #374151; background: rgba(0,0,0,0.08); }
  header nav { display: flex; gap: 0.75rem; }
  header nav a {
    color: #374151;
    text-decoration: none;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.9rem;
  }
  header nav a:hover { background: #f3f4f6; }
  header span { flex: 1; color: #666; font-size: 0.9rem; text-align: right; }
  .header-search {
    padding: 0.3rem 0.6rem;
    font-size: 0.85rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    width: 260px;
    background: #f9fafb;
  }
  .header-search:focus { outline: none; border-color: #2563eb; background: #fff; }
  .auth {
    max-width: 320px;
    margin: 5rem auto;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    background: #fff;
    padding: 2rem;
    border-radius: 8px;
  }
  input, button {
    padding: 0.5rem 0.75rem;
    font-size: 1rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
  }
  button {
    background: #2563eb;
    color: #fff;
    border: none;
    cursor: pointer;
  }
  button:hover { background: #1d4ed8; }
</style>
