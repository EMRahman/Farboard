/*
 * budget.js — one Durable Object that counts new games, for public hosting.
 *
 * Only a relay with PUBLIC_HOSTING switched on uses it: there anyone may
 * start a game, so the number of new games per UTC day (and per network per
 * hour) is capped here. Games already under way are never cut off by it.
 *
 * Stored: today's count and this hour's per-network counts, keyed by a hash
 * of the day and the network address, so nothing identifies anyone for long.
 */
import { DurableObject } from 'cloudflare:workers';
import { claimGame, publicStats } from './rules.js';

export class Budget extends DurableObject {
  /* Count one new game if the limits allow it. */
  async claim(networkHash, limits, isOwner) {
    const now = Date.now();
    // No other await between this read and the write below, so two claims
    // cannot both take the last game of the day.
    const ledger = (await this.ctx.storage.get('ledger')) || null;
    const result = claimGame(ledger, now, networkHash, limits, isOwner);
    this.ctx.storage.put('ledger', result.ledger);
    const stats = publicStats(result.ledger, now, limits);
    console.log(
      JSON.stringify({
        event: result.ok ? 'game-created' : 'game-refused',
        reason: result.reason || undefined,
        owner: isOwner || undefined,
        gamesToday: stats.gamesToday,
        dailyLimit: stats.dailyLimit
      })
    );
    return { ok: result.ok, reason: result.reason || null, stats };
  }

  async stats(limits) {
    const ledger = (await this.ctx.storage.get('ledger')) || null;
    return publicStats(ledger, Date.now(), limits);
  }
}
