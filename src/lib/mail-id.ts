function pad(num: number, size: number) {
  return num.toString().padStart(size, "0");
}

function formatDate(date: Date) {
  const yyyy = date.getUTCFullYear();
  const mm = pad(date.getUTCMonth() + 1, 2);
  const dd = pad(date.getUTCDate(), 2);
  return `${yyyy}${mm}${dd}`;
}

export function buildMrid(sequence: number, now = new Date()) {
  return `ROSMAIL${formatDate(now)}${pad(sequence, 3)}`;
}

export function buildDrid(mrid: string, sequence: number, now = new Date()) {
  return `ROSDOC${formatDate(now)}${mrid}${pad(sequence, 2)}`;
}
