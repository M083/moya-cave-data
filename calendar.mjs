export const SLOT_COUNT = 32;
export function dayNumber(date) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Expected YYYY-MM-DD');
  const time=Date.parse(date+'T00:00:00Z');
  if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==date) throw new Error('Invalid calendar date');
  return time/86400000;
}
export function slotForDate(date) { return ((dayNumber(date)%SLOT_COUNT)+SLOT_COUNT)%SLOT_COUNT; }
export function addDays(date, days) { return new Date((dayNumber(date)+days)*86400000).toISOString().slice(0,10); }
export function todayJst(utc=new Date()) { return new Date(utc.valueOf()+9*3600000).toISOString().slice(0,10); }
export function slotPath(releaseId,date) {
  if(!/^[0-9a-f]{16}$/.test(releaseId)) throw new Error('Invalid release ID');
  return `releases/${releaseId}/slots/${String(slotForDate(date)).padStart(2,'0')}.cave`;
}
