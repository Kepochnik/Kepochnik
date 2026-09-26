// BOUNCER badge: finds the token this page is about and pins a small
// "check the list" link to its slip. It reads the URL only; it never touches
// the page's wallet, forms or storage.
//
// Which chain the page is about is decided in the core
// (src/bouncer/pageSubject.ts), generated into page-subject.js, and shared
// with the popup — which used to keep a second, wronger copy of the same
// table. Getting this wrong is worse than showing no badge at all: the slip
// would be read on a chain where the same address is a different contract.
(() => {
  const read = globalThis.__bouncerPageSubject;
  if (typeof read !== "function") return;
  const subject = read(location.href);
  if (!subject) return;

  const existing = document.getElementById("bouncer-badge");
  if (existing) existing.remove();
  chrome.storage.sync.get({ siteUrl: "https://kepochnik.github.io/bouncer/" }, ({ siteUrl }) => {
    const a = document.createElement("a");
    a.id = "bouncer-badge";
    a.href = `${siteUrl}#/t/${subject.address}?chain=${subject.chain}`;
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
