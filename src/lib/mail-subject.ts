/**
 * Parse SOP subject: "MRID | DRID | Physical Mail Scan"
 * MRID: ROSMAIL + YYYYMMDD + 3-digit sequence
 * DRID: ROSDOC + YYYYMMDD + MRID + 2-digit doc sequence
 */
const MRID_RE = /^ROSMAIL\d{11}$/;
const DRID_RE = /^ROSDOC\d{8}ROSMAIL\d{11}\d{2}$/;

export function parseMridDridFromSubject(subject: string): {
  mrid: string | null;
  drid: string | null;
} {
  const raw = subject.trim();
  const parts = raw.split("|").map((p) => p.trim());
  let mrid: string | null = null;
  let drid: string | null = null;
  for (const part of parts) {
    if (!mrid && MRID_RE.test(part)) mrid = part;
    else if (!drid && DRID_RE.test(part)) drid = part;
  }
  return { mrid, drid };
}
