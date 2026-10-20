import type { Admission } from '../net/NetClient';
import type { OnlineStorage, PendingAdmission } from '../net/OnlineCredentials';
import { clearPendingAdmission } from '../net/OnlineCredentials';

/** Only the request captured before sending this attempt may be acknowledged. */
export function acknowledgeAdmission(storage: OnlineStorage, attempt: PendingAdmission | null, admission: Admission): void {
  if (!attempt) return;
  const joined = admission.type === 'joined' && admission.requestId === attempt.message.requestId;
  const ended = admission.type === 'sessionEnded' && (attempt.message.type === 'createRoom' || attempt.message.sessionId === admission.settlement.sessionId);
  if (joined || ended) clearPendingAdmission(storage, attempt.message.requestId);
}
