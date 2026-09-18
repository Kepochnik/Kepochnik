// BOUNCER badge: finds the token address in the page URL and pins a small
// "check the list" link to the slip. It reads the URL only; it never touches
// the page's wallet, forms or storage.
(() => {
  // Which chain the page is about. Getting this wrong is worse than not
  // showing the badge: the slip would then be read on a chain where the same
  // address is a different contract, or nothing at all.
  const chainFor = () => {
    const host = location.host.replace(/^www\./, "");
    const byHost = {
      "robinhoodchain.blockscout.com": "robinhood",
      "basescan.org": "base",
      "base.blockscout.com": "base",
      "bscscan.com": "bnb",
      "solscan.io": "solana",
      "solana.fm": "solana",
      "testnet.arcscan.app": "arc-testnet",
      "arcscan.app": "arc-testnet",
    };
    if (byHost[host]) return byHost[host];
    // Aggregators put the chain in the first path segment.
    const bySegment = { base: "base", bsc: "bnb", bnb: "bnb", solana: "solana", sol: "solana", robinhood: "robinhood" };
    const segment = location.pathname.split("/").filter(Boolean)[0];
    return bySegment[(segment ?? "").toLowerCase()] ?? null;
  };

  const chain = chainFor();
  if (!chain) return; // an unknown chain would send the reader to the wrong one
  const address =
    chain === "solana"
      ? (location.href.match(/\/(?:token|account|address)\/([1-9A-HJ-NP-Za-km-z]{32,44})/) ?? [])[1]
      : (location.href.match(/0x[0-9a-fA-F]{40}/) ?? [])[0]?.toLowerCase();
  if (!address) return;

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
