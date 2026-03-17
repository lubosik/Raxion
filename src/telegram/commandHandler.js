import TelegramBot from 'node-telegram-bot-api';
import supabase from '../db/supabase.js';
import { parseJobBrief } from '../services/jobBriefParser.js';
import { sourceCandidatesForJob } from '../services/candidateSourcing.js';
import { runOrchestratorCycle } from '../services/outreachSequencer.js';
import { getRecruiterChatId } from '../integrations/telegram.js';
import { approveQueuedMessage, editQueuedMessage, skipQueuedMessage } from '../services/approvalService.js';
import { deleteCandidateData } from '../services/gdprService.js';
import { normalizeJobRecord, prepareJobPayload } from '../services/dbCompat.js';

let bot;

async function handleBriefCommand(chatId, text) {
  const rawText = text.replace(/^\/brief\s*/i, '').trim();
  const job = await parseJobBrief(rawText);
  await bot.sendMessage(chatId, `🧾 Job created\nRole: ${job.job_title}\nClient: ${job.client_name || 'Unknown'}\nLocation: ${job.location || 'Unknown'}\nStarting sourcing now...`);
  const summary = await sourceCandidatesForJob(job.id);
  await bot.sendMessage(chatId, `✅ Sourcing finished\nCandidates found: ${summary.total}\nHOT: ${summary.hot}\nWARM: ${summary.warm}`);
}

async function handleStatusCommand(chatId) {
  const [{ data: jobs }, { count: candidates }, { count: invites }, { count: replies }, { count: interviews }] = await Promise.all([
    supabase.from('jobs').select('*').eq('status', 'ACTIVE'),
    supabase.from('candidates').select('*', { count: 'exact', head: true }),
    supabase.from('candidates').select('*', { count: 'exact', head: true }).not('invite_sent_at', 'is', null),
    supabase.from('candidates').select('*', { count: 'exact', head: true }).not('last_reply_at', 'is', null),
    supabase.from('candidates').select('*', { count: 'exact', head: true }).not('interview_booked_at', 'is', null),
  ]);
  const lines = (jobs || []).map((job) => {
    const normalized = normalizeJobRecord(job);
    return `• ${normalized.job_title} at ${normalized.client_name} (${normalized.paused ? 'Paused' : normalized.status})`;
  });
  await bot.sendMessage(chatId, `📊 Raxion status\nActive jobs: ${jobs?.length || 0}\nCandidates: ${candidates || 0}\nInvites sent: ${invites || 0}\nReplies: ${replies || 0}\nInterviews booked: ${interviews || 0}\n${lines.join('\n') || 'No active jobs.'}`);
}

async function handleJobCommand(chatId, text) {
  const jobId = text.replace(/^\/job\s*/i, '').trim();
  const { data: rawJob } = await supabase.from('jobs').select('*').eq('id', jobId).maybeSingle();
  const job = normalizeJobRecord(rawJob);
  if (!job) return bot.sendMessage(chatId, 'No matching job found.');
  const { data: candidates } = await supabase.from('candidates').select('pipeline_stage').eq('job_id', job.id);
  const counts = (candidates || []).reduce((acc, item) => {
    acc[item.pipeline_stage] = (acc[item.pipeline_stage] || 0) + 1;
    return acc;
  }, {});
  await bot.sendMessage(chatId, `💼 ${job.job_title}\nClient: ${job.client_name}\nStatus: ${job.status}\nSourced: ${counts.Sourced || 0}\nShortlisted: ${counts.Shortlisted || 0}\nInvites sent: ${counts.invite_sent || 0}\nReplies: ${counts.Replied || 0}\nQualified: ${counts.Qualified || 0}`);
}

export function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const recruiterChatId = getRecruiterChatId();
  if (!token || !recruiterChatId) {
    console.warn('[raxion] telegram disabled: missing token or chat id');
    return null;
  }

  bot = new TelegramBot(token, { polling: true });

  bot.on('message', async (message) => {
    const chatId = String(message.chat.id);
    if (chatId !== String(recruiterChatId) || !message.text) return;

    try {
      if (message.text.startsWith('/brief')) return handleBriefCommand(chatId, message.text);
      if (message.text === '/status') return handleStatusCommand(chatId);
      if (message.text.startsWith('/approve_')) return approveQueuedMessage(message.text.replace('/approve_', '').trim()).then(() => bot.sendMessage(chatId, 'Approved and queued for the next sending window.'));
      if (message.text.startsWith('/edit_')) {
        const [approvalId, ...rest] = message.text.replace('/edit_', '').trim().split(' ');
        await editQueuedMessage(approvalId, rest.join(' '));
        return bot.sendMessage(chatId, 'Approval message updated.');
      }
      if (message.text.startsWith('/skip_')) return skipQueuedMessage(message.text.replace('/skip_', '').trim()).then(() => bot.sendMessage(chatId, 'Skipped.'));
      if (message.text === '/pause') {
        await supabase.from('jobs').update(await prepareJobPayload({ paused: true, paused_until: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), status: 'PAUSED' })).not('id', 'is', null);
        return bot.sendMessage(chatId, '⏸ Sequencer paused');
      }
      if (message.text === '/resume') {
        await supabase.from('jobs').update(await prepareJobPayload({ paused: false, paused_until: null, status: 'ACTIVE' })).eq('status', 'PAUSED');
        await runOrchestratorCycle().catch(() => null);
        return bot.sendMessage(chatId, '▶️ Sequencer resumed');
      }
      if (message.text.startsWith('/job ')) return handleJobCommand(chatId, message.text);
      if (message.text.startsWith('/delete_candidate ')) {
        const parts = message.text.replace('/delete_candidate ', '').split(' ');
        const candidateId = parts.shift();
        const reason = parts.join(' ') || 'Deleted from Telegram';
        const result = await deleteCandidateData(candidateId, reason, 'recruiter');
        return bot.sendMessage(chatId, result?.success ? `Deleted ${result.candidate_name}` : 'Candidate not found.');
      }
    } catch (error) {
      await bot.sendMessage(chatId, '⚠️ Command failed');
    }
  });

  return bot;
}
