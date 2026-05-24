# Issues to Fix Later

## 5. Connector Update Race Conditions
**Location**: `PUT /connector/{id}` in connector-controller.ts
**Issue**: Real-time EventHub validation during concurrent updates can cause race conditions
**Details**: 
- When multiple requests update the same connector simultaneously, the EventHub connection validation process can conflict
- During the validation phase, the connector could be in an inconsistent state
- Network timeouts during EventHub validation could leave the connector in a bad state
- No proper locking mechanism during connector validation/update process

**Risk Level**: Medium
**Impact**: Invalid connector states, connection failures during data routing

**Potential Solutions**:
- Add distributed locking during connector validation/update operations
- Implement optimistic locking with version fields on connector records
- Queue connector updates to prevent concurrent modifications
- Add rollback mechanisms for failed validation states

---

## 7. Database Transaction Boundaries 
**Location**: Complex operations across multiple controllers and services
**Issue**: Unclear transaction scopes and potential consistency issues
**Details**:
- Transaction boundaries are not clearly defined for complex operations that span multiple tables
- Some operations mix direct database queries with service layer calls within the same logical transaction
- Potential for data corruption in failure scenarios where partial updates occur
- No consistent pattern for handling distributed transactions across different service boundaries
- Risk of deadlocks in concurrent scenarios due to inconsistent lock ordering

**Risk Level**: Medium-High  
**Impact**: Data corruption, system inconsistency, potential deadlocks

**Potential Solutions**:
- Define clear transaction boundaries at the service layer
- Implement saga pattern for complex multi-step operations
- Add proper transaction isolation levels for critical operations  
- Standardize error handling and rollback mechanisms
- Consider event-driven architecture for eventual consistency where appropriate