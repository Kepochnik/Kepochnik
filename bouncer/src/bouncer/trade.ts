/**
 * Where to go and buy it, if after reading the slip you still want to.
 *
 * Two things about this file, both deliberate.
 *
 * These are referral links. The tool's only asset is that it does not sell
 * you anything, so the links say what they are, they sit below the verdict
 * rather than beside it, and nothing here reorders itself for a venue that
 * pays. A STOP has to be read before a buy button is offered, not after.
 *
 * And the chain slugs are not guessed. Each venue names chains its own way,
 * a wrong slug is a dead link or — worse — the right token on the wrong
 * chain, and a chain with no proven slug simply gets no button for that
 * venue. The proven ones came from real URLs; the rest are checked against
 * the live venues by scripts/trade-check.mjs, which is the only way to know.
 */
export interface TradeVenue {
  key: "gmgn" | "basedbot";
  name: string;
  /** What the venue is, in the words of somebody who has not used it. */
  what: string;
  url: string;
}

/** The referral codes these links carry. Stated here rather than buried in a template. */
export const REFERRAL = { gmgn: "save", basedbot: "bot" } as const;

/**
 * How each venue spells each chain. Only entries proven by a real URL or by
 * the live check are here; a missing entry means no button, which is the
 * honest outcome of not knowing.
 */
export const TRADE_SLUGS: Record<string, { gmgn?: string; basedbot?: string }> = {
  robinhood: { gmgn: "robinhood", basedbot: "robinhood" },
  base: { gmgn: "base" },
  bnb: { gmgn: "bsc" },
  solana: { gmgn: "sol" },
};

/**
 * The links for one token on one chain. Empty when the venues do not cover
 * the chain, which the caller shows as nothing rather than as a dead button.
 */
export function tradeVenues(chainKey: string, address: string): TradeVenue[] {
  const slugs = TRADE_SLUGS[chainKey];
  if (!slugs || !address) return [];
  const out: TradeVenue[] = [];
  if (slugs.gmgn) {
    out.push({
      key: "gmgn",
      name: "GMGN",
      what: "chart, holders and a one-click swap",
      url: `https://gmgn.ai/${slugs.gmgn}/token/${REFERRAL.gmgn}_${address}`,
    });
  }
  if (slugs.basedbot) {
    out.push({
      key: "basedbot",
      name: "BasedBot",
      what: "buy from Telegram, no browser wallet",
      url: `https://basedbot.app/r/${REFERRAL.basedbot}/token/${slugs.basedbot}/${address}`,
    });
  }
  return out;
}
