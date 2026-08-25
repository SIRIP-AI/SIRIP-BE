import { ConflictError, RequestError } from '../../domain/errors';
import type { Database } from '../../infrastructure/persistence/database';
import { extractTelegramRequest, type TelegramInterpretationModel } from '../../infrastructure/messaging/telegram-extractor';
import { loadTelegramOperationalSnapshot } from '../../infrastructure/messaging/telegram-snapshot';
import { OperationalReportService, operationalReportText } from '../operations/operational-report-service';
import type { PlanService } from './plan-service';

export class PlanChangeService {
  private readonly reports: OperationalReportService;

  constructor(
    private readonly database: Database,
    private readonly plans: PlanService,
    private readonly model: () => TelegramInterpretationModel,
  ) {
    this.reports = new OperationalReportService(database);
  }

  async submit(userId: bigint, planId: bigint, instruction: string, idempotencyKey: string) {
    const plan = await this.plans.get(userId, planId);
    if (plan.status !== 'ACTIVE' && plan.status !== 'PROPOSED') throw new ConflictError('Hanya rencana aktif atau usulan yang dapat diubah');
    const snapshot = await loadTelegramOperationalSnapshot(this.database, this.plans, userId);
    const extraction = await extractTelegramRequest(this.model, snapshot, [], null, instruction);
    if (!extraction) throw new RequestError('Perubahan belum dapat dipahami. Silakan coba lagi.', 502);
    if (extraction.intent !== 'REPORT') return { kind: 'PREFERENCE_REVISION' as const, generation: await this.plans.revise(userId, planId, instruction) };

    const resolved = await this.reports.resolve(userId, extraction, instruction, new Date());
    if ('question' in resolved) throw new RequestError(resolved.question, 422, 'REPORT_NEEDS_CLARIFICATION');
    const event = await this.reports.apply(userId, resolved.report, 'WEB', `web-plan-change:${userId}:${idempotencyKey}`);
    const existing = await this.database.plan.findFirst({ where: { userId, previousPlanId: planId, triggerEventId: event.id, status: 'PROPOSED' }, orderBy: { version: 'desc' } });
    let generation;
    try {
      generation = existing
        ? { status: 'PROPOSAL' as const, proposal: await this.plans.get(userId, existing.id) }
        : await this.plans.revise(userId, planId, `Revisi langkah mendatang untuk memperhitungkan laporan operasional ini: ${operationalReportText(resolved.report)}.`, event.id);
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      generation = { status: 'NO_VALID_PROPOSAL_FOUND' as const, reason: error.message };
    }
    return { kind: 'REPORT_APPLIED' as const, report: { kind: resolved.report.kind, entityName: resolved.report.entityName, value: resolved.report.value }, eventId: event.id.toString(), generation };
  }
}
