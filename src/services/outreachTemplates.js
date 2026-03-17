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

export function getSenderSignature(job) {
  const templates = parseTemplates(job?.outreach_templates);
  const configured = String(templates.sender_signature || '').trim();
  if (configured) return configured;

  const senderName = String(process.env.SENDER_NAME || '').trim();
  if (senderName && job?.client_name) return `${senderName} | ${job.client_name}`;
  if (senderName) return senderName;
  if (job?.client_name) return `Recruitment Team | ${job.client_name}`;
  return 'Recruitment Team';
}

export function ensureSignedMessage(job, messageText) {
  const signature = getSenderSignature(job);
  const trimmed = String(messageText || '').trim();
  if (!trimmed) return trimmed;

  const placeholderPattern = /\[(?:your name|sender name|recruiter name)\]/gi;
  const replaced = trimmed.replace(placeholderPattern, signature).trim();
  const normalized = replaced.toLowerCase();
  const normalizedSignature = signature.toLowerCase();

  if (normalized.endsWith(normalizedSignature)) {
    return replaced;
  }

  return `${replaced}\n\n${signature}`;
}

export function buildTemplateAwarePrompt(job, key, fallbackPrompt) {
  const template = getTemplateValue(job, key);
  const signature = getSenderSignature(job);
  const signatureInstruction = `Write as ${signature}. Use that exact signature at the end of the message. Never use placeholders like [Your name].`;

  if (!template) return `${fallbackPrompt}\n\n${signatureInstruction}`;

  return `${fallbackPrompt}\n\nJob-specific template guidance:\n${template}\n\n${signatureInstruction}\n\nFollow the guidance above while still personalizing to the candidate and job.`;
}
