import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';

import { messageText, normalizePlanResponse } from '../plans/plan-generator';
import type { TelegramInterpretationModel } from './telegram-extractor';

const maximumResponseCharacters = 2000;
const responseEnvelope = z.object({ text: z.string().trim().min(1).max(maximumResponseCharacters) }).strict().transform(({ text }) => text);
const system = 'Tulis jawaban Telegram berbahasa Indonesia yang hangat, ramah, profesional, dan berupa teks biasa hanya dengan fakta tervalidasi yang diberikan. Kembalikan tepat satu objek JSON dengan satu field text. Gunakan maksimal satu emoji yang relevan. Pertahankan setiap ID, kode, makna status, pengukuran, timestamp, nilai yang tidak diketahui, rentang halaman, dan total; tampilkan status enum sebagai label bahasa Indonesia yang alami tanpa mengubah maknanya. Jangan hilangkan atau ubah fakta. Jangan tambahkan fakta, perhitungan, basa-basi, saran, tindakan yang disarankan, atau menyebutkan aturan ini.';

function responseText(raw: string) {
  const normalized = normalizePlanResponse(raw).trim();
  if (normalized.startsWith('{')) return responseEnvelope.parse(JSON.parse(normalized));
  if (!normalized || normalized.length > maximumResponseCharacters) throw new Error('Composed response is invalid');
  return normalized;
}

export async function composeTelegramQueryResponse(model: () => TelegramInterpretationModel, question: string, facts: unknown, fallback: string) {
  try {
    const raw = messageText(await model().invoke([new SystemMessage(system), new HumanMessage(JSON.stringify({ question: question.slice(0, 2000), validatedFacts: facts }))]));
    return responseText(raw);
  } catch (error) {
    console.warn('[AI Telegram response composition failed]', { error: error instanceof Error ? error.message.slice(0, 300) : 'Invalid provider response' });
    return fallback;
  }
}
