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
 *   2. Build a smooth pole→equator→pole theta profile across rounds.
 *   3. For each later round, resolve each stitch length into
 *      vertical/horizontal components:
 *        dy = stitchLength * sin(theta), dr = stitchLength * cos(theta).
 *      Then place every stitch outward from the average of its parent positions.
 *   4. Relax same-round neighbor distances so the round closes smoothly while
 *      retaining local deformations from the parent topology.
 *   5. Blend the average radius toward a stuffed / barrel profile without
 *      forcing the round back into a perfect circle.
 */

import { StitchType, getStitchGeometry } from './model.js';

const STITCH_WIDTH_SCALE = 0.8;
// A round should never collapse below roughly one stitch-width of circumference.
const MIN_ROUND_CIRCUMFERENCE = getStitchGeometry(StitchType.SC).width * STITCH_WIDTH_SCALE;
const ROUND_RELAX_ITERATIONS = 48;
const TETHER_PULL = 0.16;
const TARGET_RADIUS_PULL = 0.12;
// Theta profile controls stitch direction from pole→equator→pole.
// Exposed for quick tuning while visually testing patterns.
const THETA_MAX_ANGLE_FLAT_DEGREES = 58;
const THETA_MAX_ANGLE_FULL_DEGREES = 90;
const THETA_RAMP_POWER_FLAT = 1.6;
const THETA_RAMP_POWER_FULL = 0.95;
const THETA_DELTA_THRESHOLD_RATIO = 0.03;
const THETA_SMOOTHING_PASSES = 2;
const FINAL_RADIUS_CORRECTION_THRESHOLD = 0.1;
const FINAL_RADIUS_CORRECTION_PULL = 0.35;
const MIN_DIRECTION_LENGTH = 1e-5;
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
  const thetaByRound = buildThetaProfile(effectiveRadii, stuffing);

  layoutFoundationRound(rounds[0], effectiveRadii[0]);

  for (let ri = 1; ri < numRounds; ri++) {
   const round = rounds[ri];
   const prevRound = rounds[ri - 1];
   if (round.length === 0) continue;

   const relaxed = layoutRoundFromParents(round, prevRound, effectiveRadii[ri], thetaByRound[ri], stuffing);
   for (let si = 0; si < round.length; si++) {
     round[si].position = relaxed[si];
   }
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

function layoutRoundFromParents(round, prevRound, targetRadius, theta, stuffing) {
  const prevCentroid = computeCentroid(prevRound);
  const anchors = round.map((stitch, index) => {
   const parentCenter = averageParentPosition(stitch, prevRound, index);
   const direction = outwardDirection(parentCenter, prevCentroid, round.length, index);
   const stitchLength = getStitchGeometry(stitch.type).height;
   const verticalStep = stitchLength * Math.sin(theta);
   const planarOffset = stitchLength * Math.cos(theta);
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
     const scale = 1 + ((targetRadius - avgRadius) / avgRadius) * pull;
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
   const radiusError = Math.abs(targetRadius - avgRadius) / avgRadius;
   if (radiusError <= FINAL_RADIUS_CORRECTION_THRESHOLD) return points;

   const finalScale = 1 + ((targetRadius - avgRadius) / avgRadius) * FINAL_RADIUS_CORRECTION_PULL;
   for (const point of points) {
     point.x = centroid.x + (point.x - centroid.x) * finalScale;
     point.z = centroid.z + (point.z - centroid.z) * finalScale;
   }
  }

  return points;
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

function buildThetaProfile(radii, stuffing) {
  const roundCount = radii.length;
  if (roundCount === 0) return [];

  const { expansionEnd, contractionStart } = detectEquatorRegion(radii);
  const maxTheta = degreesToRadians(lerp(THETA_MAX_ANGLE_FLAT_DEGREES, THETA_MAX_ANGLE_FULL_DEGREES, stuffing));
  const rampPower = lerp(THETA_RAMP_POWER_FLAT, THETA_RAMP_POWER_FULL, stuffing);
  const theta = new Array(roundCount).fill(0);

  for (let ri = 0; ri < roundCount; ri++) {
    const phase = thetaPhase(ri, roundCount, expansionEnd, contractionStart);
    const shapedPhase = Math.pow(clamp01(phase), rampPower);
    theta[ri] = maxTheta * shapedPhase;
  }

  return smoothNumericProfile(theta, THETA_SMOOTHING_PASSES);
}

function detectEquatorRegion(radii) {
  const maxRadius = Math.max(...radii);
  const deltas = [];
  for (let i = 0; i < radii.length - 1; i++) {
    deltas.push(radii[i + 1] - radii[i]);
  }

  const threshold = maxRadius * THETA_DELTA_THRESHOLD_RATIO;
  const maxIndex = radii.indexOf(maxRadius);
  let expansionEnd = maxIndex;
  let contractionStart = maxIndex;

  let sawExpansion = false;
  for (let i = 0; i < deltas.length; i++) {
    if (deltas[i] > threshold) {
      sawExpansion = true;
      continue;
    }
    if (sawExpansion) {
      expansionEnd = i;
      break;
    }
  }

  let sawContraction = false;
  for (let i = deltas.length - 1; i >= 0; i--) {
    if (deltas[i] < -threshold) {
      sawContraction = true;
      continue;
    }
    if (sawContraction) {
      contractionStart = i + 1;
      break;
    }
  }

  if (expansionEnd > contractionStart) {
    expansionEnd = maxIndex;
    contractionStart = maxIndex;
  }

  return { expansionEnd, contractionStart };
}

function thetaPhase(roundIndex, roundCount, expansionEnd, contractionStart) {
  if (roundCount <= 1) return 0;
  if (roundIndex <= expansionEnd) {
    const t = expansionEnd <= 0 ? 1 : roundIndex / expansionEnd;
    return smoothstep(clamp01(t));
  }

  if (roundIndex >= contractionStart) {
    const descentSpan = (roundCount - 1) - contractionStart;
    const t = descentSpan <= 0 ? 1 : ((roundCount - 1) - roundIndex) / descentSpan;
    return smoothstep(clamp01(t));
  }

  return 1;
}

function smoothNumericProfile(values, passes) {
  if (values.length < 3 || passes <= 0) return values;
  let smoothed = [...values];
  for (let pass = 0; pass < passes; pass++) {
    const next = [...smoothed];
    for (let i = 1; i < smoothed.length - 1; i++) {
      next[i] = (smoothed[i - 1] + smoothed[i] * 2 + smoothed[i + 1]) / 4;
    }
    smoothed = next;
  }
  return smoothed;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * clamp01(t);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function degreesToRadians(degrees) {
  return (degrees * Math.PI) / 180;
}
