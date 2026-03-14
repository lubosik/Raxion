export function buildQualificationMsg1Prompt(candidateProfile) {
  return `Write a short message asking this candidate for their notice period. Return plain text only.\n\nCandidate:\n${JSON.stringify(candidateProfile, null, 2)}`;
}

export function buildQualificationMsg2Prompt(previousAnswer, jobBrief) {
  return `Write a short message asking about salary expectations after this notice-period answer: ${previousAnswer}. Keep it warm and direct. Return plain text only.\n\nJob brief:\n${JSON.stringify(jobBrief, null, 2)}`;
}

export function buildQualificationMsg3Prompt(previousAnswers, jobBrief) {
  return `Write a short message asking for current location and one must-have skill confirmation. Return plain text only.\n\nPrevious answers:\n${JSON.stringify(previousAnswers, null, 2)}\n\nJob brief:\n${JSON.stringify(jobBrief, null, 2)}`;
}

export function buildQualificationScoringPrompt(answers, jobBrief) {
  return `Review the qualification answers against the brief. Decide QUALIFIED, UNQUALIFIED, or NEEDS_REVIEW.\n\nReturn ONLY valid JSON:\n{ "verdict": string, "reason": string, "qualificationData": object }\n\nAnswers:\n${JSON.stringify(answers, null, 2)}\n\nJob brief:\n${JSON.stringify(jobBrief, null, 2)}`;
}

export const qualificationSystemPrompt = 'You run candidate qualification for recruiters. Return plain text unless JSON is explicitly requested. When JSON is requested, return only valid JSON.';
