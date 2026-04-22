<script lang="ts">
  import { supabase } from "$lib/supabase";
  import ReleaseNotesModal from "$lib/components/ReleaseNotesModal.svelte";
  import { version } from "../../package.json";
  import { onMount } from "svelte";

  let { children } = $props();
  let session = $state<any>(null);
  let loading = $state(true);
  let email = $state("");
  let password = $state("");
  let showReleaseNotes = $state(false);

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
  <title>tasukul mail</title>
</svelte:head>

<main>
  {#if loading}
    <p>読み込み中...</p>
  {:else if !session}
    <section class="auth">
      <h1>tasukul mail</h1>
      <input type="email" placeholder="email" bind:value={email} />
      <input type="password" placeholder="password" bind:value={password} />
      <button onclick={signIn}>ログイン</button>
    </section>
  {:else}
    <header>
      <strong>tasukul mail</strong>
      <button class="header-version" onclick={() => (showReleaseNotes = true)}>
        v{version}
      </button>
      <nav>
        <a href="/">受信トレイ</a>
        <a href="/drafts">下書き</a>
        <a href="/compose">新規作成</a>
        <a href="/accounts">アカウント</a>
      </nav>
      <span>{session.user.email}</span>
      <button onclick={signOut}>ログアウト</button>
    </header>
    {@render children()}
    <ReleaseNotesModal bind:open={showReleaseNotes} />
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    font-family:
      -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN",
      "Noto Sans JP", sans-serif;
    background: #f6f7f9;
    color: #222;
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
