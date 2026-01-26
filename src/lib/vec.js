/**
 * 2D Vector Math Utilities
 *
 * All vectors are plain objects with x and y properties: { x: number, y: number }
 */

/**
 * Squared length of a vector (avoids sqrt for performance when comparing distances)
 */
export function vlen2(a) {
  return a.x * a.x + a.y * a.y;
}

/**
 * Length (magnitude) of a vector
 */
export function vlen(a) {
  return Math.sqrt(vlen2(a));
}

/**
 * Subtract vector b from vector a
 */
export function vsub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

/**
 * Add two vectors
 */
export function vadd(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

/**
 * Multiply vector by scalar
 */
export function vmul(a, s) {
  return { x: a.x * s, y: a.y * s };
}

/**
 * Normalize vector to unit length
 */
export function vnorm(a) {
  const len = vlen(a);
  return len > 0 ? vmul(a, 1 / len) : { x: 0, y: 0 };
}

/**
 * Dot product of two vectors
 */
export function vdot(a, b) {
  return a.x * b.x + a.y * b.y;
}

/**
 * Rotate vector v around center c by angle a (in degrees)
 */
export function vrot(v, c, a) {
  if (a === 0) return v;

  const radians = (Math.PI / 180) * a;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const nx = cos * (v.x - c.x) - sin * (v.y - c.y) + c.x;
  const ny = cos * (v.y - c.y) + sin * (v.x - c.x) + c.y;

  return { x: nx, y: ny };
}
