import { create } from 'zustand'
import type {
  EasingMode,
  ForgeSceneManifest,
  KeyframeManifest,
  LoopMode,
  Vec3,
} from '../../domain/sceneManifest.ts'

export const CAMERA_TRACK_ID = '__camera__'

export type TransformSample = {
  targetId: string
  position: Vec3
  rotation: Vec3
  scale: Vec3
}

export type CameraKeyframe = {
  id: string
  time: number
  position: Vec3
  target: Vec3
  fov: number
  easing?: EasingMode
}

export type CameraSample = {
  position: Vec3
  target: Vec3
  fov: number
}

export type LoopTimeResult = {
  time: number
  finished: boolean
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

export function applyEasing(t: number, easing: EasingMode = 'linear'): number {
  const u = clamp01(t)
  switch (easing) {
    case 'linear':
      return u
    case 'easeIn':
      return u * u
    case 'easeOut':
      return 1 - (1 - u) * (1 - u)
    case 'easeInOut':
      return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2
    case 'step':
      return u >= 1 ? 1 : 0
  }
}

export function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha
}

export function lerpVec3(a: Vec3, b: Vec3, alpha: number): Vec3 {
  return [lerp(a[0], b[0], alpha), lerp(a[1], b[1], alpha), lerp(a[2], b[2], alpha)]
}

function cloneVec3(v: Vec3): Vec3 {
  return [v[0], v[1], v[2]]
}

export function resolveLoopTime(time: number, duration: number, loopMode: LoopMode): LoopTimeResult {
  if (!Number.isFinite(duration) || duration <= 0) {
    return { time: 0, finished: loopMode === 'once' }
  }
  if (!Number.isFinite(time) || time <= 0) {
    return { time: 0, finished: false }
  }

  switch (loopMode) {
    case 'once':
      if (time >= duration) {
        return { time: duration, finished: true }
      }
      return { time, finished: false }
    case 'loop': {
      const wrapped = time % duration
      return { time: wrapped, finished: false }
    }
    case 'pingpong': {
      const cycle = duration * 2
      const mod = time % cycle
      const resolved = mod <= duration ? mod : cycle - mod
      return { time: resolved, finished: false }
    }
  }
}

function sortByTime<T extends { time: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.time - b.time)
}

function sampleTrack<K extends { time: number; easing?: EasingMode }, S>(
  keyframes: readonly K[],
  time: number,
  fromKeyframe: (kf: K) => S,
  interpolate: (a: K, b: K, alpha: number) => S
): S | null {
  if (keyframes.length === 0) return null
  const sorted = sortByTime(keyframes)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]

  if (time <= first.time) return fromKeyframe(first)
  if (time >= last.time) return fromKeyframe(last)

  for (let i = 0; i < sorted.length - 1; i++) {
    const prev = sorted[i]
    const next = sorted[i + 1]
    if (time >= prev.time && time <= next.time) {
      const span = next.time - prev.time
      if (span <= 0) return fromKeyframe(next)
      const rawAlpha = (time - prev.time) / span
      const easing = prev.easing ?? next.easing ?? 'linear'
      const alpha = applyEasing(rawAlpha, easing)
      return interpolate(prev, next, alpha)
    }
  }

  return fromKeyframe(last)
}

export function sampleNodeTrack(
  keyframes: readonly KeyframeManifest[],
  targetId: string,
  time: number
): TransformSample | null {
  const track = keyframes.filter((kf) => kf.targetId === targetId)
  return sampleTrack(
    track,
    time,
    (kf) => ({
      targetId: kf.targetId,
      position: cloneVec3(kf.position),
      rotation: cloneVec3(kf.rotation),
      scale: cloneVec3(kf.scale),
    }),
    (a, b, alpha) => ({
      targetId: a.targetId,
      position: lerpVec3(a.position, b.position, alpha),
      rotation: lerpVec3(a.rotation, b.rotation, alpha),
      scale: lerpVec3(a.scale, b.scale, alpha),
    })
  )
}

export function sampleAllNodeTracks(
  keyframes: readonly KeyframeManifest[],
  time: number
): Record<string, TransformSample> {
  const targetIds = new Set(keyframes.map((kf) => kf.targetId))
  const samples: Record<string, TransformSample> = {}
  for (const targetId of targetIds) {
    const sample = sampleNodeTrack(keyframes, targetId, time)
    if (sample) {
      samples[targetId] = sample
    }
  }
  return samples
}

export function sampleCameraTrack(
  keyframes: readonly CameraKeyframe[],
  time: number
): CameraSample | null {
  return sampleTrack(
    keyframes,
    time,
    (kf) => ({
      position: cloneVec3(kf.position),
      target: cloneVec3(kf.target),
      fov: kf.fov,
    }),
    (a, b, alpha) => ({
      position: lerpVec3(a.position, b.position, alpha),
      target: lerpVec3(a.target, b.target, alpha),
      fov: lerp(a.fov, b.fov, alpha),
    })
  )
}

export type TimelineState = {
  playing: boolean
  currentTime: number
  duration: number
  loopMode: LoopMode
  keyframes: KeyframeManifest[]
  cameraKeyframes: CameraKeyframe[]
  play: () => void
  pause: () => void
  togglePlay: () => void
  seek: (time: number) => void
  advance: (deltaSeconds: number) => void
  setDuration: (duration: number) => void
  setLoopMode: (loopMode: LoopMode) => void
  upsertKeyframe: (keyframe: KeyframeManifest) => void
  removeKeyframe: (id: string) => void
  upsertCameraKeyframe: (keyframe: CameraKeyframe) => void
  removeCameraKeyframe: (id: string) => void
  sampleNode: (targetId: string, time?: number) => TransformSample | null
  sampleCamera: (time?: number) => CameraSample | null
  loadFromManifest: (
    manifest: Pick<ForgeSceneManifest, 'keyframes' | 'loopMode'> & {
      cameraKeyframes?: CameraKeyframe[]
    }
  ) => void
  reset: () => void
}

const DEFAULT_DURATION = 5

function computeMaxTime(keyframes: readonly { time: number }[], cameraKeyframes: readonly { time: number }[]): number {
  let max = DEFAULT_DURATION
  for (const kf of keyframes) {
    if (kf.time > max) max = kf.time
  }
  for (const kf of cameraKeyframes) {
    if (kf.time > max) max = kf.time
  }
  return max
}

function upsertSorted<T extends { id: string; time: number }>(list: readonly T[], item: T): T[] {
  const filtered = list.filter((existing) => existing.id !== item.id)
  return sortByTime([...filtered, item])
}

export const useTimelineStore = create<TimelineState>((set, get) => ({
  playing: false,
  currentTime: 0,
  duration: DEFAULT_DURATION,
  loopMode: 'loop',
  keyframes: [],
  cameraKeyframes: [],

  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
  togglePlay: () => set((state) => ({ playing: !state.playing })),

  seek: (time) =>
    set((state) => {
      const clamped = Number.isFinite(time) ? Math.max(0, Math.min(state.duration, time)) : 0
      return { currentTime: clamped }
    }),

  advance: (deltaSeconds) =>
    set((state) => {
      if (!state.playing || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
        return state
      }
      const next = resolveLoopTime(state.currentTime + deltaSeconds, state.duration, state.loopMode)
      return {
        currentTime: next.time,
        playing: next.finished ? false : state.playing,
      }
    }),

  setDuration: (duration) =>
    set((state) => {
      const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_DURATION
      return {
        duration: safeDuration,
        currentTime: Math.min(state.currentTime, safeDuration),
      }
    }),

  setLoopMode: (loopMode) => set({ loopMode }),

  upsertKeyframe: (keyframe) =>
    set((state) => {
      const keyframes = upsertSorted(state.keyframes, keyframe)
      return {
        keyframes,
        duration: Math.max(state.duration, keyframe.time),
      }
    }),

  removeKeyframe: (id) =>
    set((state) => ({
      keyframes: state.keyframes.filter((kf) => kf.id !== id),
    })),

  upsertCameraKeyframe: (keyframe) =>
    set((state) => {
      const cameraKeyframes = upsertSorted(state.cameraKeyframes, keyframe)
      return {
        cameraKeyframes,
        duration: Math.max(state.duration, keyframe.time),
      }
    }),

  removeCameraKeyframe: (id) =>
    set((state) => ({
      cameraKeyframes: state.cameraKeyframes.filter((kf) => kf.id !== id),
    })),

  sampleNode: (targetId, time) => {
    const state = get()
    return sampleNodeTrack(state.keyframes, targetId, time ?? state.currentTime)
  },

  sampleCamera: (time) => {
    const state = get()
    return sampleCameraTrack(state.cameraKeyframes, time ?? state.currentTime)
  },

  loadFromManifest: (manifest) => {
    const keyframes = sortByTime(manifest.keyframes)
    const cameraKeyframes = sortByTime(manifest.cameraKeyframes ?? [])
    set({
      playing: false,
      currentTime: 0,
      loopMode: manifest.loopMode,
      keyframes,
      cameraKeyframes,
      duration: computeMaxTime(keyframes, cameraKeyframes),
    })
  },

  reset: () =>
    set({
      playing: false,
      currentTime: 0,
      duration: DEFAULT_DURATION,
      loopMode: 'loop',
      keyframes: [],
      cameraKeyframes: [],
    }),
}))
