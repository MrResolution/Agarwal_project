// MediaPipe Pose: 33 body landmarks. "Left"/"right" are the athlete's own sides.

export const LM = {
  nose: 0, lEyeIn: 1, lEye: 2, lEyeOut: 3, rEyeIn: 4, rEye: 5, rEyeOut: 6, lEar: 7, rEar: 8, mouthL: 9, mouthR: 10,
  lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16,
  lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20, lThumb: 21, rThumb: 22,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28, lHeel: 29, rHeel: 30, lFoot: 31, rFoot: 32,
} as const;
export const N_LANDMARKS = 33;

/** The standard MediaPipe Pose skeleton. */
export const CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];

export type Side = "L" | "R" | "C";
const FACE_LEFT = new Set([1, 2, 3, 7, 9]);
export function sideOf(i: number): Side {
  if (i === 0) return "C";
  if (i <= 10) return FACE_LEFT.has(i) ? "L" : "R";
  return i % 2 === 1 ? "L" : "R";
}

/** Landmark in normalised image coordinates (0-1), as MediaPipe returns them. */
export interface Lm { x: number; y: number; z: number; visibility: number }
/** Metric 3-D point (metres). World landmarks are hip-centred, x to the image right, y down. */
export interface P3 { x: number; y: number; z: number }
/** Point in source-frame pixels. */
export interface P2 { x: number; y: number }

/** One tracked frame: image landmarks, world landmarks and the source frame size. */
export interface PoseFrame {
  image: Lm[] | null;
  world: P3[] | null;
  width: number;
  height: number;
  t: number; // performance.now() in ms
}

export const SIDE_COLOUR: Record<Side, string> = { L: "#6f95ff", R: "#cff25c", C: "#ffffff" };
