/**
 * Checkout service.
 * Imports calculateTax and TaxResult from the shared-utils package.
 *
 * calculateTax signature expected: (subtotal: number, taxRatePercent: number) => TaxResult
 * If shared-utils changes this signature, this service breaks.
 */
import { calculateTax, TaxResult } from "@myco-demo/shared-utils";

export interface Order {
  id: string;
  subtotal: number;
  items: string[];
}

export function processCheckout(order: Order): TaxResult {
  // US default tax rate 8.5%
  return calculateTax(order.subtotal, 8.5);
}
