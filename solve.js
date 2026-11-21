// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly what csv-reader
// returns for {text, header} — {columns, rows, errors} — only faster.
//
// How it reads: the text is walked once, left to right. A U+FEFF at the very start
// is dropped. A record ends at LF or CRLF, and a line left with no characters is no
// record. Outside quotes a CR not followed by LF is dropped (stray_cr). A field that
// opens with a quote runs to the next quote that is not doubled ("" inside it is one
// quote, each CRLF or lone CR inside it is read as LF); what follows its closing
// quote, up to the next comma or line break, is appended as it stands (quote_junk,
// when the field ends); a quote that never closes is a literal character and the
// text after it is read again as unquoted (unterminated_quote). A quote inside an
// unquoted field is a literal character. Fields stay strings, never trimmed or
// converted. columns is the first record when header is true, else null; rows holds
// the records after it, each padded with "" (short_row, with fields: its field
// count) or cut (long_row, with extra: the cut fields) to the first record's width.
// Each error is {code, line, row}, in the order met; line is the 1-based line its
// record starts on, row its record's index in rows (null for the header).
//
// Speed: most records are plain lines — no quote, no stray CR in them — so a whole
// record is taken at once with one slice and one native split(','). Only a line
// holding a quote or a CR falls back to the field-by-field reader below, which
// itself scans with indexOf for the next delimiter instead of walking characters.

const COMMA = 0;
const BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on and the index in rows it takes.
  let recLine = 1;
  let recRow = null;

  // Finish a record: store the header, or pad/cut it to the first record's width
  // and push it, recording short_row / long_row as the record ends.
  function finish(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  // Read an unquoted field starting at pos, with `head` already in it ("" normally,
  // '"' when a never-closing quote is re-read as unquoted). Returns [value, ended,
  // added], where added counts the characters kept here (a dropped stray CR adds
  // none). ended is COMMA, BREAK or END.
  function readUnquoted(head) {
    let value = head;
    let added = 0;
    for (;;) {
      const comma = text.indexOf(',', pos);
      const lf = text.indexOf('\n', pos);
      const cr = text.indexOf('\r', pos);
      let stop = -1;
      let what = END;
      if (comma !== -1) {
        stop = comma;
        what = COMMA;
      }
      if (lf !== -1 && (stop === -1 || lf < stop)) {
        stop = lf;
        what = BREAK;
      }
      if (cr !== -1 && (stop === -1 || cr < stop)) {
        stop = cr;
        what = 3;
      }
      if (stop === -1) {
        if (pos < n) {
          value += text.slice(pos, n);
          added += n - pos;
        }
        pos = n;
        return [value, END, added];
      }
      if (what === 3) {
        if (text.charCodeAt(stop + 1) === 10) {
          if (stop > pos) {
            value += text.slice(pos, stop);
            added += stop - pos;
          }
          pos = stop + 2;
          line += 1;
          return [value, BREAK, added];
        }
        // A lone CR is dropped, and the field goes on.
        if (stop > pos) {
          value += text.slice(pos, stop);
          added += stop - pos;
        }
        errors.push({ code: 'stray_cr', line: recLine, row: recRow });
        pos = stop + 1;
        continue;
      }
      if (stop > pos) {
        value += text.slice(pos, stop);
        added += stop - pos;
      }
      if (what === COMMA) {
        pos = stop + 1;
        return [value, COMMA, added];
      }
      pos = stop + 1;
      line += 1;
      return [value, BREAK, added];
    }
  }

  // Read a quoted field whose opening quote is at pos. Returns [value, ended].
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    for (;;) {
      const q = text.indexOf('"', pos);
      const cr = text.indexOf('\r', pos);
      const lf = text.indexOf('\n', pos);
      let stop = -1;
      let what = 0; // 0: quote, 1: CR, 2: LF
      if (q !== -1) {
        stop = q;
        what = 0;
      }
      if (cr !== -1 && (stop === -1 || cr < stop)) {
        stop = cr;
        what = 1;
      }
      if (lf !== -1 && (stop === -1 || lf < stop)) {
        stop = lf;
        what = 2;
      }
      if (stop === -1) {
        // The quote never closes: it is a literal character, and the text after
        // it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recLine, row: recRow });
        return readUnquoted('"');
      }
      if (what === 0) {
        if (text.charCodeAt(stop + 1) === 34) {
          // A doubled quote inside: one quote, and the field goes on.
          value += text.slice(pos, stop) + '"';
          pos = stop + 2;
          continue;
        }
        value += text.slice(pos, stop);
        pos = stop + 1;
        if (pos >= n) return [value, END];
        const c = text.charCodeAt(pos);
        if (c === 44) {
          pos += 1;
          return [value, COMMA];
        }
        if (c === 10) {
          pos += 1;
          line += 1;
          return [value, BREAK];
        }
        if (c === 13 && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          return [value, BREAK];
        }
        // What follows the closing quote is appended as it stands.
        const junk = readUnquoted(value);
        if (junk[2] > 0) errors.push({ code: 'quote_junk', line: recLine, row: recRow });
        return junk;
      }
      // A CRLF or a lone CR inside quotes is one LF; a bare LF is one too.
      value += text.slice(pos, stop) + '\n';
      line += 1;
      pos = stop + (what === 1 && text.charCodeAt(stop + 1) === 10 ? 2 : 1);
    }
  }

  // Read one record the slow way, field by field. Returns false when the text is
  // spent (no record), true when a record was read (and finished).
  function readRecordSlow() {
    const fields = [];
    let ended;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      const field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field[0]);
      ended = field[1];
    } while (ended === COMMA);
    // A line that held only stray CRs is left with no characters: no record (its
    // stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) return true;
    finish(fields);
    return true;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recLine = line;
    recRow = header && columns === null ? null : rows.length;

    // Fast path: a whole plain record at once. The line must hold no quote and no
    // CR (a trailing CR of a CRLF ending is stripped first). Anything else goes
    // through the field reader, which handles quotes, junk and stray CRs.
    const lineEnd = text.indexOf('\n', pos);
    const end = lineEnd === -1 ? n : lineEnd;
    const effEnd = end > pos && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    if (effEnd > pos) {
      const segment = text.slice(pos, effEnd);
      if (segment.indexOf('"') === -1 && segment.indexOf('\r') === -1) {
        finish(segment.split(','));
        if (lineEnd === -1) {
          pos = n;
        } else {
          pos = lineEnd + 1;
          line += 1;
        }
        continue;
      }
    }
    readRecordSlow();
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
