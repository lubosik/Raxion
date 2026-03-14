import supabase from '../db/supabase.js';
import { callClaude, extractDocumentData } from '../integrations/claude.js';
import { searchLinkedInPeople, getLinkedInProfile, getJobApplicants, downloadApplicantResume } from '../integrations/unipile.js';
import { sendTelegramMessage, getRecruiterChatId } from '../integrations/telegram.js';
import { sleep } from '../lib_utils.js';
import { logActivity } from './activityLogger.js';

function normaliseCandidate(profile, job, scoring, source = 'LinkedIn Search') {
  const linkedinUrl = profile.profile_url || profile.linkedin_url || (profile.public_identifier ? `https://www.linkedin.com/in/${profile.public_identifier}` : null);
  const yearsExperience = Array.isArray(profile.work_experience)
    ? profile.work_experience.length
    : Number(profile.years_experience || 0) || null;

  return {
    job_id: job.id,
    name: profile.name || profile.full_name || 'Unknown',
    email: profile.email || null,
    phone: profile.phone || null,
    linkedin_url: linkedinUrl,
    linkedin_provider_id: profile.provider_id || profile.id || null,
    current_title: profile.current_title || profile.headline || profile.work_experience?.[0]?.title || null,
    current_company: profile.current_company || profile.work_experience?.[0]?.company || null,
    location: profile.location || null,
    years_experience: yearsExperience,
    tech_skills: Array.isArray(profile.skills) ? profile.skills.join(', ') : profile.skills || null,
    past_employers: Array.isArray(profile.work_experience) ? profile.work_experience.map((item) => item.company).filter(Boolean).join(', ') : null,
    education: Array.isArray(profile.education) ? profile.education.map((item) => item.school || item.name).filter(Boolean).join(', ') : null,
    fit_score: scoring.fit_score,
    fit_grade: scoring.fit_grade,
    fit_rationale: scoring.fit_rationale,
    pipeline_stage: scoring.fit_score >= 60 ? 'Shortlisted' : 'Sourced',
    enrichment_status: 'Pending',
    source,
    notes: profile.headline || null,
  };
}

async function generateSearchQueries(job) {
  const generated = await callClaude(
    `Generate 3 LinkedIn people search query variations as JSON for this role.\nJob title: ${job.job_title}\nMust-have skills: ${job.tech_stack_must}\nLocation: ${job.location}\nSeniority: ${job.seniority_level}\nSector: ${job.sector}\nRemote policy: ${job.remote_policy}\nReturn {"queries":[{"keywords":"","location":"","network_distance":[1,2]}]}.`,
    'You generate precise LinkedIn recruiter search inputs. Return valid JSON only.',
    { expectJson: true },
  ).then((result) => result.queries || []).catch(() => []);

  if (generated.length) return generated;

  const baseTitle = job.job_title || job.name || 'Recruitment Consultant';
  const mustHaves = String(job.tech_stack_must || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3);
  const seniority = String(job.seniority_level || '').trim();
  const location = String(job.location || '').trim();

  return [
    {
      keywords: [seniority, baseTitle, ...mustHaves].filter(Boolean).join(' '),
      location,
      network_distance: [1, 2],
    },
    {
      keywords: [baseTitle, ...mustHaves].filter(Boolean).join(' '),
      location,
      network_distance: [2, 3],
    },
    {
      keywords: seniority && baseTitle ? `${seniority} ${baseTitle}` : baseTitle,
      location,
      network_distance: [1, 2, 3],
    },
  ];
}

export async function scoreCandidateAgainstJob(candidateProfile, job) {
  const result = await callClaude(
    `Score this candidate for the role and return JSON.\nRole: ${JSON.stringify(job)}\nCandidate: ${JSON.stringify(candidateProfile)}\nScoring criteria:\n- Tech stack match (35)\n- Seniority fit (20)\n- Location/visa fit (15)\n- Sector/domain experience (15)\n- Overall profile quality (15)\nReturn {"fit_score":0-100,"fit_grade":"HOT|WARM|POSSIBLE|ARCHIVE","fit_rationale":""}.`,
    'You are a rigorous recruiting evaluator. Return valid JSON only.',
    { expectJson: true },
  ).catch(() => null);

  const fitScore = Math.max(0, Math.min(100, Math.round(Number(result?.fit_score || 0))));
  const fitGrade = fitScore >= 80 ? 'HOT' : fitScore >= 60 ? 'WARM' : fitScore >= 40 ? 'POSSIBLE' : 'ARCHIVE';
  return {
    fit_score: fitScore,
    fit_grade: result?.fit_grade || fitGrade,
    fit_rationale: result?.fit_rationale || 'No rationale returned',
  };
}

async function getJob(jobOrId) {
  if (typeof jobOrId === 'object') return jobOrId;
  const { data } = await supabase.from('jobs').select('*').eq('id', jobOrId).single();
  return data;
}

export async function sourceCandidatesForJob(jobOrId) {
  const job = await getJob(jobOrId);
  if (!job) return { total: 0, hot: 0, warm: 0 };

  const queries = await generateSearchQueries(job);
  const dedupe = new Map();

  for (const query of queries.slice(0, 3)) {
    // eslint-disable-next-line no-await-in-loop
    const results = await searchLinkedInPeople({
      keywords: query.keywords,
      location: query.location,
      network_distance: query.network_distance || [1, 2],
    });
    // eslint-disable-next-line no-await-in-loop
    await logActivity(job.id, null, 'SEARCH_QUERY_EXECUTED', `Search "${query.keywords || 'Untitled query'}" returned ${(results || []).length} results`, {
      keywords: query.keywords || null,
      location: query.location || null,
      network_distance: query.network_distance || [1, 2],
      result_count: (results || []).length,
    });
    for (const result of results || []) {
      const providerId = result.provider_id || result.id;
      if (providerId && !dedupe.has(providerId) && dedupe.size < 50) {
        dedupe.set(providerId, result);
      }
    }
  }

  const savedCandidates = [];
  for (const result of dedupe.values()) {
    // eslint-disable-next-line no-await-in-loop
    const profile = await getLinkedInProfile(result.provider_id || result.id);
    if (!profile) continue;
    // eslint-disable-next-line no-await-in-loop
    const scoring = await scoreCandidateAgainstJob(profile, job);
    if (scoring.fit_score < 30) continue;

    const candidate = normaliseCandidate({ ...result, ...profile }, job, scoring);
    // eslint-disable-next-line no-await-in-loop
    const { data } = await supabase.from('candidates').upsert(candidate, {
      onConflict: 'job_id,linkedin_provider_id',
    }).select('*').single();
    if (data) {
      savedCandidates.push(data);
      // eslint-disable-next-line no-await-in-loop
      await logActivity(
        job.id,
        data.id,
        data.pipeline_stage === 'Shortlisted' ? 'CANDIDATE_SHORTLISTED' : 'CANDIDATE_SOURCED',
        `${data.name} scored ${data.fit_score || 0} (${data.fit_grade || 'UNKNOWN'}) for ${job.job_title}`,
        {
          fit_score: data.fit_score,
          fit_grade: data.fit_grade,
          pipeline_stage: data.pipeline_stage,
          current_title: data.current_title,
          current_company: data.current_company,
        },
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(1500);
  }

  const hot = savedCandidates.filter((item) => item.fit_grade === 'HOT').length;
  const warm = savedCandidates.filter((item) => item.fit_grade === 'WARM').length;

  if (!savedCandidates.length) {
    await logActivity(job.id, null, 'SEARCH_PIPELINE_EMPTY', `No candidates were saved for ${job.job_title}`, {
      attempted_queries: queries.slice(0, 3),
      deduped_profiles: dedupe.size,
    });
  }

  await logActivity(job.id, null, 'CANDIDATES_SOURCED', `Sourced ${savedCandidates.length} candidates for ${job.job_title}`, {
    total: savedCandidates.length,
    hot,
    warm,
  });

  await sendTelegramMessage(
    getRecruiterChatId(),
    `🔍 Sourced ${savedCandidates.length} candidates for ${job.job_title} - ${hot} HOT, ${warm} WARM`,
  ).catch(() => null);

  return { total: savedCandidates.length, hot, warm };
}

async function extractResumeText(buffer) {
  if (!buffer) return null;
  return extractDocumentData(
    buffer.toString('base64'),
    'application/pdf',
    'Extract the plain text resume content and then return JSON {"text":"..."} with the full extracted text.',
    'You extract resume text from PDF documents. Return valid JSON only.',
    { expectJson: true, maxTokens: 1000 },
  ).then((result) => result.text || null).catch(() => null);
}

export async function sourceFromLinkedInJobPosting(jobOrId) {
  const job = await getJob(jobOrId);
  if (!job?.linkedin_job_posting_id) return [];

  const applicants = await getJobApplicants(job.linkedin_job_posting_id, {});
  const saved = [];

  for (const applicant of applicants || []) {
    // eslint-disable-next-line no-await-in-loop
    const scoring = await scoreCandidateAgainstJob(applicant, job);
    let cvText = null;

    if (['HOT', 'WARM'].includes(scoring.fit_grade) && applicant.applicant_id) {
      // eslint-disable-next-line no-await-in-loop
      const resume = await downloadApplicantResume(applicant.applicant_id);
      // eslint-disable-next-line no-await-in-loop
      cvText = await extractResumeText(resume);
    }

    const candidate = normaliseCandidate(applicant, job, scoring, 'Job Posting Applicant');
    candidate.cv_text = cvText;
    candidate.pipeline_stage = scoring.fit_score >= 60 ? 'Shortlisted' : 'Sourced';

    // eslint-disable-next-line no-await-in-loop
    const { data } = await supabase.from('candidates').upsert(candidate, {
      onConflict: 'job_id,linkedin_provider_id',
    }).select('*').single();
    if (data) saved.push(data);
  }

  await logActivity(job.id, null, 'JOB_APPLICANTS_INGESTED', `Ingested ${saved.length} LinkedIn applicants for ${job.job_title}`, { total: saved.length });
  return saved;
}
