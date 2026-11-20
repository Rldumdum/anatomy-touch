import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { makeAttachmentMaterial, makeTissueMaterial, makeTissueUniforms, type TissueKind, type TissueUniforms } from './materials';
import partsData from './data/parts.json';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export type Layer = 'muscle' | 'bone';
export interface PartMeta {
  id: string;
  layer: Layer;
  kind: TissueKind;
  name: string;
  side: 'left' | 'right' | null;
  region: string;
  group: string;
  parent: string | null;
  center: number[];
  radius: number;
  axis: number[];
}
export interface Part extends PartMeta {
  mesh: THREE.Mesh;
  uniforms: TissueUniforms;
  material: THREE.MeshPhysicalMaterial;
  centerV: THREE.Vector3;
}
interface AttachmentMeta { id: string; muscle: string; type: 'origin' | 'insertion'; side: 'left' | 'right' | null }

export const PARTS_META = partsData.parts as PartMeta[];
const ATTACH_META = partsData.attachments as AttachmentMeta[];

export function displaySide(p: Pick<PartMeta, 'side'>) {
  return p.side ? (p.side === 'left' ? 'Left' : 'Right') : '';
}

export class Anatomy {
  root = new THREE.Group();
  parts: Part[] = [];
  byId = new Map<string, Part>();
  byMesh = new Map<THREE.Object3D, Part>();
  layerOn: Record<Layer, boolean> = { muscle: true, bone: true };
  hidden: Part[] = [];
  isolated: Set<Part> | null = null;
  xray = false;
  showAttachments = true;
  selected: Part | null = null;
  private attachRoot = new THREE.Group();
  private attachMeshes = new Map<string, THREE.Mesh>();
  private attachLoading: Promise<void> | null = null;
  private highlightAnim = new Map<Part, number>(); // target highlight
  onChange: () => void = () => {};

  constructor(private loader = new GLTFLoader()) {
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    this.root.add(this.attachRoot);
  }

  async load(onProgress: (frac: number, label: string) => void) {
    const files: [string, Layer][] = [['/models/bones.glb', 'bone'], ['/models/muscles.glb', 'muscle']];
    const sizes = { '/models/bones.glb': 3.6e6, '/models/muscles.glb': 8.4e6 } as Record<string, number>;
    const loaded: Record<string, number> = {};
    const total = Object.values(sizes).reduce((a, b) => a + b, 0);
    const report = () => {
      const sum = Object.values(loaded).reduce((a, b) => a + b, 0);
      onProgress(Math.min(0.97, sum / total), `Loading model  ${(sum / 1e6).toFixed(1)} / 12.0 MB`);
    };
    const metaById = new Map(PARTS_META.map((m) => [m.id, m]));
    await Promise.all(
      files.map(async ([url]) => {
        const gltf = await this.loader.loadAsync(url, (e) => { loaded[url] = e.loaded; report(); });
        gltf.scene.updateMatrixWorld(true);
        const meshes: THREE.Mesh[] = [];
        gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
        for (const m of meshes) {
          const meta = metaById.get(m.name) ?? metaById.get(m.parent?.name ?? '');
          if (!meta) continue;
          this.addPart(meta, m);
        }
      }),
    );
    onProgress(1, 'Ready');
    this.buildBvhInIdle();
  }

  private addPart(meta: PartMeta, src: THREE.Mesh) {
    // Bake the dequantisation transform so mesh space == world space (metres).
    const g = src.geometry;
    const pos = g.attributes.position;
    const out = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(src.matrixWorld);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
    geo.setAttribute('normal', g.attributes.normal);
    geo.setAttribute('_tissue', g.attributes._tissue);
    if (g.attributes._fibre) geo.setAttribute('_fibre', g.attributes._fibre);
    geo.setIndex(g.index);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const centerV = new THREE.Vector3().fromArray(meta.center);
    const uniforms = makeTissueUniforms(centerV, new THREE.Vector3().fromArray(meta.axis), meta.radius);
    const material = makeTissueMaterial(meta.kind, uniforms);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = meta.id;
    mesh.frustumCulled = false; // vertex displacement can push past the bounds
    mesh.renderOrder = meta.layer === 'muscle' ? 2 : 1;
    const part: Part = { ...meta, mesh, uniforms, material, centerV };
    this.parts.push(part);
    this.byId.set(meta.id, part);
    this.byMesh.set(mesh, part);
    this.root.add(mesh);
  }

  private buildBvhInIdle() {
    const queue = [...this.parts].sort((a, b) => (a.layer === 'muscle' ? -1 : 1) - (b.layer === 'muscle' ? -1 : 1));
    const step = () => {
      const t0 = performance.now();
      while (queue.length && performance.now() - t0 < 10) {
        const p = queue.shift()!;
        p.mesh.geometry.computeBoundsTree();
      }
      if (queue.length) setTimeout(step, 0);
    };
    setTimeout(step, 50);
  }

  // ---------- visibility ----------
  isVisible(p: Part) {
    return this.layerOn[p.layer] && !this.hidden.includes(p) && !this.autoPeeled.has(p) && (!this.isolated || this.isolated.has(p));
  }

  /** Muscles temporarily peeled away so a deep target can be seen. */
  autoPeeled = new Set<Part>();

  /**
   * Peel away any muscles that sit between `eye` and the visible face of `target`.
   * Returns how many were peeled.
   */
  reveal(target: Part | Part[], eye: THREE.Vector3) {
    const targets = Array.isArray(target) ? target : [target];
    this.autoPeeled.clear();
    for (const p of this.parts) p.mesh.visible = this.isVisible(p);
    const others = this.parts.filter((p) => !targets.includes(p) && p.mesh.visible && p.layer === 'muscle').map((p) => p.mesh);
    const rc = new THREE.Raycaster();
    const v = new THREE.Vector3(), n = new THREE.Vector3(), dir = new THREE.Vector3();
    const votes = new Map<Part, number>();
    let samples = 0;
    const perTarget = Math.ceil(40 / targets.length);
    for (const t of targets) {
    const pos = t.mesh.geometry.attributes.position;
    const nrm = t.mesh.geometry.attributes.normal;
    const step = Math.max(1, Math.floor(pos.count / (perTarget * 4)));
    let local = 0;
    for (let i = 0; i < pos.count && local < perTarget; i += step) {
      v.fromBufferAttribute(pos, i);
      n.fromBufferAttribute(nrm, i).normalize();
      dir.copy(eye).sub(v);
      if (n.dot(dir) <= 0) continue; // back-facing sample
      samples++;
      local++;
      const dist = dir.length();
      rc.set(eye, dir.multiplyScalar(-1 / dist));
      rc.far = dist - 0.003;
      for (const h of rc.intersectObjects(others, false)) {
        const p = this.byMesh.get(h.object)!;
        votes.set(p, (votes.get(p) ?? 0) + 1);
      }
    }
    }
    for (const [p, c] of votes) if (c >= Math.max(2, samples * 0.08)) this.autoPeeled.add(p);
    this.refresh();
    return this.autoPeeled.size;
  }

  clearReveal() {
    if (!this.autoPeeled.size) return;
    this.autoPeeled.clear();
    this.refresh();
  }

  refresh() {
    for (const p of this.parts) p.mesh.visible = this.isVisible(p);
    this.applyXray();
    this.updateAttachments();
    this.onChange();
  }

  setLayer(layer: Layer, on: boolean) {
    this.layerOn[layer] = on;
    this.refresh();
  }

  hide(p: Part) {
    if (!this.hidden.includes(p)) this.hidden.push(p);
    if (this.isolated) this.isolated.delete(p);
    if (this.isolated && this.isolated.size === 0) this.isolated = null;
    this.refresh();
  }

  showAll() {
    this.hidden = [];
    this.isolated = null;
    this.autoPeeled.clear();
    this.refresh();
  }

  isolate(parts: Part[] | null) {
    this.isolated = parts && parts.length ? new Set(parts) : null;
    if (this.isolated) for (const p of parts!) this.hidden = this.hidden.filter((h) => h !== p);
    this.refresh();
  }

  setXray(on: boolean) {
    this.xray = on;
    this.applyXray();
    this.onChange();
  }

  private applyXray() {
    for (const p of this.parts) {
      const ghost = this.xray && p.layer === 'muscle' && p !== this.selected && !this.selectedGroup.includes(p);
      const m = p.material;
      if (m.transparent !== ghost) {
        m.transparent = ghost;
        m.depthWrite = !ghost;
        m.opacity = ghost ? 0.16 : 1;
        m.needsUpdate = true;
      }
    }
  }

  // ---------- picking ----------
  pick(raycaster: THREE.Raycaster): { part: Part; point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const candidates = this.parts.filter((p) => p.mesh.visible && !(this.xray && p.layer === 'muscle' && this.layerOn.bone && p !== this.selected));
    const hits = raycaster.intersectObjects(candidates.map((p) => p.mesh), false);
    const hit = hits[0];
    if (!hit) return null;
    const part = this.byMesh.get(hit.object)!;
    const normal = hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 0, 1);
    return { part, point: hit.point.clone(), normal };
  }

  // ---------- selection & highlight ----------
  /** Other parts highlighted together with the selection (e.g. all heads of a muscle). */
  selectedGroup: Part[] = [];

  select(p: Part | null, group: Part[] = []) {
    const g = p ? [...new Set([p, ...group])] : [];
    for (const q of [this.selected, ...this.selectedGroup]) if (q && !g.includes(q)) this.highlightAnim.set(q, 0);
    this.selected = p;
    this.selectedGroup = g.filter((q) => q !== p);
    for (const q of g) this.highlightAnim.set(q, 1);
    this.applyXray();
    this.updateAttachments();
    this.onChange();
  }

  setTint(p: Part, color: THREE.ColorRepresentation | null, amt = 1) {
    if (color === null) p.uniforms.uTintAmt.value = 0;
    else { p.uniforms.uTint.value.set(color); p.uniforms.uTintAmt.value = amt; }
  }

  clearTints() { for (const p of this.parts) p.uniforms.uTintAmt.value = 0; }

  /** Animate highlight uniforms. Returns true while animating. */
  update(dt: number, t: number) {
    let active = false;
    for (const [p, target] of this.highlightAnim) {
      const u = p.uniforms.uHighlight;
      const goal = target ? 0.55 + 0.25 * Math.sin(t * 3.2) : 0;
      u.value += (goal - u.value) * (1 - Math.exp(-dt * 10));
      if (target) active = true;
      else if (Math.abs(u.value) < 0.003) { u.value = 0; this.highlightAnim.delete(p); }
      else active = true;
    }
    return active;
  }

  // ---------- attachments ----------
  setShowAttachments(on: boolean) {
    this.showAttachments = on;
    this.updateAttachments();
  }

  hasAttachments(p: Part) {
    return ATTACH_META.some((a) => a.muscle === p.name);
  }

  private updateAttachments() {
    const p = this.selected;
    const want = this.showAttachments && p && p.layer === 'muscle' && this.layerOn.bone;
    if (want && !this.attachLoading) this.attachLoading = this.loadAttachments();
    for (const [id, mesh] of this.attachMeshes) {
      const meta = ATTACH_META.find((a) => a.id === id)!;
      mesh.visible = !!want && meta.muscle === p!.name && (meta.side === p!.side || !meta.side || !p!.side);
    }
  }

  private async loadAttachments() {
    const gltf = await this.loader.loadAsync('/models/attachments.glb');
    gltf.scene.updateMatrixWorld(true);
    const metaById = new Map(ATTACH_META.map((a) => [a.id, a]));
    const mats = { origin: makeAttachmentMaterial('origin'), insertion: makeAttachmentMaterial('insertion') };
    const ghosts = { origin: makeAttachmentMaterial('origin', true), insertion: makeAttachmentMaterial('insertion', true) };
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const meta = metaById.get(m.name) ?? metaById.get(m.parent?.name ?? '');
      if (!meta) return;
      const mesh = new THREE.Mesh(m.geometry, mats[meta.type]);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(m.matrixWorld);
      mesh.renderOrder = 3;
      mesh.visible = false;
      mesh.raycast = () => {};
      // faint see-through copy so patches under the muscle still read
      const ghost = new THREE.Mesh(m.geometry, ghosts[meta.type]);
      ghost.renderOrder = 4;
      ghost.raycast = () => {};
      mesh.add(ghost);
      this.attachMeshes.set(meta.id, mesh);
      this.attachRoot.add(mesh);
    });
    this.updateAttachments();
    this.onChange();
  }
}
