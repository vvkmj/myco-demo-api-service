/**
 * Order routes for the API service.
 * Imports generateOrderId from the shared-utils package.
 *
 * If shared-utils removes or renames generateOrderId, this breaks.
 */
import { generateOrderId } from "@myco-demo/shared-utils";

export function createOrder(items: string[]): { id: string; items: string[] } {
  return {
    id: generateOrderId(),
    items,
  };
}
