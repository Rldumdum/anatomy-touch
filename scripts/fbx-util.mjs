// Minimal Node shims so three's FBXLoader can parse geometry (no textures needed).
import fs from 'node:fs';
import * as THREE from 'three';

globalThis.self ??= globalThis;
globalThis.window ??= globalThis;
globalThis.document ??= {
  createElementNS: () => ({ style: {}, addEventListener() {}, removeEventListener() {}, getContext: () => null }),
  createElement: () => ({ style: {}, getContext: () => null }),
};

const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');

export function loadFbx(file) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new FBXLoader();
  // silence texture loading attempts
  loader.manager.setURLModifier(() => 'data:,');
  return loader.parse(ab, '');
}

export { THREE };
