const CHAT_ENDED_TAG = '[CHAT_ENDED]';
const CHAT_END_RECOMMENDED_TAG = '[CHAT_END_RECOMMENDED]';
const CHAT_END_REASON_PREFIX = '[CHAT_END_REASON:';
const CHAT_END_RECOMMENDATION_PREFIX = '[CHAT_END_RECOMMENDATION:';

function lines(notes) {
  return String(notes || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function withUniqueLine(notes, line) {
  const next = lines(notes);
  if (!next.includes(line)) next.push(line);
  return next.join('\n');
}

function removeLines(notes, matcher) {
  return lines(notes)
    .filter((line) => !matcher(line))
    .join('\n');
}

function extractTaggedValue(notes, prefix) {
  const match = lines(notes).find((line) => line.startsWith(prefix) && line.endsWith(']'));
  if (!match) return null;
  return match.slice(prefix.length, -1).trim() || null;
}

export function isConversationEnded(candidate) {
  return String(candidate?.notes || '').includes(CHAT_ENDED_TAG);
}

export function isEndChatRecommended(candidate) {
  return String(candidate?.notes || '').includes(CHAT_END_RECOMMENDED_TAG);
}

export function getConversationEndReason(candidate) {
  return extractTaggedValue(candidate?.notes, CHAT_END_REASON_PREFIX);
}

export function getEndChatRecommendationReason(candidate) {
  return extractTaggedValue(candidate?.notes, CHAT_END_RECOMMENDATION_PREFIX);
}

export function markConversationEnded(candidate, reason, { archive = true } = {}) {
  let nextNotes = removeLines(candidate?.notes, (line) => (
    line === CHAT_END_RECOMMENDED_TAG
    || line.startsWith(CHAT_END_RECOMMENDATION_PREFIX)
    || line === CHAT_ENDED_TAG
    || line.startsWith(CHAT_END_REASON_PREFIX)
  ));
  nextNotes = withUniqueLine(nextNotes, CHAT_ENDED_TAG);
  if (reason) nextNotes = withUniqueLine(nextNotes, `${CHAT_END_REASON_PREFIX} ${reason}]`);

  const updates = {
    notes: nextNotes,
    follow_up_due_at: null,
  };

  if (archive) {
    updates.pipeline_stage = 'Archived';
  }

  return updates;
}

export function markEndChatRecommended(candidate, reason) {
  let nextNotes = removeLines(candidate?.notes, (line) => (
    line === CHAT_END_RECOMMENDED_TAG
    || line.startsWith(CHAT_END_RECOMMENDATION_PREFIX)
  ));
  nextNotes = withUniqueLine(nextNotes, CHAT_END_RECOMMENDED_TAG);
  if (reason) nextNotes = withUniqueLine(nextNotes, `${CHAT_END_RECOMMENDATION_PREFIX} ${reason}]`);

  return {
    notes: nextNotes,
  };
}

export function clearEndChatRecommendation(candidate) {
  return {
    notes: removeLines(candidate?.notes, (line) => (
      line === CHAT_END_RECOMMENDED_TAG
      || line.startsWith(CHAT_END_RECOMMENDATION_PREFIX)
    )),
  };
}
