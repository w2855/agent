(async () => {
  const cs = (el) => getComputedStyle(el);
  const root = document.documentElement;
  const V = (n) => cs(root).getPropertyValue(n).trim();

  const out = {
    theme: root.dataset.theme,
    accent: root.dataset.accent,
    vars: {
      accent: V('--accent'), accentInk: V('--accent-ink'), accentSoft: V('--accent-soft'),
      pageTop: V('--page-top'), pageBottom: V('--page-bottom'),
      panel: V('--panel'), text: V('--text'), text3: V('--text-3'),
      bubble: V('--bubble'), chipBg: V('--chip-active-bg'), chipInk: V('--chip-active-ink'),
    },
    rendered: {
      sidebar: cs(document.querySelector('#sidebar')).backgroundColor,
      body: cs(document.body).backgroundImage.slice(0, 120),
      newChat: cs(document.querySelector('#newChatBtn')).backgroundColor,
      newChatInk: cs(document.querySelector('#newChatBtn')).color,
      chipAll: cs(document.querySelector('#filters .chip.is-active')).backgroundColor,
      chipAllInk: cs(document.querySelector('#filters .chip.is-active')).color,
      send: cs(document.querySelector('#sendBtn')).backgroundColor,
      composer: cs(document.querySelector('#composer')).backgroundColor,
      title: cs(document.querySelector('#title')).color,
      prose: cs(document.querySelector('.empty p')).color,
      brandLoaded: document.querySelector('#brandGlyph').complete
        && document.querySelector('#brandGlyph').naturalWidth > 0,
    },
  };
  return out;
})();
