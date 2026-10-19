// Applies the saved theme before first paint and drives the header toggle.
// "system" follows prefers-color-scheme; light and dark override it.
(function () {
  const KEY = 'fm-theme';
  const ORDER = ['system', 'light', 'dark'];
  const LABEL = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };
  const read = () => {
    try { return ORDER.includes(localStorage.getItem(KEY)) ? localStorage.getItem(KEY) : 'system'; } catch { return 'system'; }
  };
  const apply = (choice) => {
    if (choice === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = choice;
    const button = document.getElementById('theme-toggle');
    if (button) button.textContent = LABEL[choice];
  };
  apply(read());
  document.addEventListener('DOMContentLoaded', () => {
    apply(read());
    document.getElementById('theme-toggle').addEventListener('click', () => {
      const next = ORDER[(ORDER.indexOf(read()) + 1) % ORDER.length];
      try { localStorage.setItem(KEY, next); } catch { /* private mode: still switch for this page */ }
      apply(next);
    });
  });
})();
