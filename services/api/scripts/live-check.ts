/**
 * Live smoke check against the real upstream APIs. Not part of the test suite:
 * it needs network access and depends on third-party data that changes.
 */
import { GeoService } from '../src/retailers/geo.js';
import { OpenPricesAdapter } from '../src/retailers/openPrices.js';

// Upstream usage policies require a contactable identifier.
const UA =
  process.env.JUVA_CONTACT_USER_AGENT ??
  'Juva/0.2 live-check (set JUVA_CONTACT_USER_AGENT with a contact address)';

async function main(): Promise<void> {
  const geo = new GeoService({ userAgent: UA });
  const adapter = new OpenPricesAdapter({ userAgent: UA, geo });

  // Mountain View, CA — the best-covered US area measured in Open Prices.
  const location = await geo.resolveLocation({ postalCode: '94043', countryCode: 'us' });
  console.log('location:', location.label.slice(0, 60), location.latitude, location.longitude);

  const stores = await adapter.getNearbyStores({
    latitude: location.latitude,
    longitude: location.longitude,
    radiusMiles: 3,
    limit: 6,
  });
  console.log(`\nstores found via OSM: ${stores.length}`);
  for (const store of stores) {
    console.log(`  ${store.id}  ${store.retailerName}  ${store.distanceMiles}mi`);
  }

  const concepts = ['milk', 'bread', 'eggs', 'yogurt', 'chicken breast', 'bananas'];
  let priced = 0;

  for (const store of stores.slice(0, 4)) {
    const observations = await adapter.getPrice({
      store,
      concepts,
      currency: 'USD',
    });
    if (observations.length === 0) continue;
    priced += observations.length;
    console.log(`\n${store.retailerName} (${store.id}) -> ${observations.length} observations`);
    for (const o of observations.slice(0, 5)) {
      const promo = o.promotion
        ? ` PROMO[${o.promotion.label}, loyalty=${o.promotion.requirements.loyaltyRequired}]`
        : '';
      const unit = o.unitPrice ? ` unit=${o.unitPrice.cents}c/${o.unitPrice.per}` : '';
      console.log(
        `   ${o.matchedConcept?.padEnd(15)} ${(o.price.cents / 100).toFixed(2)} ${o.price.currency}` +
          ` | ${o.freshness.padEnd(7)} | conf ${o.confidence} | ${o.observedAt.slice(0, 10)}` +
          ` | scope=${o.scope.kind}:${o.scope.storeId === store.id ? 'MATCHES' : 'MISMATCH'}${unit}${promo}`,
      );
      console.log(`     ${o.product.name.slice(0, 60)}`);
    }
  }

  console.log(`\ntotal observations: ${priced}`);
  console.log('adapter health:', JSON.stringify(adapter.health()));
  console.log('geo health:', JSON.stringify(geo.overpassHealth.snapshot().state));
}

main().catch((error) => {
  console.error('LIVE CHECK FAILED:', error);
  process.exit(1);
});
