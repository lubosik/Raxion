import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import supabase from './src/db/supabase.js';
import { createUnipileWebhookRouter } from './src/webhooks/unipileWebhooks.js';
import { createDashboardServer } from './src/dashboard/server.js';
import { startTelegramBot } from './src/telegram/commandHandler.js';
import { startInboxMonitor } from './src/inboxMonitor.js';
import { runOrchestratorCycle } from './src/services/outreachSequencer.js';
import { sendTelegramMessage, getRecruiterChatId } from './src/integrations/telegram.js';
import { logError } from './src/lib_errors.js';
import { setupWebhooks } from './src/integrations/unipile.js';
import { ensureSchemaReady } from './src/services/schemaService.js';

const port = Number(process.env.PORT || 3001);
const app = express();

app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));
app.use(express.urlencoded({ extended: true }));

app.use('/webhooks/unipile', createUnipileWebhookRouter());
app.use(createDashboardServer());

async function testSupabase() {
  const { error } = await supabase.from('raxion_settings').select('key').limit(1);
  if (error) throw error;
}

function registerCronJobs() {
  cron.schedule('*/15 * * * *', async () => {
    try {
      await runOrchestratorCycle();
      console.log('[raxion] orchestrator cycle complete');
    } catch (error) {
      await logError('index.sequencerCron', error, 'critical');
    }
  });

  cron.schedule('0 20 * * *', async () => {
    try {
      const [{ count: invites }, { count: accepts }, { count: replies }, { count: qualified }, { count: interviews }] = await Promise.all([
        supabase.from('candidates').select('*', { count: 'exact', head: true }).not('invite_sent_at', 'is', null),
        supabase.from('candidates').select('*', { count: 'exact', head: true }).not('invite_accepted_at', 'is', null),
        supabase.from('candidates').select('*', { count: 'exact', head: true }).not('last_reply_at', 'is', null),
        supabase.from('candidates').select('*', { count: 'exact', head: true }).eq('pipeline_stage', 'Qualified'),
        supabase.from('candidates').select('*', { count: 'exact', head: true }).not('interview_booked_at', 'is', null),
      ]);
      await sendTelegramMessage(getRecruiterChatId(), `📊 Daily summary\nInvites sent: ${invites || 0}\nAcceptances: ${accepts || 0}\nReplies: ${replies || 0}\nQualified: ${qualified || 0}\nInterviews booked: ${interviews || 0}`);
    } catch (error) {
      await logError('index.resetCron', error, 'error');
    }
  });
}

async function bootstrap() {
  try {
    await testSupabase();
    await ensureSchemaReady();
    await setupWebhooks();
    startTelegramBot();
    startInboxMonitor();
    registerCronJobs();

    app.listen(port, async () => {
      console.log(`🤖 Raxion online. Sequencer active. Listening for webhooks. Port ${port}`);
      setTimeout(() => {
        runOrchestratorCycle().catch((error) => {
          console.error('[raxion] startup orchestrator failed', error);
        });
      }, 30000);
      try {
        await sendTelegramMessage(getRecruiterChatId(), '🤖 Raxion online. Sequencer active. Listening for webhooks.');
      } catch (error) {
        console.error('[raxion] telegram startup notification failed', error);
      }
    });
  } catch (error) {
    await logError('index.bootstrap', error, 'critical');
    process.exit(1);
  }
}

bootstrap();
