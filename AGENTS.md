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
- Initial planning is scoped to selected batches and one selected destination; every scoped batch must be dispatched there within its current deterministic remaining quality window.
- New initial plans require one persisted plan-level arrival deadline. Revisions inherit it, and dispatch arrival must satisfy both that deadline and each batch's quality deadline.
- AI planning may return a transient infeasible result with a reason. Infeasible results are never persisted as plans.
- Only configured resources may be used in a plan.
- Completing the final upcoming step atomically completes the active plan and releases its batch scope.
- A completed plan cannot be revised. Direct pending revisions are dismissed when their predecessor completes.
- Vehicle delays reset after their last active-plan use unless explicitly marked persistent; availability and capacity never reset implicitly.
- A plan has explicit batch scope. Multiple plans may be active for one user, but a batch may belong to at most one active plan.
- Active-scope overlap is enforced transactionally during approval under a per-user PostgreSQL advisory lock; PostgreSQL cannot express the cross-table status constraint as a simple partial index.

Validate all HTTP, sensor, WhatsApp, and LLM data at their boundaries. Keep transport DTOs out of the domain and do not expose secrets or private operator data in logs or errors.

## Development

- `npm run dev`: run the TypeScript server in watch mode.
- `npm run build`: compile with strict TypeScript checks.
- `npm run db:reset`: destructively rebuild the configured local database and seed the provisioning baseline.
- `npm run seed`: reset the demo account to two cold rooms, three trucks, three destinations, and no operational workflow or sensor data.
- `npm run langgraph:dev`: run the local LangGraph Agent Server and open the plan workflow in Studio.
- `npm start`: run the compiled server.

Telegram development uses an HTTPS webhook at `${PUBLIC_BASE_URL}/api/integrations/telegram/webhook`. Point ngrok at backend port `3000`, configure `TELEGRAM_BOT_TOKEN` and a random `TELEGRAM_WEBHOOK_SECRET`, then restart the backend to register the current URL. Operators permanently link their chat from the Overview page using a single-use token that expires after 10 minutes.

Plan generation and natural-language revision run through LangGraph. Graph nodes load context, invoke the LangChain chat model, parse feasible or infeasible output, refresh context, and route up to two deterministic validation repairs. Prisma remains authoritative for feasible proposal persistence, approval, completed-step history, and concurrency; graph execution does not save or activate plans.

The separate `chat_workflow` normalizes channel-independent chatbot behavior. Telegram is the current transport; deterministic outbound monitoring alerts do not invoke an LLM.

LangGraph Studio reads real development data for the supplied user ID and can make configured model calls. Run the Agent Server on localhost only; Studio graph execution intentionally cannot save or activate plans.

The in-app demo reset is restricted to `adi.rahman@sirip.id`. It restores the same resource/operational baseline as `npm run seed`, removes messaging connections and pending link tokens, and preserves the current password and authenticated sessions; the CLI seed also resets credentials and clears sessions.

Run the narrowest relevant verification. Update the routed documentation when behavior, contracts, architecture, or setup changes.
