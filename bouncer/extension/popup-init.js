// Runs before the app in the popup: if the active tab is a token page, open
// that token's slip in live mode, on the chain that page is about. Reads the
// tab's URL and nothing else.
//
// It used to carry its own two-case host table and send everything it did not
// recognise to Robinhood Chain — so opening the popup on a Base token page
// read those twenty bytes on a chain where they are a different contract, or
// nothing, and then printed a verdict about it. Its address pattern was
// EVM-only, so a Solana mint was ignored outright. The table now lives in the
// core (src/bouncer/pageSubject.ts) and is generated into page-subject.js,
// which the popup loads before this file.
(() => {
  const read = globalThis.__bouncerPageSubject;
  if (typeof read !== "function") return; // the app boots on its own
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = (tabs && tabs[0] && tabs[0].url) || "";
      const subject = read(url);
      // No chain means no answer. An address read on the wrong chain is a
      // confident report about a different contract, which is the one outcome
      // worse than an empty popup.
      if (!subject) return;
      const next = `#/t/${subject.address}?chain=${subject.chain}`;
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
