/**
 * The structured shape the model must return.
 *
 * `strict: true` with `additionalProperties: false` is doing real work here: the
 * model is given no field in which to express a saving, a verdict, a
 * recommendation or a judgement about the shopper. It can only transcribe. Any
 * extra property it tries to add is rejected by the provider before Juva sees it.
 */
export const receiptSchema = {
  name: 'juva_receipt_extraction',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      merchant: { type: ['string', 'null'] },
      currency: { type: 'string', enum: ['USD', 'NGN', 'GBP', 'EUR'] },
      /** The printed total the shopper paid, if legible. */
      totalCents: { type: ['integer', 'null'], minimum: 0 },
      /** Basket-level coupons, as a positive magnitude. */
      receiptDiscountCents: { type: ['integer', 'null'], minimum: 0 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      lines: {
        type: 'array',
        maxItems: 300,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            rawText: { type: 'string' },
            productName: { type: 'string' },
            chargedPriceCents: { type: 'integer' },
            quantity: { type: 'integer', minimum: 1 },
            unitPriceCents: { type: ['integer', 'null'], minimum: 0 },
            discountCents: { type: ['integer', 'null'], minimum: 0 },
            /**
             * What kind of line this is. Juva re-derives this itself and treats the
             * model's answer as a hint only, because classification decides whether
             * money is added or subtracted.
             */
            kind: {
              type: 'string',
              enum: ['item', 'discount', 'fee', 'tax', 'subtotal', 'ignored'],
            },
            barcode: { type: ['string', 'null'] },
          },
          required: [
            'rawText',
            'productName',
            'chargedPriceCents',
            'quantity',
            'unitPriceCents',
            'discountCents',
            'kind',
            'barcode',
          ],
        },
      },
    },
    required: ['merchant', 'currency', 'totalCents', 'receiptDiscountCents', 'confidence', 'lines'],
  },
} as const;
