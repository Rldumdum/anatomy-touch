import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export type Pose = 'palm' | 'pinch' | 'fist' | 'point' | 'none';

export interface GestureCallbacks {
  rotate(dx: number, dy: number): void; // normalised screen deltas
  zoom(factor: number): void;
  cursor(x: number, y: number, pose: Pose): void; // client px
  pinchStart(x: number, y: number): void;
  pinchMove(x: number, y: number): void;
  pinchEnd(x: number, y: number, quick: boolean): void;
  status(text: string): void;
  lost(): void;
}

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

const dist = (a: NormalizedLandmark, b: NormalizedLandmark) => Math.hypot(a.x - b.x, a.y - b.y, (a.z - b.z) * 0.5);

function classify(lm: NormalizedLandmark[]): { pose: Pose; pinchDist: number; size: number } {
  const size = dist(lm[0], lm[9]) || 1e-3; // wrist → middle knuckle
  const ext = (tip: number, pip: number) => dist(lm[0], lm[tip]) > dist(lm[0], lm[pip]) * 1.12;
  const index = ext(8, 6), middle = ext(12, 10), ring = ext(16, 14), pinky = ext(20, 18);
  const pinchDist = dist(lm[4], lm[8]) / size;
  if (pinchDist < 0.33) return { pose: 'pinch', pinchDist, size };
  const n = [index, middle, ring, pinky].filter(Boolean).length;
  if (n >= 4) return { pose: 'palm', pinchDist, size };
  if (n === 0) return { pose: 'fist', pinchDist, size };
  if (index && !middle && !ring) return { pose: 'point', pinchDist, size };
  return { pose: 'none', pinchDist, size };
}

/** Front-camera hand tracking mapped to orbit / zoom / tap gestures. */
export class GestureControl {
  private video: HTMLVideoElement;
  private overlay: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private running = false;
  private lastVideoTime = -1;
  private smooth: { x: number; y: number } | null = null;
  private prevPose: Pose = 'none';
  private prevPalm: { x: number; y: number } | null = null;
  private prevFistY: number | null = null;
  private pinch: { t: number; x: number; y: number; moved: number } | null = null;
  private twoHandDist: number | null = null;
  private poseVotes: Pose[] = [];

  constructor(private cb: GestureCallbacks) {
    this.video = document.getElementById('gesture-video') as HTMLVideoElement;
    this.overlay = document.getElementById('gesture-overlay') as HTMLCanvasElement;
    this.ctx = this.overlay.getContext('2d')!;
  }

  async start() {
    this.cb.status('Requesting camera…');
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.cb.status('Loading hand model…');
    if (!this.landmarker) {
      const fileset = await FilesetResolver.forVisionTasks(WASM);
      const opts = (delegate: 'GPU' | 'CPU') => ({
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO' as const,
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.5,
      });
      try { this.landmarker = await HandLandmarker.createFromOptions(fileset, opts('GPU')); }
      catch { this.landmarker = await HandLandmarker.createFromOptions(fileset, opts('CPU')); }
    }
    this.overlay.width = this.video.videoWidth || 640;
    this.overlay.height = this.video.videoHeight || 480;
    this.running = true;
    this.cb.status('Show your hand ✋');
    this.loop();
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.pinch) { this.cb.pinchEnd(this.smooth?.x ?? 0, this.smooth?.y ?? 0, false); this.pinch = null; }
    this.cb.lost();
  }

  private loop = () => {
    if (!this.running || !this.landmarker) return;
    requestAnimationFrame(this.loop);
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;
    const res = this.landmarker.detectForVideo(this.video, performance.now());
    this.draw(res.landmarks);
    this.handle(res.landmarks);
  };

  private draw(hands: NormalizedLandmark[][]) {
    const { ctx, overlay: c } = this;
    ctx.clearRect(0, 0, c.width, c.height);
    for (const lm of hands) {
      ctx.strokeStyle = 'rgba(242,181,122,0.9)';
      ctx.lineWidth = 3;
      for (const [a, b] of CONNECTIONS) {
        ctx.beginPath();
        ctx.moveTo(lm[a].x * c.width, lm[a].y * c.height);
        ctx.lineTo(lm[b].x * c.width, lm[b].y * c.height);
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      for (const p of lm) { ctx.beginPath(); ctx.arc(p.x * c.width, p.y * c.height, 3, 0, Math.PI * 2); ctx.fill(); }
    }
  }

  private toScreen(nx: number, ny: number) {
    // mirror horizontally; use the central 70% of the camera frame for full-screen reach
    const m = 0.15;
    const x = Math.min(1, Math.max(0, (1 - nx - m) / (1 - 2 * m)));
    const y = Math.min(1, Math.max(0, (ny - m) / (1 - 2 * m)));
    return { x: x * window.innerWidth, y: y * window.innerHeight };
  }

  private handle(hands: NormalizedLandmark[][]) {
    if (!hands.length) {
      if (this.prevPose !== 'none') this.cb.status('Show your hand ✋');
      if (this.pinch) { this.cb.pinchEnd(this.smooth!.x, this.smooth!.y, false); this.pinch = null; }
      this.prevPose = 'none';
      this.prevPalm = null;
      this.prevFistY = null;
      this.twoHandDist = null;
      this.smooth = null;
      this.cb.lost();
      return;
    }

    // two hands pinching: spread to zoom
    if (hands.length === 2) {
      const a = classify(hands[0]), b = classify(hands[1]);
      if (a.pose === 'pinch' && b.pose === 'pinch') {
        const d = Math.hypot(hands[0][8].x - hands[1][8].x, hands[0][8].y - hands[1][8].y);
        if (this.twoHandDist) this.cb.zoom(Math.pow(this.twoHandDist / d, 1.6));
        this.twoHandDist = d;
        this.cb.status('Two-hand zoom');
        return;
      }
    }
    this.twoHandDist = null;

    const lm = hands[0];
    const { pose: raw } = classify(lm);
    // small majority filter to stop flicker between poses
    this.poseVotes.push(raw);
    if (this.poseVotes.length > 4) this.poseVotes.shift();
    const counts = new Map<Pose, number>();
    for (const p of this.poseVotes) counts.set(p, (counts.get(p) ?? 0) + 1);
    const pose = raw === 'pinch' || this.prevPose === 'pinch' ? raw : [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];

    // cursor: midpoint of thumb+index when pinching, index tip otherwise
    const src = pose === 'pinch' ? { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 } : pose === 'palm' || pose === 'fist' ? lm[9] : lm[8];
    const target = this.toScreen(src.x, src.y);
    const k = 0.45;
    this.smooth = this.smooth ? { x: this.smooth.x + (target.x - this.smooth.x) * k, y: this.smooth.y + (target.y - this.smooth.y) * k } : target;
    const { x, y } = this.smooth;
    this.cb.cursor(x, y, pose);

    // pinch → tap / squeeze
    if (pose === 'pinch' && this.prevPose !== 'pinch') {
      this.pinch = { t: performance.now(), x, y, moved: 0 };
      this.cb.pinchStart(x, y);
    } else if (pose === 'pinch' && this.pinch) {
      this.pinch.moved = Math.max(this.pinch.moved, Math.hypot(x - this.pinch.x, y - this.pinch.y));
      this.cb.pinchMove(x, y);
    } else if (pose !== 'pinch' && this.pinch) {
      const quick = performance.now() - this.pinch.t < 450 && this.pinch.moved < 40;
      this.cb.pinchEnd(x, y, quick);
      this.pinch = null;
    }

    // open palm → rotate by hand motion
    if (pose === 'palm') {
      const p = { x: 1 - lm[9].x, y: lm[9].y };
      if (this.prevPalm) this.cb.rotate(p.x - this.prevPalm.x, p.y - this.prevPalm.y);
      this.prevPalm = p;
      this.cb.status('Rotating');
    } else this.prevPalm = null;

    // fist → move up/down to zoom
    if (pose === 'fist') {
      if (this.prevFistY !== null) this.cb.zoom(Math.exp((lm[9].y - this.prevFistY) * 3.2));
      this.prevFistY = lm[9].y;
      this.cb.status('Zooming');
    } else this.prevFistY = null;

    if (pose === 'pinch') this.cb.status(this.pinch && performance.now() - this.pinch.t > 450 ? 'Squeezing' : 'Pinch');
    else if (pose === 'point') this.cb.status('Aiming');
    else if (pose === 'none') this.cb.status('Hand detected');
    this.prevPose = pose;
  }
}
