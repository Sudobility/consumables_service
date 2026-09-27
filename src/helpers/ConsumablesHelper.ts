/**
 * @fileoverview Core business logic for consumable credit management.
 * Provides balance CRUD, purchase recording, usage recording, and
 * idempotent webhook processing with atomic database operations.
 */

import { eq, desc, sql } from "drizzle-orm";
import type { ConsumablesSchemaResult } from "../schema";
import type {
  ConsumableBalanceResponse,
  ConsumablePurchaseRequest,
  ConsumableSource,
  ConsumableUseResponse,
} from "@sudobility/types";
import type {
  ConsumablePurchase,
  ConsumableUsage,
  ConsumableUsageOptions,
  ConsumablesConfig,
} from "../types";

/** Valid ConsumableSource values for input validation. */
const VALID_SOURCES: ConsumableSource[] = ["web", "apple", "google", "free"];

/**
 * Minimal typed interface for the Drizzle database instance.
 * Keeps `any` return types to avoid drizzle-orm version coupling,
 * while ensuring the db object has the expected shape.
 */
export interface DrizzleDb {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
}

/**
 * Core helper class for managing consumable credits.
 * Handles balance get-or-create, purchase recording with atomic increments,
 * usage recording with atomic decrements, and idempotent webhook processing.
 */
export class ConsumablesHelper {
  private db: DrizzleDb;
  private tables: ConsumablesSchemaResult;
  private config: ConsumablesConfig;

  constructor(
    db: DrizzleDb,
    tables: ConsumablesSchemaResult,
    config: ConsumablesConfig
  ) {
    this.db = db;
    this.tables = tables;
    this.config = config;
  }

  /**
   * Gets or creates a balance record for the given user.
   * On first access, grants initialFreeCredits and records a "free" purchase audit entry.
   * @param userId - The user's unique identifier.
   * @returns The user's balance and initial credits.
   */
  async getBalance(userId: string): Promise<ConsumableBalanceResponse> {
    const { consumableBalances } = this.tables;
    const existing = await this.db
      .select()
      .from(consumableBalances)
      .where(eq(consumableBalances.user_id, userId));

    if (existing.length > 0) {
      return {
        balance: existing[0].balance,
        initial_credits: existing[0].initial_credits,
      };
    }

    // First access — create with free credits
    const freeCredits = this.config.initialFreeCredits;
    await this.db.insert(consumableBalances).values({
      user_id: userId,
      balance: freeCredits,
      initial_credits: freeCredits,
    });

    // Record the free credits as a purchase audit entry
    if (freeCredits > 0) {
      await this.db.insert(this.tables.consumablePurchases).values({
        user_id: userId,
        credits: freeCredits,
        source: "free" as ConsumableSource,
      });
    }

    return { balance: freeCredits, initial_credits: freeCredits };
  }

  /**
   * Records a purchase and atomically increments the user's credit balance.
   * Ensures the balance row exists via getBalance() before updating.
   * Wrapped in a database transaction for consistency.
   * @param userId - The user's unique identifier.
   * @param request - Purchase details including credits, source, and optional metadata.
   * @returns The updated balance after the purchase.
   * @throws Error if credits is not a positive integer or source is invalid.
   */
  async recordPurchase(
    userId: string,
    request: ConsumablePurchaseRequest
  ): Promise<ConsumableBalanceResponse> {
    // Validate inputs
    if (!Number.isInteger(request.credits) || request.credits <= 0) {
      throw new Error("credits must be a positive integer");
    }
    if (!VALID_SOURCES.includes(request.source)) {
      throw new Error("source must be one of: web, apple, google, free");
    }

    const { consumableBalances, consumablePurchases } = this.tables;

    return this.db.transaction(async (tx: any) => {
      // Ensure balance record exists (idempotent) — uses tx for reads/writes
      const existing = await tx
        .select()
        .from(consumableBalances)
        .where(eq(consumableBalances.user_id, userId));

      if (existing.length === 0) {
        const freeCredits = this.config.initialFreeCredits;
        await tx.insert(consumableBalances).values({
          user_id: userId,
          balance: freeCredits,
          initial_credits: freeCredits,
        });

        if (freeCredits > 0) {
          await tx.insert(consumablePurchases).values({
            user_id: userId,
            credits: freeCredits,
            source: "free" as ConsumableSource,
          });
        }
      }

      // Insert purchase record
      await tx.insert(consumablePurchases).values({
        user_id: userId,
        credits: request.credits,
        source: request.source,
        transaction_ref_id: request.transaction_ref_id ?? null,
        product_id: request.product_id ?? null,
        price_cents: request.price_cents ?? null,
        currency: request.currency ?? null,
      });

      // Atomically increment balance
      await tx
        .update(consumableBalances)
        .set({
          balance: sql`${consumableBalances.balance} + ${request.credits}`,
          updated_at: new Date(),
        })
        .where(eq(consumableBalances.user_id, userId));

      // Return updated balance
      const updated = await tx
        .select()
        .from(consumableBalances)
        .where(eq(consumableBalances.user_id, userId));

      return {
        balance: updated[0].balance,
        initial_credits: updated[0].initial_credits,
      };
    });
  }

  /**
   * Records a credit usage and atomically decrements the balance.
   *
   * The second argument accepts either a filename string — the original
   * signature, kept so published consumers keep working untouched — or an
   * options object.
   *
   * `credits` defaults to 1 and `allowNegative` to false, so a caller passing
   * neither gets exactly the previous behaviour.
   *
   * The default guard (`balance > 0`) asserts *you must have credit to spend*,
   * not *you must have enough*: a deduction larger than a positive balance
   * still applies and lands negative. That is right where the deduction is
   * itself the permission check, taken at the moment of use. Where permission
   * was granted earlier — a job admitted by a gate and charged when it finishes
   * — the balance may have moved below zero in between, and refusing then would
   * not protect it, only fail to record a debt. Those callers pass
   * `allowNegative`.
   *
   * @param userId - The user's unique identifier.
   * @param filenameOrOptions - A filename, or `{ credits, reference, allowNegative }`.
   * @returns The updated balance and whether the deduction was applied.
   */
  async recordUsage(
    userId: string,
    filenameOrOptions?: string | ConsumableUsageOptions
  ): Promise<ConsumableUseResponse> {
    const options: ConsumableUsageOptions =
      typeof filenameOrOptions === "string"
        ? { filename: filenameOrOptions }
        : (filenameOrOptions ?? {});

    const credits = options.credits ?? 1;
    if (!Number.isInteger(credits) || credits <= 0) {
      throw new Error("credits must be a positive integer");
    }

    const { consumableBalances, consumableUsages } = this.tables;

    const result = await this.db
      .update(consumableBalances)
      .set({
        balance: sql`${consumableBalances.balance} - ${credits}`,
        updated_at: new Date(),
      })
      .where(
        options.allowNegative
          ? sql`${consumableBalances.user_id} = ${userId}`
          : sql`${consumableBalances.user_id} = ${userId} AND ${consumableBalances.balance} > 0`
      )
      .returning({ balance: consumableBalances.balance });

    if (result.length === 0) {
      // Either the user has no balance row, or the guard refused.
      const current = await this.getBalance(userId);
      return { balance: current.balance, success: false };
    }

    await this.db.insert(consumableUsages).values({
      user_id: userId,
      credits,
      reference: options.reference ?? null,
      filename: options.filename ?? null,
    });

    return { balance: result[0].balance, success: true };
  }

  /**
   * Fetches paginated purchase history for a user, ordered most recent first.
   * @param userId - The user's unique identifier.
   * @param limit - Maximum number of records to return. Defaults to 50.
   * @param offset - Number of records to skip. Defaults to 0.
   * @returns Array of purchase records.
   */
  async getPurchaseHistory(
    userId: string,
    limit = 50,
    offset = 0
  ): Promise<ConsumablePurchase[]> {
    const { consumablePurchases } = this.tables;
    return this.db
      .select()
      .from(consumablePurchases)
      .where(eq(consumablePurchases.user_id, userId))
      .orderBy(desc(consumablePurchases.created_at))
      .limit(limit)
      .offset(offset);
  }

  /**
   * Fetches paginated usage history for a user, ordered most recent first.
   * @param userId - The user's unique identifier.
   * @param limit - Maximum number of records to return. Defaults to 50.
   * @param offset - Number of records to skip. Defaults to 0.
   * @returns Array of usage records.
   */
  async getUsageHistory(
    userId: string,
    limit = 50,
    offset = 0
  ): Promise<ConsumableUsage[]> {
    const { consumableUsages } = this.tables;
    return this.db
      .select()
      .from(consumableUsages)
      .where(eq(consumableUsages.user_id, userId))
      .orderBy(desc(consumableUsages.created_at))
      .limit(limit)
      .offset(offset);
  }

  /**
   * Records a purchase from a webhook event, with idempotency.
   * Checks if the transaction_ref_id already exists to prevent duplicate processing.
   * Safe to call multiple times with the same transactionId.
   * @param userId - The user's unique identifier.
   * @param transactionId - The unique transaction reference from RevenueCat.
   * @param credits - Number of credits to grant.
   * @param source - Purchase source ("web", "apple", or "google").
   * @param productId - The RevenueCat product identifier.
   * @param priceCents - The purchase price in cents.
   * @param currency - The ISO currency code.
   * @returns Whether the webhook was already processed and the current balance.
   */
  async recordPurchaseFromWebhook(
    userId: string,
    transactionId: string,
    credits: number,
    source: ConsumableSource,
    productId: string,
    priceCents: number,
    currency: string
  ): Promise<{ alreadyProcessed: boolean; balance: number }> {
    // Check for duplicate
    const existing = await this.db
      .select()
      .from(this.tables.consumablePurchases)
      .where(
        eq(this.tables.consumablePurchases.transaction_ref_id, transactionId)
      );

    if (existing.length > 0) {
      const bal = await this.getBalance(userId);
      return { alreadyProcessed: true, balance: bal.balance };
    }

    try {
      const result = await this.recordPurchase(userId, {
        credits,
        source,
        transaction_ref_id: transactionId,
        product_id: productId,
        price_cents: priceCents,
        currency,
      });
      return { alreadyProcessed: false, balance: result.balance };
    } catch (error) {
      // The API enforces a unique transaction_ref_id index. If a webhook and
      // the authenticated purchase confirmation race, the losing transaction
      // is rolled back and treated as the same successful, idempotent purchase.
      const raced = await this.db
        .select()
        .from(this.tables.consumablePurchases)
        .where(
          eq(this.tables.consumablePurchases.transaction_ref_id, transactionId)
        );
      if (raced.length === 0) throw error;
      const bal = await this.getBalance(userId);
      return { alreadyProcessed: true, balance: bal.balance };
    }
  }
}
