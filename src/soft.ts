import * as THREE from 'three';
import type { Part } from './anatomy';

/**
 * Soft-tissue response for muscles (and a rigid knock for bones).
 *
 * Each touched part runs three coupled damped oscillators:
 *  - dent:   local indentation under the finger (stiff, ~critically damped while pressed, underdamped on release)
 *  - sway:   whole-belly jiggle pinned at the tendons (low frequency, lightly damped, like flesh)
 *  - ripple: a decaying surface wave travelling away from the contact point
 */
interface State {
  part: Part;
  pressing: boolean;
  pressT: number;
  dent: number;
  dentV: number;
  depth: number;
  sway: number;
  swayV: number;
  swayK: number;
  ripple: number;
  rippleT: number;
  flex: number;
  flexT: number; // <0 inactive
  shakeT: number; // <0 inactive
  shakeDir: THREE.Vector3;
}

export class SoftTissue {
  private states = new Map<Part, State>();

  private state(part: Part): State {
    let s = this.states.get(part);
    if (!s) {
      const r = part.radius;
      const tendon = part.kind === 'tendon';
      s = {
        part,
        pressing: false,
        pressT: 0,
        dent: 0,
        dentV: 0,
        depth: THREE.MathUtils.clamp(r * 0.11, 0.004, 0.016) * (tendon ? 0.3 : 1),
        sway: 0,
        swayV: 0,
        // bigger muscles wobble slower (≈3–7 Hz)
        swayK: (2 * Math.PI * THREE.MathUtils.clamp(7.5 - r * 14, 3.2, 7.5)) ** 2,
        ripple: 0,
        rippleT: 0,
        flex: 0,
        flexT: -1,
        shakeT: -1,
        shakeDir: new THREE.Vector3(),
      };
      part.uniforms.uSigma.value = THREE.MathUtils.clamp(r * 0.26, 0.011, 0.04);
      this.states.set(part, s);
    }
    return s;
  }

  press(part: Part, point: THREE.Vector3, normal: THREE.Vector3) {
    const s = this.state(part);
    if (part.layer === 'bone') {
      s.shakeT = 0;
      s.shakeDir.copy(normal).multiplyScalar(-1);
      return;
    }
    part.uniforms.uTouchPos.value.copy(point);
    part.uniforms.uSwayDir.value.copy(normal).multiplyScalar(-1);
    s.pressing = true;
    s.pressT = 0;
    s.ripple = s.depth * 0.16;
    s.rippleT = 0;
    s.swayV -= s.depth * 2.5;
  }

  /** Move the contact point while pressing (e.g. pinch-drag in gesture mode). */
  drag(part: Part, point: THREE.Vector3) {
    if (this.states.get(part)?.pressing) part.uniforms.uTouchPos.value.lerp(point, 0.5);
  }

  release(part: Part, strength = 1) {
    const s = this.states.get(part);
    if (!s || part.layer === 'bone') return;
    if (!s.pressing) return;
    s.pressing = false;
    // flesh springs back past rest: kick the sway with the stored indentation
    s.swayV += (s.dent / Math.max(s.depth, 1e-4)) * s.depth * 9 * strength;
    s.ripple = s.depth * 0.24 * strength;
    s.rippleT = 0;
  }

  releaseAll() { for (const s of this.states.values()) this.release(s.part, 0.6); }

  flex(part: Part) {
    if (part.layer !== 'muscle') return;
    const s = this.state(part);
    s.flexT = 0;
  }

  isFlexing(part: Part) { return (this.states.get(part)?.flexT ?? -1) >= 0; }

  /** Integrate; returns true while anything is still moving. */
  update(dt: number) {
    let active = false;
    const sub = 4;
    const h = dt / sub;
    for (const s of this.states.values()) {
      const u = s.part.uniforms;
      if (s.part.layer === 'bone') {
        if (s.shakeT >= 0) {
          s.shakeT += dt;
          const a = 0.0016 * Math.sin(s.shakeT * 2 * Math.PI * 26) * Math.exp(-s.shakeT * 13);
          u.uShake.value.copy(s.shakeDir).multiplyScalar(a);
          if (s.shakeT > 0.5) { s.shakeT = -1; u.uShake.value.set(0, 0, 0); }
          active = true;
        }
        continue;
      }
      if (s.pressing) s.pressT += dt;
      const target = s.pressing ? s.depth * Math.min(1, 0.55 + s.pressT * 0.9) : 0;
      const kD = s.pressing ? 420 : 300;
      const cD = s.pressing ? 2 * Math.sqrt(kD) * 0.9 : 2 * Math.sqrt(kD) * 0.22;
      const cS = 2 * Math.sqrt(s.swayK) * 0.085;
      for (let i = 0; i < sub; i++) {
        s.dentV += (kD * (target - s.dent) - cD * s.dentV) * h;
        s.dent += s.dentV * h;
        s.swayV += (-s.swayK * s.sway - cS * s.swayV) * h;
        s.sway += s.swayV * h;
      }
      s.rippleT += dt;
      s.ripple *= Math.exp(-dt * 4.5);
      // contraction envelope: 0.35s in, 0.7s hold with tremor, 0.6s out
      if (s.flexT >= 0) {
        s.flexT += dt;
        const t = s.flexT;
        const ease = (x: number) => x * x * (3 - 2 * x);
        s.flex = t < 0.35 ? ease(t / 0.35) : t < 1.05 ? 1 + 0.03 * Math.sin(t * 60) : t < 1.65 ? 1 - ease((t - 1.05) / 0.6) : 0;
        if (t >= 1.65) { s.flexT = -1; s.flex = 0; s.swayV += s.depth * 4; }
      }
      u.uDent.value = s.dent;
      u.uSway.value = s.sway;
      u.uRipple.value = s.ripple;
      u.uRippleT.value = s.rippleT;
      u.uFlex.value = s.flex;
      u.uBump.value = 1 + s.flex * 0.8;
      const moving =
        s.pressing || s.flexT >= 0 || Math.abs(s.dent) > 1e-5 || Math.abs(s.dentV) > 1e-4 || Math.abs(s.sway) > 2e-5 || Math.abs(s.swayV) > 2e-4 || s.ripple > 1e-5;
      if (moving) active = true;
      else {
        u.uDent.value = u.uSway.value = u.uRipple.value = 0;
        this.states.delete(s.part);
      }
    }
    return active;
  }
}
