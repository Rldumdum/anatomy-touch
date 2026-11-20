import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
// @ts-expect-error n8ao ships without types
import { N8AOPass } from 'n8ao';

export const HOME_TARGET = new THREE.Vector3(0, 0.98, 0);
const HOME_DIR = new THREE.Vector3(0.18, 0.06, 1).normalize();
let HOME_DIST = 3.6;
/** Distance that fits the whole 1.75 m body (plus margin) for the current aspect. */
function homeDistance(fovDeg: number, aspect: number) {
  const half = THREE.MathUtils.degToRad(fovDeg) / 2;
  const byHeight = 1.0 / Math.tan(half);
  const byWidth = 0.55 / (Math.tan(half) * aspect);
  return Math.max(byHeight, byWidth);
}

export class Viewer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  composer: EffectComposer | null = null;
  ao: any = null;
  quality: 'high' | 'fast' = 'high';
  private dirtyFrames = 2;
  private animating = new Set<string>();
  private focusGoal: { target: THREE.Vector3; dist: number; dir?: THREE.Vector3 } | null = null;
  private frameTimes: number[] = [];
  onFrame: (dt: number, t: number) => boolean = () => false;
  onQualityDrop: () => void = () => {};

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.02, 40);
    this.camera.position.copy(HOME_TARGET).addScaledVector(HOME_DIR, HOME_DIST);
    this.scene.add(this.camera);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(HOME_TARGET);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.rotateSpeed = 0.75;
    this.controls.zoomSpeed = 1.1;
    this.controls.panSpeed = 0.9;
    this.controls.minDistance = 0.12;
    this.controls.maxDistance = 5.5;
    this.controls.screenSpacePanning = true;
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.addEventListener('change', () => this.invalidate());
    this.controls.addEventListener('start', () => { this.focusGoal = null; });

    this.setupLook();
    this.setupPost();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    // iOS Safari: block page-level pinch zoom gestures
    document.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  private setupLook() {
    // Specimen-room backdrop: warm vignette
    const c = document.createElement('canvas');
    c.width = 16; c.height = 512;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#191514');
    grad.addColorStop(0.55, '#2a2422');
    grad.addColorStop(1, '#100e0d');
    g.fillStyle = grad;
    g.fillRect(0, 0, 16, 512);
    const bg = new THREE.CanvasTexture(c);
    bg.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = bg;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.5;

    // Lights ride with the camera so whatever you rotate to is well lit.
    const key = new THREE.DirectionalLight(0xfff1e2, 2.6);
    key.position.set(-1.6, 2.2, 1.2);
    const fill = new THREE.DirectionalLight(0xc9d8ff, 0.55);
    fill.position.set(2.2, -0.4, 0.8);
    const rim = new THREE.DirectionalLight(0xffe3cf, 2.2);
    rim.position.set(1.2, 1.6, -6);
    const target = new THREE.Object3D();
    target.position.set(0, 0, -HOME_DIST);
    this.camera.add(target);
    for (const l of [key, fill, rim]) { l.target = target; this.camera.add(l); }
    this.scene.add(new THREE.HemisphereLight(0xfff4ea, 0x2a1d18, 0.35));

    // Soft contact shadow under the feet
    const sc = document.createElement('canvas');
    sc.width = sc.height = 128;
    const sg = sc.getContext('2d')!;
    const rg = sg.createRadialGradient(64, 64, 0, 64, 64, 64);
    rg.addColorStop(0, 'rgba(0,0,0,0.55)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    sg.fillStyle = rg;
    sg.fillRect(0, 0, 128, 128);
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.6),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -0.002;
    shadow.renderOrder = -1;
    this.scene.add(shadow);
  }

  private setupPost() {
    try {
      const w = window.innerWidth, h = window.innerHeight;
      this.composer = new EffectComposer(this.renderer);
      this.ao = new N8AOPass(this.scene, this.camera, w, h);
      Object.assign(this.ao.configuration, {
        aoRadius: 0.045,
        distanceFalloff: 1.0,
        intensity: 2.6,
        halfRes: true,
        gammaCorrection: false,
        color: new THREE.Color(0x0a0202),
      });
      this.ao.setQualityMode('Medium');
      this.composer.addPass(this.ao);
      this.composer.addPass(new SMAAPass(w, h));
      this.composer.addPass(new OutputPass());
    } catch (e) {
      console.warn('Post-processing unavailable, using direct render', e);
      this.composer = null;
      this.quality = 'fast';
    }
  }

  setQuality(q: 'high' | 'fast') {
    this.quality = q;
    this.renderer.setPixelRatio(q === 'high' ? Math.min(window.devicePixelRatio, 1.75) : Math.min(window.devicePixelRatio, 2));
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the whole body framed in portrait too
    this.camera.fov = w / h < 0.9 ? 40 : 32;
    this.camera.updateProjectionMatrix();
    const fresh = this.camera.position.distanceTo(this.controls.target) === HOME_DIST && this.controls.target.equals(HOME_TARGET);
    HOME_DIST = homeDistance(this.camera.fov, this.camera.aspect);
    if (fresh || !this.started) this.camera.position.copy(HOME_TARGET).addScaledVector(HOME_DIR, HOME_DIST);
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
    this.invalidate();
  }

  invalidate(frames = 2) { this.dirtyFrames = Math.max(this.dirtyFrames, frames); }
  hold(key: string, on: boolean) { if (on) this.animating.add(key); else this.animating.delete(key); this.invalidate(); }

  focus(center: THREE.Vector3, radius: number, dir?: THREE.Vector3) {
    const fovR = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const fit = Math.max(radius * 1.25, 0.06) / Math.sin(Math.min(fovR, fovR * this.camera.aspect));
    const goal = { target: center.clone(), dist: THREE.MathUtils.clamp(fit, 0.18, 3.2), dir: dir?.clone().normalize() };
    this.focusGoal = goal;
    this.invalidate();
    const d = goal.dir ?? this.camera.position.clone().sub(this.controls.target).normalize();
    return goal.target.clone().addScaledVector(d, goal.dist); // where the camera will end up
  }

  home() {
    this.focusGoal = { target: HOME_TARGET.clone(), dist: HOME_DIST, dir: HOME_DIR.clone() };
    this.invalidate();
  }

  /** Rotate the orbit by screen-space deltas (used by hand gestures). */
  orbitBy(dAzimuth: number, dPolar: number) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const sph = new THREE.Spherical().setFromVector3(offset);
    sph.theta -= dAzimuth;
    sph.phi = THREE.MathUtils.clamp(sph.phi - dPolar, 0.05, Math.PI - 0.05);
    offset.setFromSpherical(sph);
    this.camera.position.copy(this.controls.target).add(offset);
    this.camera.lookAt(this.controls.target);
    this.focusGoal = null;
    this.invalidate();
  }

  zoomBy(factor: number) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const d = THREE.MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    offset.setLength(d);
    this.camera.position.copy(this.controls.target).add(offset);
    this.focusGoal = null;
    this.invalidate();
  }

  private stepFocus(dt: number) {
    if (!this.focusGoal) return false;
    const k = 1 - Math.exp(-dt * 6.5);
    const { target, dist, dir } = this.focusGoal;
    this.controls.target.lerp(target, k);
    const offset = this.camera.position.clone().sub(this.controls.target);
    const curDir = offset.clone().normalize();
    const newDir = dir ? curDir.lerp(dir, k).normalize() : curDir;
    const newDist = THREE.MathUtils.lerp(offset.length(), dist, k);
    this.camera.position.copy(this.controls.target).addScaledVector(newDir, newDist);
    if (this.controls.target.distanceTo(target) < 1e-4 && Math.abs(newDist - dist) < 1e-4) this.focusGoal = null;
    return true;
  }

  private started = false;

  start() {
    this.started = true;
    const clock = new THREE.Clock();
    let lowFrames = 0;
    const loop = () => {
      requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 1 / 20);
      const t = clock.elapsedTime;
      const moving = this.stepFocus(dt);
      this.controls.update();
      const active = this.onFrame(dt, t);
      if (moving || active || this.animating.size) this.invalidate(1);
      if (this.dirtyFrames <= 0) return;
      this.dirtyFrames--;
      if (this.quality === 'high' && this.composer) this.composer.render(dt);
      else this.renderer.render(this.scene, this.camera);
      // Adaptive quality: sustained slow frames drop AO / SMAA
      this.frameTimes.push(dt);
      if (this.frameTimes.length > 45) this.frameTimes.shift();
      if (this.quality === 'high' && this.frameTimes.length === 45) {
        const avg = this.frameTimes.reduce((a, b) => a + b, 0) / 45;
        lowFrames = avg > 1 / 26 ? lowFrames + 1 : 0;
        if (lowFrames > 90) { this.setQuality('fast'); this.onQualityDrop(); }
      }
    };
    loop();
  }
}
