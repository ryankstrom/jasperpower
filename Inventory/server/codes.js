// Identifier helpers: EUI normalisation, generated asset IDs, and scanned-code parsing.
import { randomInt } from 'node:crypto';

// Crockford base32 without I, L, O, U — easy to read off a label.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateUid() {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `JSP-${s}`;
}

// Returns the 16-hex-digit EUI in upper case, or null if the input isn't one.
export function normalizeEui(v) {
  if (v == null) return null;
  const hex = String(v).replace(/[\s:\-]/g, '').toUpperCase();
  return /^[0-9A-F]{16}$/.test(hex) ? hex : null;
}

/**
 * Work out what a scanned QR / barcode / typed string refers to.
 * Handles:
 *  - Jasper labels:   https://host/u/JSP-XXXXXXXX  or bare JSP-XXXXXXXX
 *  - LoRa Alliance TR005:  LW:D0:<JoinEUI>:<DevEUI>:<ProfileID>[:...]
 *  - JSON payloads with deveui / dev_eui / eui / joineui / sn keys (several vendors)
 *  - Text with "DevEUI: ..." etc, or a bare 16-hex EUI
 *  - Anything else: treated as a serial number / uid to search for
 */
export function parseScan(raw) {
  const text = String(raw ?? '').trim();
  const out = { raw: text, uid: null, eui: null, join_eui: null, serial: null, format: 'text' };
  if (!text) return out;

  const label = text.match(/(?:\/u\/|^)(JSP-[0-9A-Z]{8})\b/i);
  if (label) {
    out.uid = label[1].toUpperCase();
    out.format = 'jasper-label';
    return out;
  }
  const uidInUrl = text.match(/\/u\/([^/?#\s]+)/);
  if (uidInUrl) {
    out.uid = decodeURIComponent(uidInUrl[1]);
    out.format = 'jasper-label';
    return out;
  }

  const tr005 = text.match(/^LW:D0:([0-9A-F]{16}):([0-9A-F]{16})/i);
  if (tr005) {
    out.join_eui = tr005[1].toUpperCase();
    out.eui = tr005[2].toUpperCase();
    out.format = 'lora-tr005';
    return out;
  }

  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      const pick = (...keys) => {
        for (const [k, v] of Object.entries(obj)) {
          if (keys.includes(k.toLowerCase().replace(/[^a-z]/g, ''))) return v;
        }
        return null;
      };
      out.eui = normalizeEui(pick('deveui', 'eui', 'gatewayeui', 'gweui'));
      out.join_eui = normalizeEui(pick('joineui', 'appeui'));
      const sn = pick('sn', 'serial', 'serialnumber');
      out.serial = sn != null ? String(sn) : null;
      out.format = 'json';
      if (out.eui || out.serial) return out;
    } catch { /* not JSON — fall through */ }
  }

  const labelled = text.match(/(?:dev\s*eui|gateway\s*eui|gw\s*eui|eui)\s*[:=]?\s*([0-9A-F]{2}(?:[\s:\-]?[0-9A-F]{2}){7})/i);
  if (labelled) {
    out.eui = normalizeEui(labelled[1]);
    const join = text.match(/(?:join\s*eui|app\s*eui)\s*[:=]?\s*([0-9A-F]{2}(?:[\s:\-]?[0-9A-F]{2}){7})/i);
    if (join) out.join_eui = normalizeEui(join[1]);
    const sn = text.match(/\b(?:s\/?n|serial(?:\s*(?:no|number))?)\s*[:=#]?\s*([A-Z0-9\-]+)/i);
    if (sn) out.serial = sn[1];
    out.format = 'text-eui';
    return out;
  }

  const bare = normalizeEui(text);
  if (bare) {
    out.eui = bare;
    out.format = 'eui';
    return out;
  }

  out.serial = text;
  return out;
}
