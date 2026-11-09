# @sudobility/consumables_service

Shared backend library for consumable credits management with Drizzle ORM and PostgreSQL.

It provides a Drizzle schema factory, a `ConsumablesHelper` class for balance/purchase/usage
operations with atomic SQL, RevenueCat webhook validation/parsing, and a server-side RevenueCat
REST client. The library defines the schema but **does not own migrations** — the consuming API
passes in its own Drizzle `PgSchema` and generates/runs migrations. ESM-only; ships as compiled
`dist/`. `drizzle-orm` and `@sudobility/types` are peer dependencies.

## Installation

```bash
bun add @sudobility/consumables_service
```

This is a GitHub Packages package under the `@sudobility` scope. Installing it (or contributing)
requires an `.npmrc` with `@sudobility:registry=https://npm.pkg.github.com` and a token with
`read:packages`.

## Usage

```typescript
import {
  createConsumablesSchema,
  ConsumablesHelper,
  validateWebhookRequest,
  parseConsumablePurchaseEvent,
} from '@sudobility/consumables_service';

// Create schema tables within your Drizzle PgSchema (you own the migrations)
const tables = createConsumablesSchema(mySchema);

// Initialize helper with DB and config
const helper = new ConsumablesHelper(db, tables, { initialFreeCredits: 3 });

// Core operations
const balance = await helper.getBalance(userId);
const updated = await helper.recordPurchase(userId, { credits: 25, source: 'web' });

// recordUsage accepts a filename (legacy) or an options object
const result = await helper.recordUsage(userId, 'logo.svg');
const scored = await helper.recordUsage(userId, {
  credits: 2,
  reference: 'generate-score',
  allowNegative: true,
});
```

## API

### Schema

| Export | Description |
|--------|-------------|
| `createConsumablesSchema(pgSchema)` | Creates `consumable_balances`, `consumable_purchases`, `consumable_usages` tables within the supplied Drizzle `PgSchema`. Returns `{ consumableBalances, consumablePurchases, consumableUsages }` (type `ConsumablesSchemaResult`). |

### ConsumablesHelper

Constructed with `(db, tables, config)` where `config` is `ConsumablesConfig`.

| Method | Description |
|--------|-------------|
| `getBalance(userId)` | Get-or-create balance (auto-grants `initialFreeCredits` once, on row creation) |
| `recordPurchase(userId, request)` | Record purchase + atomic balance increment, in a transaction. Validates `credits` (positive integer) and `source` |
| `recordUsage(userId, filenameOrOptions?)` | Atomic decrement. Accepts a filename string or `{ credits?, reference?, allowNegative?, filename? }`. Default guard is `balance > 0`; `allowNegative` bypasses it. Returns `{ balance, success }` |
| `getPurchaseHistory(userId, limit?, offset?)` | Paginated purchase audit trail (most-recent-first, defaults 50/0) |
| `getUsageHistory(userId, limit?, offset?)` | Paginated usage audit trail (most-recent-first, defaults 50/0) |
| `recordPurchaseFromWebhook(userId, transactionId, credits, source, productId, priceCents, currency)` | Idempotent webhook-driven purchase recording; deduplicates by `transaction_ref_id` |

### Webhook Helpers

| Export | Description |
|--------|-------------|
| `validateWebhookSignature(rawBody, signature, secret)` | HMAC-SHA256 validation. Accepts RevenueCat's `t=<ts>,v1=<hex>` signed form (with ±300s timestamp window) and a legacy bare hex digest |
| `validateWebhookRequest(rawBody, signature, authorization, secret)` | Accepts a valid HMAC signature **or** a matching `Authorization` (bearer) header |
| `parseConsumablePurchaseEvent(event)` | Extracts purchase data from a RevenueCat webhook. Only `NON_RENEWING_PURCHASE` and `INITIAL_PURCHASE` events; maps store → source (STRIPE→web, APP_STORE→apple, PLAY_STORE→google) |

### Credit Products

| Export | Description |
|--------|-------------|
| `parseCreditProducts(value)` | Parses a `"product_id:credits,..."` string (e.g. from a `CREDIT_PRODUCTS` env var) into `CreditProduct[]`, ignoring malformed/duplicate entries |
| `creditsForProduct(productId, products)` | Case-insensitive lookup of configured credits for a product id; returns `number | null` |

### RevenueCat Client

| Export | Description |
|--------|-------------|
| `RevenueCatClient` | Server-side RevenueCat REST API v1 client. Constructed with `{ apiKey, baseUrl?, timeoutMs?, fetch? }`. Keep the Secret API key server-side |
| `client.getOfferings(appUserId, platform?)` | Fetches offerings (the client SDK is still preferred for storefront UI/prices) |
| `client.findCustomerPurchase(appUserId, transactionId, productId)` | Verifies a non-subscription transaction exists for the App User ID; returns `RevenueCatPurchase | null` |

### Types

Exported types: `ConsumableBalance`, `ConsumablePurchase`, `ConsumableUsage`,
`ConsumableUsageOptions`, `RevenueCatWebhookEvent`, `ConsumablesConfig`,
`ConsumablesSchemaResult`, `DrizzleDb`, `CreditProduct`, and the `RevenueCat*` client config/response
types. Request/response types such as `ConsumablePurchaseRequest` and `ConsumableSource` come from
the `@sudobility/types` peer dependency.

## Development

Uses Bun as runtime and package manager (never npm/yarn/pnpm). Tests run under Vitest.

```bash
bun install          # Install dependencies
bun run build        # Build ESM via tsc + fix-esm-imports.mjs -> dist/
bun run dev          # Watch mode (tsc --watch)
bun run test:unit    # Run tests once (vitest run)
bun run test:watch   # Run tests in watch mode
bun run typecheck    # Type check (tsc --noEmit)
bun run lint         # ESLint (src/)
bun run lint:fix     # ESLint with auto-fix
bun run format       # Prettier format src/
bun run format:check # Prettier check (CI-friendly)
bun run verify       # typecheck && lint && test:unit && build (run before publishing)
```

## License

BUSL-1.1
