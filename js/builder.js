/**
 * builder.js — Stitch Graph Builder
 *
 * Takes the output of parser.js (an array of round operation sequences) and
 * constructs a StitchGraph with proper parent/child and same-round neighbor
 * relationships.
 *
 * Rules for each supported stitch type:
 *
 *   MR (Magic Ring)
 *     Round 0 only.  Creates the foundation ring stitches.
 *     No parents (or self-referential for topology, but we leave parents empty).
 *     All MR stitches in round 0 are connected as neighbors.
 *
 *   SC (Single Crochet)
 *     Consumes one stitch from the previous round ("cursor" advances by 1).
 *     Produces one stitch in the current round.
 *     parents = [prevRound[cursor]]
 *
 *   INC (Increase)
 *     Consumes one stitch from the previous round (cursor advances by 1).
 *     Produces TWO stitches in the current round.
 *     Both children share the same parent.
 *     parents = [prevRound[cursor]]  for both children
 *
 *   DEC (Decrease / SCTOG)
 *     Consumes TWO stitches from the previous round (cursor advances by 2).
 *     Produces ONE stitch in the current round.
 *     parents = [prevRound[cursor], prevRound[cursor+1]]
 *
 * After all stitches for a round are created, we connect the circular
 * neighbor chain: stitch[i].nextInRound = stitch[i+1], wrapping at the end.
 *
 * The "cursor" into the previous round wraps modulo the previous round length
 * to handle slight pattern errors gracefully; a warning is emitted when this
 * occurs.
 */

import { Stitch, StitchType, StitchGraph } from './model.js';

/**
 * Build a StitchGraph from a parsed pattern.
 *
 * @param {{ rounds: Array<{ roundNumber: number, ops: Array<{type,count}> }>, errors: string[] }} parsed
 * @returns {{ graph: StitchGraph, warnings: string[] }}
 */
export function buildGraph(parsed) {
  const graph = new StitchGraph();
  const warnings = [...parsed.errors];

  let prevRound = [];  // stitches from the previous round available as parents
  let cursor = 0;      // index into prevRound for the next stitch to consume

  for (let ri = 0; ri < parsed.rounds.length; ri++) {
    const { roundNumber, ops } = parsed.rounds[ri];
    const currentRound = [];

    if (ri === 0) {
      // ── Round 0: Magic Ring foundation ──────────────────────────────────────
      // Expect a single MR op (or fallback: treat any stitch as MR).
      const mrOps = ops.filter(op => op.type === StitchType.MR);

      if (mrOps.length === 0) {
        warnings.push(`Round 1 has no MR stitch; treating first op as MR.`);
        // Use first op's count to determine ring size
      }

      // Count total stitches for the ring
      let ringSize = 0;
      for (const op of ops) {
        if (op.type === StitchType.MR) ringSize++;
        else if (op.type === StitchType.SC) ringSize++;
        // MR 6 → 6 SC-like foundation stitches
      }
      // Handle "MR 6" parsed as six MR ops of count=1
      if (ringSize === 0) ringSize = ops.length;

      for (let i = 0; i < ringSize; i++) {
        const s = new Stitch({ type: StitchType.MR, round: ri, indexInRound: i });
        currentRound.push(s);
      }

      // No parents for the magic ring
      // Neighbor chain is set below after the loop
    } else {
      // ── Subsequent rounds ────────────────────────────────────────────────────
      cursor = 0;  // reset cursor to start of previous round

      for (let oi = 0; oi < ops.length; oi++) {
        const op = ops[oi];

        switch (op.type) {
          case StitchType.SC: {
            const parent = prevRound[cursor % prevRound.length];
            if (cursor >= prevRound.length) {
              warnings.push(`R${roundNumber}: cursor overflow at op ${oi + 1} (SC)`);
            }
            cursor++;

            const s = new Stitch({ type: StitchType.SC, round: ri, indexInRound: currentRound.length });
            link(s, [parent]);
            currentRound.push(s);
            break;
          }

          case StitchType.INC: {
            const parent = prevRound[cursor % prevRound.length];
            if (cursor >= prevRound.length) {
              warnings.push(`R${roundNumber}: cursor overflow at op ${oi + 1} (INC)`);
            }
            cursor++;

            // Two children share one parent
            const s1 = new Stitch({ type: StitchType.INC, round: ri, indexInRound: currentRound.length });
            link(s1, [parent]);
            currentRound.push(s1);

            const s2 = new Stitch({ type: StitchType.INC, round: ri, indexInRound: currentRound.length });
            link(s2, [parent]);
            currentRound.push(s2);
            break;
          }

          case StitchType.DEC: {
            // Consume two parents
            const p1 = prevRound[cursor % prevRound.length];
            if (cursor >= prevRound.length) {
              warnings.push(`R${roundNumber}: cursor overflow at op ${oi + 1} (DEC parent 1)`);
            }
            cursor++;
            const p2 = prevRound[cursor % prevRound.length];
            if (cursor >= prevRound.length) {
              warnings.push(`R${roundNumber}: cursor overflow at op ${oi + 1} (DEC parent 2)`);
            }
            cursor++;

            const s = new Stitch({ type: StitchType.DEC, round: ri, indexInRound: currentRound.length });
            link(s, [p1, p2]);
            currentRound.push(s);
            break;
          }

          case StitchType.MR: {
            // MR in a non-first round is unusual; treat as SC
            warnings.push(`R${roundNumber}: MR found in non-first round; treating as SC.`);
            const parent = prevRound[cursor % prevRound.length];
            cursor++;
            const s = new Stitch({ type: StitchType.SC, round: ri, indexInRound: currentRound.length });
            link(s, [parent]);
            currentRound.push(s);
            break;
          }

          default:
            warnings.push(`R${roundNumber}: unknown stitch type "${op.type}" — skipped.`);
        }
      }
    }

    // ── Connect circular neighbor chain ────────────────────────────────────────
    const n = currentRound.length;
    if (n > 0) {
      for (let i = 0; i < n; i++) {
        currentRound[i].nextInRound = currentRound[(i + 1) % n];
        currentRound[(i + 1) % n].prevInRound = currentRound[i];
      }
    }

    graph.rounds.push(currentRound);
    prevRound = currentRound;
  }

  return { graph, warnings };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Bidirectionally link a stitch to its parents. */
function link(stitch, parents) {
  for (const p of parents) {
    stitch.parents.push(p);
    p.children.push(stitch);
  }
}
