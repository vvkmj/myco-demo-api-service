# Data Router System (DRS)

[![Integration Tests](https://github.com/Motorq/drs-debug/actions/workflows/integration-tests.yml/badge.svg)](https://github.com/Motorq/drs-debug/actions/workflows/integration-tests.yml)
[![Control Plane Build](https://github.com/Motorq/drs-debug/actions/workflows/control-plane.yml/badge.svg)](https://github.com/Motorq/drs-debug/actions/workflows/control-plane.yml)
[![Data Plane Build](https://github.com/Motorq/drs-debug/actions/workflows/data-plane.yml/badge.svg)](https://github.com/Motorq/drs-debug/actions/workflows/data-plane.yml)
[![Database Migrations](https://github.com/Motorq/drs-debug/actions/workflows/database-migrations.yml/badge.svg)](https://github.com/Motorq/drs-debug/actions/workflows/database-migrations.yml)

## Overview

The Data Router System (DRS) is a scalable message routing platform that supports multiple routing strategies and ensures reliable message delivery. With comprehensive integration test coverage (107 passing tests), DRS provides production-ready reliability for enterprise-scale message routing scenarios.

### Key Features

- **Multiple Routing Strategies**: STICKY and STATIC routing with validated implementations
- **Default Outlet Support**: Robust fallback routing for unmapped keys in static routing scenarios
- **Outlet Groups**: Shared infrastructure support for multi-team analytics and data processing
- **Enterprise-Grade Validation**: Enhanced error handling with specific, actionable error messages
- **Production-Ready Reliability**: Comprehensive integration test suite ensures API stability

## Architecture
[Architecture](ARCHITECTURE.md)

## Prerequisites

- Node.js (v22.14.0)
- Docker and Docker Compose
- PostgreSQL client
- npm (latest version)

## Quick Start

1. Clone the repository:
   ```bash
   git clone https://github.com/Motorq/drs-debug.git
   cd drs-debug
   ```

2. Install dependencies:
   ```bash
   npm ci
   ```

3. Start the system:
   ```bash
   chmod +x local/run.sh
   ./local/run.sh
   ```

4. To stop and clean up:
   ```bash
   chmod +x local/cleanup.sh
   ./local/cleanup.sh
   ```

## Common Use Cases

For detailed guides on validated, production-ready use cases, refer to the docs directory:

1. [Creating a Stack App](docs/1-creating-stack-app.md) - Analytics stack routing with sticky load balancing
2. [Creating Static Routing](docs/2-creating-static-routing.md) - Tenant-based routing with default outlet support
3. [Creating Copy Jobs](docs/3-creating-copy-jobs.md) - Data migration and replication scenarios
4. [Creating Outlet Groups](docs/4-creating-outlet-groups.md) - Shared infrastructure for multi-team environments

### New Capabilities Unlocked

- **Default Outlet Functionality**: Reliable fallback routing for unmapped keys in static routing scenarios
- **Enhanced Outlet Validation**: Comprehensive validation with clear error messages for faster troubleshooting
- **Stable Outlet Groups**: Production-tested shared infrastructure support for enterprise teams
- **Integration Test Coverage**: All API endpoints verified with 107 comprehensive integration tests

## Services

After running the system:
- Control Plane: http://localhost:4001/docs
- Data Plane: its just a webjob

## Repository Structure

```
.
├── apps/
│   ├── control-plane/     # Configuration management service
│   ├── data-plane/       # Message routing service
│   └── database-migrations/ # Database schema management
├── packages/             # Shared packages and configurations
└── local/               # Local development scripts
```

## License

Proprietary - All Rights Reserved
