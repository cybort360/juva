# Retailer Adapter Contract

Juva intentionally separates retailer-specific retrieval from grocery optimization.

A feed configured in `JUVA_RETAILER_FEEDS_JSON` must accept a POST request containing grocery concepts, location, radius and currency, and return normalized stores/products.

Example configuration:

```json
[
  {
    "id": "retailer-a",
    "name": "Retailer A official adapter",
    "endpoint": "https://your-adapter.example.com/search",
    "authHeader": "Bearer server-side-token"
  }
]
```

Do not place retailer secrets in the Expo app. Feed credentials belong only in the API environment.

A normalized product must contain at minimum:

```json
{
  "id": "store-product-id",
  "canonicalConcept": "milk",
  "storeId": "store-123",
  "title": "Whole Milk",
  "brand": "Example Dairy",
  "sizeLabel": "1 gal",
  "priceCents": 349,
  "available": true,
  "observedAt": "2026-08-11T01:00:00Z",
  "confidence": 0.99,
  "source": "retailer_api"
}
```

The adapter is responsible for honoring the source's terms, auth requirements, rate limits and geographic semantics. Juva's core optimizer never needs retailer-specific code.
