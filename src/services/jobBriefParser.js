import supabase from '../db/supabase.js';
import { callClaude } from '../integrations/claude.js';
import { buildJobBriefPrompt, jobBriefSystemPrompt } from '../prompts/parseJobBrief.js';
import { prepareJobPayload, normalizeJobRecord } from './dbCompat.js';

export async function parseJobBrief(rawText) {
  const parsed = await callClaude(buildJobBriefPrompt(rawText), jobBriefSystemPrompt, { expectJson: true });
  const payload = {
    name: parsed.role || parsed.jobTitle || 'New Job',
    status: 'ACTIVE',
    job_title: parsed.role || parsed.jobTitle,
    client_name: parsed.clientName,
    recruiter_name: parsed.recruiterName || null,
    seniority_level: parsed.seniority,
    employment_type: parsed.employmentType || 'Full-time',
    location: parsed.location,
    remote_policy: parsed.remote ? 'Remote' : 'On-site',
    salary_min: parsed.salaryMin,
    salary_max: parsed.salaryMax,
    currency: parsed.currency || 'GBP',
    sector: parsed.sector,
    tech_stack_must: Array.isArray(parsed.mustHaves) ? parsed.mustHaves.join(', ') : '',
    tech_stack_nice: Array.isArray(parsed.niceToHaves) ? parsed.niceToHaves.join(', ') : '',
    candidate_profile: rawText,
    full_job_description: rawText,
  };

  const { data, error } = await supabase.from('jobs').insert(await prepareJobPayload(payload)).select('*').single();
  if (error) throw error;
  return normalizeJobRecord(data);
}
