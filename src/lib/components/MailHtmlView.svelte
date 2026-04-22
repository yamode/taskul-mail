<script lang="ts">
  // HTMLメールを iframe+srcdoc でサンドボックス表示する。
  //   - sandbox="allow-popups allow-popups-to-escape-sandbox": JS 無効、リンクは新タブで開ける
  //   - <base target="_blank"> を注入して全リンクを新タブ化
  //   - 描画後にコンテンツ高さへフィット (scroll を iframe 内部に閉じない)
  //   - 画像のリモート参照はそのまま (追跡ピクセル問題はここでは扱わない PoC)

  interface Props {
    html: string;
  }

  let { html }: Props = $props();

  let iframeEl = $state<HTMLIFrameElement | null>(null);

  // srcdoc に渡す前に <base target="_blank"> と最低限のベーススタイルを先頭に挿入。
  // メール側の <head> がある/ないどちらでも動くように、一旦 head への挿入と BODY 直前の挿入両方を試みる。
  let srcdoc = $derived.by(() => {
    const baseInjection = `<base target="_blank">
<style>
  body { margin: 0; padding: 12px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif; color: #1f2937; word-break: break-word; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100% !important; }
  a { color: #2563eb; }
</style>`;
    if (/<head[^>]*>/i.test(html)) {
      return html.replace(/<head[^>]*>/i, (m) => `${m}\n${baseInjection}\n`);
    }
    if (/<html[^>]*>/i.test(html)) {
      return html.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${baseInjection}</head>\n`);
    }
    return `<!doctype html><html><head>${baseInjection}</head><body>${html}</body></html>`;
  });

  function onLoad() {
    const el = iframeEl;
    if (!el) return;
    try {
      const doc = el.contentDocument;
      if (!doc) return;
      // コンテンツ高さに iframe を合わせる。scrollHeight は body/html の大きい方を使う。
      const h = Math.max(
        doc.body?.scrollHeight ?? 0,
        doc.documentElement?.scrollHeight ?? 0,
      );
      if (h > 0) el.style.height = `${h + 8}px`;
    } catch (_e) {
      // sandbox 越しに同一オリジンと見なされないケースはサイズ取得できないが無視
    }
  }
</script>

<iframe
  bind:this={iframeEl}
  class="mail-html"
  title="mail body"
  sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
  srcdoc={srcdoc}
  onload={onLoad}
></iframe>

<style>
  .mail-html {
    width: 100%;
    border: 0;
    background: #fff;
    display: block;
    min-height: 40px;
  }
</style>
