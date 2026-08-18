/**
 * How long ago a price was observed, in words.
 *
 * Deliberately coarse and never rounded up. "18 minutes ago" is a claim about how current a
 * price is, and a shopper standing in an aisle will act on it — so the phrasing errs toward
 * sounding older rather than fresher, and an unparseable timestamp says so plainly instead
 * of guessing.
 */
export function observedAgo(observedAt: string, now: Date = new Date()): string {
  const parsed = Date.parse(observedAt);
  if (!Number.isFinite(parsed)) return 'checked at an unknown time';

  const seconds = Math.floor((now.getTime() - parsed) / 1000);
  // A future timestamp is a source error, not a fresh price. Never call it "just now".
  if (seconds < 0) return 'checked at an unknown time';
  if (seconds < 90) return 'checked just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `checked ${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `checked ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;

  const days = Math.floor(hours / 24);
  if (days < 31) return `checked ${days} ${days === 1 ? 'day' : 'days'} ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `checked ${months} ${months === 1 ? 'month' : 'months'} ago`;

  const years = Math.floor(days / 365);
  return `checked over ${years} ${years === 1 ? 'year' : 'years'} ago`;
}

/** Human label for where a price came from. Never dressed up as more than it is. */
export function sourceLabel(source: string): string {
  switch (source) {
    case 'retailer_api':
      return 'Retailer API';
    case 'authorized_feed':
      return 'Authorized feed';
    case 'community_feed':
      return 'Community-contributed';
    case 'receipt':
      return 'Verified from receipts';
    case 'demo':
      return 'Demo data';
    default:
      return 'Unknown source';
  }
}
