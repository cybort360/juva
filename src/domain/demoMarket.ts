import type {
  GroceryList,
  MarketSnapshot,
  Promotion,
  RetailerProduct,
  Store,
  UserPreferences,
} from './types';

const now = new Date().toISOString();

export const demoPreferences: UserPreferences = {
  location: { label: 'Brooklyn, NY', postalCode: '11201' },
  radiusMiles: 5,
  maxStores: 2,
  transportMode: 'drive',
  brandPolicy: 'flexible',
  couponIds: [],
  loyaltyRetailers: ['grove'],
  timeValueCentsPerMinute: 3,
  extraStopPenaltyCents: 75,
  /** Neutral: effort counts at face value, neither discounted nor doubled. */
  conveniencePreference: 0.5,
  /** Roughly the cost of a second trip for one forgotten item. */
  missingItemPenaltyCents: 400,
  // Off until the shopper opts in: Juva never asks for permission on a cold start.
  receiptRemindersEnabled: false,
  receiptReminderMinutes: 90,
  receiptImageRetentionDays: 30,
  onboarded: false,
};

export const demoStores: Store[] = [
  {
    id: 'grove-dumbo',
    retailerId: 'grove',
    retailerName: 'Grove Market',
    displayName: 'Grove Market · Dumbo',
    address: '48 Jay St',
    distanceMiles: 0.8,
    etaMinutes: 7,
    colorToken: 'forest',
  },
  {
    id: 'north-atlantic',
    retailerId: 'north',
    retailerName: 'North Market',
    displayName: 'North Market · Atlantic',
    address: '220 Atlantic Ave',
    distanceMiles: 1.9,
    etaMinutes: 12,
    colorToken: 'blue',
  },
  {
    id: 'value-flatbush',
    retailerId: 'value',
    retailerName: 'Value Foods',
    displayName: 'Value Foods · Flatbush',
    address: '713 Flatbush Ave',
    distanceMiles: 3.1,
    etaMinutes: 18,
    colorToken: 'amber',
  },
];

export const demoPromotions: Promotion[] = [
  {
    id: 'grove-milk-card',
    retailerId: 'grove',
    label: '$3.49 with Grove membership',
    loyaltyRequired: true,
    overridePriceCents: 349,
  },
  {
    id: 'north-cereal-2',
    retailerId: 'north',
    label: '2 for $7',
    requiredQuantity: 2,
    overridePriceCents: 350,
  },
];

function product(
  id: string,
  concept: string,
  storeId: string,
  title: string,
  brand: string,
  size: string,
  price: number,
  opts?: Partial<RetailerProduct['observation']>,
  productOpts?: { soldByWeight?: boolean },
): RetailerProduct {
  return {
    id,
    canonicalConcept: concept,
    storeId,
    title,
    brand,
    sizeLabel: size,
    ...(productOpts?.soldByWeight === undefined ? {} : { soldByWeight: productOpts.soldByWeight }),
    observation: {
      id: `obs-${id}`,
      storeId,
      retailerId: storeId.split('-')[0] ?? storeId,
      retailerProductId: id,
      // Demo prices are still store-scoped, so the locality rule is exercised
      // by the demo market too rather than only by real adapters.
      scope: 'store',
      priceCents: price,
      currency: 'USD',
      source: 'demo',
      observedAt: now,
      // Never 'live': this is Juva's controlled market, not a retailer feed.
      freshness: 'demo',
      confidence: 0.98,
      available: true,
      availability: 'in_stock',
      ...opts,
    },
  };
}

export const demoProducts: RetailerProduct[] = [
  product('g-milk', 'milk', 'grove-dumbo', 'Whole Milk', 'Grove Farms', '1 gal', 419, {
    promotionId: 'grove-milk-card',
  }),
  product('g-eggs', 'eggs', 'grove-dumbo', 'Large Grade A Eggs', 'Grove', '12 ct', 499),
  product('g-rice', 'rice', 'grove-dumbo', 'Long Grain Rice', 'Mahatma', '5 lb', 499),
  product(
    'g-chicken',
    'chicken breast',
    'grove-dumbo',
    'Boneless Chicken Breast',
    'Grove Butcher',
    '~2 lb',
    699,
    undefined,
    { soldByWeight: true },
  ),
  product('g-bread', 'bread', 'grove-dumbo', 'Classic White Bread', 'Wonder', '20 oz', 399),
  product('g-cereal', 'cereal', 'grove-dumbo', 'Corn Flakes', "Kellogg's", '18 oz', 599),
  product('g-bananas', 'bananas', 'grove-dumbo', 'Bananas', 'Fresh', '6 ct', 249),
  product('g-oil', 'cooking oil', 'grove-dumbo', 'Vegetable Oil', 'Crisco', '48 oz', 449),
  product('g-tomato', 'tomatoes', 'grove-dumbo', 'Roma Tomatoes', 'Fresh', '2 lb', 449),
  product('g-onion', 'onions', 'grove-dumbo', 'Yellow Onions', 'Fresh', '3 lb', 399),
  product('g-yogurt', 'yogurt', 'grove-dumbo', 'Greek Yogurt', 'Chobani', '32 oz', 699),
  product('g-oats', 'oats', 'grove-dumbo', 'Old Fashioned Oats', 'Quaker', '42 oz', 649),

  product('n-milk', 'milk', 'north-atlantic', 'Whole Milk', 'North Dairy', '1 gal', 299),
  product('n-eggs', 'eggs', 'north-atlantic', 'Large Eggs', 'North', '12 ct', 299),
  product('n-rice', 'rice', 'north-atlantic', 'Long Grain Rice', 'Mahatma', '5 lb', 799),
  product(
    'n-chicken',
    'chicken breast',
    'north-atlantic',
    'Chicken Breast Family Pack',
    'North Butcher',
    '~2 lb',
    1199,
    undefined,
    { soldByWeight: true },
  ),
  product('n-bread', 'bread', 'north-atlantic', 'White Sandwich Bread', 'North', '20 oz', 229),
  product('n-cereal', 'cereal', 'north-atlantic', 'Corn Flakes', "Kellogg's", '18 oz', 399, {
    promotionId: 'north-cereal-2',
  }),
  product('n-bananas', 'bananas', 'north-atlantic', 'Bananas', 'Fresh', '6 ct', 159),
  product('n-oil', 'cooking oil', 'north-atlantic', 'Vegetable Oil', 'North Pantry', '48 oz', 699),
  product('n-tomato', 'tomatoes', 'north-atlantic', 'Roma Tomatoes', 'Fresh', '2 lb', 349),
  product('n-onion', 'onions', 'north-atlantic', 'Yellow Onions', 'Fresh', '3 lb', 329),
  product('n-yogurt', 'yogurt', 'north-atlantic', 'Greek Yogurt', 'Chobani', '32 oz', 499),
  product('n-oats', 'oats', 'north-atlantic', 'Old Fashioned Oats', 'Quaker', '42 oz', 399),

  product('v-milk', 'milk', 'value-flatbush', 'Whole Milk', 'Value Dairy', '1 gal', 529),
  product('v-eggs', 'eggs', 'value-flatbush', 'Large Eggs', 'Value', '12 ct', 449),
  product('v-rice', 'rice', 'value-flatbush', 'Long Grain Rice', 'Value Pantry', '5 lb', 549),
  product(
    'v-chicken',
    'chicken breast',
    'value-flatbush',
    'Boneless Chicken Breast',
    'Value',
    '~2 lb',
    749,
    undefined,
    { soldByWeight: true },
  ),
  product('v-bread', 'bread', 'value-flatbush', 'White Bread', 'Value Bakery', '20 oz', 329),
  product('v-cereal', 'cereal', 'value-flatbush', 'Corn Flakes', 'Value Pantry', '18 oz', 699),
  product('v-bananas', 'bananas', 'value-flatbush', 'Bananas', 'Fresh', '6 ct', 219),
  product('v-oil', 'cooking oil', 'value-flatbush', 'Vegetable Oil', 'Value Pantry', '48 oz', 499),
  product('v-tomato', 'tomatoes', 'value-flatbush', 'Roma Tomatoes', 'Fresh', '2 lb', 259),
  product('v-onion', 'onions', 'value-flatbush', 'Yellow Onions', 'Fresh', '3 lb', 289),
  product('v-yogurt', 'yogurt', 'value-flatbush', 'Greek Yogurt', 'Value Cultured', '32 oz', 799),
  product('v-oats', 'oats', 'value-flatbush', 'Old Fashioned Oats', 'Value Pantry', '42 oz', 599),
];

export const demoList: GroceryList = {
  id: 'demo-weekly',
  title: 'Weekly groceries',
  prompt: 'Weekly groceries for two under $80',
  budgetCents: 8000,
  currency: 'USD',
  createdAt: now,
  items: [
    ['milk', 'Milk', 1, '1 gallon'],
    ['eggs', 'Eggs', 1, '12 large'],
    ['rice', 'Rice', 1, '5 lb'],
    ['chicken breast', 'Chicken breast', 1, '~2 lb'],
    ['bread', 'Bread', 1, '1 loaf'],
    ['cereal', 'Corn Flakes', 1, '18 oz'],
    ['bananas', 'Bananas', 1, '6'],
    ['cooking oil', 'Cooking oil', 1, '48 oz'],
    ['tomatoes', 'Tomatoes', 1, '2 lb'],
    ['onions', 'Onions', 1, '3 lb'],
    ['yogurt', 'Greek yogurt', 1, '32 oz'],
    ['oats', 'Oats', 1, '42 oz'],
  ].map(([concept, displayName, quantity, unit], index) => ({
    id: `item-${index + 1}`,
    concept: String(concept),
    displayName: String(displayName),
    quantity: Number(quantity),
    unit: String(unit),
    ...(concept === 'cereal'
      ? { brandPolicy: 'flexible' as const, requestedBrand: "Kellogg's" }
      : {}),
  })),
};

/**
 * Juva's controlled market: three nearby stores, twelve everyday groceries,
 * two promotions. Deterministic, fully offline, and always labelled as demo.
 */
export function buildDemoSnapshot(): MarketSnapshot {
  return {
    stores: demoStores,
    products: demoProducts,
    promotions: demoPromotions,
    mode: 'demo',
    fetchedAt: new Date().toISOString(),
  };
}
