// Runs before the app in the popup: if the active tab's URL carries a
// 0x address (a token page on Pons, GMGN, DexScreener or Blockscout), open
// its slip in live mode on the matching chain. Reads the URL only.
(() => {
  const chainFor = (url) => (/arcscan\.app/.test(url) ? (/testnet/.test(url) ? "arc-testnet" : "arc") : "robinhood");
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs && tabs[0] && tabs[0].url ? tabs[0].url : "";
      const m = url.match(/0x[0-9a-fA-F]{40}/);
      if (!m) return;
      const next = `#/t/${m[0].toLowerCase()}?chain=${chainFor(url)}`;
      if (location.hash !== next) location.hash = next;
    });
  } catch (_) {
    /* not inside an extension: the app boots on its own */
  }
})();

// A custom RPC or proxy is another origin: ask Chrome for it when the user
// saves one, so the popup can call it (Web Store rules: narrow defaults,
// optional origins requested on demand).
(() => {
  const ask = (value) => {
    try {
      const origin = new URL(value).origin + "/*";
      chrome.permissions.request({ origins: [origin] }, () => {});
    } catch (_) { /* not a URL yet */ }
  };
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t && (t.id === "rpc" || t.id === "proxy") && t.value.trim()) ask(t.value.trim());
  });
})();
