# Data Routing Service (DRS) - Frequently Asked Questions

This FAQ covers common questions about the Data Routing Service, particularly around outlet groups, app types, and routing behaviors.

## Table of Contents

1. [Outlet Groups and App Types](#outlet-groups-and-app-types)
2. [Static Key Management](#static-key-management)
3. [Default Outlets](#default-outlets)
4. [Outlet Ownership and Exclusivity](#outlet-ownership-and-exclusivity)
5. [Routing Behavior](#routing-behavior)
6. [Protection Mechanisms](#protection-mechanisms)
7. [Common Issues and Troubleshooting](#common-issues-and-troubleshooting)

## Outlet Groups and App Types

### Q1: What are outlet groups and how do they differ from manual outlets?

**Outlet Groups** are collections of outlets that can be shared across multiple apps. Apps can be configured to use either:

- **`outlet_type: "manual"`** - App owns its outlets directly. Outlets have `app_name` populated.
- **`outlet_type: "outlet_group"`** - App uses outlets from a shared outlet group. Outlets have `app_name: null` and belong to the group.

### Q2: What are the benefits of using outlet groups?

Outlet groups provide several advantages:

- **Shared Resources**: Multiple apps can share the same set of outlets
- **Consistent Routing**: The same key routes to the same outlet across all apps using the group
- **Load Balancing**: Load is distributed across all apps using the outlet group
- **Centralized Management**: Outlets are managed at the group level, not per app

### Q3: How does outlet group routing work differently from manual routing?

**Manual Apps:**
- Outlets belong directly to the app
- Static keys are unique within the app
- Sticky routing state is maintained per app

**Outlet Group Apps:**
- Apps share outlets from the outlet group
- Static keys are unique within the outlet group (shared across all apps)
- Sticky routing state is shared across all apps using the group

## Static Key Management

### Q4: Can multiple outlets have the same static key?

**No** - This is now prevented by validation:

- **Within the same manual app**: Cannot have duplicate static keys
- **Within the same outlet group**: Cannot have duplicate static keys
- **Across different apps/groups**: Same static key is allowed in different contexts

**Example Error:**
```json
{
  "status": 400,
  "message": "App myapp already has an outlet with static_key 'vehicle_type_a'"
}
```

### Q5: What happens if I try to create a duplicate static key?

The system will return a `400 Bad Request` error with a clear message indicating which app or outlet group already has that static key. You must choose a different static key or update the existing outlet.

## Default Outlets

### Q6: Can I have multiple default outlets?

**No** - Only one default outlet is allowed per context:

- **Manual apps**: One default outlet per app
- **Outlet groups**: One default outlet per outlet group

### Q7: How do default outlets work with static routing?

Default outlets catch unmapped keys in static routing:

- **Mapped keys**: Route to outlets with matching static keys
- **Unmapped keys**: Route to the default outlet (if it exists)
- **No default outlet**: Unmapped keys are not included in the routing response

**Example:**
```javascript
// Static mapping response
{
  "vehicle_type_a": "outlet-123",    // Mapped key
  "vehicle_type_b": "outlet-456",    // Mapped key  
  "unknown_type": "default-outlet"   // Unmapped → default
}
```

## Outlet Ownership and Exclusivity

### Q8: Can an outlet belong to multiple outlet groups or apps?

**No** - Outlets have exclusive membership:

- An outlet belongs to either **one app** OR **one outlet group**, never both
- Outlets cannot be in multiple outlet groups simultaneously
- This prevents routing conflicts and ensures clear ownership

### Q9: Can I create manual outlets for apps that use outlet groups?

**No** - Apps with `outlet_type: "outlet_group"` cannot have individual outlets created for them. You'll receive this error:

```json
{
  "status": 400,
  "message": "Cannot create outlets directly for apps with outlet_type='outlet_group'. Create outlets for the outlet group instead."
}
```

## Routing Behavior

### Q10: When I add a new outlet to an app, what messages will start getting routed to it?

**For Manual Apps:**
- **Static routing**: Messages with the new outlet's static key will immediately route to it
- **Sticky routing**: New vehicle IDs will be assigned to the outlet based on load balancing

**For Outlet Group Apps:**
- **Static routing**: All apps using the outlet group can route to the new outlet
- **Sticky routing**: New assignments across all apps in the group will consider the new outlet

### Q11: Do outlet groups support both static and sticky routing?

**Yes** - Outlet groups support both routing types based on the app's `routing_type`:

- **Static routing**: Uses outlets' static keys to determine routing
- **Sticky routing**: Maintains consistent key-to-outlet mapping across all apps in the group

### Q12: How does load balancing work with outlet groups?

Load balancing considers **all apps** using the outlet group:

- Assignments are distributed across outlets in the group
- The system tracks total assignments across all apps
- New keys get assigned to outlets with the least total load

## Protection Mechanisms

### Q13: What validation is in place to prevent routing conflicts?

The system has several layers of protection:

1. **Static Key Uniqueness**: Prevents duplicate static keys within the same context
2. **Default Outlet Limits**: Ensures only one default outlet per context
3. **Outlet Exclusivity**: Prevents outlets from belonging to multiple groups/apps
4. **App Type Validation**: Prevents manual outlet creation for outlet group apps
5. **Database Constraints**: Foreign key relationships ensure data integrity

### Q14: What happens if I try to break these rules?

The system will return appropriate HTTP error codes:

- **400 Bad Request**: Validation errors (duplicates, conflicts)
- **404 Not Found**: Referenced apps or outlet groups don't exist
- **500 Internal Server Error**: Database constraint violations

## Common Issues and Troubleshooting

### Q15: My static routing isn't working for outlet group apps. What's wrong?

This was a known issue that has been **fixed**. Ensure you're running the latest version of the control plane. The fix properly handles static routing for apps using outlet groups.

### Q16: I can create duplicate static keys in my system. Is this normal?

This was a bug that has been **fixed**. The system now prevents duplicate static keys within the same app or outlet group. If you can still create duplicates, you may be running an older version.

### Q17: How do I migrate from manual outlets to outlet groups?

1. Create a new outlet group
2. Create new outlets for the outlet group (with the same configuration)
3. Update your app to use `outlet_type: "outlet_group"`
4. Test routing behavior
5. Clean up old manual outlets

### Q18: Can I see all outlets available to my app?

Yes, use the `POST /outlet/listByApp` endpoint:

```bash
curl -X POST http://localhost:4001/outlet/listByApp \
  -H "Content-Type: application/json" \
  -d '{"appName": "your-app-name"}'
```

This works for both manual and outlet group apps.

### Q19: How do I test static routing behavior?

Use the static mappings endpoint:

```bash
curl -X POST http://localhost:4001/staticMappings/getStaticMappings \
  -H "Content-Type: application/json" \
  -d '{
    "appName": "your-app-name",
    "keys": ["key1", "key2", "unmapped_key"]
  }'
```

### Q20: How can I verify sticky routing consistency?

Create sticky mappings with the same keys across different apps using the same outlet group:

```bash
curl -X POST http://localhost:4001/stickyMappings/createAndGetStickyMappings \
  -H "Content-Type: application/json" \
  -d '{
    "appName": "app1", 
    "keys": ["vehicle123"]
  }'
```

The same key should map to the same outlet across all apps in the group.

## Best Practices

### ✅ Recommended Practices

1. **Use outlet groups** for shared resources across multiple apps
2. **Use meaningful static keys** that clearly identify the routing intent
3. **Always include a default outlet** for static routing to handle unmapped keys
4. **Test routing behavior** after making configuration changes
5. **Monitor outlet load distribution** to ensure balanced assignments

### ❌ Avoid These Practices

1. Don't try to reuse static keys within the same context
2. Don't create manual outlets for outlet group apps
3. Don't rely on undefined behavior for unmapped keys without default outlets
4. Don't forget to validate your routing configuration in non-production environments

## Getting Help

If you encounter issues not covered in this FAQ:

1. Check the control plane logs for detailed error messages
2. Verify your app and outlet configuration using the list endpoints
3. Test routing behavior using the mapping endpoints
4. Check the integration tests for examples of proper usage

For additional support, refer to the main project documentation or contact the development team.