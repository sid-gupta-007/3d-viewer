export type Vec3 = [number, number, number]

export type EasingMode = 'linear' | 'easeInOut' | 'easeIn' | 'easeOut' | 'step'
export type LoopMode = 'once' | 'loop' | 'pingpong'

export type EnvironmentPresetId = 'studio' | 'sunset' | 'night' | 'warehouse' | 'xr-stage'

export type LightDefinition = {
  id: string
  type: 'ambient' | 'hemisphere' | 'directional' | 'point' | 'spot'
  color: string
  groundColor?: string
  intensity: number
  position?: Vec3
}

export type CameraManifest = {
  position: Vec3
  target: Vec3
  fov: number
  near: number
  far: number
}

export type EnvironmentManifest = {
  preset: EnvironmentPresetId
  background: string
  fog?: { color: string; near: number; far: number }
  exposure: number
  xrEnabled: boolean
  lights: LightDefinition[]
}

export type ForgePartOperation =
  | {
      kind: 'split'
      sourceId: string
      mode: 'islands' | 'materials'
      partIds?: string[]
    }
  | {
      kind: 'extract'
      sourceId: string
      partId: string
      partName?: string
      triangleIndices: number[]
    }

export type NodeManifest = {
  forgeId: string
  name: string
  parentId: string | null
  type: string
  visible: boolean
  position: Vec3
  rotation: Vec3
  scale: Vec3
  pivot?: Vec3
  splitFrom?: string
  splitMode?: 'islands' | 'materials' | 'extract'
  splitIndex?: number
  extractedTriangles?: number[]
}

export type KeyframeManifest = {
  id: string
  targetId: string
  time: number
  position: Vec3
  rotation: Vec3
  scale: Vec3
  easing?: EasingMode
}

export type ForgeSceneManifest = {
  version: 1
  projectName: string
  assetPath: string
  camera: CameraManifest
  environment: EnvironmentManifest
  nodes: NodeManifest[]
  keyframes: KeyframeManifest[]
  loopMode: LoopMode
  duration?: number
  assetKey?: string
  splits?: ForgePartOperation[]
}

export function createDefaultManifest(projectName = 'ForgeScene', assetPath = './assets/model.glb'): ForgeSceneManifest {
  return {
    version: 1,
    projectName,
    assetPath,
    camera: {
      position: [4.6, 3.6, 6.8],
      target: [0, 0.8, 0],
      fov: 38,
      near: 0.1,
      far: 100,
    },
    environment: {
      preset: 'studio',
      background: '#111317',
      fog: { color: '#111317', near: 12, far: 32 },
      exposure: 1,
      xrEnabled: false,
      lights: [
        { id: 'hemi', type: 'hemisphere', color: '#dce9ff', groundColor: '#242a3b', intensity: 2.1 },
        { id: 'key', type: 'directional', color: '#fff0d9', intensity: 3.5, position: [4, 8, 5] },
        { id: 'rim', type: 'directional', color: '#617eff', intensity: 2.7, position: [-5, 3, -4] },
      ],
    },
    nodes: [],
    keyframes: [],
    loopMode: 'loop',
  }
}

export function validateSceneManifest(input: unknown): input is ForgeSceneManifest {
  if (!input || typeof input !== 'object') return false
  const m = input as Partial<ForgeSceneManifest>
  return (
    m.version === 1 &&
    typeof m.projectName === 'string' &&
    typeof m.assetPath === 'string' &&
    Array.isArray(m.camera?.position) &&
    Array.isArray(m.camera?.target) &&
    typeof m.camera?.fov === 'number' &&
    Array.isArray(m.nodes) &&
    Array.isArray(m.keyframes) &&
    (m.duration === undefined || (typeof m.duration === 'number' && Number.isFinite(m.duration) && m.duration > 0)) &&
    (m.assetKey === undefined || typeof m.assetKey === 'string') &&
    (m.splits === undefined || Array.isArray(m.splits))
  )
}
