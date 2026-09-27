/** Server-side RevenueCat REST API v1 client. */
export interface RevenueCatClientConfig {
  /** RevenueCat Secret API key. Keep this on the server. */
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface RevenueCatOffering {
  identifier: string;
  description?: string | null;
  packages: Array<{
    identifier: string;
    platform_product_identifier: string;
  }>;
}

export interface RevenueCatOfferings {
  current_offering_id: string | null;
  offerings: RevenueCatOffering[];
}

export interface RevenueCatNonSubscriptionPurchase {
  id: string;
  is_sandbox: boolean;
  purchase_date: string;
  store: string;
}

export interface RevenueCatCustomerInfo {
  subscriber?: {
    non_subscriptions?: Record<string, RevenueCatNonSubscriptionPurchase[]>;
  };
}

export interface RevenueCatPurchase {
  product_id: string;
  transaction_id: string;
  store: string;
  purchased_at: string;
  is_sandbox: boolean;
}

/**
 * Wraps the RevenueCat REST API v1. The client SDK remains responsible for
 * localized store prices and purchase UI; this server client verifies receipts.
 */
export class RevenueCatClient {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: RevenueCatClientConfig) {
    this.fetcher = config.fetch ?? fetch;
    this.baseUrl = (config.baseUrl ?? "https://api.revenuecat.com/v1").replace(
      /\/$/,
      ""
    );
    this.timeoutMs = config.timeoutMs ?? 10_000;
    if (!config.apiKey) throw new Error("RevenueCat apiKey is required");
  }

  /** Gets an app user's RevenueCat offerings (SDK is preferred for storefront UI). */
  async getOfferings(
    appUserId: string,
    platform?: string
  ): Promise<RevenueCatOfferings> {
    if (!appUserId) throw new Error("appUserId is required");
    const url = `${this.baseUrl}/subscribers/${encodeURIComponent(appUserId)}/offerings`;
    const result = await this.request<{
      current_offering_id: string | null;
      offerings: RevenueCatOffering[];
    }>(url, platform ? { "X-Platform": platform } : undefined);
    return {
      current_offering_id: result.current_offering_id,
      offerings: result.offerings ?? [],
    };
  }

  /** Verifies a transaction exists for this App User ID and the expected product. */
  async findCustomerPurchase(
    appUserId: string,
    transactionId: string,
    productId: string
  ): Promise<RevenueCatPurchase | null> {
    if (!appUserId || !transactionId || !productId) return null;
    const url = `${this.baseUrl}/subscribers/${encodeURIComponent(appUserId)}`;
    const info = await this.request<RevenueCatCustomerInfo>(url);
    const transactions = info.subscriber?.non_subscriptions?.[productId] ?? [];
    const purchase = transactions.find(item => item.id === transactionId);
    if (!purchase) return null;
    return {
      product_id: productId,
      transaction_id: purchase.id,
      store: purchase.store,
      purchased_at: purchase.purchase_date,
      is_sandbox: purchase.is_sandbox,
    };
  }

  private async request<T>(
    url: string,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          ...extraHeaders,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok)
      throw new Error(`RevenueCat API v1 request failed (${response.status})`);
    return (await response.json()) as T;
  }
}
