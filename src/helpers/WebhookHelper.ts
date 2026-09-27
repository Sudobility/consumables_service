/**
 * @fileoverview Webhook validation and parsing utilities for RevenueCat events.
 * Handles HMAC-SHA256 signature verification and extraction of purchase data
 * from webhook payloads.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { RevenueCatWebhookEvent } from "../types";

/**
 * Validates a RevenueCat webhook HMAC-SHA256 signature.
 * Uses timing-safe comparison to prevent timing attacks.
 * @param rawBody - The raw request body string.
 * @param signature - The signature from the webhook header.
 * @param secret - The shared webhook secret.
 * @returns True if the signature is valid, false otherwise.
 */
export function validateWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string
): boolean {
  // RevenueCat's current signature is `t=<unix seconds>,v1=<hex>` and
  // authenticates both the timestamp and raw body. Keep accepting a bare hex
  // digest during legacy webhook migrations.
  const match = /^t=(\d+),v1=([a-f0-9]+)$/i.exec(signature.trim());
  if (match) {
    const timestamp = Number(match[1]);
    if (
      !Number.isSafeInteger(timestamp) ||
      Math.abs(Date.now() / 1000 - timestamp) > 300
    )
      return false;
    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`)
      .digest();
    const actual = Buffer.from(match[2], "hex");
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }
  const hmac = createHmac("sha256", secret);
  hmac.update(rawBody);
  const expected = hmac.digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");
  const signatureBuffer = Buffer.from(signature, "hex");

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

/** Supports both RevenueCat HMAC signing and its configured Authorization header. */
export function validateWebhookRequest(
  rawBody: string,
  signature: string | undefined,
  authorization: string | undefined,
  secret: string
): boolean {
  if (signature && validateWebhookSignature(rawBody, signature, secret))
    return true;
  if (!authorization || !secret) return false;
  const supplied = authorization.replace(/^Bearer\s+/i, "");
  const expected = Buffer.from(secret);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const STORE_TO_SOURCE: Record<string, string> = {
  STRIPE: "web",
  APP_STORE: "apple",
  PLAY_STORE: "google",
};

/**
 * Parses a RevenueCat webhook event and extracts purchase data.
 * Only processes NON_RENEWING_PURCHASE and INITIAL_PURCHASE events.
 * Maps store names to sources (STRIPE -> web, APP_STORE -> apple, PLAY_STORE -> google).
 * @param event - The RevenueCat webhook event payload.
 * @returns Extracted purchase data, or null if the event type is not a consumable purchase.
 */
export function parseConsumablePurchaseEvent(event: RevenueCatWebhookEvent): {
  userId: string;
  transactionId: string;
  productId: string;
  priceCents: number;
  currency: string;
  store: string;
} | null {
  if (!event || !event.event || typeof event.event !== "object") return null;
  const validTypes = ["NON_RENEWING_PURCHASE", "INITIAL_PURCHASE"];

  if (!validTypes.includes(event.event.type)) {
    return null;
  }

  const { app_user_id, transaction_id, product_id, store } = event.event;
  if (!app_user_id || !transaction_id || !product_id || !store) return null;

  return {
    userId: app_user_id,
    transactionId: transaction_id,
    productId: product_id,
    priceCents: Number.isFinite(event.event.price_in_purchased_currency)
      ? Math.round(event.event.price_in_purchased_currency * 100)
      : 0,
    currency: event.event.currency || "USD",
    store: STORE_TO_SOURCE[store] ?? store,
  };
}
