/**
 * parser.js — Crochet Pattern Text Parser
 *
 * Converts a multi-line pattern string into an ordered list of round
 * operation sequences.  The parser deliberately knows nothing about 3D
 * geometry or stitch graph construction — those concerns are in builder.js.
 *
 * Supported syntax examples:
 *   R1: MR 6
 *   R2: INC x6
 *   R3: (SC, INC) x6
 *   R4: (SC 2, INC) x6
 *   R5: SC 24
 *   R6: (SC 2, DEC) x6
 *   R7: SC 5, INC 3, SC 5
 *
 * Returns an array of Round objects, one per non-empty line.
 * Each Round contains an ordered array of Op objects.
 * The ordering is the exact worked order — it is NEVER summarised.
 *
 * An Op is: { type: StitchType, count: number }
 * For a plain "SC" that is one stitch, count === 1.
 * For "SC 3" that is three consecutive SC stitches, count === 3.
 */

import { StitchType } from './model.js';

// ─── Token patterns ────────────────────────────────────────────────────────────

/** Stitch keywords (case-insensitive). Maps token → StitchType. */
const STITCH_ALIASES = {
  MR:    StitchType.MR,
  SC:    StitchType.SC,
  INC:   StitchType.INC,
  DEC:   StitchType.DEC,
  SCTOG: StitchType.DEC,  // Treat SCTOG as DEC
};

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a full pattern string.
 *
 * @param {string} patternText
 * @returns {{ rounds: Round[], errors: string[] }}
 *
 * A Round is { roundNumber: number, ops: Op[] }
 * An Op is { type: string, count: number }
 */
export function parsePattern(patternText) {
  const errors = [];
  const rounds = [];

  const lines = patternText.split('\n');
  let autoRound = 1;

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo].trim();
    if (!raw || raw.startsWith('//') || raw.startsWith('#')) continue;

    // Strip optional "R<n>:" or "Round <n>:" prefix
    let body = raw;
    const roundPrefix = raw.match(/^(?:R(?:ound)?\s*\d+\s*:)\s*/i);
    if (roundPrefix) {
      body = raw.slice(roundPrefix[0].length).trim();
    }

    try {
      const ops = parseRoundBody(body);
      rounds.push({ roundNumber: autoRound, ops });
      autoRound++;
    } catch (e) {
      errors.push(`Line ${lineNo + 1}: ${e.message}`);
    }
  }

  return { rounds, errors };
}

// ─── Internal parsing ──────────────────────────────────────────────────────────

/**
 * Parse the body of a single round (after stripping the "R1:" prefix).
 * Returns an array of Ops in exact worked order.
 */
function parseRoundBody(body) {
  const tokens = tokenize(body);
  const ops = [];
  parseTokenList(tokens, 0, ops);
  return ops;
}

/**
 * Tokenize a round body into a structured token stream.
 * Tokens: STITCH, NUMBER, COMMA, LPAREN, RPAREN, REPEAT ('x' or 'X'), EOF
 */
function tokenize(src) {
  const tokens = [];
  let i = 0;

  while (i < src.length) {
    // Skip whitespace
    if (/\s/.test(src[i])) { i++; continue; }

    // Number
    if (/\d/.test(src[i])) {
      let n = '';
      while (i < src.length && /\d/.test(src[i])) n += src[i++];
      tokens.push({ kind: 'NUMBER', value: parseInt(n, 10) });
      continue;
    }

    // Comma
    if (src[i] === ',') { tokens.push({ kind: 'COMMA' }); i++; continue; }

    // Parentheses
    if (src[i] === '(') { tokens.push({ kind: 'LPAREN' }); i++; continue; }
    if (src[i] === ')') { tokens.push({ kind: 'RPAREN' }); i++; continue; }

    // Repeat marker: 'x' or 'X' not followed by a letter (so 'x6' is valid)
    if (/[xX]/.test(src[i]) && (i + 1 >= src.length || !/[a-zA-Z]/.test(src[i + 1]))) {
      tokens.push({ kind: 'REPEAT' });
      i++;
      continue;
    }

    // Stitch keyword
    if (/[a-zA-Z]/.test(src[i])) {
      let word = '';
      while (i < src.length && /[a-zA-Z]/.test(src[i])) word += src[i++];
      const upper = word.toUpperCase();
      if (STITCH_ALIASES[upper]) {
        tokens.push({ kind: 'STITCH', value: STITCH_ALIASES[upper] });
      } else {
        throw new Error(`Unknown stitch "${word}"`);
      }
      continue;
    }

    throw new Error(`Unexpected character "${src[i]}" at position ${i}`);
  }

  tokens.push({ kind: 'EOF' });
  return tokens;
}

/**
 * Recursive descent parser over the token stream.
 * Appends individual Op objects (each with count=1) to `out` in worked order.
 * Returns the index of the next unconsumed token.
 */
function parseTokenList(tokens, pos, out) {
  while (pos < tokens.length) {
    const tok = tokens[pos];

    if (tok.kind === 'EOF' || tok.kind === 'RPAREN') break;

    if (tok.kind === 'COMMA') { pos++; continue; }

    if (tok.kind === 'LPAREN') {
      // Collect the ops inside the parens
      const groupOps = [];
      pos = parseTokenList(tokens, pos + 1, groupOps);
      // Expect RPAREN
      if (tokens[pos] && tokens[pos].kind === 'RPAREN') pos++;
      // Expect optional repeat: x<n> or just a NUMBER
      let repeatCount = 1;
      if (tokens[pos] && tokens[pos].kind === 'REPEAT') {
        pos++;
        if (tokens[pos] && tokens[pos].kind === 'NUMBER') {
          repeatCount = tokens[pos].value;
          pos++;
        }
      } else if (tokens[pos] && tokens[pos].kind === 'NUMBER') {
        // bare number after ) means repeat (some patterns write ") 6")
        repeatCount = tokens[pos].value;
        pos++;
      }
      for (let r = 0; r < repeatCount; r++) {
        for (const op of groupOps) {
          out.push({ ...op });
        }
      }
      continue;
    }

    if (tok.kind === 'STITCH') {
      const type = tok.value;
      pos++;
      // Optional count: "SC 3" or "SC x3" means 3 SC ops
      let count = 1;
      if (tokens[pos] && tokens[pos].kind === 'REPEAT') pos++; // skip 'x'
      if (tokens[pos] && tokens[pos].kind === 'NUMBER') {
        count = tokens[pos].value;
        pos++;
      }
      for (let c = 0; c < count; c++) {
        out.push({ type, count: 1 });
      }
      continue;
    }

    // Unexpected token — skip with warning context
    throw new Error(`Unexpected token ${JSON.stringify(tok)}`);
  }

  return pos;
}
