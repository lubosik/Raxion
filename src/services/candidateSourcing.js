import supabase from '../db/supabase.js';
import { callClaude, extractDocumentData } from '../integrations/claude.js';
import { searchLinkedInPeople, getLinkedInProfile, getJobApplicants, downloadApplicantResume } from '../integrations/unipile.js';
import { sendTelegramMessage, getRecruiterChatId } from '../integrations/telegram.js';
import { sleep } from '../lib_utils.js';
import { logActivity } from './activityLogger.js';
import { normalizeJobRecord } from './dbCompat.js';
import { getRuntimeConfigValue } from './configService.js';

let scoreHistoryColumnsSupported;

const GENERIC_TITLE_TERMS = new Set([
  'agent',
  'consultant',
  'manager',
  'executive',
  'specialist',
  'associate',
  'advisor',
  'lead',
  'head',
  'director',
  'senior',
  'junior',
  'principal',
  'staff',
  'remote',
  'hybrid',
  'onsite',
  'full',
  'time',
]);

const DISQUALIFYING_JUNIOR_TERMS = [
  'student',
  'intern',
  'undergraduate',
  'college',
  'university',
  'graduate student',
  'high school',
  'entry level',
  'trainee',
];

const ROLE_SIGNAL_RULES = [
  {
    matches: ['real estate', 'estate agent', 'realtor', 'property'],
    requireAny: ['real estate', 'realtor', 'estate agent', 'property', 'broker', 'brokerage', 'leasing', 'lettings', 'mortgage'],
  },
  {
    matches: ['recruit', 'talent acquisition', 'headhunt', 'sourcer'],
    requireAny: ['recruit', 'recruiter', 'recruitment', 'talent acquisition', 'headhunter', 'sourcer', 'staffing'],
  },
  {
    matches: ['software engineer', 'developer', 'backend', 'frontend', 'full stack'],
    requireAny: ['software', 'engineer', 'developer', 'backend', 'frontend', 'full stack', 'javascript', 'node', 'react', 'python'],
  },
];

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
    latest_fit_score: normalizedScore.fit_score,
    latest_fit_grade: normalizedScore.fit_grade,
    latest_fit_rationale: normalizedScore.fit_rationale,
    latest_scored_at: new Date().toISOString(),
    best_scored_at: new Date().toISOString(),
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
  const preserveExistingBestScore = existingScore > incomingScore;
  const preserveExistingStage = stageRank(existing.pipeline_stage) > stageRank(incoming.pipeline_stage);

  return {
    ...incoming,
    latest_fit_score: incoming.fit_score,
    latest_fit_grade: incoming.fit_grade,
    latest_fit_rationale: incoming.fit_rationale,
    latest_scored_at: incoming.latest_scored_at || new Date().toISOString(),
    fit_score: preserveExistingBestScore ? existing.fit_score : incoming.fit_score,
    fit_grade: preserveExistingBestScore ? existing.fit_grade : incoming.fit_grade,
    fit_rationale: preserveExistingBestScore ? existing.fit_rationale : incoming.fit_rationale,
    best_scored_at: preserveExistingBestScore ? (existing.best_scored_at || existing.created_at || new Date().toISOString()) : (incoming.latest_scored_at || new Date().toISOString()),
    pipeline_stage: preserveExistingStage || preserveExistingBestScore ? existing.pipeline_stage : incoming.pipeline_stage,
    enrichment_status: existing.enrichment_status || incoming.enrichment_status,
    invite_sent_at: existing.invite_sent_at || incoming.invite_sent_at || null,
    invite_accepted_at: existing.invite_accepted_at || incoming.invite_accepted_at || null,
    dm_sent_at: existing.dm_sent_at || incoming.dm_sent_at || null,
    last_reply_at: existing.last_reply_at || incoming.last_reply_at || null,
    unipile_chat_id: existing.unipile_chat_id || incoming.unipile_chat_id || null,
  };
}

function latestDiffersFromBest(candidate) {
  return candidate?.latest_fit_score != null
    && (
      Number(candidate.latest_fit_score) !== Number(candidate.fit_score || 0)
      || String(candidate.latest_fit_grade || '') !== String(candidate.fit_grade || '')
      || String(candidate.latest_fit_rationale || '') !== String(candidate.fit_rationale || '')
    );
}

function stripScoreHistoryFields(candidate) {
  const {
    latest_fit_score,
    latest_fit_grade,
    latest_fit_rationale,
    latest_scored_at,
    best_scored_at,
    ...legacyCandidate
  } = candidate;

  return legacyCandidate;
}

async function supportsScoreHistoryColumns() {
  if (typeof scoreHistoryColumnsSupported === 'boolean') return scoreHistoryColumnsSupported;

  const { error } = await supabase.from('candidates').select('latest_fit_score').limit(1);
  scoreHistoryColumnsSupported = !error;
  return scoreHistoryColumnsSupported;
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toSearchableText(...parts) {
  return parts
    .flat()
    .map((value) => compactText(value))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueTerms(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function extractMinYears(job) {
  const explicit = Number(job.years_experience_min || job.min_years_experience || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const haystack = toSearchableText(job.job_title, job.full_job_description, job.candidate_profile);
  const plusMatch = haystack.match(/(\d+)\s*\+\s*years?/);
  if (plusMatch) return Number(plusMatch[1]);
  const rangeMatch = haystack.match(/(\d+)\s*[-to]{1,3}\s*(\d+)\s*years?/);
  if (rangeMatch) return Number(rangeMatch[1]);
  return 0;
}

function deriveRequiredSignals(job) {
  const haystack = toSearchableText(job.job_title, job.sector, job.tech_stack_must, job.candidate_profile, job.full_job_description);
  for (const rule of ROLE_SIGNAL_RULES) {
    if (rule.matches.some((term) => haystack.includes(term))) {
      return rule.requireAny;
    }
  }

  const titleTerms = String(job.job_title || '')
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4 && !GENERIC_TITLE_TERMS.has(term));

  const mustHaveTerms = splitCsv(job.tech_stack_must)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3);

  return uniqueTerms([...titleTerms.slice(0, 4), ...mustHaveTerms.slice(0, 4)]);
}

function buildJobSearchProfile(job) {
  const minimumYears = extractMinYears(job);
  const requiredSignals = deriveRequiredSignals(job);
  const searchGuidance = compactText(getRuntimeConfigValue('RAXION_SOURCING_SEARCH_GUIDANCE', ''));
  const scoringGuidance = compactText(getRuntimeConfigValue('RAXION_SCORING_GUIDANCE', ''));
  const seniorityText = compactText(job.seniority_level || '');
  const isSeniorRole = minimumYears >= 5 || /\b(senior|lead|principal|director|head)\b/i.test(seniorityText) || /\b(senior|lead|principal|director|head)\b/i.test(job.job_title || '');

  return {
    minimumYears,
    requiredSignals,
    isSeniorRole,
    searchGuidance,
    scoringGuidance,
  };
}

function buildCandidateHaystack(profile) {
  return toSearchableText(
    profile.name,
    profile.current_title,
    profile.headline,
    profile.summary,
    profile.current_company,
    profile.location,
    profile.skills,
    profile.tech_skills,
    profile.work_experience?.map((item) => `${item.title || ''} ${item.company || ''}`),
    profile.education?.map((item) => `${item.school || item.name || ''} ${item.degree || ''}`),
  );
}

function evaluateCandidateRelevance(profile, job) {
  const searchProfile = buildJobSearchProfile(job);
  const haystack = buildCandidateHaystack(profile);
  const yearsExperience = Number(profile.years_experience || (Array.isArray(profile.work_experience) ? profile.work_experience.length : 0) || 0);
  const juniorMarker = DISQUALIFYING_JUNIOR_TERMS.find((term) => haystack.includes(term));

  if (searchProfile.isSeniorRole && juniorMarker && yearsExperience < Math.max(3, searchProfile.minimumYears)) {
    return {
      accepted: false,
      reason: `Rejected as likely junior profile due to "${juniorMarker}" for a senior role`,
    };
  }

  if (searchProfile.minimumYears >= 5 && yearsExperience > 0 && yearsExperience < searchProfile.minimumYears) {
    return {
      accepted: false,
      reason: `Rejected for insufficient experience (${yearsExperience} years vs ${searchProfile.minimumYears}+ required)`,
    };
  }

  if (searchProfile.requiredSignals.length) {
    const matchedSignals = searchProfile.requiredSignals.filter((term) => haystack.includes(term.toLowerCase()));
    if (!matchedSignals.length) {
      return {
        accepted: false,
        reason: `Rejected for missing required role signals (${searchProfile.requiredSignals.slice(0, 4).join(', ')})`,
      };
    }

    return {
      accepted: true,
      matchedSignals,
      reason: `Matched role signals: ${matchedSignals.join(', ')}`,
    };
  }

  return {
    accepted: true,
    matchedSignals: [],
    reason: 'Accepted by default relevance filter',
  };
}

async function generateSearchQueries(job) {
  const searchProfile = buildJobSearchProfile(job);
  const generated = await callClaude(
    `Generate 3 LinkedIn people search query variations as JSON for this exact role only.
Ignore all previous jobs, previous candidates, and any outside context. Use only the job data in this prompt.
Role must-haves:
- Job title: ${job.job_title}
- Must-have skills: ${job.tech_stack_must}
- Location: ${job.location}
- Seniority: ${job.seniority_level}
- Sector: ${job.sector}
- Remote policy: ${job.remote_policy}
- Minimum years experience: ${searchProfile.minimumYears || 'not explicitly specified'}
- Required role signals: ${searchProfile.requiredSignals.join(', ') || 'none'}
- Reject junior/student/intern profiles: ${searchProfile.isSeniorRole ? 'yes' : 'only if clearly irrelevant'}
${searchProfile.searchGuidance ? `- Client-specific search guidance: ${searchProfile.searchGuidance}` : ''}
Return {"queries":[{"keywords":"","location":"","network_distance":[1,2]}]}.`,
    'You generate precise LinkedIn recruiter search inputs. Use only the current role. Do not generalize from prior jobs. Exclude obviously irrelevant, junior, student, or cross-domain results unless the role explicitly asks for them. Return valid JSON only.',
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
  const roleSignals = searchProfile.requiredSignals.slice(0, 3);
  const yearsHint = searchProfile.minimumYears >= 5 ? `${searchProfile.minimumYears}+ years` : '';

  return [
    {
      keywords: [seniority, baseTitle, ...roleSignals, ...mustHaves, yearsHint].filter(Boolean).join(' '),
      location,
      network_distance: [1, 2],
    },
    {
      keywords: [baseTitle, ...roleSignals, ...mustHaves].filter(Boolean).join(' '),
      location,
      network_distance: [2, 3],
    },
    {
      keywords: [seniority && baseTitle ? `${seniority} ${baseTitle}` : baseTitle, ...roleSignals].filter(Boolean).join(' '),
      location,
      network_distance: [1, 2, 3],
    },
  ];
}

export async function scoreCandidateAgainstJob(candidateProfile, job) {
  const searchProfile = buildJobSearchProfile(job);
  const result = await callClaude(
    `Score this candidate for this exact role only and return JSON.
Ignore every other job, previous search, previous candidate, and any outside context.
Role: ${JSON.stringify(job)}
Candidate: ${JSON.stringify(candidateProfile)}
Critical requirements:
- Minimum years experience: ${searchProfile.minimumYears || 'not explicitly specified'}
- Required role signals: ${searchProfile.requiredSignals.join(', ') || 'none'}
- Treat obvious students, interns, or adjacent-but-wrong-domain candidates as ARCHIVE for senior roles unless the role explicitly asks for junior talent.
${searchProfile.scoringGuidance ? `- Client-specific scoring guidance: ${searchProfile.scoringGuidance}` : ''}
Scoring criteria:
- Must-have/domain fit (40)
- Seniority and years experience fit (25)
- Location/market fit (15)
- Profile quality and credibility (20)
Return {"fit_score":0-100,"fit_grade":"HOT|WARM|POSSIBLE|ARCHIVE","fit_rationale":""}.`,
    'You are a rigorous recruiting evaluator. Use only the current role and current candidate. If the candidate is clearly outside the required domain or far below the role seniority, score harshly and return ARCHIVE. Return valid JSON only.',
    { expectJson: true },
  ).catch(() => null);

  if (!result) {
    const haystack = buildCandidateHaystack(candidateProfile);
    const titleTerms = String(job.job_title || '').toLowerCase().split(/\s+/).filter((item) => item.length > 3);
    const skillTerms = String(job.tech_stack_must || '').toLowerCase().split(',').map((item) => item.trim()).filter(Boolean);
    const titleMatches = titleTerms.filter((term) => haystack.includes(term)).length;
    const skillMatches = skillTerms.filter((term) => haystack.includes(term)).length;
    const matchedSignals = searchProfile.requiredSignals.filter((term) => haystack.includes(term));
    const juniorPenalty = searchProfile.isSeniorRole && DISQUALIFYING_JUNIOR_TERMS.some((term) => haystack.includes(term)) ? 35 : 0;
    const experiencePenalty = searchProfile.minimumYears >= 5
      && Number(candidateProfile.years_experience || 0) > 0
      && Number(candidateProfile.years_experience || 0) < searchProfile.minimumYears
      ? 25
      : 0;
    const heuristicScore = Math.max(0, Math.min(85, (titleMatches * 16) + (skillMatches * 14) + (matchedSignals.length * 18) - juniorPenalty - experiencePenalty));
    const heuristicGrade = heuristicScore >= 80 ? 'HOT' : heuristicScore >= 60 ? 'WARM' : heuristicScore >= 40 ? 'POSSIBLE' : 'ARCHIVE';
    return {
      fit_score: heuristicScore,
      fit_grade: heuristicGrade,
      fit_rationale: heuristicScore
        ? `Heuristic fallback score based on title/skill/domain overlap (${titleMatches} title, ${skillMatches} skill, ${matchedSignals.length} domain)`
        : 'Heuristic fallback found no meaningful title, skill, or domain overlap',
    };
  }

  return normalizeScoreResult(result);
}

async function getJob(jobOrId) {
  if (typeof jobOrId === 'object') return normalizeJobRecord(jobOrId);
  const { data } = await supabase.from('jobs').select('*').eq('id', jobOrId).single();
  return normalizeJobRecord(data);
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
  const hasScoreHistory = await supportsScoreHistoryColumns();

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
    const relevance = evaluateCandidateRelevance(mergedProfile, job);
    if (!relevance.accepted) {
      // eslint-disable-next-line no-await-in-loop
      await logActivity(job.id, null, 'SEARCH_RESULT_REJECTED', `${mergedProfile.name || result.name || 'Candidate'} rejected before save: ${relevance.reason}`, {
        provider_id: mergedProfile.provider_id || result.provider_id || result.id || null,
        current_title: mergedProfile.current_title || mergedProfile.headline || null,
        current_company: mergedProfile.current_company || null,
        reason: relevance.reason,
      });
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
      continue;
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
    const candidatePayload = hasScoreHistory
      ? mergeCandidateWithExisting(existing, candidate)
      : stripScoreHistoryFields(mergeCandidateWithExisting(existing, candidate));
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
        latestDiffersFromBest(data)
          ? `${data.name} re-sourced at ${data.latest_fit_score || 0}/100; best remains ${data.fit_score || 0}/100 (${data.pipeline_stage})`
          : `${data.name} sourced with score ${data.fit_score || 0}/100 and stage ${data.pipeline_stage}`,
        {
          fit_score: data.fit_score,
          fit_grade: data.fit_grade,
          latest_fit_score: data.latest_fit_score,
          latest_fit_grade: data.latest_fit_grade,
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
        latestDiffersFromBest(data)
          ? `${data.name} re-scored ${data.latest_fit_score || 0}/100; best remains ${data.fit_score || 0}/100`
          : `${data.name} scored ${data.fit_score || 0}/100`,
        {
          fit_score: data.fit_score,
          fit_grade: data.fit_grade,
          latest_fit_score: data.latest_fit_score,
          latest_fit_grade: data.latest_fit_grade,
          latest_rationale: data.latest_fit_rationale,
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
  const hasScoreHistory = await supportsScoreHistoryColumns();

  let query = supabase
    .from('candidates')
    .select('*')
    .eq('job_id', job.id)
    .not('pipeline_stage', 'eq', 'Archived')
    .limit(20);

  query = hasScoreHistory ? query.is('latest_fit_score', null) : query.is('fit_score', null);
  const { data: unscored } = await query;

  if (!unscored?.length) return 0;

  await logActivity(job.id, null, 'SCORING', `Scoring ${unscored.length} candidates`, {
    candidate_ids: unscored.map((candidate) => candidate.id),
  });

  for (const candidate of unscored) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const score = await scoreCandidateAgainstJob(candidate, job);
      const pipelineStage = score.fit_score >= 60 ? 'Shortlisted' : score.fit_score >= 30 ? 'Sourced' : 'Archived';
      const now = new Date().toISOString();

      // eslint-disable-next-line no-await-in-loop
      const updatePayload = {
        fit_score: score.fit_score,
        fit_grade: score.fit_grade,
        fit_rationale: score.fit_rationale,
        pipeline_stage: pipelineStage,
      };

      if (hasScoreHistory) {
        updatePayload.latest_fit_score = score.fit_score;
        updatePayload.latest_fit_grade = score.fit_grade;
        updatePayload.latest_fit_rationale = score.fit_rationale;
        updatePayload.latest_scored_at = now;
        updatePayload.best_scored_at = now;
      }

      await supabase.from('candidates').update(updatePayload).eq('id', candidate.id);

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
  const hasScoreHistory = await supportsScoreHistoryColumns();

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
    const candidatePayload = hasScoreHistory
      ? mergeCandidateWithExisting(existing, candidate)
      : stripScoreHistoryFields(mergeCandidateWithExisting(existing, candidate));

    // eslint-disable-next-line no-await-in-loop
    const { data } = await supabase.from('candidates').upsert(candidatePayload, {
      onConflict: 'job_id,linkedin_provider_id',
    }).select('*').single();
    if (data) saved.push(data);
  }

  await logActivity(job.id, null, 'JOB_APPLICANTS_INGESTED', `Ingested ${saved.length} LinkedIn applicants for ${job.job_title}`, { total: saved.length });
  return saved;
}
