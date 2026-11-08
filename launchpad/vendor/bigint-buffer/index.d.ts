/// <reference types="node" />
export function toBigIntLE(buf: Buffer): bigint;
export function toBigIntBE(buf: Buffer): bigint;
export function toBufferLE(value: bigint, width: number): Buffer;
export function toBufferBE(value: bigint, width: number): Buffer;
