/** Thrown by `jsonSnapshot()`, saying what kind of value it met but never the value. */
export class NotJsonError extends Error {}

/**
 * A deep copy of `value` made only of what JSON holds: plain objects, arrays, strings,
 * finite numbers, booleans and null. Throws `NotJsonError` for anything JSON would change
 * or lose (a function, `NaN`, a `Map`, a circular reference…) rather than send something
 * other than what the app tracked.
 *
 * JavaScript's conventions are kept, as `JSON.stringify()` keeps them: an object member
 * that is `undefined` is left out, as if it were missing; an object with `toJSON()`, such
 * as a `Date`, is copied as what that answers; and a class instance is its own fields.
 */
export function jsonSnapshot(value: unknown): unknown {
  /** The objects being copied above the current one: meeting one again is a cycle. */
  const ancestors = new Set<object>();
  const copy = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') {
      return item;
    }
    if (typeof item === 'number') {
      if (Number.isFinite(item)) return item;
      throw new NotJsonError('a number JSON has no form for');
    }
    // undefined (in an array), a function, a symbol or a bigint.
    if (typeof item !== 'object') {
      throw new NotJsonError(`a value of type ${typeof item}`);
    }
    if (ancestors.has(item)) throw new NotJsonError('a circular reference');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return Array.from(item, copy);
      const { toJSON } = item as { toJSON?: unknown };
      if (typeof toJSON === 'function') return copy((toJSON as () => unknown).call(item));
      // A class instance, or a plain object from another frame, is its own fields. A
      // built-in such as a Map, Set, RegExp or typed array would be lost or garbled.
      if (Object.prototype.toString.call(item) !== '[object Object]') {
        throw new NotJsonError('an object JSON has no form for, such as a Map');
      }
      const copied: Record<string, unknown> = {};
      for (const [key, member] of Object.entries(item)) {
        if (member !== undefined) copied[key] = copy(member);
      }
      return copied;
    } finally {
      ancestors.delete(item);
    }
  };
  return copy(value);
}
