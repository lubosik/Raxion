import supabase from '../db/supabase.js';
import { callClaude, extractDocumentData } from '../integrations/claude.js';
import {
  addApplicantToHiringProject,
  createLinkedInJobPosting,
  downloadApplicantResume,
  getJobApplicantsPage,
  getSearchParameters,
  publishLinkedInJobPosting,
} from '../integrations/unipile.js';
import { createInterview, createJobOpening, syncCandidateToATS } from '../integrations/zohoRecruit.js';
import { getRecruiterChatId, sendTelegramMessage } from '../integrations/telegram.js';
import { logActivity } from './activityLogger.js';
import { normalizeJobRecord } from './dbCompat.js';
import { queueApproval } from './approvalService.js';

function mapWorkplace(remotePolicy) {
  const value = String(remotePolicy || '').toLowerCase();
  if (value.includes('hybrid')) return 'HYBRID';
  if (value.includes('remote')) return 'REMOTE';
  return 'ON_SITE';
}

function mapApplicationRating(fitGrade, fitScore) {
  if (fitGrade === 'HOT' || Number(fitScore || 0) >= 75) return 'GOOD_FIT';
  if (fitGrade === 'WARM' || fitGrade === 'POSSIBLE' || Number(fitScore || 0) >= 30) return 'MAYBE';
  return 'NOT_A_FIT';
}

function applicantPipelineStage(candidate) {
  if (candidate.interview_scheduled) return 'Interview Scheduled';
  if (candidate.pipeline_stage === 'Archived') return 'Archived';
  if (['HOT', 'WARM'].includes(candidate.fit_grade)) return 'Qualified';
  if (candidate.candidate_type === 'applicant') return 'Applied';
  return candidate.pipeline_stage || 'Applied';
}

function parseJsonField(value) {
  if (!value) return value;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function listJobTeamMembers(jobId) {
  const { data } = await supabase
    .from('job_team_members')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: true });
  return data || [];
}

export async function addJobTeamMember(jobId, member) {
  const payload = {
    job_id: jobId,
    name: member.name,
    email: member.email || null,
    telegram_chat_id: member.telegram_chat_id || null,
    role: member.role || 'recruiter',
    notify_on_new_applicant: Boolean(member.notify_on_new_applicant),
    notify_on_shortlist: member.notify_on_shortlist !== false,
    notify_on_interview_scheduled: member.notify_on_interview_scheduled !== false,
  };
  const { data, error } = await supabase.from('job_team_members').insert(payload).select('*').single();
  if (error) throw error;
  return data;
}

export async function replaceJobTeamMembers(jobId, teamMembers = []) {
  await supabase.from('job_team_members').delete().eq('job_id', jobId);
  const clean = teamMembers
    .filter((member) => String(member?.name || '').trim())
    .map((member) => ({
      job_id: jobId,
      name: String(member.name || '').trim(),
      email: String(member.email || '').trim() || null,
      telegram_chat_id: String(member.telegram_chat_id || '').trim() || null,
      role: member.role || 'recruiter',
      notify_on_new_applicant: Boolean(member.notify_on_new_applicant),
      notify_on_shortlist: member.notify_on_shortlist !== false,
      notify_on_interview_scheduled: member.notify_on_interview_scheduled !== false,
    }));

  if (!clean.length) return [];
  const { data, error } = await supabase.from('job_team_members').insert(clean).select('*');
  if (error) throw error;
  return data || [];
}

export async function removeJobTeamMember(jobId, memberId) {
  const { error } = await supabase.from('job_team_members').delete().eq('job_id', jobId).eq('id', memberId);
  if (error) throw error;
  return true;
}

export function buildJobDescription(job) {
  return [
    `<h2>${job.job_title || job.title || 'Untitled Job'}</h2>`,
    `<p><strong>Company:</strong> ${job.client_name || 'Unknown'}</p>`,
    `<p><strong>Location:</strong> ${job.location || 'Unspecified'}</p>`,
    `<p><strong>Seniority:</strong> ${job.seniority_level || job.seniority || 'Mid-Senior'}</p>`,
    job.salary_min
      ? `<p><strong>Salary:</strong> ${job.currency || 'USD'} ${Number(job.salary_min).toLocaleString()}${job.salary_max ? ` - ${Number(job.salary_max).toLocaleString()}` : ''}</p>`
      : '',
    '<h3>About the Role</h3>',
    `<p>${job.full_job_description || job.raw_brief || job.candidate_profile || ''}</p>`,
    '<h3>Must-Have Skills</h3>',
    `<p>${job.tech_stack_must || job.must_have_stack || 'Not provided'}</p>`,
  ].filter(Boolean).join('\n');
}

async function resolveLinkedInJobParams(job) {
  const [titles, locations, companies] = await Promise.all([
    getSearchParameters('JOB_TITLE', job.job_title || job.title || ''),
    getSearchParameters('LOCATION', job.location || ''),
    getSearchParameters('COMPANY', job.client_name || ''),
  ]);

  return {
    job_title_id: titles?.[0]?.id || null,
    company_id: companies?.[0]?.id || null,
    location_id: locations?.[0]?.id || job.location || null,
  };
}

export async function createLinkedInJobPostingForJob(job) {
  const normalizedJob = normalizeJobRecord(job);
  const params = await resolveLinkedInJobParams(normalizedJob);
  const draft = await createLinkedInJobPosting({
    job_title: params.job_title_id ? { id: params.job_title_id } : { text: normalizedJob.job_title },
    company: params.company_id ? { id: params.company_id } : { text: normalizedJob.client_name },
    workplace: mapWorkplace(normalizedJob.remote_policy),
    location: params.location_id,
    employment_status: 'FULL_TIME',
    description: buildJobDescription(normalizedJob),
  });

  const draftId = draft?.job_id || draft?.id;
  if (!draftId) {
    throw new Error(`LinkedIn posting draft creation failed: ${JSON.stringify(draft)}`);
  }

  const published = await publishLinkedInJobPosting(draftId);
  const posting = {
    job_id: published?.job_id || published?.id || draftId,
    project_id: draft?.project_id || published?.project_id || null,
  };

  await supabase.from('jobs').update({
    linkedin_job_posting_id: posting.job_id,
    linkedin_project_id: posting.project_id,
  }).eq('id', normalizedJob.id);

  await logActivity(normalizedJob.id, null, 'JOB_POSTED', `LinkedIn job posting created - ID ${posting.job_id}`, {
    linkedin_job_posting_id: posting.job_id,
    linkedin_project_id: posting.project_id,
  });

  return posting;
}

export async function createOrLinkZohoJobOpening(job) {
  const normalizedJob = normalizeJobRecord(job);
  if (normalizedJob.zoho_job_opening_id) return normalizedJob.zoho_job_opening_id;

  const result = await createJobOpening(normalizedJob);
  const zohoJobId = result?.data?.[0]?.details?.id || result?.data?.[0]?.id || null;
  if (!zohoJobId) return null;

  await supabase.from('jobs').update({ zoho_job_opening_id: zohoJobId }).eq('id', normalizedJob.id);
  await logActivity(normalizedJob.id, null, 'ZOHO_JOB_CREATED', `Zoho Job Opening created - ID ${zohoJobId}`, {
    zoho_job_opening_id: zohoJobId,
  });
  return zohoJobId;
}

export async function notifyTeamJobLaunched(job) {
  const teamMembers = await listJobTeamMembers(job.id);
  const targets = [
    ...teamMembers.filter((member) => member.telegram_chat_id).map((member) => member.telegram_chat_id),
    process.env.TELEGRAM_TEAM_CHAT_ID || null,
  ].filter(Boolean);
  if (!targets.length) return 0;

  const postingLabel = job.linkedin_job_posting_id ? `Posting ${job.linkedin_job_posting_id}` : 'posting pending';
  const message = [
    `New inbound pipeline launched for *${job.job_title}*`,
    `${job.client_name || 'Unknown client'} · ${job.location || 'No location'}`,
    `Mode: ${job.job_mode || 'outbound'}`,
    `LinkedIn: ${postingLabel}`,
    job.zoho_job_opening_id ? `Zoho Job Opening: ${job.zoho_job_opening_id}` : 'Zoho Job Opening: pending',
  ].join('\n');

  for (const chatId of targets) {
    // eslint-disable-next-line no-await-in-loop
    await sendTelegramMessage(chatId, message).catch(() => null);
  }

  await logActivity(job.id, null, 'TEAM_NOTIFIED', 'Team notified that inbound pipeline launched', {
    recipients: targets.length,
  });
  return targets.length;
}

export async function handleInboundJobLaunch(job) {
  const normalizedJob = normalizeJobRecord(job);
  if (!['inbound', 'both'].includes(normalizedJob.job_mode || 'outbound')) return normalizedJob;

  let workingJob = normalizedJob;

  if (workingJob.create_linkedin_posting || (!workingJob.linkedin_job_posting_id && workingJob.job_mode === 'inbound')) {
    const posting = await createLinkedInJobPostingForJob(workingJob);
    workingJob = { ...workingJob, linkedin_job_posting_id: posting.job_id, linkedin_project_id: posting.project_id };
  }

  if (workingJob.zoho_job_opening_id || process.env.ZOHO_API_BASE) {
    const zohoJobId = await createOrLinkZohoJobOpening(workingJob);
    if (zohoJobId) workingJob = { ...workingJob, zoho_job_opening_id: zohoJobId };
  }

  await notifyTeamJobLaunched(workingJob);
  return workingJob;
}

export async function extractCVData(buffer, candidateName) {
  if (!buffer) return null;
  const prompt = `Extract structured information from this CV for candidate ${candidateName}.

Return ONLY valid JSON with these exact keys:
{
  "raw_text": "brief 3-sentence summary of the candidate",
  "skills": ["skill1", "skill2"],
  "work_history": "most recent 3 roles as a readable string",
  "years_experience": 0,
  "education": "highest qualification and institution"
}`;

  return extractDocumentData(
    buffer.toString('base64'),
    'application/pdf',
    prompt,
    'You extract structured recruiting data from CVs. Return valid JSON only.',
    { expectJson: true, maxTokens: 1000 },
  ).catch(() => null);
}

export async function downloadAndParseResume(candidate, applicantId) {
  try {
    const resumeBuffer = await downloadApplicantResume(applicantId);
    if (!resumeBuffer) return null;

    const extracted = await extractCVData(resumeBuffer, candidate.name);
    const updatePayload = {
      resume_url: `unipile://linkedin/jobs/applicants/${applicantId}/resume`,
    };

    if (extracted) {
      updatePayload.resume_text = extracted.raw_text || null;
      updatePayload.tech_skills = Array.isArray(extracted.skills) ? extracted.skills.join(', ') : null;
      updatePayload.past_employers = extracted.work_history || null;
      updatePayload.years_experience = extracted.years_experience || null;
      updatePayload.education = extracted.education || null;
    }

    await supabase.from('candidates').update(updatePayload).eq('id', candidate.id);
    return extracted;
  } catch (error) {
    console.warn('[inbound] resume parse failed', { candidateId: candidate.id, error: error.message });
    return null;
  }
}

async function scoreApplicant(candidate, job) {
  const cvContext = candidate.resume_text ? `\nCV Summary: ${candidate.resume_text}` : '';
  const workContext = candidate.past_employers ? `\nWork History: ${candidate.past_employers}` : '';
  const result = await callClaude(
    `Score this job applicant against the job requirements.

Job: ${job.job_title}
Client: ${job.client_name}
Required Skills: ${job.tech_stack_must || job.must_have_stack || 'Not specified'}
Seniority: ${job.seniority_level || job.seniority || 'Not specified'}
Location: ${job.location || 'Not specified'}
Role Notes: ${job.full_job_description || job.raw_brief || job.candidate_profile || ''}

Candidate:
- Name: ${candidate.name}
- Headline: ${candidate.current_title || 'Unknown'}
- Location: ${candidate.location || 'Unknown'}
- Skills: ${candidate.tech_skills || 'not extracted'}
- Years Experience: ${candidate.years_experience || 'unknown'}${cvContext}${workContext}

Score 0-100 on:
- Skills match (35 points)
- Seniority fit (25 points)
- Location/availability (20 points)
- Overall profile quality and relevance (20 points)

Return ONLY valid JSON:
{
  "score": 0,
  "grade": "HOT",
  "rationale": "2 sentences explaining the score",
  "strengths": ["strength1", "strength2"],
  "concerns": ["concern1"]
}`,
    'You are a rigorous recruiting evaluator. Return valid JSON only.',
    { expectJson: true },
  ).catch(() => null);

  if (!result) {
    const fallbackScore = Math.max(0, Math.min(100, Number(candidate.fit_score || 0)));
    return {
      fit_score: fallbackScore,
      fit_grade: fallbackScore >= 75 ? 'HOT' : fallbackScore >= 50 ? 'WARM' : fallbackScore >= 30 ? 'POSSIBLE' : 'ARCHIVE',
      fit_rationale: candidate.fit_rationale || 'Fallback applicant score used',
      strengths: [],
      concerns: [],
    };
  }

  return {
    fit_score: Math.max(0, Math.min(100, Math.round(Number(result.score ?? result.fit_score ?? 0)))),
    fit_grade: String(result.grade || result.fit_grade || 'ARCHIVE').toUpperCase(),
    fit_rationale: result.rationale || result.fit_rationale || 'No rationale returned',
    strengths: Array.isArray(result.strengths) ? result.strengths : [],
    concerns: Array.isArray(result.concerns) ? result.concerns : [],
  };
}

export async function updateLinkedInApplicantRating(candidate, job, rating) {
  if (!candidate.linkedin_provider_id || !job.linkedin_project_id) return null;
  const stage = rating === 'GOOD_FIT' ? 'CONTACTED' : 'UNCONTACTED';
  return addApplicantToHiringProject(candidate.linkedin_provider_id, job.linkedin_project_id, stage).catch(() => null);
}

export async function draftApplicantReply(candidate, job) {
  if (!candidate.email || candidate.reply_sent) return null;
  if (!['HOT', 'WARM'].includes(candidate.fit_grade)) return null;

  const prompt = `Draft a reply email to a job applicant who applied for: ${job.job_title} at ${job.client_name}.

Applicant: ${candidate.name}
Their headline: ${candidate.current_title || 'Unknown'}
Score: ${candidate.fit_score || 0}/100
Strengths noted: ${candidate.fit_rationale || 'Strong overall fit'}

The email should:
1. Thank them personally for applying and reference their background specifically
2. Tell them their application looks interesting and we'd love to learn more
3. Ask them to book a brief call using this link: ${job.calendly_link || '[calendly link]'}
4. Be warm, direct, and professional with no corporate speak
5. Sign off from the recruiter at ${job.client_name}

Rules: No em-dashes. Conversational but professional. Under 8 sentences total.

Return ONLY valid JSON:
{
  "subject": "email subject line",
  "body": "email body text"
}`;

  const draft = await callClaude(prompt, 'You write concise applicant response emails. Return valid JSON only.', {
    expectJson: true,
  }).catch(() => null);

  if (!draft?.body) return null;

  const approval = await queueApproval({
    candidateId: candidate.id,
    jobId: job.id,
    channel: 'email',
    stage: 'Applicant Reply Email',
    messageText: draft.body,
    subject: draft.subject || `${job.job_title} application`,
    messageType: 'applicant_reply_email',
  });

  if (!approval) return null;
  await logActivity(job.id, candidate.id, 'APPLICANT_REPLY_DRAFTED', `Drafted applicant reply email for ${candidate.name}`, {
    approval_id: approval.id,
    subject: draft.subject || null,
  });
  return approval;
}

export async function notifyTeamOfShortlist(job, shortlistedCandidates) {
  const members = await listJobTeamMembers(job.id);
  const notifiedMembers = members.filter((member) => member.notify_on_shortlist && member.telegram_chat_id);
  if (!notifiedMembers.length || !shortlistedCandidates?.length) return 0;

  const summary = shortlistedCandidates
    .slice(0, 5)
    .map((candidate) => `• ${candidate.name} (${candidate.current_title || 'Unknown title'}) - Score: ${candidate.fit_score || 0}/100`)
    .join('\n');

  const message = [
    `Raxion Shortlist Update - ${job.job_title}`,
    '',
    `${shortlistedCandidates.length} new applicants shortlisted today.`,
    '',
    'Top candidates:',
    summary,
    shortlistedCandidates.length > 5 ? `...and ${shortlistedCandidates.length - 5} more` : '',
    '',
    `View full pipeline: ${(process.env.SERVER_BASE_URL || '').replace(/\/+$/, '')}/#jobs`,
  ].filter(Boolean).join('\n');

  for (const member of notifiedMembers) {
    // eslint-disable-next-line no-await-in-loop
    await sendTelegramMessage(member.telegram_chat_id, message).catch(() => null);
  }

  await supabase.from('candidates').update({ team_pinged: true }).in('id', shortlistedCandidates.map((candidate) => candidate.id));
  await logActivity(job.id, null, 'TEAM_NOTIFIED', `Team notified of ${shortlistedCandidates.length} shortlisted applicants`, {
    shortlisted_candidate_ids: shortlistedCandidates.map((candidate) => candidate.id),
  });
  return notifiedMembers.length;
}

export async function scheduleInterviewInZoho(candidateInput, jobInput, proposedTime = null, notes = '') {
  let candidate = candidateInput;
  const job = normalizeJobRecord(jobInput);

  if (!candidate.zoho_candidate_id) {
    await syncCandidateToATS(candidate);
    const { data: refreshed } = await supabase.from('candidates').select('*').eq('id', candidate.id).single();
    candidate = refreshed || candidate;
  }

  const interviewDate = proposedTime || new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const payload = {
    Interview_Name: `${candidate.name} - ${job.job_title}`,
    Candidate_Name: { id: candidate.zoho_candidate_id },
    Job_Opening_Name: job.zoho_job_opening_id ? { id: job.zoho_job_opening_id } : undefined,
    Interview_Owner: process.env.ZOHO_DEFAULT_INTERVIEWER_ID || undefined,
    Scheduled_On: interviewDate,
    Interview_Status: 'Pending',
    Interview_Type: 'Phone Screen',
    Comments: `Auto-scheduled by Raxion. Candidate score: ${candidate.fit_score || 0}/100. ${candidate.fit_rationale || ''} ${notes || ''}`.trim(),
  };

  const result = await createInterview(payload);
  const zohoInterviewId = result?.data?.[0]?.details?.id || result?.data?.[0]?.id || null;
  if (!zohoInterviewId) return null;

  await supabase.from('candidates').update({
    interview_scheduled: true,
    interview_at: interviewDate,
    zoho_interview_id: zohoInterviewId,
    pipeline_stage: 'Interview Scheduled',
  }).eq('id', candidate.id);

  await logActivity(job.id, candidate.id, 'INTERVIEW_SCHEDULED', `Interview scheduled for ${candidate.name} - Zoho ID ${zohoInterviewId}`, {
    zoho_interview_id: zohoInterviewId,
    interview_at: interviewDate,
  });

  const teamMembers = await listJobTeamMembers(job.id);
  const targets = teamMembers.filter((member) => member.notify_on_interview_scheduled && member.telegram_chat_id);
  const message = [
    `Interview Scheduled - ${job.job_title}`,
    '',
    `Candidate: ${candidate.name}`,
    `Role: ${candidate.current_title || 'Unknown'}`,
    `Score: ${candidate.fit_score || 0}/100`,
    `Time: ${new Date(interviewDate).toLocaleString('en-GB', { timeZone: job.timezone || 'Europe/London' })}`,
  ].join('\n');

  for (const member of targets) {
    // eslint-disable-next-line no-await-in-loop
    await sendTelegramMessage(member.telegram_chat_id, message).catch(() => null);
  }

  return zohoInterviewId;
}

async function upsertApplicantCandidate(job, applicant) {
  const appliedAt = applicant.applied_at
    ? new Date(Number(applicant.applied_at) * 1000).toISOString()
    : new Date().toISOString();

  const candidatePayload = {
    job_id: job.id,
    candidate_type: 'applicant',
    applicant_id: applicant.id || applicant.applicant_id,
    name: applicant.name || applicant.full_name || 'Unknown',
    linkedin_url: applicant.public_profile_url || applicant.profile_url || null,
    linkedin_provider_id: applicant.profile_id || applicant.provider_id || null,
    current_title: applicant.headline || applicant.current_title || null,
    current_company: applicant.current_company || null,
    location: applicant.location || null,
    email: applicant.email_address || applicant.email || null,
    phone: applicant.phone_number || applicant.phone || null,
    applied_at: appliedAt,
    pipeline_stage: 'Applied',
    enrichment_status: applicant.email_address ? 'Enriched' : 'Pending',
    past_employers: applicant.work_experience ? JSON.stringify(applicant.work_experience) : null,
    education: applicant.education ? JSON.stringify(applicant.education) : null,
    source: 'LinkedIn Applicant',
  };

  const { data, error } = await supabase.from('candidates').insert(candidatePayload).select('*').single();
  if (error) {
    if (String(error.message || '').includes('idx_candidates_job_applicant')) {
      return null;
    }
    throw error;
  }
  return data;
}

export async function fetchAndProcessApplicants(jobInput) {
  const job = normalizeJobRecord(jobInput);
  if (!job.linkedin_job_posting_id) {
    await logActivity(job.id, null, 'APPLICANT_FETCH_SKIPPED', 'No LinkedIn posting ID - skipping applicant fetch', {});
    return { fetched: 0, shortlisted: 0 };
  }

  await logActivity(job.id, null, 'APPLICANT_FETCH_STARTED', 'Fetching new applicants from LinkedIn', {});

  const response = await getJobApplicantsPage(job.linkedin_job_posting_id, {
    limit: 50,
    service: 'CLASSIC',
    min_years_of_experience: 0,
    ...(job.applicant_fetch_cursor ? { cursor: job.applicant_fetch_cursor } : {}),
  });

  const items = response?.items || response?.applicants || [];
  let fetched = 0;
  const shortlisted = [];

  for (const applicant of items) {
    // eslint-disable-next-line no-await-in-loop
    const { data: existing } = await supabase
      .from('candidates')
      .select('id')
      .eq('job_id', job.id)
      .eq('applicant_id', applicant.id || applicant.applicant_id)
      .maybeSingle();
    if (existing) continue;

    // eslint-disable-next-line no-await-in-loop
    const candidate = await upsertApplicantCandidate(job, applicant);
    if (!candidate?.id) continue;
    fetched += 1;

    // eslint-disable-next-line no-await-in-loop
    await logActivity(job.id, candidate.id, 'APPLICANT_INGESTED', `New applicant ingested - ${candidate.name}`, {
      applicant_id: candidate.applicant_id,
    });

    if (candidate.applicant_id) {
      // eslint-disable-next-line no-await-in-loop
      await downloadAndParseResume(candidate, candidate.applicant_id);
    }

    // eslint-disable-next-line no-await-in-loop
    const { data: refreshed } = await supabase.from('candidates').select('*').eq('id', candidate.id).single();
    // eslint-disable-next-line no-await-in-loop
    const score = await scoreApplicant(refreshed || candidate, job);
    const applicationRating = mapApplicationRating(score.fit_grade, score.fit_score);
    const strengths = Array.isArray(score.strengths) ? score.strengths.join('\n') : '';
    const concerns = Array.isArray(score.concerns) ? score.concerns.join('\n') : '';
    const notes = [refreshed?.notes || '', strengths ? `[APPLICANT_STRENGTHS]\n${strengths}` : '', concerns ? `[APPLICANT_CONCERNS]\n${concerns}` : '']
      .filter(Boolean)
      .join('\n');

    // eslint-disable-next-line no-await-in-loop
    await supabase.from('candidates').update({
      fit_score: score.fit_score,
      fit_grade: score.fit_grade,
      fit_rationale: score.fit_rationale,
      application_rating: applicationRating,
      pipeline_stage: applicantPipelineStage({ ...refreshed, ...score, candidate_type: 'applicant' }),
      notes,
      latest_fit_score: score.fit_score,
      latest_fit_grade: score.fit_grade,
      latest_fit_rationale: score.fit_rationale,
      latest_scored_at: new Date().toISOString(),
      best_scored_at: new Date().toISOString(),
    }).eq('id', candidate.id);

    if (['HOT', 'WARM'].includes(score.fit_grade)) {
      shortlisted.push({ ...(refreshed || candidate), ...score });
    }

    // eslint-disable-next-line no-await-in-loop
    await updateLinkedInApplicantRating({ ...(refreshed || candidate), ...score }, job, applicationRating);
    // eslint-disable-next-line no-await-in-loop
    await draftApplicantReply({ ...(refreshed || candidate), ...score }, job);
  }

  await supabase.from('jobs').update({
    last_applicant_fetch_at: new Date().toISOString(),
    applicant_fetch_cursor: response?.cursor?.next || null,
  }).eq('id', job.id);

  if (shortlisted.length) {
    await notifyTeamOfShortlist(job, shortlisted);
  }

  await logActivity(job.id, null, 'APPLICANT_FETCH_COMPLETE', `Fetched ${fetched} new applicants`, {
    fetched,
    total: response?.paging?.total_count || items.length,
  });

  return { fetched, shortlisted: shortlisted.length };
}

export async function listApplicantsForJob(jobId) {
  const { data } = await supabase
    .from('candidates')
    .select('*')
    .eq('job_id', jobId)
    .eq('candidate_type', 'applicant')
    .order('fit_score', { ascending: false })
    .order('applied_at', { ascending: false });

  return (data || []).map((candidate) => ({
    ...candidate,
    parsed_work_history: parseJsonField(candidate.past_employers),
    parsed_education: parseJsonField(candidate.education),
  }));
}
