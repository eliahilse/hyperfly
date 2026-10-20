/** The intrinsic getters see a value's internal slots, so neither a subclass nor another realm can misreport it. */
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayTag = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag)!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")!.get!;

/** Whether `value` is a Uint8Array of any realm, subclasses included. */
export function isUint8Array(value: unknown): value is Uint8Array {
  return typedArrayTag.call(value) === "Uint8Array";
}

/** The real byte length of a value `isUint8Array` accepted. */
export function byteLengthOf(value: Uint8Array): number {
  return typedArrayByteLength.call(value) as number;
}
