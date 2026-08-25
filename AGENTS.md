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
- Temperature, quality-window, and sensor-offline alerts share deterministic processing but reconcile independently by rule family. Telemetry resolves offline state only as an explicit connectivity recovery; a composition-root stale sweep creates offline alerts without requiring overview reads.
- Measurement time and receipt time are distinct.
- Telemetry ingestion is idempotent.
- MVP telemetry identifies provisioned devices by the stored `deviceUid + sensorId` binding; it does not claim strong device authentication or use a shared API key.
- Completed plan steps are historical facts and cannot be replanned.
- AI proposals require deterministic validation and human approval before activation.
- Routine landing intake, weighing, grading, sensor association, and deterministic quality assessment happen before AI planning. The planner chooses future logistics only.
- Initial planning is scoped to selected batches and one persisted destination; revisions inherit that destination and every scoped batch must be loaded then dispatched there. Plan and deterministic quality deadlines are targets: the earliest physically valid late plan remains approvable with exact persisted warnings, and quality lateness is critical.
- New initial plans require one persisted plan-level arrival deadline and revisions inherit it. Physically valid candidates are ranked by minimum exact lateness across that deadline and each batch's quality deadline.
- AI planning returns either a `PROPOSAL` or transient `NO_VALID_PROPOSAL_FOUND`; the latter is reserved for no physically valid candidate within the seven-day search horizon and is never persisted.
- Generated actions are `STORE`, `LOAD`, `DISPATCH`, and conditional `INSPECT`. Direct `LOAD -> DISPATCH` is preferred when feasible; storage is not mandatory. Dispatch uses the same vehicle as the preceding load and one selected destination. `HANDOVER` and `OTHER` remain readable only as legacy history.
- Generated plan summaries and step rationales are bounded, best-effort AI explanations with deterministic fallbacks. They are explanatory only. Actions, resources, schedules, timing rationale, latest-safe timestamps, deadlines, and quality limits remain structured backend-owned values and are never extracted from model prose.
- Only configured resources may be used in a plan.
- Completing the final upcoming step atomically completes the active plan and releases its batch scope.
- A completed plan cannot be revised. Direct pending revisions are dismissed when their predecessor completes.
- Vehicle delays reset after their last active-plan use unless explicitly marked persistent; availability and capacity never reset implicitly.
- A plan has explicit batch scope. Multiple plans may be active for one user, but a batch may belong to at most one active plan.
- Active-scope overlap is enforced transactionally during approval under a per-user PostgreSQL advisory lock; PostgreSQL cannot express the cross-table status constraint as a simple partial index.
- Initial plan creation remains web-only. Linked Telegram operators may query operational state and may report supported operational facts only after preview and explicit confirmation.
- A confirmed Telegram report atomically creates a `TELEGRAM` operational event and updates the authoritative fact. The backend deterministically revalidates directly affected active plans, recommends replanning only when the current future steps are no longer valid, and still offers replan-anyway. Replanning, revision approval, and dismissal remain separate explicit decisions; approval requires final confirmation. An unsuccessful revision leaves the active plan unchanged.
- Telegram conversations persist a runtime-validated pending-state envelope and the newest 10 visible messages with rolling 30-minute expiry; legacy direct pending JSON is normalized without a migration. Clarification and report-correction slots merge deterministically, with newly supplied non-null values taking precedence. Webhook update IDs are replay-protected, and callback queries use bounded inline actions.

Validate all HTTP, sensor, WhatsApp, and LLM data at their boundaries. Keep transport DTOs out of the domain and do not expose secrets or private operator data in logs or errors.

## Development

- `npm run dev`: run the TypeScript server in watch mode.
- `npm run build`: compile with strict TypeScript checks.
- `npm run db:reset`: destructively rebuild the configured local database and seed the provisioning baseline.
- `npm run seed`: reset the demo account to two cold rooms, three trucks, three destinations, and no operational workflow or sensor data.
- `npm run langgraph:dev`: run the local LangGraph Agent Server and open the plan workflow in Studio.
- `npm start`: run the compiled server.

Telegram development uses an HTTPS webhook at `${PUBLIC_BASE_URL}/api/integrations/telegram/webhook`. Point ngrok at backend port `3000`, configure `TELEGRAM_BOT_TOKEN` and a random `TELEGRAM_WEBHOOK_SECRET`, then restart the backend to register the current URL. Operators permanently link their chat from the Overview page using a single-use token that expires after 10 minutes.

Operator-facing Telegram messages use a warm, friendly, professional voice with sentence-case headings. Reserve ✅ for persisted successes, ⚠️ for warnings or expiry, and 🚨 for critical alerts; preserve exact operational facts and explicit `WARNING`/`CRITICAL` text.

Plan generation and natural-language revision run through LangGraph. Graph nodes load context, derive concrete UTC deadlines, feasible resources, resource flexibility, and urgency, generate deterministically validated candidates, and invoke the LangChain chat model to return only the preferred candidate ID. After fresh-state validation, a separate strict model call may replace only the summary and general step rationales; malformed or unavailable explanation output retains deterministic fallback text. Prisma remains authoritative for proposal persistence, human approval, completed-step history, and concurrency. Approval reloads authoritative state and reruns deterministic validation inside the locked activation transaction. Free-text vehicle restrictions remain advisory.

Plan-page natural-language changes first use the same extraction and deterministic report service as Telegram. A complete supported report is immediately persisted with source `WEB`, updates the authoritative resource or operational state, and always requests a replacement proposal for the selected active/proposed plan. Incomplete reports do not mutate. Non-report text remains a constrained candidate-selection revision. Report facts remain persisted even when no replacement proposal can be generated; activation still requires normal proposal approval.

Other active plans contribute compact storage and vehicle reservation intervals to deterministic candidate validation. Overlapping vehicle occupancy is valid only for one shared trip with the same dispatch time, destination, and return time. The model selector receives a compact reservation summary without batch identity or weight; deterministic validation remains authoritative.

Before Telegram intent/slot extraction, the backend loads a compact user-scoped snapshot of every active/proposed plan plus bounded current batches, resources, sensors, and active alerts. Extraction receives that snapshot, pending structured state, the newest 10 total visible messages, and the current message, with one bounded repair and no regex fallback. Incident facts remain reports unless the operator explicitly requests replanning; `V2` is a display version, not a database ID.

Production inbound Telegram messages and callbacks traverse `chat_workflow`, whose graph exposes validation, callback, extraction, query, report, replan, proposal-edit, confirm, cancel, and fallback nodes; Prisma `MessagingConversation`, not LangGraph checkpoints, remains the sole durable pending-state authority. Natural-language operational questions are extracted into an allow-listed query specification. The LLM never generates SQL, Prisma filters, authorization predicates, or numeric facts. Deterministic execution is always scoped to the linked user and supports bounded counts, lists, sums, and numeric/status filters over cold storage, vehicles, destinations, batches, plans, steps, sensors, and active alerts. Storage occupancy and free capacity are computed from current owned batch locations; ambiguous storage weight thresholds require clarification. User-scoped resolution, query execution and pagination, report previews and confirmed mutations, impact assessment, planner permission, proposal validation, and approval remain deterministic. Operator action messages use escaped Telegram HTML and bounded inline keyboards. Query answer wording may use a separate model call containing only the operator question and validated result facts; failure returns the deterministic wording, and pagination/buttons never depend on model output. The newest 10 visible inbound, assistant, semantic callback, and outbound-alert messages provide restart-safe context; callback payloads and secrets are never retained. Deterministic outbound monitoring alerts do not invoke an LLM.

LangGraph Studio reads real development data for the supplied user ID and can make configured model calls. Run the Agent Server on localhost only. The plan graph cannot persist or activate plans; the chat graph uses the production operation adapter, so confirmed mutating chat actions can change development data.

The in-app demo reset is restricted to `adi.rahman@sirip.id`. It restores the same resource/operational baseline as `npm run seed`, preserves the Telegram connection, current password, and authenticated sessions, and clears pending conversations and link tokens; the CLI seed also resets credentials, connections, and sessions.

Loading in-app demo data first resets the account, then creates completed trips `FT-101` through `FT-103`, linked monitoring batches `B-101` through `B-103`, linked closed historical batches `B-104` through `B-106`, and three assigned sensors with healthy baseline telemetry near 2C and more than four quality days remaining. Demo quality-risk, excursion, and recovery simulations ingest historically timed readings through the production parser and repository path; simulated-sensor offline backdates authoritative seen/sync timestamps before normal monitoring processing. The seeded account may also temporarily black-hole telemetry from one of its assigned physical sensors to demonstrate real firmware backlog synchronization; these blocks are process-local and clear on restart. Synthetic telemetry remains restricted to seeded `SIM-*` entities. The provisioning seed and reset baseline remain resource-only.

Run the narrowest relevant verification. Update the routed documentation when behavior, contracts, architecture, or setup changes.
