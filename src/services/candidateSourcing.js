import supabase from '../db/supabase.js';
import { callClaude, extractDocumentData } from '../integrations/claude.js';
import { searchLinkedInPeople, getLinkedInProfile, getJobApplicants, downloadApplicantResume } from '../integrations/unipile.js';
import { sendTelegramMessage, getRecruiterChatId } from '../integrations/telegram.js';
import { sleep } from '../lib_utils.js';
import { logActivity } from './activityLogger.js';

function normalizeScoreResult(scoreResult) {
  const fitScore = Math.max(0, Math.min(100, Math.round(Number(scoreResult?.fit_score ?? scoreResult?.score ?? 0))));
  const fitGrade = fitScore >= 80 ? 'HOT' : fitScore >= 60 ? 'WARM' : fitScore >= 40 ? 'POSSIBLE' : 'ARCHIVE';

  return {
    fit_score: fitScore,
    fit_grade: scoreResult?.fit_grade || scoreResult?.grade || fitGrade,
    fit_rationale: scoreResult?.fit_rationale || scoreResult?.rationale || scoreResult?.reason || 'No rationale returned',
  };
}

function normaliseCandidate(profile, job, scoring, source = 'LinkedIn Search') {
  const linkedinUrl = profile.profile_url || profile.linkedin_url || (profile.public_identifier ? `https://www.linkedin.com/in/${profile.public_identifier}` : null);
  const yearsExperience = Array.isArray(profile.work_experience)
    ? profile.work_experience.length
    : Number(profile.years_experience || 0) || null;
  const normalizedScore = normalizeScoreResult(scoring);
  const pipelineStage = normalizedScore.fit_score >= 60 ? 'Shortlisted' : normalizedScore.fit_score >= 30 ? 'Sourced' : 'Archived';

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
    fit_score: normalizedScore.fit_score,
    fit_grade: normalizedScore.fit_grade,
    fit_rationale: normalizedScore.fit_rationale,
    pipeline_stage: pipelineStage,
    enrichment_status: 'Pending',
    source,
    notes: profile.headline || null,
  };
}

function stageRank(stage) {
  const ranking = {
    Archived: 0,
    Sourced: 1,
    Shortlisted: 2,
    Enriched: 3,
    invite_sent: 4,
    invite_accepted: 5,
    dm_sent: 6,
    email_sent: 6,
    Replied: 7,
    Qualified: 8,
    Placed: 9,
  };
  return ranking[stage] ?? 0;
}

function mergeCandidateWithExisting(existing, incoming) {
  if (!existing) return incoming;

  const existingScore = Number(existing.fit_score || 0);
  const incomingScore = Number(incoming.fit_score || 0);
  const preserveExistingScore = existingScore > incomingScore;
  const preserveExistingStage = stageRank(existing.pipeline_stage) > stageRank(incoming.pipeline_stage);

  return {
    ...incoming,
    fit_score: preserveExistingScore ? existing.fit_score : incoming.fit_score,
    fit_grade: preserveExistingScore ? existing.fit_grade : incoming.fit_grade,
    fit_rationale: preserveExistingScore ? existing.fit_rationale : incoming.fit_rationale,
    pipeline_stage: preserveExistingStage || preserveExistingScore ? existing.pipeline_stage : incoming.pipeline_stage,
    enrichment_status: existing.enrichment_status || incoming.enrichment_status,
    invite_sent_at: existing.invite_sent_at || incoming.invite_sent_at || null,
    invite_accepted_at: existing.invite_accepted_at || incoming.invite_accepted_at || null,
    dm_sent_at: existing.dm_sent_at || incoming.dm_sent_at || null,
    last_reply_at: existing.last_reply_at || incoming.last_reply_at || null,
    unipile_chat_id: existing.unipile_chat_id || incoming.unipile_chat_id || null,
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

  if (!result) {
    const haystack = [
      candidateProfile.current_title,
      candidateProfile.headline,
      candidateProfile.current_company,
      candidateProfile.skills,
      candidateProfile.tech_skills,
      candidateProfile.summary,
    ].join(' ').toLowerCase();
    const titleTerms = String(job.job_title || '').toLowerCase().split(/\s+/).filter((item) => item.length > 3);
    const skillTerms = String(job.tech_stack_must || '').toLowerCase().split(',').map((item) => item.trim()).filter(Boolean);
    const titleMatches = titleTerms.filter((term) => haystack.includes(term)).length;
    const skillMatches = skillTerms.filter((term) => haystack.includes(term)).length;
    const heuristicScore = Math.min(85, (titleMatches * 18) + (skillMatches * 14));
    const heuristicGrade = heuristicScore >= 80 ? 'HOT' : heuristicScore >= 60 ? 'WARM' : heuristicScore >= 40 ? 'POSSIBLE' : 'ARCHIVE';
    return {
      fit_score: heuristicScore,
      fit_grade: heuristicGrade,
      fit_rationale: heuristicScore ? `Heuristic fallback score based on title/skill matches (${titleMatches} title, ${skillMatches} skill)` : 'Heuristic fallback found no meaningful title or skill overlap',
    };
  }

  return normalizeScoreResult(result);
}

async function getJob(jobOrId) {
  if (typeof jobOrId === 'object') return jobOrId;
  const { data } = await supabase.from('jobs').select('*').eq('id', jobOrId).single();
  return data;
}

async function getActiveDuplicateProviderIds(jobId, providerIds = []) {
  const filteredProviderIds = providerIds.filter(Boolean);
  if (!filteredProviderIds.length) return new Set();

  const { data: activeJobs } = await supabase
    .from('jobs')
    .select('id')
    .eq('status', 'ACTIVE')
    .eq('paused', false)
    .neq('id', jobId);

  const activeJobIds = (activeJobs || []).map((job) => job.id).filter(Boolean);
  if (!activeJobIds.length) return new Set();

  const { data: duplicates } = await supabase
    .from('candidates')
    .select('linkedin_provider_id, job_id, name')
    .in('job_id', activeJobIds)
    .in('linkedin_provider_id', filteredProviderIds);

  return new Set((duplicates || []).map((candidate) => candidate.linkedin_provider_id).filter(Boolean));
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

  const blockedProviderIds = await getActiveDuplicateProviderIds(job.id, Array.from(dedupe.keys()));
  for (const providerId of blockedProviderIds) {
    dedupe.delete(providerId);
  }

  if (blockedProviderIds.size) {
    await logActivity(job.id, null, 'ACTIVE_PIPELINE_DEDUPE', `Skipped ${blockedProviderIds.size} candidates already attached to another active job`, {
      duplicate_provider_ids: Array.from(blockedProviderIds),
    });
  }

  const savedCandidates = [];
  for (const result of dedupe.values()) {
    // eslint-disable-next-line no-await-in-loop
    const profile = await getLinkedInProfile(result.provider_id || result.id);
    const mergedProfile = profile ? { ...result, ...profile } : { ...result };
    if (!profile) {
      // eslint-disable-next-line no-await-in-loop
      await logActivity(job.id, null, 'PROFILE_FALLBACK_USED', `Using search result only for ${result.name || result.full_name || result.id}`, {
        provider_id: result.provider_id || result.id || null,
      });
    }
    // eslint-disable-next-line no-await-in-loop
    const scoring = await scoreCandidateAgainstJob(mergedProfile, job);

    const candidate = normaliseCandidate(mergedProfile, job, scoring);
    // eslint-disable-next-line no-await-in-loop
    const { data: existing } = await supabase
      .from('candidates')
      .select('*')
      .eq('job_id', job.id)
      .eq('linkedin_provider_id', candidate.linkedin_provider_id)
      .maybeSingle();
    const candidatePayload = mergeCandidateWithExisting(existing, candidate);
    // eslint-disable-next-line no-await-in-loop
    const { data } = await supabase.from('candidates').upsert(candidatePayload, {
      onConflict: 'job_id,linkedin_provider_id',
    }).select('*').single();
    if (data) {
      savedCandidates.push(data);
      // eslint-disable-next-line no-await-in-loop
      await logActivity(
        job.id,
        data.id,
        'CANDIDATE_SOURCED',
        `${data.name} sourced with score ${data.fit_score || 0}/100 and stage ${data.pipeline_stage}`,
        {
          fit_score: data.fit_score,
          fit_grade: data.fit_grade,
          pipeline_stage: data.pipeline_stage,
          current_title: data.current_title,
          current_company: data.current_company,
        },
      );
      // eslint-disable-next-line no-await-in-loop
      await logActivity(
        job.id,
        data.id,
        'CANDIDATE_SCORED',
        `${data.name} scored ${data.fit_score || 0}/100`,
        {
          fit_score: data.fit_score,
          fit_grade: data.fit_grade,
          rationale: data.fit_rationale,
          pipeline_stage: data.pipeline_stage,
        },
      );
      if (data.pipeline_stage === 'Archived') {
        // eslint-disable-next-line no-await-in-loop
        await logActivity(job.id, data.id, 'CANDIDATE_ARCHIVED', `${data.name} archived after scoring`, {
          fit_score: data.fit_score,
          fit_grade: data.fit_grade,
          rationale: data.fit_rationale,
        });
      }
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

export async function scoreUnscoredCandidates(jobOrId) {
  const job = await getJob(jobOrId);
  if (!job) return 0;

  const { data: unscored } = await supabase
    .from('candidates')
    .select('*')
    .eq('job_id', job.id)
    .is('fit_score', null)
    .not('pipeline_stage', 'eq', 'Archived')
    .limit(20);

  if (!unscored?.length) return 0;

  await logActivity(job.id, null, 'SCORING', `Scoring ${unscored.length} candidates`, {
    candidate_ids: unscored.map((candidate) => candidate.id),
  });

  for (const candidate of unscored) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const score = await scoreCandidateAgainstJob(candidate, job);
      const pipelineStage = score.fit_score >= 60 ? 'Shortlisted' : score.fit_score >= 30 ? 'Sourced' : 'Archived';

      // eslint-disable-next-line no-await-in-loop
      await supabase.from('candidates').update({
        fit_score: score.fit_score,
        fit_grade: score.fit_grade,
        fit_rationale: score.fit_rationale,
        pipeline_stage: pipelineStage,
      }).eq('id', candidate.id);

      // eslint-disable-next-line no-await-in-loop
      await logActivity(job.id, candidate.id, 'CANDIDATE_SCORED', `${candidate.name || 'Candidate'} scored ${score.fit_score}/100`, {
        fit_score: score.fit_score,
        fit_grade: score.fit_grade,
        rationale: score.fit_rationale,
        pipeline_stage: pipelineStage,
      });

      if (pipelineStage === 'Archived') {
        // eslint-disable-next-line no-await-in-loop
        await logActivity(job.id, candidate.id, 'CANDIDATE_ARCHIVED', `${candidate.name || 'Candidate'} archived after scoring`, {
          fit_score: score.fit_score,
          fit_grade: score.fit_grade,
          rationale: score.fit_rationale,
        });
      }
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      await logActivity(job.id, candidate.id, 'SCORE_ERROR', `Scoring failed: ${error.message}`, {});
    }
  }

  return unscored.length;
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
  const blockedProviderIds = await getActiveDuplicateProviderIds(job.id, (applicants || []).map((applicant) => applicant.provider_id || applicant.id));
  const saved = [];

  for (const applicant of applicants || []) {
    if (blockedProviderIds.has(applicant.provider_id || applicant.id)) {
      // eslint-disable-next-line no-await-in-loop
      await logActivity(job.id, null, 'ACTIVE_PIPELINE_DEDUPE', `Skipped applicant ${applicant.name || applicant.full_name || 'Unknown'} already attached to another active job`, {
        provider_id: applicant.provider_id || applicant.id || null,
      });
      continue;
    }

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
    const { data: existing } = await supabase
      .from('candidates')
      .select('*')
      .eq('job_id', job.id)
      .eq('linkedin_provider_id', candidate.linkedin_provider_id)
      .maybeSingle();
    const candidatePayload = mergeCandidateWithExisting(existing, candidate);

    // eslint-disable-next-line no-await-in-loop
    const { data } = await supabase.from('candidates').upsert(candidatePayload, {
      onConflict: 'job_id,linkedin_provider_id',
    }).select('*').single();
    if (data) saved.push(data);
  }

  await logActivity(job.id, null, 'JOB_APPLICANTS_INGESTED', `Ingested ${saved.length} LinkedIn applicants for ${job.job_title}`, { total: saved.length });
  return saved;
}
