# Consumables Service

> **Git policy — never auto-commit or auto-push.** Leave work in the working tree.
> Run `git commit`, `git push`, or `gh pr create` **only when the user explicitly asks in that
> turn**. Approval for an earlier change does not carry forward; finishing a task is not permission
> to commit it. Do not create feature branches — stay on the current branch.

Shared backend library for consumable credits management with Drizzle ORM (PostgreSQL).

- **npm**: `@sudobility/consumables_service` — published to **GitHub Packages** (`npm.pkg.github.com`), public, scope `@sudobility`
- **License**: BUSL-1.1
- Version lives in `package.json` (`bun run verify` before bumping/publishing).

## Stack & Tooling

- TypeScript 5.9 (strict), ESM-only output, `moduleResolution: bundler`.
- **Bun** is the runtime and package manager — never npm/yarn/pnpm.
- Tests: **Vitest 4.x** (`test:unit` = `vitest run`). Note `bun test` also happens to run the same
  spec files, but `test:unit`/`verify` are the canonical scripts.
- Peer deps (not bundled): `@sudobility/types` ^1.9.78, `drizzle-orm` >=0.44.0.

## Commands

```bash
bun run build        # tsc -p tsconfig.esm.json && node scripts/fix-esm-imports.mjs -> dist/
bun run dev          # tsc --watch
bun run test:unit    # vitest run (mock DB, no real Postgres needed)
bun run typecheck    # tsc --noEmit
bun run lint         # eslint src/
bun run verify       # typecheck && lint && test:unit && build  (run before publish)
```

Build is two-step: `tsc` emits ESM, then `scripts/fix-esm-imports.mjs` rewrites relative import
specifiers to add `.js` extensions (TS does not do this). Don't hand-edit `dist/`.

## Layout

```
src/
├── index.ts                     # Barrel: re-exports everything public
├── types/index.ts               # DB row types, RevenueCatWebhookEvent, ConsumablesConfig, ConsumableUsageOptions
├── schema/index.ts              # createConsumablesSchema(pgSchema)
└── helpers/
    ├── ConsumablesHelper.ts      # Core logic: balance / purchase / usage
    ├── WebhookHelper.ts          # validateWebhookSignature/Request, parseConsumablePurchaseEvent
    ├── RevenueCatClient.ts       # Server-side RevenueCat REST v1 client
    └── credit-products.ts        # parseCreditProducts, creditsForProduct
tests/                            # Vitest specs with a hand-mocked db object
```

## Architecture & Conventions

- **Schema factory, consumer owns migrations.** `createConsumablesSchema(schema: any)` builds three
  tables (`consumable_balances`, `consumable_purchases`, `consumable_usages`) inside a Drizzle
  `PgSchema` the consumer supplies. `schema` and the helper's `db` are typed loosely (`any` /
  minimal `DrizzleDb`) **on purpose** to avoid drizzle-orm version coupling. **Never add migration
  files here** — the consuming API (e.g. svgr_api) generates and runs them.
- **Atomic balance math.** Purchases increment and usages decrement with SQL
  (`SET balance = balance + N` / `- N`). Never read-then-write — always atomic to avoid races.
- **Get-or-create balances.** `getBalance(userId)` creates the row and grants
  `config.initialFreeCredits` **only on first access** (also writes a `"free"` purchase audit row).
  Do not grant free credits on later calls.
- **Idempotent webhooks.** `recordPurchaseFromWebhook()` dedupes by `transaction_ref_id` before
  inserting, and also treats a unique-index race (lost insert) as an already-processed success. Do
  not remove either check.

## Gotchas

- **`recordUsage` guard is `balance > 0`, not "enough balance".** A deduction larger than a small
  positive balance still applies and can land negative — intended where the deduction *is* the
  permission check. Callers that gated earlier pass `allowNegative: true` to deduct past zero. If
  no row exists or the guard refuses, it returns `{ success: false }` (no usage row written).
- **`recordUsage` second arg is overloaded.** A bare string is treated as `filename` (legacy
  signature, kept working); an object is `{ credits?, reference?, allowNegative?, filename? }`,
  `credits` defaults to 1.
- **Webhook signature accepts two forms.** RevenueCat's signed `t=<unix>,v1=<hex>` (verified over
  `"<ts>.<body>"` with a ±300s timestamp window) and a legacy bare hex HMAC of the raw body.
  Comparison is timing-safe.
- **`parseConsumablePurchaseEvent` only handles `NON_RENEWING_PURCHASE` / `INITIAL_PURCHASE`** and
  returns `null` for anything else or missing fields.
- **Keep the RevenueCat Secret key server-side.** `RevenueCatClient` uses the v1 REST API with a
  Secret key; the frontend uses the separate public SDK key. SDK is still preferred for storefront
  prices/UI; this client is for receipt/transaction verification.
- **`recordPurchase` ensures the balance row exists first** (inside its transaction) — the extra
  read is the get-or-create pattern, not dead code.

## Related projects

- **svgr_api** — primary consumer; uses `createConsumablesSchema` + `ConsumablesHelper`. Changes
  here affect it directly. Dependency direction: `svgr_api -> consumables_service` (library).
- **consumables_client** (`@sudobility/consumables_client`) — frontend counterpart that calls the
  consuming API over HTTP at runtime; must agree on response shapes/error codes.

After publishing, bump the dependency in consuming APIs and re-verify they build and test.
