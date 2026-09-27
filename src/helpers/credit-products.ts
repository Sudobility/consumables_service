/** Server-owned RevenueCat product to credit mapping. */
export interface CreditProduct {
  productId: string;
  credits: number;
}

/** Parse `CREDIT_PRODUCTS=product_id:credits,...` without trusting client metadata. */
export function parseCreditProducts(
  value: string | null | undefined
): CreditProduct[] {
  const products = new Map<string, CreditProduct>();
  for (const entry of (value ?? "").split(",")) {
    const separator = entry.lastIndexOf(":");
    if (separator < 0) continue;
    const productId = entry.slice(0, separator).trim();
    const rawCredits = entry.slice(separator + 1).trim();
    const credits = /^\d+$/.test(rawCredits) ? Number(rawCredits) : NaN;
    if (productId && Number.isSafeInteger(credits) && credits > 0) {
      const normalizedId = productId.toLowerCase();
      if (!products.has(normalizedId))
        products.set(normalizedId, { productId, credits });
    }
  }
  return [...products.values()];
}

/** Look up configured credits using a normalized ID comparison for store casing differences. */
export function creditsForProduct(
  productId: string,
  products: readonly CreditProduct[]
): number | null {
  const normalizedId = productId.toLowerCase();
  return (
    products.find(product => product.productId.toLowerCase() === normalizedId)
      ?.credits ?? null
  );
}
