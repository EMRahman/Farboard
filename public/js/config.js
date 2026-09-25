/*
 * config.js — settings for this copy of Farboard.
 *
 * A copy running on Cloudflare has its own relay at the same address and
 * finds it by itself; these settings are for everything else.
 */
window.FarboardConfig = {
  // A relay to host games on when this site has none of its own, as on the
  // GitHub Pages copy: the address of a relay with public hosting switched
  // on, e.g. 'farboard.yourname.workers.dev'. Leave it empty for none.
  sharedRelay: '',

  // Where "Deploy to Cloudflare" takes people making a copy of their own.
  deployUrl: 'https://deploy.workers.cloudflare.com/?url=https://github.com/EMRahman/Farboard'
};
