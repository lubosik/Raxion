export function parseTemplates(rawTemplates) {
  if (!rawTemplates) return {};
  if (typeof rawTemplates === 'object') return rawTemplates;

  try {
    return JSON.parse(rawTemplates);
  } catch {
    return {};
  }
}

export function getTemplateValue(job, key) {
  const templates = parseTemplates(job?.outreach_templates);
  return String(templates[key] || '').trim();
}

export function buildTemplateAwarePrompt(job, key, fallbackPrompt) {
  const template = getTemplateValue(job, key);
  if (!template) return fallbackPrompt;

  return `${fallbackPrompt}\n\nJob-specific template guidance:\n${template}\n\nFollow the guidance above while still personalizing to the candidate and job.`;
}
