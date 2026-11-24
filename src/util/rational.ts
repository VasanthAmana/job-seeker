/**
 * Exact decimal arithmetic for score weighting.
 *
 * Ported from rank_state.overall_score, which used Python's Fraction over
 * the decimal *string* of each value and weight: binary float summation can
 * turn 59.5 into 59.49999999999999 and drop an otherwise valid result into
 * the lower band. A number's shortest round-trip string (what JavaScript's
 * String() and Python's str() both print) is parsed into a BigInt fraction.
 */

export interface Rational {
  num: bigint;
  den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x === 0n ? 1n : x;
}

function reduce(num: bigint, den: bigint): Rational {
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

/** The exact value of a finite number's decimal representation. */
export function fromNumber(value: number): Rational {
  if (!Number.isFinite(value)) {
    throw new RangeError(`not a finite number: ${value}`);
  }
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) {
    throw new RangeError(`cannot parse number: ${text}`);
  }
  const [, sign, whole = "0", frac = "", exp = "0"] = match;
  let num = BigInt(`${whole}${frac}`);
  let den = 10n ** BigInt(frac.length);
  const e = Number(exp);
  if (e > 0) num *= 10n ** BigInt(e);
  if (e < 0) den *= 10n ** BigInt(-e);
  if (sign === "-") num = -num;
  return reduce(num, den);
}

export function add(a: Rational, b: Rational): Rational {
  return reduce(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function mul(a: Rational, b: Rational): Rational {
  return reduce(a.num * b.num, a.den * b.den);
}

export const ZERO: Rational = { num: 0n, den: 1n };

/** int(x + 1/2): Python's `int()` truncates toward zero. */
export function roundHalfUp(x: Rational): number {
  const shifted = add(x, { num: 1n, den: 2n });
  return Number(shifted.num / shifted.den);
}
