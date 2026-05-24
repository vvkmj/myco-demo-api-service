# DRS (Data Routing Service) Pager Runbook

## Quick Reference
- **Service**: Data Routing Service (DRS)
- **Monitoring**: Grafana Alerts
- **Escalation**: Follow standard on-call escalation procedure
- **Components**: data-plane (message processing), dlq-service (dead letter processing)

---

## 🚨 CRITICAL ALERT: DRS DLQ Threshold Exceeded

### **WHO**: On-call engineer responsible for DRS infrastructure
### **WHAT**: Dead Letter Queue has exceeded threshold - unprocessed messages accumulating
### **WHEN**: Currently firing - immediate attention required
### **WHERE**: DLQ processing in data-plane service
### **WHY**: Messages failing to process and accumulating faster than DLQ can handle them

### **Sequential Investigation Steps**

1. **Check Current DLQ State**
   - Monitor `dlq_outlets_pending` metric in Grafana for both sticky and static routing types
   - Look for spike in DLQ message count vs normal baseline
   - Check if specific outlets are affected or system-wide issue

2. **Identify Processing Bottleneck**
   - Review `dlq_processing_duration_ms` histogram for performance degradation
   - Check `dlq_processing_errors` count for sticky vs static processing failures
   - Look for `dlq_outlet_processing_errors` to identify problematic outlets

3. **Database Health Assessment**
   - Check DLQ database connection pool status and availability
   - Monitor database query performance for DLQ operations
   - Verify dlq_entries table is accessible and not locked

4. **Immediate Actions**
   - Restart DLQ service to reset connections and clear any stuck processing
   - Check for recent configuration changes to outlets or apps
   - Scale up DLQ processing if CPU/memory constrained

5. **Escalation Triggers**
   - DLQ count continues growing after 30 minutes of troubleshooting
   - Database connectivity issues detected
   - Multiple outlet processing failures occurring simultaneously

---

## 📊 Alert Definitions & Runbooks

### 1. Error in DRS - Outlet Send Error

#### **5 W's**
- **WHO**: On-call engineer
- **WHAT**: Messages failing to send to configured outlet destinations
- **WHEN**: During message routing when outlet send operations fail
- **WHERE**: BaseRoutingProcessor outlet sender in data-plane service
- **WHY**: EventHub connectivity issues, expired credentials, or outlet configuration problems

#### **Sequential Investigation Steps**
1. **Identify Affected Outlets**
   - Check `messages_sent_to_outlet` vs `messages_sent_to_dlq` metrics to see failure ratio
   - Look for `outlet_not_found` metric spikes indicating configuration issues
   - Review `outlet_send_duration_ms` timing for performance degradation

2. **Validate Outlet Configuration**
   - Verify outlet exists in control plane API
   - Check EventHub connection string validity and credential expiration
   - Confirm entityPath matches actual EventHub name

3. **Test EventHub Connectivity**
   - Check Azure EventHub service status page
   - Verify network connectivity from data-plane to Azure EventHub
   - Test EventHub authentication with current credentials

4. **Producer Connection Health**
   - Monitor `get_or_create_producer_duration_ms` for connection delays
   - Check OutletProducerManager cache for stuck or expired connections
   - Review producer TTL and invalidation cycles (5-minute cleanup interval)

#### **Resolution Actions**
- Update outlet credentials in control plane if authentication failing
- Restart data-plane service to reset producer connection pool
- Scale EventHub throughput units if throttling detected
- Contact Azure support if EventHub service issues confirmed

---

### 2. Error in DRS - DLQ Failed to Process Messages

#### **5 W's**
- **WHO**: On-call engineer
- **WHAT**: DLQ processor unable to process pending messages from dlq_entries table
- **WHEN**: During scheduled DLQ processing cycles (sticky: 1min, static: 5min intervals)
- **WHERE**: DLQProcessorImpl processing sticky or static messages
- **WHY**: Database connectivity issues, outlet producer failures, or control plane API problems

#### **Sequential Investigation Steps**
1. **Determine Processing Type Failure**
   - Check `dlq_processing_errors` metric with routing_type attribute (sticky vs static)
   - Review `dlq_outlets_pending` gauge for both routing types to see which is accumulating
   - Compare sticky (1-minute) vs static (5-minute) processing intervals

2. **Database Layer Investigation**
   - Check dlq_entries table accessibility and query performance
   - Monitor database connection pool exhaustion
   - Verify getStickyOutletIds() or getPendingStaticKeys() queries executing successfully

3. **Control Plane API Health** (Static routing only)
   - Test control plane API `/apps/{appName}/static-mappings` endpoint availability
   - Check authentication token validity for control plane calls
   - Monitor getStaticMappings() API response times

4. **Outlet Producer Initialization**
   - Review `dlq_get_or_create_producer_duration_ms` for delays
   - Check outlet configuration retrieval from control plane
   - Verify EventHub producer connection establishment

#### **Resolution Actions**
- Restart DLQ service to reset database connections and producer cache
- Check control plane service health and API token refresh
- Review database performance and optimize dlq_entries queries if needed
- Validate outlet configurations haven't changed causing producer failures

---

### 3. P95 Latency Breach in DRS Batch Processing

#### **5 W's**
- **WHO**: On-call engineer
- **WHAT**: 95th percentile latency for message batch processing exceeds threshold
- **WHEN**: During high message volume or when processing pipeline slows down
- **WHERE**: AppInstance message batch processing in data-plane service
- **WHY**: High message volume, slow outlet responses, complex routing logic, or resource constraints

#### **Sequential Investigation Steps**
1. **Analyze Processing Latency Pattern**
   - Review `message_batch_processing_duration_ms` histogram for latency distribution
   - Compare current latency against baseline to identify degradation pattern
   - Check if latency correlates with specific apps or routing types

2. **Message Volume and Complexity Assessment**
   - Monitor `messages_received` count for volume spikes
   - Check `unique_keys_in_batch` gauge for routing complexity (more keys = more outlets)
   - Review `messages_in_batch` gauge for batch size patterns

3. **Routing Performance Analysis**
   - Compare sticky vs static routing processing times
   - Check `get_static_mapping` duration for control plane API delays
   - Monitor `get_or_create_producer_duration_ms` for outlet connection delays

4. **Resource and Infrastructure Health**
   - Check data-plane service CPU and memory utilization
   - Monitor EventHub consumer prefetch and batch size configuration
   - Review outlet EventHub throughput and throttling

#### **Resolution Actions**
- Scale up data-plane replicas if resource constrained
- Optimize EventHub consumer configuration (batch size, prefetch count)
- Check outlet EventHub scaling and throughput units
- Review app routing configurations for optimization opportunities

---

### 4. Error in DRS - DLQ Add Error

#### **5 W's**
- **WHO**: On-call engineer
- **WHAT**: Failed to add messages to Dead Letter Queue
- **WHEN**: When primary outlet sending fails and DLQ fallback also fails
- **WHERE**: BaseRoutingProcessor.sendToDLQ() method
- **WHY**: Database connection issues or DLQ storage problems

#### **Investigation Steps**
1. Check DLQ database status:
   ```bash
   kubectl logs -f deployment/drs-data-plane -n <namespace> | grep "dlq_add"
   ```

2. Review database connectivity:
   - Check connection pool status
   - Verify database health and availability
   - Look for timeout or connection errors

#### **Resolution Actions**
- **CRITICAL**: This indicates message loss risk
- Immediately check database connectivity
- Review DLQ table capacity and indexes
- Restart data-plane services if persistent connection issues
- Escalate to database team if database-level issues

---

### 5. Error in DRS - Message Processing Start Error

#### **5 W's**
- **WHO**: On-call engineer
- **WHAT**: App instance failed to start EventHub message processing pipeline
- **WHEN**: During app instance initialization after successful startup
- **WHERE**: AppInstance.startProcessing() method when setting up consumer subscription
- **WHY**: EventHub consumer initialization failures, processor creation issues, or configuration problems

#### **Sequential Investigation Steps**
1. **Initialization Sequence Analysis**
   - Check `message_processing_start_errors` count with app_name attribute
   - Review `app_instance_start_attempt` success vs error status
   - Identify which specific apps are failing to start processing

2. **EventHub Consumer Health**
   - Monitor EventHub consumer group status and partition assignments
   - Check checkpoint store blob connectivity and permissions
   - Verify EventHub connection string and entityPath configuration

3. **Processor Creation Validation**
   - Confirm app routing_type is valid (STICKY or STATIC)
   - Check processor initialization for selected routing type
   - Verify outlet configuration exists for the app

4. **Configuration Integrity**
   - Test control plane API connectivity for app configuration fetch
   - Verify app has exactly 1 inlet configured
   - Confirm app has at least 1 outlet configured

#### **Resolution Actions**
- Restart data-plane service to retry app instance initialization
- Verify app configuration in control plane has valid inlet/outlet setup
- Check EventHub service health and consumer group quotas
- Review blob storage connectivity for checkpoint store
- Test control plane API accessibility and authentication

---

### 6. Error in DRS - Message Batch Processing Error

#### **5 W's**
- **WHO**: On-call engineer
- **WHAT**: Error during message batch processing
- **WHEN**: While processing received message batches
- **WHERE**: Message processing pipeline in app instance
- **WHY**: Routing failures, outlet issues, or processing logic errors

#### **Investigation Steps**
1. Check batch processing errors:
   ```bash
   kubectl logs -f deployment/drs-data-plane -n <namespace> | grep "Error processing messages"
   ```

2. Identify error patterns:
   - Check for routing key issues
   - Look for outlet connectivity problems
   - Review processor-specific errors

#### **Resolution Actions**
- Review recent message patterns for invalid routing keys
- Verify outlet configurations and connectivity
- Restart app instances if persistent errors
- Check for recent configuration changes

---

### 7. Error in DRS - Static Mapping Fetch Error

#### **5 W's**
- **WHO**: On-call engineer
- **WHAT**: Failed to fetch static routing mappings from control plane
- **WHEN**: During static routing processing
- **WHERE**: StaticRoutingProcessor.getStaticMappings()
- **WHY**: Control plane API issues or network connectivity problems

#### **Investigation Steps**
1. Check control plane connectivity:
   ```bash
   kubectl logs -f deployment/drs-data-plane -n <namespace> | grep "get_static_mapping_errors"
   ```

2. Test control plane API:
   - Check control plane service health
   - Verify API endpoint accessibility
   - Review authentication/authorization

#### **Resolution Actions**
- Check control plane service status
- Verify network connectivity between data-plane and control plane
- Review API rate limits and quotas
- Restart data-plane if connection pool issues

---

### 8. Error in DRS - DLQ Outlet Processing Error

#### **5 W's**
- **WHO**: On-call engineer
- **WHAT**: Failed to process messages for specific outlet in DLQ
- **WHEN**: During DLQ outlet processing
- **WHERE**: DLQProcessorImpl.processOutlet()
- **WHY**: Outlet connection failures or producer initialization issues

#### **Investigation Steps**
1. Check outlet-specific errors:
   ```bash
   kubectl logs -f deployment/drs-dlq -n <namespace> | grep "dlq_outlet_processing_errors"
   ```

2. Identify problematic outlets:
   - Check which outlet_id is failing
   - Review producer creation errors
   - Verify outlet configuration

#### **Resolution Actions**
- Restart DLQ service to reset producer connections
- Verify outlet configuration and credentials
- Check Azure EventHub health for specific outlet
- Review outlet-specific logs for authentication issues

---

### 9. Error in DRS - DLQ Producer Fetch/Create Errors

#### **5 W's**
- **WHO**: On-call engineer
- **WHAT**: Failed to create or fetch EventHub producer for DLQ processing
- **WHEN**: During DLQ message processing
- **WHERE**: DLQProcessorImpl.getOrCreateProducer()
- **WHY**: Outlet configuration issues or EventHub connectivity problems

#### **Investigation Steps**
1. Check producer creation:
   ```bash
   kubectl logs -f deployment/drs-dlq -n <namespace> | grep "dlq_get_or_create_producer"
   ```

2. Review outlet configurations:
   - Verify outlet exists in control plane
   - Check connection string validity
   - Confirm EventHub entity path

#### **Resolution Actions**
- Verify outlet configuration in control plane
- Test EventHub connectivity manually
- Restart DLQ service to clear producer cache
- Check Azure EventHub service status

---

### 10. Error in DRS - DLQ Cleanup Error

#### **5 W's**
- **WHO**: On-call engineer
- **WHAT**: Failed to cleanup processed DLQ records
- **WHEN**: During scheduled DLQ cleanup operations
- **WHERE**: DLQService.cleanupOldRecords()
- **WHY**: Database performance issues or cleanup query problems

#### **Investigation Steps**
1. Check cleanup operations:
   ```bash
   kubectl logs -f deployment/drs-dlq -n <namespace> | grep "dlq_cleanup_errors"
   ```

2. Review database performance:
   - Check cleanup query execution time
   - Verify database connection health
   - Look for lock contention issues

#### **Resolution Actions**
- Monitor database performance during cleanup
- Review cleanup batch size configuration
- Check database index health
- Consider manual cleanup if automated process fails

---

### 11. Error in DRS - DLQ Cleanup Eligible Fetch Error

#### **5 W's**
- **WHO**: On-call engineer
- **WHAT**: Failed to fetch count of records eligible for cleanup
- **WHEN**: Before DLQ cleanup operations
- **WHERE**: DLQService.cleanupOldRecords() - eligibility check
- **WHY**: Database query issues or connectivity problems

#### **Investigation Steps**
1. Check eligibility query:
   ```bash
   kubectl logs -f deployment/drs-dlq -n <namespace> | grep "dlq_get_cleanup_eligible"
   ```

2. Database connectivity:
   - Test database connection
   - Check query execution plans
   - Review database locks or contention

#### **Resolution Actions**
- Restart DLQ service if connection issues
- Review database performance
- Check cleanup eligibility query performance
- Monitor database connection pool

---

## 🔧 General Troubleshooting Resources

### Key Metrics to Monitor in Grafana
- **Message Flow**: `messages_received`, `messages_sent_to_outlet`, `messages_sent_to_dlq`, `heartbeat`
- **Performance**: `message_batch_processing_duration_ms`, `dlq_processing_duration_ms`
- **DLQ Health**: `dlq_outlets_pending`, `dlq_cleanup_eligible_records`
- **Errors**: `dlq_processing_errors`, `get_static_mapping_errors`, `outlet_not_found`
- **System**: `app_instance_start_attempt`, `service_start_success`

### Database Tables to Check
- **dlq_entries**: Main DLQ storage with retry_count, processed status
- **App configurations**: Control plane database for outlet/inlet configs
- **Connection pools**: Database connection health and availability

### APIs to Validate
- **Control Plane**: `/apps/{appName}` for app configuration
- **Static Mappings**: `/apps/{appName}/static-mappings` for routing
- **Outlet Details**: `/outlets/{outletId}` for EventHub configuration
- **Authentication**: Token refresh and validity

### Service Components to Check
- **data-plane**: Message processing, app instances, routing processors
- **dlq-service**: DLQ processing, cleanup operations
- **control-plane**: Configuration API, authentication service
- **EventHub**: Azure service status, throughput units, consumer groups
- **Database**: PostgreSQL health, connection pools, query performance

### Escalation Criteria
- **Immediate**: DLQ threshold exceeded and growing (message loss risk)
- **30-minute**: Multiple alert types firing or persistent single alert
- **Database Team**: DLQ add errors, connection pool exhaustion
- **Platform Team**: EventHub connectivity, Azure service issues
- **Security Team**: Authentication failures, token refresh issues

---

## 📞 Contact Information
- **Primary On-Call**: [Your team's on-call rotation]
- **Database Team**: [Database team contact]
- **Platform Team**: [Platform/Infrastructure team contact]
- **Escalation Manager**: [Manager contact for critical issues]

## 📚 Additional Resources
- [DRS Architecture Documentation]
- [Grafana Dashboard Links]
- [Azure EventHub Status Page]
- [Database Health Dashboard]