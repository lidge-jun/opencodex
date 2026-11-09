// Capture native typed-array accessors so caller-defined properties are never read.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer").get;
const getByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset").get;
const getByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength").get;
const setBytes = Uint8Array.prototype.set;

/** Copy a bounded byte view without invoking caller-defined getters or iterators. */
export function snapshotUpdateBytes(bytes, maxBytes) {
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Invalid update bytes");
  }
  try {
    const length = getByteLength.call(bytes);
    if (length > maxBytes) throw new Error("Update bytes exceed limit");
    const view = new Uint8Array(getBuffer.call(bytes), getByteOffset.call(bytes), length);
    const snapshot = new Uint8Array(length);
    setBytes.call(snapshot, view);
    return snapshot;
  } catch {
    throw new Error("Invalid update bytes");
  }
}
