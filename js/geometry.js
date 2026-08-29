/**
 * geometry.js — 3D Position Computation
 *
 * Assigns a world-space position (x, y, z) to each stitch in the graph.
 * This module knows about 3D math but nothing about crochet parsing/building.
 *
 * ─── Algorithm overview ──────────────────────────────────────────────────────
 *
 * The old layout forced every round onto a perfect circle, which erased
 * localized increases/decreases.  The current layout is parent-driven:
 *
 *   1. Place the foundation ring on a circle.
 *   2. For each later round, place every stitch outward from the average of
 *      its parent stitch positions, using stitch height as the desired
 *      parent→child edge length.
 *   3. Relax same-round neighbor distances so the round closes smoothly while
 *      retaining local deformations from the parent topology.
 *   4. Blend the average radius toward a stuffed / barrel profile without
 *      forcing the round back into a perfect circle.
 */

import { StitchType, getStitchGeometry } from './model.js';

const STITCH_WIDTH_SCALE = 0.8;
// A round should never collapse below roughly one stitch-width of circumference.
const MIN_ROUND_CIRCUMFERENCE = getStitchGeometry(StitchType.SC).width * STITCH_WIDTH_SCALE;
const ROUND_RELAX_ITERATIONS = 48;
const TETHER_PULL = 0.16;
const TARGET_RADIUS_PULL = 0.12;
// Keep most of the parent→child edge vertical while leaving enough planar run
// for the round to expand and show localized shaping.
const VERTICAL_STEP_BASE = 0.82;
const VERTICAL_STEP_STUFFING_REDUCTION = 0.14;
// When the vertical step would exceed the stitch height, retain a small planar
// component so coincident parent/child columns can still spread into a round.
const PLANAR_FALLBACK_RATIO = 0.2;
const FINAL_RADIUS_CORRECTION_THRESHOLD = 0.1;
const FINAL_RADIUS_CORRECTION_PULL = 0.35;
const MIN_DIRECTION_LENGTH = 1e-5;
// Magic rings and FO pinches are essentially a point in real life.
const PINCH_ROUND_RADIUS_FACTOR = 0.05;
// A first round that does not increase much from the magic ring should stay
// much tighter than one that doubles the ring immediately.
const MAGIC_RING_FULL_EXPANSION_RATIO = 2.0;
const MAGIC_RING_EXPANSION_MIN = 0.35;
const MAGIC_RING_EXPANSION_MAX = 1.0;
const RELAX_CONVERGENCE_EPSILON = 1e-4;

/**
 * Compute 3D positions for every stitch in the graph.
 * Mutates stitch.position in place.
 *
 * @param {import('./model.js').StitchGraph} graph
 * @param {number} stuffing  0.0 (flat) … 1.0 (fully inflated)
 */
export function computePositions(graph, stuffing = 0.5) {
  const rounds = graph.rounds;
  if (rounds.length === 0) return;

  const numRounds = rounds.length;

  // Natural radius for each round (sum of nominal stitch widths / 2π)
  const naturalRadii = rounds.map(round => {
   const circumference = round.reduce((sum, stitch) => {
     return sum + getStitchGeometry(stitch.type).width * STITCH_WIDTH_SCALE;
   }, 0);
   return Math.max(circumference, MIN_ROUND_CIRCUMFERENCE) / (2 * Math.PI);
  });

  // Barrel radius = max natural radius across all rounds
  const maxRadius = Math.max(...naturalRadii);

  // Effective radius per round blends natural ↔ barrel
  const effectiveRadii = naturalRadii.map(r => r * (1 - stuffing) + maxRadius * stuffing);

  const roundsToPinch = new Set(graph.pinchedRoundIndices ?? []);

  // Magic rings are essentially a point in real life.
  const isMagicRing = rounds[0].every(s => s.type === StitchType.MR);
  if (isMagicRing) {
   roundsToPinch.add(0);
  }

  layoutFoundationRound(rounds[0], effectiveRadii[0]);
  if (roundsToPinch.has(0)) {
    // Pinch the magic ring before later rounds are placed so the first worked
    // stitches anchor to the tight center they come from in real crochet.
    pinchRound(rounds[0], PINCH_ROUND_RADIUS_FACTOR);
    roundsToPinch.delete(0);
  }

  // FO pinches are applied after layout so they close tightly even when
  // parent-driven relaxation would otherwise keep a larger radius.

  for (let ri = 1; ri < numRounds; ri++) {
   const round = rounds[ri];
   const prevRound = rounds[ri - 1];
   if (round.length === 0) continue;

   const relaxed = layoutRoundFromParents(
     round,
     prevRound,
     effectiveRadii[ri],
     stuffing,
     prevRound.every(stitch => stitch.type === StitchType.MR),
   );
   for (let si = 0; si < round.length; si++) {
     round[si].position = relaxed[si];
   }
  }

  for (const roundIndex of roundsToPinch) {
   if (roundIndex < 0 || roundIndex >= numRounds) continue;
   pinchRound(rounds[roundIndex], PINCH_ROUND_RADIUS_FACTOR);
  }

  normalizeScaleToStitchHeights(graph);
  centerVertically(graph);
}

function layoutFoundationRound(round, radius) {
  const n = round.length;
  if (n === 0) return;

  for (let si = 0; si < n; si++) {
   const theta = (2 * Math.PI * si) / n;
   round[si].position = {
     x: radius * Math.cos(theta),
     y: 0,
     z: radius * Math.sin(theta),
   };
  }
}

function layoutRoundFromParents(round, prevRound, targetRadius, stuffing, isFromMagicRing = false) {
  const prevCentroid = computeCentroid(prevRound);
  const effectiveTargetRadius = isFromMagicRing
   ? magicRingTargetRadius(round, prevRound, targetRadius, stuffing)
   : targetRadius;
  const anchors = round.map((stitch, index) => {
   const parentCenter = averageParentPosition(stitch, prevRound, index);
   const direction = outwardDirection(parentCenter, prevCentroid, round.length, index);
   const targetHeight = getStitchGeometry(stitch.type).height;
   const verticalStep = stitchVerticalStep(targetHeight, stuffing);
   const planarOffset = stitchPlanarOffset(stitch, stuffing);
   return {
     x: parentCenter.x + direction.x * planarOffset,
     y: parentCenter.y + verticalStep,
     z: parentCenter.z + direction.z * planarOffset,
   };
  });

  const points = anchors.map(anchor => ({ ...anchor }));
  const desiredNeighborDistances = round.map((stitch, index) => {
   const next = round[(index + 1) % round.length];
   const a = getStitchGeometry(stitch.type).width;
   const b = getStitchGeometry(next.type).width;
   return ((a + b) * 0.5) * STITCH_WIDTH_SCALE;
  });

  for (let iter = 0; iter < ROUND_RELAX_ITERATIONS; iter++) {
   let maxShift = 0;

   for (let i = 0; i < points.length; i++) {
     const nextX = points[i].x + (anchors[i].x - points[i].x) * TETHER_PULL;
     const nextZ = points[i].z + (anchors[i].z - points[i].z) * TETHER_PULL;
     maxShift = Math.max(maxShift, Math.hypot(nextX - points[i].x, nextZ - points[i].z));
     points[i].x = nextX;
     points[i].z = nextZ;
   }

   for (let i = 0; i < points.length; i++) {
     const j = (i + 1) % points.length;
     maxShift = Math.max(maxShift, relaxPair(points[i], points[j], desiredNeighborDistances[i], i, points.length));
   }

   for (let i = points.length - 1; i >= 0; i--) {
     const j = (i + 1) % points.length;
     maxShift = Math.max(maxShift, relaxPair(points[i], points[j], desiredNeighborDistances[i], i, points.length));
   }

   const centroid = computeCentroid(points);
   const avgRadius = average(points.map(p => distance2d(p, centroid)));
   if (avgRadius > MIN_DIRECTION_LENGTH) {
     const pull = TARGET_RADIUS_PULL + stuffing * 0.08;
     const scale = 1 + ((effectiveTargetRadius - avgRadius) / avgRadius) * pull;
     for (const point of points) {
       const prevX = point.x;
       const prevZ = point.z;
       point.x = centroid.x + (point.x - centroid.x) * scale;
       point.z = centroid.z + (point.z - centroid.z) * scale;
       maxShift = Math.max(maxShift, Math.hypot(point.x - prevX, point.z - prevZ));
     }
   }

   if (maxShift < RELAX_CONVERGENCE_EPSILON) break;
  }

  const centroid = computeCentroid(points);
  const avgRadius = average(points.map(p => distance2d(p, centroid)));
  if (avgRadius > MIN_DIRECTION_LENGTH) {
   const radiusError = Math.abs(effectiveTargetRadius - avgRadius) / avgRadius;
   if (radiusError > FINAL_RADIUS_CORRECTION_THRESHOLD) {
     const finalScale = 1 + ((effectiveTargetRadius - avgRadius) / avgRadius) * FINAL_RADIUS_CORRECTION_PULL;
     for (const point of points) {
       point.x = centroid.x + (point.x - centroid.x) * finalScale;
       point.z = centroid.z + (point.z - centroid.z) * finalScale;
     }
   }
  }

  return isFromMagicRing ? reprojectToStitchHeight(points, round, prevRound) : points;
}

function averageParentPosition(stitch, prevRound, fallbackIndex) {
  const parents = stitch.parents.length ? stitch.parents : [prevRound[fallbackIndex % prevRound.length]];
  const sum = parents.reduce((acc, parent) => {
   acc.x += parent.position.x;
   acc.y += parent.position.y;
   acc.z += parent.position.z;
   return acc;
  }, { x: 0, y: 0, z: 0 });

  return {
   x: sum.x / parents.length,
   y: sum.y / parents.length,
   z: sum.z / parents.length,
  };
}

function outwardDirection(point, centroid, count, index) {
  const dx = point.x - centroid.x;
  const dz = point.z - centroid.z;
  const len = Math.hypot(dx, dz);
  if (len > MIN_DIRECTION_LENGTH) {
   return { x: dx / len, z: dz / len };
  }

  const theta = (2 * Math.PI * index) / Math.max(count, 1);
  return { x: Math.cos(theta), z: Math.sin(theta) };
}

function relaxPair(a, b, targetDistance, fallbackAngleIndex, fallbackAngleCount) {
  let dx = b.x - a.x;
  let dz = b.z - a.z;
  let dist = Math.hypot(dx, dz);

  if (dist < MIN_DIRECTION_LENGTH) {
   const fallbackAngle = (2 * Math.PI * fallbackAngleIndex) / Math.max(fallbackAngleCount, 1);
   dx = Math.cos(fallbackAngle) * MIN_DIRECTION_LENGTH;
   dz = Math.sin(fallbackAngle) * MIN_DIRECTION_LENGTH;
   dist = MIN_DIRECTION_LENGTH;
  }

  const correction = ((targetDistance - dist) / dist) * 0.5;
  const prevAx = a.x;
  const prevAz = a.z;
  const prevBx = b.x;
  const prevBz = b.z;
  a.x -= dx * correction;
  a.z -= dz * correction;
  b.x += dx * correction;
  b.z += dz * correction;
  return Math.max(
    Math.hypot(a.x - prevAx, a.z - prevAz),
    Math.hypot(b.x - prevBx, b.z - prevBz),
  );
}

function computeCentroid(points) {
  if (points.length === 0) return { x: 0, y: 0, z: 0 };

  const sum = points.reduce((acc, point) => {
   const pos = point.position ?? point;
   acc.x += pos.x;
   acc.y += pos.y ?? 0;
   acc.z += pos.z;
   return acc;
  }, { x: 0, y: 0, z: 0 });

  return {
   x: sum.x / points.length,
   y: sum.y / points.length,
   z: sum.z / points.length,
  };
}

function normalizeScaleToStitchHeights(graph) {
  const ratios = [];

  for (const stitch of graph.allStitches) {
   const target = getStitchGeometry(stitch.type).height;
   if (target <= 0) continue;

   for (const parent of stitch.parents) {
     const actual = Math.hypot(
       stitch.position.x - parent.position.x,
       stitch.position.y - parent.position.y,
       stitch.position.z - parent.position.z,
     );
     if (actual > MIN_DIRECTION_LENGTH) {
       ratios.push(actual / target);
     }
   }
  }

  if (ratios.length === 0) return;

  ratios.sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  const medianRatio = ratios.length % 2 === 0
    ? (ratios[mid - 1] + ratios[mid]) / 2
    : ratios[mid];
  if (medianRatio <= MIN_DIRECTION_LENGTH) return;

  const scale = 1 / medianRatio;
  for (const stitch of graph.allStitches) {
   stitch.position.x *= scale;
   stitch.position.y *= scale;
   stitch.position.z *= scale;
  }
}

function stitchVerticalStep(targetHeight, stuffing) {
  return targetHeight * (VERTICAL_STEP_BASE - stuffing * VERTICAL_STEP_STUFFING_REDUCTION);
}

function stitchPlanarOffset(stitch, stuffing) {
  const targetHeight = getStitchGeometry(stitch.type).height;
  const verticalStep = stitchVerticalStep(targetHeight, stuffing);
  const planarSquared = targetHeight ** 2 - verticalStep ** 2;
  return Math.sqrt(planarSquared > 0 ? planarSquared : targetHeight ** 2 * PLANAR_FALLBACK_RATIO);
}

function magicRingTargetRadius(round, prevRound, targetRadius, stuffing) {
  // prevRound is non-empty at real call sites; the divisor guard is only a
  // defensive fallback in case a malformed graph ever reaches this path.
  const expansionRatio = round.length / Math.max(prevRound.length, 1);
  const expansionFactor = Math.max(
    MAGIC_RING_EXPANSION_MIN,
    Math.min(MAGIC_RING_EXPANSION_MAX, expansionRatio / MAGIC_RING_FULL_EXPANSION_RATIO),
  );
  return Math.min(
    targetRadius,
    average(round.map(stitch => stitchPlanarOffset(stitch, stuffing))) * expansionFactor,
  );
}

function reprojectToStitchHeight(points, round, prevRound) {
  // The first worked round is uniquely constrained by the magic ring's pinched
  // center. Reproject just those stitches back to their nominal height so the
  // base stays rounded instead of stretching into a cone. This intentionally
  // uses the post-pinch parent centers, because stitches coming from the ring
  // should measure from the tightened anchor they are worked into.
  return points.map((point, index) => {
    const parentCenter = averageParentPosition(round[index], prevRound, index);
    const dx = point.x - parentCenter.x;
    const dy = point.y - parentCenter.y;
    const dz = point.z - parentCenter.z;
    const actual = Math.hypot(dx, dy, dz);
    const target = getStitchGeometry(round[index].type).height;
    if (actual <= MIN_DIRECTION_LENGTH || target <= 0) return point;
    const scale = target / actual;
    return {
      x: parentCenter.x + dx * scale,
      y: parentCenter.y + dy * scale,
      z: parentCenter.z + dz * scale,
    };
  });
}

function pinchRound(round, radiusFactor) {
  if (round.length === 0) return;
  const centroid = computeCentroid(round);
  for (const stitch of round) {
    stitch.position.x = centroid.x + (stitch.position.x - centroid.x) * radiusFactor;
    stitch.position.z = centroid.z + (stitch.position.z - centroid.z) * radiusFactor;
  }
}

function centerVertically(graph) {
  const ys = graph.allStitches.map(stitch => stitch.position.y);
  if (ys.length === 0) return;

  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const midY = (minY + maxY) / 2;

  for (const stitch of graph.allStitches) {
   stitch.position.y -= midY;
  }
}

function distance2d(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
