export function buildJobBriefPrompt(rawText) {
  return `Convert the following recruitment brief into structured JSON.\n\nReturn ONLY valid JSON with this exact shape:\n{\n  "role": string|null,\n  "seniority": string|null,\n  "location": string|null,\n  "remote": boolean,\n  "salaryMin": number|null,\n  "salaryMax": number|null,\n  "mustHaves": string[],\n  "niceToHaves": string[],\n  "dealBreakers": string[],\n  "sector": string|null,\n  "clientName": string|null\n}\n\nUse null when unknown.\n\nBrief:\n${rawText}`;
}

export const jobBriefSystemPrompt = 'You extract structured recruitment briefs. Return only valid JSON. Never include markdown, commentary, or code fences.';
