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

export function isWithinSendingWindow(job, now = new Date()) {
  const timezone = job?.timezone || 'Europe/London';
  const activeDays = String(job?.active_days || 'Mon,Tue,Wed,Thu,Fri')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const zoned = getZonedParts(now, timezone);
  if (activeDays.length && !activeDays.includes(zoned.weekday)) {
    return false;
  }

  const currentMinutes = (zoned.hour * 60) + zoned.minute;
  const startMinutes = toMinutes(job?.send_from, '08:00');
  const endMinutes = toMinutes(job?.send_until, '18:00');

  return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}
