# SIRIP Backend

Express 5 and strict TypeScript backend for SIRIP's telemetry, deterministic quality calculation, operational state, planning, and external integrations.

## Documentation Routing

Read only the documents relevant to the task, then use `SIRIP AI Master.md` to resolve broader product intent.

| Task | Read first |
| --- | --- |
| Product scope, actors, or terminology | `../docs/SIRIP AI Master.md` |
| Business workflows, lifecycle, telemetry, quality, or plan rules | `../docs/SIRIP AI Flow.md` |
| Entities, persistence, relationships, or statuses | `../docs/SIRIP AI Data.md` |
| AI planning, replanning, tools, validation, or WhatsApp | `../docs/SIRIP AI Agent.md` |
| API fields consumed by the frontend or display semantics | `../docs/SIRIP AI UIUX.md` |

When documents overlap, preserve the explicit MVP rules in the most task-specific document and flag material conflicts rather than inventing behavior.

## Architecture

Use a Domain-Driven Design (DDD) file structure. Organize code by business responsibility and keep dependencies pointing inward:

`infrastructure -> application -> domain`

- `src/domain/`: entities, value objects, domain services, domain errors, and repository contracts. It must not import Express, databases, LLM SDKs, WhatsApp SDKs, or other infrastructure.
- `src/application/`: use cases and orchestration. It may depend on domain types and contracts, but not concrete adapters.
- `src/infrastructure/`: Express routes and middleware, persistence implementations, sensor ingestion adapters, AI/LLM workflows, WhatsApp integrations, and application composition.
- `src/index.ts`: composition root and process startup only.

Group files by domain capability inside each layer when needed, such as `batches`, `sensors`, `quality`, `operations`, and `plans`. Do not create empty layers, interfaces with one incidental implementation, or generic base repositories.

Core domain rules include:

- Quality calculations are deterministic and never delegated to the LLM.
- Measurement time and receipt time are distinct.
- Telemetry ingestion is idempotent.
- Completed plan steps are historical facts and cannot be replanned.
- AI proposals require deterministic validation and human approval before activation.
- Only configured resources may be used in a plan.
- A plan has explicit batch scope. Multiple plans may be active for one user, but a batch may belong to at most one active plan.
- Active-scope overlap is enforced transactionally during approval under a per-user PostgreSQL advisory lock; PostgreSQL cannot express the cross-table status constraint as a simple partial index.

Validate all HTTP, sensor, WhatsApp, and LLM data at their boundaries. Keep transport DTOs out of the domain and do not expose secrets or private operator data in logs or errors.

## Development

- `npm run dev`: run the TypeScript server in watch mode.
- `npm run build`: compile with strict TypeScript checks.
- `npm run db:reset`: destructively rebuild the configured local database and seed the provisioning baseline.
- `npm run seed`: reset the demo account to two cold rooms, three trucks, three destinations, and no operational workflow or sensor data.
- `npm start`: run the compiled server.

Run the narrowest relevant verification. Update the routed documentation when behavior, contracts, architecture, or setup changes.
