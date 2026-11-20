import * as THREE from 'three';
import type { Anatomy, Part } from './anatomy';
import type { SoftTissue } from './soft';
import type { Viewer } from './viewer';

export interface InputHandlers {
  onTap(part: Part | null): void;
  onDoubleTap(part: Part): void;
  onInteract(): void;
}

const MOVE_TOL = 9; // px before a touch becomes a rotate
const TAP_MS = 320;
const DOUBLE_MS = 330;

/** Screen-space picking + touch semantics layered on top of OrbitControls. */
export class Input {
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private pointers = new Map<number, { x: number; y: number }>();
  private press: { id: number; x: number; y: number; t: number; part: Part | null; moved: boolean; multi: boolean } | null = null;
  private lastTap: { t: number; part: Part | null } = { t: 0, part: null };

  constructor(private viewer: Viewer, private anatomy: Anatomy, private soft: SoftTissue, private h: InputHandlers) {
    const el = viewer.canvas;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.cancel(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  pickAt(clientX: number, clientY: number) {
    const r = this.viewer.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.viewer.camera);
    return this.anatomy.pick(this.raycaster);
  }

  private down(e: PointerEvent) {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.h.onInteract();
    if (this.pointers.size > 1) {
      // second finger: this is a pinch/pan, not a poke
      if (this.press) {
        this.press.multi = true;
        if (this.press.part) this.soft.release(this.press.part, 0.4);
      }
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const hit = this.pickAt(e.clientX, e.clientY);
    this.press = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), part: hit?.part ?? null, moved: false, multi: false };
    if (hit) {
      this.soft.press(hit.part, hit.point, hit.normal);
      this.viewer.invalidate();
    }
  }

  private move(e: PointerEvent) {
    const p = this.pointers.get(e.pointerId);
    if (p) { p.x = e.clientX; p.y = e.clientY; }
    const pr = this.press;
    if (!pr || pr.id !== e.pointerId || pr.moved) return;
    if (Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > MOVE_TOL) {
      pr.moved = true;
      if (pr.part) this.soft.release(pr.part, 0.5);
    }
  }

  private up(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    const pr = this.press;
    if (!pr || pr.id !== e.pointerId) return;
    this.press = null;
    if (pr.part) this.soft.release(pr.part, 1);
    if (pr.moved || pr.multi) return;
    const now = performance.now();
    const held = now - pr.t > TAP_MS;
    if (!held && pr.part && this.lastTap.part === pr.part && now - this.lastTap.t < DOUBLE_MS) {
      this.lastTap = { t: 0, part: null };
      this.h.onDoubleTap(pr.part);
      return;
    }
    this.lastTap = { t: now, part: pr.part };
    // a long press on empty space shouldn't clear the selection
    if (!pr.part && held) return;
    this.h.onTap(pr.part);
  }

  private cancel(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    if (this.press?.id === e.pointerId) {
      if (this.press.part) this.soft.release(this.press.part, 0.5);
      this.press = null;
    }
  }
}
