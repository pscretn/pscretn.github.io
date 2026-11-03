/* R20 Personality Generator: email gate (Google Apps Script, bound to a Sheet).

   Before downloading, a visitor enters their email; this script emails them a
   6-digit code from your Gmail, checks the code, and records every download as
   a row in the sheet: date, email, fixture, file.

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
const DAILY_CODE_CAP = 80;          // a free Gmail account can send about 100 a day
const CODE_MINUTES = 10;

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'Bad request.' }); }
  const email = String(req.email || '').trim().toLowerCase();
  if (!validEmail(email)) return out({ ok: false, error: 'Enter a valid email address.' });
  const cache = CacheService.getScriptCache();

  if (req.action === 'send') {
    if (cache.get('wait:' + email)) return out({ ok: false, error: 'A code was just sent. Wait a minute before asking for another.' });
    const props = PropertiesService.getScriptProperties();
    const day = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
    const sent = Number(props.getProperty('sent:' + day) || 0);
    if (sent >= DAILY_CODE_CAP || MailApp.getRemainingDailyQuota() < 5) return out({ ok: false, error: 'Too many codes sent today. Please try again tomorrow.' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    cache.put('code:' + email, JSON.stringify({ code: code, tries: 0 }), CODE_MINUTES * 60);
    cache.put('wait:' + email, '1', 60);
    props.setProperty('sent:' + day, String(sent + 1));
    MailApp.sendEmail({
      to: email,
      name: 'TrilitLabs',
      subject: 'Your TrilitLabs code: ' + code,
      body: 'Your code for the TrilitLabs R20 Personality Generator is ' + code + '.\n\n' +
            'It works for ' + CODE_MINUTES + ' minutes. If you didn\'t ask for it, ignore this email.\n\n' +
            'TrilitLabs · https://pscretn.com/trilitlabs.html',
    });
    return out({ ok: true });
  }

  if (req.action === 'verify') {
    const raw = cache.get('code:' + email);
    if (!raw) return out({ ok: false, error: 'That code has expired. Send a new one.' });
    const c = JSON.parse(raw);
    if (String(req.code || '').trim() !== c.code) {
      c.tries++;
      if (c.tries >= 5) { cache.remove('code:' + email); return out({ ok: false, error: 'Too many wrong codes. Send a new one.' }); }
      cache.put('code:' + email, JSON.stringify(c), CODE_MINUTES * 60);
      return out({ ok: false, error: 'Wrong code. Check the email and try again.' });
    }
    cache.remove('code:' + email);
    return out({ ok: true, token: tokenFor(email) });
  }

  if (req.action === 'log') {
    if (req.token !== tokenFor(email)) return out({ ok: false, error: 'Not verified.' });
    const n = Number(cache.get('logs:' + email) || 0);
    if (n >= 40) return out({ ok: true });              // ignore floods, quietly
    cache.put('logs:' + email, String(n + 1), 6 * 3600);
    sheet().appendRow([new Date(), email, clip(req.fixture), clip(req.file), clip(req.kind)]);
    return out({ ok: true });
  }

  return out({ ok: false, error: 'Unknown action.' });
}

/* a token only this script can make, so a verified browser can log downloads
   later without another code */
function tokenFor(email) {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('secret');
  if (!secret) { secret = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('secret', secret); }
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(email, secret));
}

function sheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(SHEET_NAME); sh.appendRow(['Date', 'Email', 'Fixture', 'File', 'Download']); sh.setFrozenRows(1); }
  return sh;
}

function validEmail(s) { return s.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[a-z]{2,}$/i.test(s); }
function clip(v) { return String(v || '').slice(0, 120).replace(/^[=+\-@]/, "'$&"); }   // no formulas from visitors
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
