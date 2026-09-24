// Historical Chainlink prices without an archive node.
//
// A Chainlink proxy numbers its rounds as (phaseId << 64) | aggregatorRoundId,
// and every round keeps its answer and updatedAt forever. So "the price at time
// T" is a binary search over round ids for the last round updated at or before
// T. Each lookup costs ~log2(rounds) eth_calls; rounds are cached, so searches
// for nearby timestamps share most of their path.

import { encodeUint, toSigned, words } from './rpc.mjs';

const SEL = {
  latestRoundData: '0xfeaf968c',
  getRoundData: '0x9a6fc8f5',
  decimals: '0x313ce567',
  phaseAggregators: '0xc1597304',
  latestRound: '0x668a0f02',
};
const PHASE_SHIFT = 64n;
const AGG_MASK = (1n << PHASE_SHIFT) - 1n;

/**
 * @typedef {{ roundId: bigint, answer: bigint, updatedAt: number }} Round
 * @typedef {{ price: number, updatedAt: number }} PricePoint
 */

export function createFeedReader(rpc) {
  const rounds = new Map(); // `${feed}:${roundId}` -> Round | null
  const meta = new Map(); // feed -> Promise<{ decimals, latest }>

  function decodeRound(hex) {
    if (!hex) return null;
    const [roundId, answer, , updatedAt] = words(hex);
    if (!updatedAt) return null;
    return { roundId, answer: toSigned(answer), updatedAt: Number(updatedAt) };
  }

  async function round(feed, roundId) {
    const key = `${feed}:${roundId}`;
    if (!rounds.has(key)) {
      rounds.set(key, rpc.call(feed, SEL.getRoundData + encodeUint(roundId)).then(decodeRound));
    }
    return rounds.get(key);
  }

  function feedMeta(feed) {
    if (!meta.has(feed)) {
      meta.set(
        feed,
        (async () => {
          const [dec, latest] = await Promise.all([
            rpc.call(feed, SEL.decimals),
            rpc.call(feed, SEL.latestRoundData),
          ]);
          if (!dec || !latest) throw new Error(`Feed ${feed} did not answer; is it a Chainlink proxy on this chain?`);
          return { decimals: Number(words(dec)[0]), latest: decodeRound(latest) };
        })(),
      );
    }
    return meta.get(feed);
  }

  async function lastRoundOfPhase(feed, phase, current) {
    if (phase === current.phase) return current.aggRound;
    const agg = await rpc.call(feed, SEL.phaseAggregators + encodeUint(phase));
    const aggregator = agg && '0x' + agg.slice(-40);
    if (!aggregator || /^0x0+$/.test(aggregator)) return 0n;
    const last = await rpc.call(aggregator, SEL.latestRound);
    return last ? words(last)[0] : 0n;
  }

  /** @returns {Promise<Round|null>} last round updated at or before `ts`, or null if the feed is younger. */
  async function roundAt(feed, ts, latest) {
    const current = { phase: latest.roundId >> PHASE_SHIFT, aggRound: latest.roundId & AGG_MASK };
    for (let phase = current.phase; phase >= 1n; phase--) {
      const id = (agg) => (phase << PHASE_SHIFT) | agg;
      let hi = await lastRoundOfPhase(feed, phase, current);
      if (hi < 1n) continue;
      const first = await round(feed, id(1n));
      if (!first || first.updatedAt > ts) continue; // T predates this phase: look further back
      let lo = 1n;
      let best = first;
      while (lo < hi) {
        const mid = (lo + hi + 1n) / 2n;
        const r = await round(feed, id(mid));
        if (r && r.updatedAt <= ts) {
          lo = mid;
          best = r;
        } else {
          hi = mid - 1n;
        }
      }
      return best;
    }
    return null;
  }

  return {
    /** @returns {Promise<PricePoint>} */
    async latest(feed) {
      const { decimals, latest } = await feedMeta(feed);
      return { price: scale(latest.answer, decimals), updatedAt: latest.updatedAt };
    },

    /** @returns {Promise<PricePoint|null>} */
    async at(feed, ts) {
      const { decimals, latest } = await feedMeta(feed);
      const r = latest.updatedAt <= ts ? latest : await roundAt(feed, ts, latest);
      return r && { price: scale(r.answer, decimals), updatedAt: r.updatedAt };
    },

    /** @returns {Promise<PricePoint>} the feed's earliest surviving round. */
    async first(feed) {
      const { decimals, latest } = await feedMeta(feed);
      for (let phase = 1n; phase <= latest.roundId >> PHASE_SHIFT; phase++) {
        const r = await round(feed, (phase << PHASE_SHIFT) | 1n);
        if (r) return { price: scale(r.answer, decimals), updatedAt: r.updatedAt };
      }
      return { price: scale(latest.answer, decimals), updatedAt: latest.updatedAt };
    },
  };
}

function scale(answer, decimals) {
  return Number(answer) / 10 ** decimals;
}
