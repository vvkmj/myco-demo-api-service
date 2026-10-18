/**
 * Entry point for the API service.
 * Wires together routes and services that all depend on @myco-demo/shared-utils.
 */
import { handleGetUser } from "./routes/users";
import { processCheckout } from "./services/checkout";
import { createOrder } from "./routes/orders";

console.log("=== myco-demo-api-service ===");

// Simulate a user display
const demoUser = {
  id: "u-001",
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.com",
  createdAt: new Date(),
};
console.log("User:", handleGetUser(demoUser));

// Simulate an order
const order = createOrder(["Widget A", "Widget B"]);
console.log("Order:", order.id);

// Simulate checkout
const tax = processCheckout({ id: order.id, subtotal: 99.99, items: order.items });
console.log(`Tax: $${tax.taxAmount} | Total: $${tax.total}`);
