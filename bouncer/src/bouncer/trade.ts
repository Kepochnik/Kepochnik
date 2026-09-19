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

/** The codes these links carry. Stated here rather than buried in a template. */
export const REFERRAL = { gmgn: "save", basedbot: "bot" } as const;

/** Every venue the tool can link to, so a missing one can be named rather than silently dropped. */
export const VENUE_NAMES: Record<"gmgn" | "basedbot", string> = { gmgn: "GMGN", basedbot: "BasedBot" };

/**
 * How each venue spells each chain, and how sure we are.
 *
 * Robinhood came from working URLs for both venues. The other three GMGN
 * slugs are recall, and they are still unverified: both venues answer 403
 * to any automated client — plain fetch and a real headless browser alike,
 * from two different networks — so scripts/trade-check.mjs reports "could
 * not be judged" rather than proving anything. It will catch a 404 the day
 * one of them starts answering.
 *
 * They ship anyway because the cost of being wrong is a 404 page the reader
 * can see, not a wrong number they would act on — the two are not the same
 * kind of mistake, and only the second is worth withholding a feature over.
 * A chain with no entry at all still gets no button; inventing coverage on
 * somebody else's product is a different thing again.
 */
export const TRADE_SLUGS: Record<string, { gmgn?: string; basedbot?: string }> = {
  robinhood: { gmgn: "robinhood", basedbot: "robinhood" }, // both from real URLs
  base: { gmgn: "base" }, // unverified
  bnb: { gmgn: "bsc" }, // unverified
  solana: { gmgn: "sol" }, // unverified
};

/** Which slugs a real URL proved, as opposed to the ones still taken on recall. */
export const PROVEN: Record<string, Array<"gmgn" | "basedbot">> = { robinhood: ["gmgn", "basedbot"] };

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

/**
 * Venues that exist but have no slug for this chain.
 *
 * Dropping them silently was the wrong call and it showed: BasedBot simply
 * vanished on every chain but Robinhood and the page gave no reason, so it
 * read as a bug rather than as a gap. This whole tool says what it could
 * not read; a venue it cannot link to is the same kind of fact.
 */
export function missingVenues(chainKey: string): string[] {
  const slugs = TRADE_SLUGS[chainKey];
  if (!slugs) return [];
  return (Object.keys(VENUE_NAMES) as Array<"gmgn" | "basedbot">).filter((v) => !slugs[v]).map((v) => VENUE_NAMES[v]);
}
