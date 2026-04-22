<script lang="ts">
  import { releaseNotes } from "$lib/release-notes";
  import { version } from "../../../package.json";

  let { open = $bindable(false) }: { open: boolean } = $props();
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="overlay" onclick={() => (open = false)}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <h3>リリースノート</h3>
        <span class="current">現在 v{version}</span>
      </div>
      <div class="modal-body">
        {#each releaseNotes as note}
          <div class="release" class:current={note.version === version}>
            <div class="release-head">
              <span class="release-ver">v{note.version}</span>
              <span class="release-date">{note.date}</span>
            </div>
            <ul>
              {#each note.changes as change}
                <li>{change}</li>
              {/each}
            </ul>
          </div>
        {/each}
      </div>
      <div class="modal-footer">
        <button class="btn-close" onclick={() => (open = false)}>閉じる</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 200;
    display: flex; justify-content: center; align-items: flex-start; padding-top: 50px;
    backdrop-filter: blur(2px);
  }
  .modal {
    background: #fff; border-radius: 12px; width: 500px; max-width: 95vw;
    max-height: 85vh; overflow-y: auto; box-shadow: 0 16px 48px rgba(0,0,0,0.2);
  }
  .modal-header {
    padding: 16px 20px; border-bottom: 1px solid #eee;
    display: flex; align-items: center; justify-content: space-between;
    position: sticky; top: 0; background: #fff; border-radius: 12px 12px 0 0; z-index: 1;
  }
  .modal-header h3 { font-size: 16px; font-weight: 800; margin: 0; }
  .current { font-size: 12px; color: #1565c0; font-weight: 600; }
  .modal-body { padding: 16px 20px; }
  .modal-footer {
    padding: 12px 20px; border-top: 1px solid #eee;
    display: flex; justify-content: flex-end;
    position: sticky; bottom: 0; background: #fff; border-radius: 0 0 12px 12px;
  }
  .btn-close {
    padding: 7px 22px; border: 1px solid #ccc; border-radius: 6px;
    background: #fff; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  .release { margin-bottom: 16px; }
  .release.current { background: #f0f7ff; border-radius: 8px; padding: 10px 12px; margin-left: -12px; margin-right: -12px; }
  .release-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
  .release-ver { font-size: 15px; font-weight: 800; color: #1a1a1a; }
  .release-date { font-size: 12px; color: #999; }
  .release ul { margin: 0; padding-left: 20px; }
  .release li { font-size: 13px; color: #444; line-height: 1.6; }
</style>
