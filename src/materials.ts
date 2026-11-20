import * as THREE from 'three';

/** Per-mesh uniforms that drive soft-tissue deformation and highlighting. */
export interface TissueUniforms {
  uTouchPos: { value: THREE.Vector3 };
  uDent: { value: number };
  uSigma: { value: number };
  uRipple: { value: number };
  uRippleT: { value: number };
  uSway: { value: number };
  uSwayDir: { value: THREE.Vector3 };
  uFlex: { value: number };
  uCenter: { value: THREE.Vector3 };
  uAxis: { value: THREE.Vector3 };
  uRadius: { value: number };
  uShake: { value: THREE.Vector3 };
  uHighlight: { value: number };
  uTint: { value: THREE.Color };
  uTintAmt: { value: number };
  uBump: { value: number };
}

export type TissueKind = 'muscle' | 'tendon' | 'bone' | 'cartilage' | 'tooth';

export function makeTissueUniforms(center: THREE.Vector3, axis: THREE.Vector3, radius: number): TissueUniforms {
  return {
    uTouchPos: { value: new THREE.Vector3(1e3, 1e3, 1e3) },
    uDent: { value: 0 },
    uSigma: { value: 0.02 },
    uRipple: { value: 0 },
    uRippleT: { value: 0 },
    uSway: { value: 0 },
    uSwayDir: { value: new THREE.Vector3(0, 0, 1) },
    uFlex: { value: 0 },
    uCenter: { value: center.clone() },
    uAxis: { value: axis.clone().normalize() },
    uRadius: { value: radius },
    uShake: { value: new THREE.Vector3() },
    uHighlight: { value: 0 },
    uTint: { value: new THREE.Color(0x3ddc97) },
    uTintAmt: { value: 0 },
    uBump: { value: 1 },
  };
}

const NOISE = /* glsl */ `
float tHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float tNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(tHash(i + vec3(0,0,0)), tHash(i + vec3(1,0,0)), f.x),
                 mix(tHash(i + vec3(0,1,0)), tHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(tHash(i + vec3(0,0,1)), tHash(i + vec3(1,0,1)), f.x),
                 mix(tHash(i + vec3(0,1,1)), tHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
vec3 tPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
  vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
  vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
  vec3 R1 = cross(vSigmaY, surf_norm);
  vec3 R2 = cross(surf_norm, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDir;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
`;

const UNIFORM_DECL = /* glsl */ `
uniform vec3 uTouchPos; uniform float uDent; uniform float uSigma; uniform float uRipple; uniform float uRippleT;
uniform float uSway; uniform vec3 uSwayDir; uniform float uFlex; uniform vec3 uCenter; uniform vec3 uAxis;
uniform float uRadius; uniform vec3 uShake; uniform float uHighlight; uniform vec3 uTint; uniform float uTintAmt; uniform float uBump;
varying float vTissue; varying vec3 vObjPos;
#ifdef MUSCLE
varying vec3 vFibre;
#endif
`;

const VERT_SOFT = /* glsl */ `
#include <beginnormal_vertex>
vTissue = _tissue;
vObjPos = position;
vec3 softOffset = uShake;
#ifdef MUSCLE
vFibre = _fibre;
{
  float belly = 1.0 - smoothstep(0.3, 0.85, _tissue);
  // contraction: belly bulges perpendicular to the line of pull, ends stay anchored
  vec3 rel = position - uCenter;
  float a = dot(rel, uAxis);
  vec3 perp = rel - a * uAxis;
  float prof = clamp(1.0 - (a * a) / (uRadius * uRadius * 0.7), 0.0, 1.0);
  softOffset += perp * (uFlex * 0.3 * prof * belly);
  // finger press: gaussian dent along the surface normal
  vec3 d = position - uTouchPos;
  float r2 = dot(d, d);
  float s2 = uSigma * uSigma;
  float g = exp(-r2 / s2);
  float w = mix(0.2, 1.0, belly);
  float dent = uDent * g * w;
  softOffset -= objectNormal * dent;
  // ripple that runs away from the contact point
  float r = sqrt(r2);
  softOffset += objectNormal * (uRipple * sin(r * 6.2831 / (uSigma * 2.4) - uRippleT * 34.0) * exp(-r / (uSigma * 3.0)) * belly);
  // whole-belly jiggle, pinned at the tendons
  softOffset += uSwayDir * (uSway * exp(-r2 / (s2 * 12.0)) * belly);
  // tilt the normal to follow the dent so lighting sells the deformation
  vec3 gradH = (2.0 * dent / s2) * d;
  objectNormal = normalize(objectNormal - (gradH - objectNormal * dot(gradH, objectNormal)));
}
#endif
`;

function patch(kind: TissueKind, uniforms: TissueUniforms) {
  const muscle = kind === 'muscle' || kind === 'tendon';
  return (shader: THREE.WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float _tissue;\n${muscle ? 'attribute vec3 _fibre;' : ''}\n${UNIFORM_DECL}`)
      .replace('#include <beginnormal_vertex>', VERT_SOFT)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += softOffset;');

    const colour = muscle
      ? /* glsl */ `
  float tend = smoothstep(0.3, 0.8, vTissue);
  vec3 F = normalize(vFibre + 1e-5);
  vec3 Q = vObjPos - F * dot(vObjPos, F);
  float n1 = tNoise(Q * 430.0);
  float n2 = tNoise(Q * 1300.0 + 3.7);
  float mott = tNoise(vObjPos * 22.0);
  float mott2 = tNoise(vObjPos * 70.0 + 9.1);
  vec3 bellyCol = mix(vec3(0.20, 0.018, 0.016), vec3(0.36, 0.045, 0.035), mott * 0.7 + mott2 * 0.3);
  bellyCol *= 0.74 + 0.38 * n1 + 0.1 * n2;
  vec3 tendonCol = mix(vec3(0.70, 0.66, 0.58), vec3(0.86, 0.84, 0.80), n2) ;
  vec3 tissueCol = mix(bellyCol, tendonCol, tend);
  float fw = length(fwidth(Q * 430.0));
  float fade = 1.0 - smoothstep(0.35, 1.1, fw);
  float hgt = (n1 * 0.7 + n2 * 0.3) * fade * mix(1.0, 0.35, tend);
  float tRough = mix(0.52, 0.34, tend) - 0.12 * n1;
`
      : /* glsl */ `
  float tend = smoothstep(0.3, 0.8, vTissue);
  float n1 = tNoise(vObjPos * 240.0);
  float n2 = tNoise(vObjPos * 820.0 + 1.3);
  float mott = tNoise(vObjPos * 16.0);
  #ifdef TOOTH
  vec3 baseCol = mix(vec3(0.60, 0.48, 0.30), vec3(0.66, 0.55, 0.36), mott);
  vec3 altCol = vec3(0.86, 0.85, 0.79);
  #else
  vec3 baseCol = mix(vec3(0.62, 0.53, 0.38), vec3(0.76, 0.69, 0.54), mott * 0.8 + n1 * 0.2);
  vec3 altCol = mix(vec3(0.62, 0.70, 0.74), vec3(0.74, 0.80, 0.82), n2);
  #endif
  vec3 tissueCol = mix(baseCol * (0.93 + 0.09 * n2), altCol, tend);
  float fw = length(fwidth(vObjPos * 820.0));
  float hgt = (n2 * 0.6 + n1 * 0.4) * (1.0 - smoothstep(0.4, 1.2, fw)) * (1.0 - tend) * 0.6;
  float tRough = mix(0.66, 0.26, tend) - 0.08 * n1;
`;

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${UNIFORM_DECL}\n${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${colour}\n  diffuseColor.rgb = mix(tissueCol, uTint, uTintAmt * 0.55);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = clamp(tRough, 0.08, 1.0);')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n  normal = tPerturb(-vViewPosition, normal, vec2(dFdx(hgt), dFdy(hgt)) * 0.012 * uBump, faceDirection);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
  float fres = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.2);
  totalEmissiveRadiance += uHighlight * (0.16 + 1.6 * fres) * vec3(1.0, 0.72, 0.42);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.35, 1.2, 1.0) + vec3(0.06, 0.04, 0.0), clamp(uHighlight, 0.0, 1.0));
  totalEmissiveRadiance += uTintAmt * uTint * (0.05 + 0.35 * fres);`,
      );
  };
}

export function makeTissueMaterial(kind: TissueKind, uniforms: TissueUniforms): THREE.MeshPhysicalMaterial {
  const muscle = kind === 'muscle' || kind === 'tendon';
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.5,
    metalness: 0,
    clearcoat: muscle ? 0.32 : kind === 'tooth' ? 0.5 : 0.12,
    clearcoatRoughness: muscle ? 0.38 : 0.5,
    sheen: muscle ? 0.5 : 0.15,
    sheenRoughness: 0.55,
    sheenColor: muscle ? new THREE.Color(0.85, 0.32, 0.26) : new THREE.Color(0.9, 0.85, 0.7),
  });
  if (muscle) m.defines = { MUSCLE: '' };
  if (kind === 'tooth') m.defines = { TOOTH: '' };
  m.onBeforeCompile = patch(kind, uniforms);
  m.customProgramCacheKey = () => `tissue-${muscle ? 'm' : kind === 'tooth' ? 't' : 'b'}`;
  m.userData.uniforms = uniforms;
  return m;
}

export function makeAttachmentMaterial(type: 'origin' | 'insertion', ghost = false): THREE.Material {
  const c = type === 'origin' ? new THREE.Color(0xff5b3a) : new THREE.Color(0x3d8bff);
  if (ghost) return new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.32, depthTest: false, depthWrite: false });
  return new THREE.MeshStandardMaterial({
    color: c,
    emissive: c,
    emissiveIntensity: 0.55,
    roughness: 0.4,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -6,
    transparent: true,
    opacity: 0.92,
  });
}
