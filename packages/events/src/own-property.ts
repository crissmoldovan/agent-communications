/**
 * Sets `key` on `target` as an own, enumerable data property. Plain assignment of `__proto__` would call the prototype
 * setter instead of creating the property, so a mapping or schema key of that name — data like any other key (D3, D6)
 * — would vanish or change the object's prototype. Internal: not part of the package's API.
 */
export function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
