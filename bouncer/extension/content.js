// BOUNCER badge: finds the 0x address in the page URL and pins a small
// "check the list" link to the slip. It reads the URL only; it never
// touches the page's wallet, forms or storage.
(() => {
  const match = location.href.match(/0x[0-9a-fA-F]{40}/);
  if (!match) return;
  const address = match[0].toLowerCase();
  const chain = /arcscan\.app/.test(location.host) ? "arc-testnet" : "robinhood";
  const existing = document.getElementById("bouncer-badge");
  if (existing) existing.remove();
  chrome.storage.sync.get({ siteUrl: "https://kepochnik.github.io/bouncer/" }, ({ siteUrl }) => {
    const a = document.createElement("a");
    a.id = "bouncer-badge";
    a.href = `${siteUrl}#/t/${address}?chain=${chain}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "🦍 BOUNCER · check the list";
    Object.assign(a.style, {
      position: "fixed", right: "16px", bottom: "16px", zIndex: "2147483647",
      background: "#0e0d10", color: "#c9a227", border: "1px solid #c9a227", borderRadius: "999px",
      padding: "10px 14px", font: "600 13px ui-monospace, Menlo, monospace", textDecoration: "none",
      boxShadow: "0 4px 18px rgba(0,0,0,.45)", letterSpacing: ".04em",
    });
    document.body.appendChild(a);
  });
})();
