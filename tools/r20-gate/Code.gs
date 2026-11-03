/**
 * @OnlyCurrentDoc  Limits the script to this one spreadsheet, not all of your Drive.
 */
/* Personality Generator: download sign-ups (Google Apps Script, bound to a Sheet).

   Before downloading, a visitor gives their name and email. This script records
   the sign-up and every download as a row in the sheet: date, name, email,
   fixture, file, download. It sends no email and touches nothing but this sheet.

   Set up:
     1. Create a Google Sheet (any name). Extensions → Apps Script.
     2. Replace everything in Code.gs with this file. Save.
     3. Deploy → New deployment → type Web app.
        Execute as: Me.  Who has access: Anyone.  Deploy, then allow access
        (Google warns because it's your own unverified script: Advanced →
        Go to project → Allow).
     4. Copy the Web app URL (https://script.google.com/macros/s/…/exec) into
        R20_GATE_URL in trilitlabs.html.
   After changing this file later: Deploy → Manage deployments → edit →
   Version: New version, so the same URL keeps working. */

const SHEET_NAME = 'Downloads';
const HEADER = ['Date', 'Name', 'Email', 'Fixture', 'File', 'Download'];
const PER_EMAIL = 40;        // rows per email every 6 hours, to keep floods out of the sheet
const PER_DAY = 3000;        // rows per day in all

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'Bad request.' }); }
  if (req.action !== 'log') return out({ ok: false, error: 'Unknown action.' });

  const name = String(req.name || '').replace(/\s+/g, ' ').trim();
  const email = String(req.email || '').trim().toLowerCase();
  if (name.length < 2) return out({ ok: false, error: 'Enter your name.' });
  if (!validEmail(email)) return out({ ok: false, error: 'Enter a valid email address.' });

  const cache = CacheService.getScriptCache();
  const n = Number(cache.get('rows:' + email) || 0);
  const day = 'day:' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  const all = Number(cache.get(day) || 0);
  if (n >= PER_EMAIL || all >= PER_DAY) return out({ ok: true });   // ignore floods, quietly
  cache.put('rows:' + email, String(n + 1), 6 * 3600);
  cache.put(day, String(all + 1), 6 * 3600);

  sheet().appendRow([new Date(), clip(name), email, clip(req.fixture), clip(req.file), clip(req.kind)]);
  return out({ ok: true });
}

/* the Downloads tab, created on first use; an older tab without a Name
   column gets one, so earlier rows stay lined up */
function sheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(SHEET_NAME); sh.appendRow(HEADER); sh.setFrozenRows(1); return sh; }
  if (sh.getRange(1, 2).getValue() !== 'Name') { sh.insertColumnBefore(2); sh.getRange(1, 2).setValue('Name'); }
  return sh;
}

function validEmail(s) { return s.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[a-z]{2,}$/i.test(s); }
function clip(v) { return String(v || '').slice(0, 120).replace(/^[=+\-@]/, "'$&"); }   // no formulas from visitors
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
