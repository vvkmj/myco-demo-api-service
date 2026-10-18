# myco-demo-api-service

> **Demo repo** — Part of the Myco cross-repo breakage detection test.

This service is the **downstream consumer**. It imports types and utilities from [`myco-demo-shared-utils`](https://github.com/vvkmj/myco-demo-shared-utils) as an npm package dependency.

## Dependencies on shared-utils

| This file | Imports | From shared-utils |
|-----------|---------|-------------------|
| `src/routes/users.ts` | `formatUser`, `UserRecord` | `src/userFormatter.ts` |
| `src/services/checkout.ts` | `calculateTax`, `TaxResult` | `src/taxCalculator.ts` |
| `src/routes/orders.ts` | `generateOrderId` | `src/orderUtils.ts` |

## Myco Integration

Myco runs on every PR via `.github/workflows/myco.yml`.  
It checks upstream `myco-demo-shared-utils` to ensure all imported symbols still exist.  
A missing or renamed symbol triggers `P1-XREPO-1` and blocks the merge.
