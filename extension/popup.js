const addr = document.getElementById("addr");
const site = document.getElementById("site");
const hint = document.getElementById("hint");
chrome.storage.sync.get({ siteUrl: "https://kepochnik.github.io/bouncer/" }, ({ siteUrl }) => { site.value = siteUrl; });
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const m = (tabs[0]?.url ?? "").match(/0x[0-9a-fA-F]{40}/);
  if (m) { addr.value = m[0].toLowerCase(); hint.textContent = "address taken from the current tab"; }
});
document.getElementById("go").addEventListener("click", () => {
  const a = addr.value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { hint.textContent = "paste a 20-byte hex address"; return; }
  const s = site.value.trim() || "https://kepochnik.github.io/bouncer/";
  chrome.storage.sync.set({ siteUrl: s });
  const chain = /arcscan\.app/.test(s) ? "arc-testnet" : "robinhood";
  chrome.tabs.create({ url: `${s}#/t/${a}?chain=${chain}` });
});
