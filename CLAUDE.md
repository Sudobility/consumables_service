# Consumables Service

> **Git policy — never auto-commit or auto-push.** Leave your work in the working tree.
> Run `git commit`, `git push`, `gh pr create`, or `scripts/push_all.sh` **only when the user
> explicitly asks in that turn**. Approval for an earlier change does not carry forward, and
> finishing a task is not permission to commit it.

Shared backend library for consumable credits management with Drizzle ORM.

**npm**: `@sudobility/consumables_service` (public)
**Version**: 0.1.7
**License**: BUSL-1.1

## Tech Stack

- **Language**: TypeScript 5.9.x (strict mode)
- **Runtime**: Bun
- **Package Manager**: Bun (never npm/yarn/pnpm)
- **Build**: TypeScript compiler via `tsconfig.esm.json` (ESM only)
- **Test**: Vitest 4.x
- **ORM**: Drizzle ORM >=0.44.0 (peer dependency)

## Project Structure

```
src/
├── index.ts                    # Main barrel exports (types, schema, helpers)
├── types/
│   └── index.ts                # ConsumableBalance, ConsumablePurchase, ConsumableUsage, RevenueCatWebhookEvent, ConsumablesConfig
├── schema/
│   └── index.ts                # createConsumablesSchema(pgSchema) -- Drizzle table definitions
└── helpers/
    ├── index.ts                # Re-exports ConsumablesHelper, validateWebhookSignature, parseConsumablePurchaseEvent
    ├── ConsumablesHelper.ts    # Core business logic class (balance CRUD, purchase/usage recording)
    └── WebhookHelper.ts        # RevenueCat webhook HMAC validation + event parsing
tests/
├── ConsumablesHelper.test.ts   # Business logic tests with mock DB
└── WebhookHelper.test.ts       # HMAC validation + event parsing tests
```

## Commands

```bash
bun run build        # Build ESM via tsc -p tsconfig.esm.json
bun run clean        # Remove dist/
bun run dev          # Watch mode (tsc --watch)
bun test             # Run tests (vitest run)
bun run test:watch   # Watch tests
bun run lint         # ESLint (eslint src/)
bun run lint:fix     # ESLint with auto-fix
bun run typecheck    # TypeScript check (tsc --noEmit)
bun run format       # Prettier format
bun run format:check # Prettier check (CI-friendly)
bun run verify       # All checks + build (typecheck && lint && test && build) -- use before commit
```

## Dependencies

### Peer Dependencies
- `@sudobility/types` ^1.9.53 -- shared type definitions (ConsumableBalanceResponse, ConsumablePurchaseRequest, ConsumableSource, ConsumableUseResponse)
- `drizzle-orm` >=0.44.0 -- ORM for database operations

### Dev Dependencies
- TypeScript ^5.9.0, Vitest ^4.0.4, drizzle-orm ^0.45.1, ESLint ^9.x, Prettier ^3.x

## Build Configuration

- **tsconfig.json**: Used for type checking (`noEmit: true`), strict mode, `isolatedModules: true`
- **tsconfig.esm.json**: Extends tsconfig.json, sets `noEmit: false`, `module: ESNext`, `outDir: ./dist`, `declarationMap: true`, `sourceMap: true`

## Key Concepts

### Schema Creator
`createConsumablesSchema(pgSchema)` creates three tables within a given Drizzle PgSchema:
- `consumable_balances` -- user balance (user_id PK, balance, initial_credits, timestamps)
- `consumable_purchases` -- purchase audit trail (serial id, user_id, credits, source, transaction_ref_id, product_id, price_cents, currency, timestamp)
- `consumable_usages` -- usage audit trail (serial id, user_id, filename, timestamp)

The `schema` parameter is typed as `any` intentionally to avoid drizzle-orm version coupling. The consuming API passes its own schema so migrations stay in one place.

### ConsumablesHelper
Core business logic class. Constructed with `(db, tables, config)`:
- `getBalance(userId)` -- get-or-create; auto-grants `config.initialFreeCredits` on first access and records a "free" purchase audit entry
- `recordPurchase(userId, request)` -- insert purchase record + atomic balance increment via `SET balance = balance + N`
- `recordUsage(userId, filename?)` -- atomic decrement with `WHERE balance > 0` guard; returns `{ success: false }` if insufficient
- `getPurchaseHistory(userId, limit?, offset?)` -- paginated, most-recent-first
- `getUsageHistory(userId, limit?, offset?)` -- paginated, most-recent-first
- `recordPurchaseFromWebhook(userId, transactionId, credits, source, productId, priceCents, currency)` -- idempotent; deduplicates by `transaction_ref_id`

### RevenueCatClient
- Server-only RevenueCat REST API v1 client; requires a Secret API key with customer read access.
- `getOfferings(appUserId)` retrieves offerings, though the frontend SDK is preferred for storefront UI and prices.
- `findCustomerPurchase(appUserId, transactionId, productId)` verifies the expected non-subscription transaction for that RevenueCat App User ID.
- Keep the key on the server. The frontend uses the separate public SDK key.

### WebhookHelper
- `validateWebhookSignature(rawBody, signature, secret)` -- HMAC-SHA256 validation using Node.js `crypto`
- `validateWebhookRequest(...)` -- accepts RevenueCat HMAC signatures or configured Authorization headers
- `parseConsumablePurchaseEvent(event)` -- extracts purchase data from RevenueCat webhook; only processes `NON_RENEWING_PURCHASE` and `INITIAL_PURCHASE` event types; maps store names to source (STRIPE->web, APP_STORE->apple, PLAY_STORE->google)

## Usage

```typescript
import {
  createConsumablesSchema,
  ConsumablesHelper,
} from "@sudobility/consumables_service";

// In your API's schema file:
const tables = createConsumablesSchema(mySchema);

// In your API's service file:
const helper = new ConsumablesHelper(db, tables, { initialFreeCredits: 3 });

const balance = await helper.getBalance(userId);
const updated = await helper.recordPurchase(userId, { credits: 25, source: "web", ... });
const result = await helper.recordUsage(userId, "logo.svg");
```

## Consuming APIs

APIs using this library:
- svgr_api

## Related Projects

- **svgr_api** -- The primary consuming API. It uses `createConsumablesSchema` and `ConsumablesHelper` for its credits system. Changes here directly affect svgr_api.
- **consumables_client** (`@sudobility/consumables_client`) -- Frontend counterpart that calls this service's API endpoints over HTTP. The client and service must agree on API contracts (response shapes, error codes).

Dependency direction: `svgr_api` --> `consumables_service` (library dep); `consumables_client` --> `consumables_service` (HTTP at runtime)

## Coding Patterns

- **Schema factory pattern**: `createConsumablesSchema(pgSchema)` accepts any Drizzle `PgSchema` so the consumer owns all migrations. Never create migrations in this package -- the consuming API handles that.
- **Atomic balance operations**: Balance increments (purchases) and decrements (usage) use atomic SQL operations (e.g., `SET credits = credits + N`). Never read-then-write; always use atomic updates to avoid race conditions.
- **Idempotent webhook processing**: `recordPurchaseFromWebhook()` uses the transaction reference as a deduplication key. Replaying the same webhook is safe and produces no duplicate records.
- **Get-or-create pattern for balances**: `getBalance(userId)` creates a balance row with `initialFreeCredits` if none exists. This avoids separate "create user" flows.
- **Drizzle query building**: Uses `eq()`, `desc()`, `sql` template literals from `drizzle-orm` for type-safe query construction.

## Gotchas

- **`createConsumablesSchema` takes any `PgSchema` to avoid drizzle-orm version coupling**: The consuming API passes its own schema instance. This means this library does not pin a specific drizzle-orm version for schema creation. Be careful not to use drizzle APIs that only exist in specific versions.
- **`recordPurchaseFromWebhook` is idempotent (safe to replay)**: It checks for existing transactions by reference ID before inserting. Do not remove this deduplication check.
- **Balance decrements guard against going negative**: `recordUsage()` uses a `WHERE credits > 0` guard in the atomic update. If the balance is zero, the operation fails gracefully rather than going negative. Do not remove this guard.
- **Consumer owns migrations**: Even though this package defines the schema, the consuming API (e.g., svgr_api) generates and runs migrations. Never add migration files to this package.
- **Free credits are granted once**: `getBalance()` only grants `initialFreeCredits` on first access (row creation). Subsequent calls return the existing balance. Do not change this to grant free credits on every call.
- **`db` is typed as `any`**: The ConsumablesHelper constructor accepts `db: any` to avoid version coupling with drizzle-orm. This sacrifices type safety for flexibility.
- **`recordPurchase` calls `getBalance` first**: This ensures the balance row exists before incrementing. The extra query is intentional for the get-or-create pattern.

## Publishing

- Package: `@sudobility/consumables_service` (public on npm)
- Build before publish: `bun run build` produces ESM output in `dist/`
- Run `bun run verify` before publishing -- this runs lint, typecheck, tests, and build in sequence.
- Bump version in `package.json`, then `npm publish --access public`
- After publishing, update the dependency version in consuming APIs (e.g., svgr_api) and verify they still build and pass tests

## Git Workflow

- Do not use feature branches for code changes. Always stay on the current branch.
