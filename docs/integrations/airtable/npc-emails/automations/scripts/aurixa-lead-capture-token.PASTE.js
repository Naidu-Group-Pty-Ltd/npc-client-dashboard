// PASTE-READY — Aurixa Lead Capture, script 1 of 2 (wflEQ1wsJH1x7GQhL)
// Goes after the email node `wacuQvJSp0tGlWStY`.
// Input variables to declare in the UI:
//   recordId  -> the TRIGGER record's Airtable record ID
//
// DEFECT 3 FIXED. The source generated this token with Math.random(), while its
// own comment called it "secure, pseudo-random". It is not: Math.random() is not
// a CSPRNG, and this token is what gates the Stage-2 questionnaire URL — so a
// guessable token is a guessable door.
//
// Only the ENTROPY SOURCE changed. The alphabet, the length, the hand-rolled
// URL-safe base64 transform and therefore the token's shape and the minted URL
// are all exactly as before, so nothing downstream sees a different format.
//
// TEST-RUN THIS IN THE UI BEFORE ENABLING. If Airtable's scripting sandbox does
// not expose `crypto.getRandomValues`, line 1 throws with a clear message rather
// than silently falling back to a weak token. If it throws, do not swap
// Math.random() back in — say so, and the token check moves server-side instead.

function randomIndices(count, modulo) {
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
        throw new Error(
            'crypto.getRandomValues is unavailable in this scripting runtime. ' +
            'Do NOT substitute Math.random() — this token gates the Stage-2 URL. ' +
            'Raise it so the token can be validated server-side instead.'
        );
    }
    // Rejection sampling: a plain % would bias the low indices of the alphabet.
    const out = [];
    const limit = Math.floor(256 / modulo) * modulo;
    const buf = new Uint8Array(count * 2);
    while (out.length < count) {
        crypto.getRandomValues(buf);
        for (let i = 0; i < buf.length && out.length < count; i++) {
            if (buf[i] < limit) out.push(buf[i] % modulo);
        }
    }
    return out;
}

// 1. Fetch table context
let table = base.getTable("Aurixa Waitlist");

// 2. Get the record ID from the automation environment
let config = input.config();
let recordId = config.recordId;

// 3. Generate a 16-character random sequence (now from a CSPRNG)
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
let rawString = '';
for (const idx of randomIndices(16, chars.length)) {
    rawString += chars.charAt(idx);
}

// 4. Convert the sequence to a URL-safe Base64 string manually (bypassing btoa)
const b64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
let base64Token = '';
let i = 0;

while (i < rawString.length) {
    let c1 = rawString.charCodeAt(i++);
    let c2 = i < rawString.length ? rawString.charCodeAt(i++) : NaN;
    let c3 = i < rawString.length ? rawString.charCodeAt(i++) : NaN;

    let byte1 = c1 >> 2;
    let byte2 = ((c1 & 3) << 4) | (isNaN(c2) ? 0 : c2 >> 4);
    let byte3 = isNaN(c2) ? 64 : ((c2 & 15) << 2) | (isNaN(c3) ? 0 : c3 >> 6);
    let byte4 = isNaN(c3) ? 64 : c3 & 63;

    base64Token += b64Chars.charAt(byte1) + b64Chars.charAt(byte2);
    if (byte3 !== 64) base64Token += b64Chars.charAt(byte3);
    if (byte4 !== 64) base64Token += b64Chars.charAt(byte4);
}

// 5. Set expiration time (24 hours from now)
let hoursToLive = 24;
let expiryDate = new Date();
expiryDate.setHours(expiryDate.getHours() + hoursToLive);
let expiryTimestamp = expiryDate.toISOString();

// 6. Construct the final URL
let baseUrl = "https://aurixasystems.com.au/questionnaire";
let mintedUrl = `${baseUrl}?token=${base64Token}&expires=${encodeURIComponent(expiryTimestamp)}`;

// 7. Update the Airtable record fields
await table.updateRecordAsync(recordId, {
    "Token": base64Token,
    "Bypass URL": mintedUrl
});
