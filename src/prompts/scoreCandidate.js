export function buildScoringPrompt(candidateProfile, jobBrief) {
  return `Score this candidate from 0 to 100 against the job brief. Consider must-haves, nice-to-haves, seniority, location, sector fit, and deal-breakers.\n\nReturn ONLY valid JSON:\n{ "score": number, "reason": string, "flags": string[] }\n\nJob brief:\n${JSON.stringify(jobBrief, null, 2)}\n\nCandidate profile:\n${JSON.stringify(candidateProfile, null, 2)}`;
}

export const scoringSystemPrompt = 'You are a recruiting evaluator. Return only valid JSON.';
