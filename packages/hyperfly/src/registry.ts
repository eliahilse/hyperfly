import type { Codec } from "./codec.js";

/**
 * Codecs keyed by fingerprint. Rotation is why this exists: retraining a profile
 * produces a new fingerprint, so a deployment that holds only one codec per route
 * turns every rollout into a cutover in which in-flight clients fall back to JSON.
 * Holding the outgoing codec alongside the incoming one makes that a transition.
 */
export class CodecRegistry<T = unknown> {
  private readonly byFingerprint = new Map<string, Codec<T>>();

  /** Codecs of one payload type infer it; codecs of different types make a registry of `unknown`. */
  constructor(codecs?: readonly Codec<T>[]);
  constructor(codecs?: readonly Codec<NoInfer<T>>[]);
  constructor(codecs: readonly Codec<T>[] = []) {
    for (const codec of codecs) this.add(codec);
  }

  add(codec: Codec<T>): this {
    this.byFingerprint.set(codec.fingerprint, codec);
    return this;
  }

  remove(fingerprint: string): boolean {
    return this.byFingerprint.delete(fingerprint);
  }

  get(fingerprint: string): Codec<T> | undefined {
    return this.byFingerprint.get(fingerprint);
  }

  has(fingerprint: string): boolean {
    return this.byFingerprint.has(fingerprint);
  }

  get fingerprints(): string[] {
    return [...this.byFingerprint.keys()];
  }

  get size(): number {
    return this.byFingerprint.size;
  }

  /** The artifact text for a fingerprint, for `.well-known` discovery (negotiation §3). */
  artifact(fingerprint: string): string | undefined {
    return this.byFingerprint.get(fingerprint)?.artifact;
  }

  /**
   * The client's preference wins: the first fingerprint it lists that we can serve.
   * That is what lets a client migrate itself during a rotation without the server
   * tracking who holds what.
   */
  select(accepted: readonly string[]): Codec<T> | undefined {
    for (const fingerprint of accepted) {
      const codec = this.byFingerprint.get(fingerprint);
      if (codec) return codec;
    }
    return undefined;
  }
}
