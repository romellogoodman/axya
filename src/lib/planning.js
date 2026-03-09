/**
 * Motion Planning for Pen Plotters
 *
 * Implements constant-acceleration motion planning based on:
 * https://github.com/fogleman/axi/blob/master/axi/planner.py
 */

import { vadd, vdot, vlen, vmul, vnorm, vsub } from "./vec.js";

const EPSILON = 1e-9;

// Default device hardware constants (AxiDraw v3)
export const defaultDevice = {
  stepsPerMm: 5,
  penServoMin: 7500, // pen down (100%)
  penServoMax: 28000, // pen up (0%)
};

/**
 * Convert pen percentage (0-100) to servo PWM position
 * 0% = fully up, 100% = fully down
 */
export function penPctToPos(pct, device = defaultDevice) {
  const t = pct / 100.0;
  return Math.round(device.penServoMin * t + device.penServoMax * (1 - t));
}

// Legacy Device export for backwards compatibility
export const Device = {
  ...defaultDevice,
  penPctToPos(pct) {
    return penPctToPos(pct, defaultDevice);
  },
};

/**
 * Create motion profiles for a given device
 */
export function createProfiles(device = defaultDevice) {
  return {
    // Pen down (drawing) - slower, with cornering
    penDownProfile: {
      acceleration: 200 * device.stepsPerMm,
      maximumVelocity: 50 * device.stepsPerMm,
      corneringFactor: 0.127 * device.stepsPerMm,
    },
    // Pen up (travel) - faster, no cornering
    penUpProfile: {
      acceleration: 400 * device.stepsPerMm,
      maximumVelocity: 200 * device.stepsPerMm,
      corneringFactor: 0,
    },
    penUpHeight: 50, // percent
    penDownHeight: 60, // percent
    penDropDuration: 0.12, // seconds
    penLiftDuration: 0.12, // seconds
  };
}

// Default motion profiles (for backwards compatibility)
export const defaultProfile = createProfiles(defaultDevice);

/**
 * A single constant-acceleration motion block
 */
export class Block {
  constructor(accel, duration, vInitial, p1, p2) {
    if (vInitial < 0) {
      throw new Error(`vInitial must be >= 0, but was ${vInitial}`);
    }
    if (vInitial + accel * duration < -EPSILON) {
      throw new Error(
        `vFinal must be >= 0, but vInitial=${vInitial}, duration=${duration}, accel=${accel}`
      );
    }

    this.accel = accel;
    this.duration = duration;
    this.vInitial = vInitial;
    this.p1 = p1;
    this.p2 = p2;
    this.distance = vlen(vsub(p1, p2));
  }

  get vFinal() {
    return Math.max(0, this.vInitial + this.accel * this.duration);
  }

  /**
   * Get the state at time t within this block
   */
  instant(t, dt = 0, ds = 0) {
    const clampedT = Math.max(0, Math.min(this.duration, t));
    const a = this.accel;
    const v = this.vInitial + a * clampedT;
    const s = Math.max(
      0,
      Math.min(
        this.distance,
        this.vInitial * clampedT + (a * clampedT * clampedT) / 2
      )
    );

    const dir = vsub(this.p2, this.p1);
    const p =
      this.distance > EPSILON
        ? vadd(this.p1, vmul(vnorm(dir), s))
        : { ...this.p1 };

    return { t: clampedT + dt, p, s: s + ds, v, a };
  }

  serialize() {
    return {
      accel: this.accel,
      duration: this.duration,
      vInitial: this.vInitial,
      p1: this.p1,
      p2: this.p2,
    };
  }

  static deserialize(o) {
    return new Block(o.accel, o.duration, o.vInitial, o.p1, o.p2);
  }
}

/**
 * Pen motion (servo movement)
 */
export class PenMotion {
  constructor(initialPos, finalPos, pDuration) {
    this.initialPos = initialPos;
    this.finalPos = finalPos;
    this.pDuration = pDuration;
  }

  duration() {
    return this.pDuration;
  }

  serialize() {
    return {
      t: "PenMotion",
      initialPos: this.initialPos,
      finalPos: this.finalPos,
      duration: this.pDuration,
    };
  }

  static deserialize(o) {
    return new PenMotion(o.initialPos, o.finalPos, o.duration);
  }
}

/**
 * XY motion (series of acceleration blocks)
 */
export class XYMotion {
  constructor(blocks) {
    this.blocks = blocks;

    // Pre-compute time and distance offsets for each block
    this.ts = [];
    this.ss = [];
    let t = 0;
    let s = 0;
    for (const block of blocks) {
      this.ts.push(t);
      this.ss.push(s);
      t += block.duration;
      s += block.distance;
    }
  }

  get p1() {
    return this.blocks[0]?.p1 || { x: 0, y: 0 };
  }

  get p2() {
    return this.blocks[this.blocks.length - 1]?.p2 || { x: 0, y: 0 };
  }

  duration() {
    return this.blocks.reduce((sum, b) => sum + b.duration, 0);
  }

  /**
   * Get the state at time t within this motion
   */
  instant(t) {
    // Find the block containing time t
    let blockIdx = 0;
    for (let i = 0; i < this.ts.length; i++) {
      if (this.ts[i] <= t) {
        blockIdx = i;
      } else {
        break;
      }
    }

    const block = this.blocks[blockIdx];
    return block.instant(
      t - this.ts[blockIdx],
      this.ts[blockIdx],
      this.ss[blockIdx]
    );
  }

  serialize() {
    return {
      t: "XYMotion",
      blocks: this.blocks.map((b) => b.serialize()),
    };
  }

  static deserialize(o) {
    return new XYMotion(o.blocks.map(Block.deserialize));
  }
}

/**
 * Complete motion plan
 */
export class Plan {
  constructor(motions) {
    this.motions = motions;
  }

  duration(start = 0) {
    return this.motions.slice(start).reduce((sum, m) => sum + m.duration(), 0);
  }

  motion(i) {
    return this.motions[i];
  }

  serialize() {
    return {
      motions: this.motions.map((m) => m.serialize()),
    };
  }

  static deserialize(o) {
    return new Plan(
      o.motions.map((m) => {
        switch (m.t) {
          case "XYMotion":
            return XYMotion.deserialize(m);
          case "PenMotion":
            return PenMotion.deserialize(m);
          default:
            throw new Error(`Unknown motion type: ${m.t}`);
        }
      })
    );
  }
}

/**
 * Internal segment class for planning
 */
class Segment {
  constructor(p1, p2) {
    this.p1 = p1;
    this.p2 = p2;
    this.maxEntryVelocity = 0;
    this.entryVelocity = 0;
    this.blocks = [];
  }

  length() {
    return vlen(vsub(this.p2, this.p1));
  }

  direction() {
    return vnorm(vsub(this.p2, this.p1));
  }
}

/**
 * Calculate maximum velocity for a corner between two segments
 * Based on GRBL cornering algorithm
 */
function cornerVelocity(seg1, seg2, vMax, accel, cornerFactor) {
  const cosine = -vdot(seg1.direction(), seg2.direction());

  // Complete reversal - must stop
  if (Math.abs(cosine - 1) < EPSILON) {
    return 0;
  }

  // Half-angle formula
  const sine = Math.sqrt((1 - cosine) / 2);

  // Straight line - full speed
  if (Math.abs(sine - 1) < EPSILON) {
    return vMax;
  }

  // Junction velocity formula
  const v = Math.sqrt((accel * cornerFactor * sine) / (1 - sine));
  return Math.min(v, vMax);
}

/**
 * Compute a triangular velocity profile (accelerate then decelerate)
 */
function computeTriangle(distance, initialVel, finalVel, accel, p1, p3) {
  const acceleratingDistance =
    (2 * accel * distance + finalVel * finalVel - initialVel * initialVel) /
    (4 * accel);
  const deceleratingDistance = distance - acceleratingDistance;
  const vMax = Math.sqrt(
    initialVel * initialVel + 2 * accel * acceleratingDistance
  );
  const t1 = (vMax - initialVel) / accel;
  const t2 = (finalVel - vMax) / -accel;
  const p2 = vadd(p1, vmul(vnorm(vsub(p3, p1)), acceleratingDistance));

  return {
    s1: acceleratingDistance,
    s2: deceleratingDistance,
    t1,
    t2,
    vMax,
    p1,
    p2,
    p3,
  };
}

/**
 * Compute a trapezoidal velocity profile (accelerate, cruise, decelerate)
 */
function computeTrapezoid(distance, initialVel, maxVel, finalVel, accel, p1, p4) {
  const t1 = (maxVel - initialVel) / accel;
  const s1 = ((maxVel + initialVel) / 2) * t1;
  const t3 = (finalVel - maxVel) / -accel;
  const s3 = ((finalVel + maxVel) / 2) * t3;
  const s2 = distance - s1 - s3;
  const t2 = s2 / maxVel;
  const dir = vnorm(vsub(p4, p1));
  const p2 = vadd(p1, vmul(dir, s1));
  const p3 = vadd(p1, vmul(dir, distance - s3));

  return { s1, s2, s3, t1, t2, t3, p1, p2, p3, p4 };
}

/**
 * Remove duplicate adjacent points
 */
function dedupPoints(points, epsilon) {
  if (epsilon === 0) return points;

  const result = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (vlen(vsub(points[i], result[result.length - 1])) > epsilon) {
      result.push(points[i]);
    }
  }
  return result;
}

/**
 * Plan a constant-acceleration motion for a sequence of points
 */
function constantAccelerationPlan(points, profile) {
  const dedupedPoints = dedupPoints(points, EPSILON);

  // Single point - no motion needed
  if (dedupedPoints.length === 1) {
    return new XYMotion([
      new Block(0, 0, 0, dedupedPoints[0], dedupedPoints[0]),
    ]);
  }

  // Create segments between consecutive points
  const segments = [];
  for (let i = 0; i < dedupedPoints.length - 1; i++) {
    segments.push(new Segment(dedupedPoints[i], dedupedPoints[i + 1]));
  }

  const { acceleration: accel, maximumVelocity: vMax, corneringFactor } = profile;

  // Calculate max entry velocity for each segment based on corner angle
  for (let i = 1; i < segments.length; i++) {
    segments[i].maxEntryVelocity = cornerVelocity(
      segments[i - 1],
      segments[i],
      vMax,
      accel,
      corneringFactor
    );
  }

  // Add virtual final segment to force velocity to zero
  const lastPoint = dedupedPoints[dedupedPoints.length - 1];
  segments.push(new Segment(lastPoint, lastPoint));

  // Forward pass with backtracking
  let i = 0;
  while (i < segments.length - 1) {
    const segment = segments[i];
    const nextSegment = segments[i + 1];
    const distance = segment.length();
    const vInitial = segment.entryVelocity;
    const vExit = nextSegment.maxEntryVelocity;
    const p1 = segment.p1;
    const p2 = segment.p2;

    const m = computeTriangle(distance, vInitial, vExit, accel, p1, p2);

    if (m.s1 < -EPSILON) {
      // Backtrack: can't slow down fast enough
      segment.maxEntryVelocity = Math.sqrt(
        vExit * vExit + 2 * accel * distance
      );
      i -= 1;
    } else if (m.s2 <= 0) {
      // No deceleration needed - just accelerate
      const vFinal = Math.sqrt(vInitial * vInitial + 2 * accel * distance);
      const t = (vFinal - vInitial) / accel;
      segment.blocks = [new Block(accel, t, vInitial, p1, p2)];
      nextSegment.entryVelocity = vFinal;
      i += 1;
    } else if (m.vMax > vMax) {
      // Trapezoid: would exceed max velocity
      const z = computeTrapezoid(distance, vInitial, vMax, vExit, accel, p1, p2);
      segment.blocks = [
        new Block(accel, z.t1, vInitial, z.p1, z.p2),
        new Block(0, z.t2, vMax, z.p2, z.p3),
        new Block(-accel, z.t3, vMax, z.p3, z.p4),
      ];
      nextSegment.entryVelocity = vExit;
      i += 1;
    } else {
      // Triangle: accelerate then decelerate
      segment.blocks = [
        new Block(accel, m.t1, vInitial, m.p1, m.p2),
        new Block(-accel, m.t2, m.vMax, m.p2, m.p3),
      ];
      nextSegment.entryVelocity = vExit;
      i += 1;
    }
  }

  // Collect all blocks with non-zero duration
  const blocks = [];
  for (const segment of segments) {
    for (const block of segment.blocks) {
      if (block.duration > EPSILON) {
        blocks.push(block);
      }
    }
  }

  return new XYMotion(blocks);
}

/**
 * Create a complete motion plan for a set of paths
 *
 * @param {Array<Array<{x: number, y: number}>>} paths - Array of polylines
 * @param {Object} options - Planning options
 * @param {Object} options.device - Device hardware config
 * @returns {Plan} The motion plan
 */
export function createPlan(paths, options = {}) {
  const device = options.device || defaultDevice;
  const profiles = options.device ? createProfiles(device) : defaultProfile;

  const profile = {
    penDownProfile: options.penDownProfile || profiles.penDownProfile,
    penUpProfile: options.penUpProfile || profiles.penUpProfile,
    penUpPos: penPctToPos(options.penUpHeight ?? profiles.penUpHeight, device),
    penDownPos: penPctToPos(options.penDownHeight ?? profiles.penDownHeight, device),
    penDropDuration: options.penDropDuration ?? profiles.penDropDuration,
    penLiftDuration: options.penLiftDuration ?? profiles.penLiftDuration,
  };

  const motions = [];
  let curPos = { x: 0, y: 0 };

  // Determine pen max up position for final lift
  const penMaxUpPos =
    profile.penUpPos < profile.penDownPos
      ? penPctToPos(100, device)
      : penPctToPos(0, device);

  // For each path: travel to start, pen down, draw, pen up
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    if (path.length === 0) continue;

    const drawMotion = constantAccelerationPlan(path, profile.penDownProfile);

    // Position to lift pen to after this path
    const penUpPos = i === paths.length - 1 ? penMaxUpPos : profile.penUpPos;

    // Travel to path start (pen up)
    motions.push(
      constantAccelerationPlan([curPos, drawMotion.p1], profile.penUpProfile)
    );

    // Pen down
    motions.push(
      new PenMotion(
        profile.penUpPos,
        profile.penDownPos,
        profile.penDropDuration
      )
    );

    // Draw the path
    motions.push(drawMotion);

    // Pen up
    motions.push(
      new PenMotion(profile.penDownPos, penUpPos, profile.penLiftDuration)
    );

    curPos = drawMotion.p2;
  }

  // Return home
  motions.push(
    constantAccelerationPlan([curPos, { x: 0, y: 0 }], profile.penUpProfile)
  );

  // Final pen motion to rest position
  motions.push(
    new PenMotion(penMaxUpPos, profile.penUpPos, profile.penDropDuration)
  );

  return new Plan(motions);
}

/**
 * Format duration as mm:ss
 */
export function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
