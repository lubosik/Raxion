let monitorStarted = false;

export async function processInboundMessage() {
  return null;
}

export function startInboxMonitor() {
  monitorStarted = true;
  console.log('[raxion] inbox monitor ready (polling fallback stubbed; webhook path is primary)');
  return { started: monitorStarted };
}
