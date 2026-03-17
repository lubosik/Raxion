import { parseTemplates } from './outreachTemplates.js';

function getZonedParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'UTC',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: lookup.weekday,
    hour: Number(lookup.hour || 0),
    minute: Number(lookup.minute || 0),
  };
}

function toMinutes(value, fallback) {
  const source = String(value || fallback || '').trim();
  const match = source.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return 0;
  return (Number(match[1]) * 60) + Number(match[2]);
}

export function getChannelWindow(job, channel = 'default') {
  const templates = parseTemplates(job?.outreach_templates);
  const scheduleWindows = templates.schedule_windows || {};
  const channelWindow = scheduleWindows[channel] || {};

  return {
    send_from: channelWindow.send_from || job?.send_from || '08:00',
    send_until: channelWindow.send_until || job?.send_until || '18:00',
    timezone: channelWindow.timezone || job?.timezone || 'Europe/London',
    active_days: channelWindow.active_days || job?.active_days || 'Mon,Tue,Wed,Thu,Fri',
  };
}

export function isWithinSendingWindow(job, now = new Date(), channel = 'default') {
  const window = getChannelWindow(job, channel);
  const activeDays = String(window.active_days || 'Mon,Tue,Wed,Thu,Fri')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const zoned = getZonedParts(now, window.timezone);
  if (activeDays.length && !activeDays.includes(zoned.weekday)) {
    return false;
  }

  const currentMinutes = (zoned.hour * 60) + zoned.minute;
  const startMinutes = toMinutes(window.send_from, '08:00');
  const endMinutes = toMinutes(window.send_until, '18:00');

  return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}
