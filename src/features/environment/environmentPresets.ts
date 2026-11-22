import type {
  EnvironmentManifest,
  EnvironmentPresetId,
  LightDefinition,
  Vec3,
} from '../../domain/sceneManifest.ts'

export const WEBXR_EYE_HEIGHT_METERS = 1.6

export type FloorBounds = {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  y: number
  width: number
  depth: number
}

export type XRStageConfig = {
  eyeHeight: number
  floorBounds: FloorBounds
  referenceSpace: 'local-floor' | 'bounded-floor' | 'local'
  spawnPosition: Vec3
  spawnTarget: Vec3
}

export type EnvironmentPresetDefinition = {
  id: EnvironmentPresetId
  label: string
  description: string
  manifest: EnvironmentManifest
  floorBounds: FloorBounds
  xrStage: XRStageConfig
}

function createFloorBounds(halfWidth: number, halfDepth: number, y = 0): FloorBounds {
  return {
    minX: -halfWidth,
    maxX: halfWidth,
    minZ: -halfDepth,
    maxZ: halfDepth,
    y,
    width: halfWidth * 2,
    depth: halfDepth * 2,
  }
}

export const DEFAULT_FLOOR_BOUNDS: FloorBounds = createFloorBounds(4, 4, 0)

function createXRStage(
  floorBounds: FloorBounds,
  referenceSpace: XRStageConfig['referenceSpace'] = 'local-floor',
  eyeHeight = WEBXR_EYE_HEIGHT_METERS
): XRStageConfig {
  const eyeY = floorBounds.y + eyeHeight
  const spawnZ = Math.min(floorBounds.maxZ, 3)
  return {
    eyeHeight,
    floorBounds,
    referenceSpace,
    spawnPosition: [0, eyeY, spawnZ],
    spawnTarget: [0, eyeY, 0],
  }
}

export const ENVIRONMENT_PRESETS: Record<EnvironmentPresetId, EnvironmentPresetDefinition> = {
  studio: {
    id: 'studio',
    label: 'Studio',
    description: 'Balanced three-point neutral studio lighting',
    manifest: {
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
    floorBounds: createFloorBounds(4, 4, 0),
    xrStage: createXRStage(createFloorBounds(4, 4, 0), 'local-floor'),
  },

  sunset: {
    id: 'sunset',
    label: 'Sunset',
    description: 'Warm low-angle golden hour key light with cool sky fill',
    manifest: {
      preset: 'sunset',
      background: '#1f1726',
      fog: { color: '#2b1c2e', near: 10, far: 30 },
      exposure: 1.05,
      xrEnabled: false,
      lights: [
        { id: 'hemi', type: 'hemisphere', color: '#ffcaa6', groundColor: '#2c1f3a', intensity: 1.8 },
        { id: 'key', type: 'directional', color: '#ff8e53', intensity: 3.8, position: [8, 2.5, -4] },
        { id: 'rim', type: 'directional', color: '#7a8cff', intensity: 1.9, position: [-6, 4, 5] },
      ],
    },
    floorBounds: createFloorBounds(5, 5, 0),
    xrStage: createXRStage(createFloorBounds(5, 5, 0), 'local-floor'),
  },

  night: {
    id: 'night',
    label: 'Night',
    description: 'Deep midnight backdrop with cool moonlight and subtle accent fill',
    manifest: {
      preset: 'night',
      background: '#070910',
      fog: { color: '#090d18', near: 8, far: 26 },
      exposure: 0.9,
      xrEnabled: false,
      lights: [
        { id: 'hemi', type: 'hemisphere', color: '#4d6ea8', groundColor: '#0b0e17', intensity: 1.1 },
        { id: 'moon', type: 'directional', color: '#b7d0ff', intensity: 2.4, position: [-4, 9, -6] },
        { id: 'accent', type: 'point', color: '#3b82f6', intensity: 2.0, position: [3, 2.2, 3] },
      ],
    },
    floorBounds: createFloorBounds(4, 4, 0),
    xrStage: createXRStage(createFloorBounds(4, 4, 0), 'local-floor'),
  },

  warehouse: {
    id: 'warehouse',
    label: 'Warehouse',
    description: 'High-bay industrial lighting with wide floor bounds',
    manifest: {
      preset: 'warehouse',
      background: '#1a1d22',
      fog: { color: '#1a1d22', near: 14, far: 40 },
      exposure: 1.0,
      xrEnabled: false,
      lights: [
        { id: 'hemi', type: 'hemisphere', color: '#d7e0ea', groundColor: '#25282e', intensity: 1.6 },
        { id: 'overhead-a', type: 'directional', color: '#f5f7fa', intensity: 3.0, position: [0, 10, 2] },
        { id: 'bay-fill', type: 'point', color: '#ffd9b3', intensity: 2.2, position: [-4, 5, -3] },
      ],
    },
    floorBounds: createFloorBounds(6, 6, 0),
    xrStage: createXRStage(createFloorBounds(6, 6, 0), 'local-floor'),
  },

  'xr-stage': {
    id: 'xr-stage',
    label: 'XR Stage',
    description: 'Calibrated WebXR stage with 1.6m standing eye-height and bounded floor',
    manifest: {
      preset: 'xr-stage',
      background: '#10141c',
      fog: { color: '#10141c', near: 12, far: 28 },
      exposure: 1.0,
      xrEnabled: true,
      lights: [
        { id: 'hemi', type: 'hemisphere', color: '#e6f0ff', groundColor: '#1f2633', intensity: 2.0 },
        { id: 'key', type: 'directional', color: '#ffffff', intensity: 3.2, position: [3, 7, 4] },
        { id: 'rim', type: 'directional', color: '#4cc9f0', intensity: 2.2, position: [-4, 3, -4] },
      ],
    },
    floorBounds: createFloorBounds(3, 3, 0),
    xrStage: createXRStage(createFloorBounds(3, 3, 0), 'bounded-floor', WEBXR_EYE_HEIGHT_METERS),
  },
}

const PRESET_IDS = Object.keys(ENVIRONMENT_PRESETS) as EnvironmentPresetId[]

export function isEnvironmentPresetId(value: unknown): value is EnvironmentPresetId {
  return typeof value === 'string' && value in ENVIRONMENT_PRESETS
}

export function getEnvironmentPreset(id: EnvironmentPresetId): EnvironmentPresetDefinition {
  return ENVIRONMENT_PRESETS[id]
}

export function listEnvironmentPresets(): EnvironmentPresetDefinition[] {
  return PRESET_IDS.map((id) => ENVIRONMENT_PRESETS[id])
}

function cloneLights(lights: readonly LightDefinition[]): LightDefinition[] {
  return lights.map((light) => ({
    ...light,
    position: light.position ? ([...light.position] as Vec3) : undefined,
  }))
}

export function createEnvironmentManifest(
  id: EnvironmentPresetId,
  overrides: Partial<EnvironmentManifest> = {}
): EnvironmentManifest {
  const base = ENVIRONMENT_PRESETS[id].manifest
  return {
    preset: overrides.preset ?? base.preset,
    background: overrides.background ?? base.background,
    fog: overrides.fog
      ? { ...overrides.fog }
      : base.fog
        ? { ...base.fog }
        : undefined,
    exposure: overrides.exposure ?? base.exposure,
    xrEnabled: overrides.xrEnabled ?? base.xrEnabled,
    lights: overrides.lights ? cloneLights(overrides.lights) : cloneLights(base.lights),
  }
}

export function isWithinFloorBounds(position: Vec3, bounds: FloorBounds): boolean {
  return (
    position[0] >= bounds.minX &&
    position[0] <= bounds.maxX &&
    position[1] >= bounds.y &&
    position[2] >= bounds.minZ &&
    position[2] <= bounds.maxZ
  )
}

export function clampPositionToFloorBounds(
  position: Vec3,
  bounds: FloorBounds,
  eyeHeight = WEBXR_EYE_HEIGHT_METERS
): Vec3 {
  const x = Math.max(bounds.minX, Math.min(bounds.maxX, position[0]))
  const y = Math.max(bounds.y + eyeHeight, position[1])
  const z = Math.max(bounds.minZ, Math.min(bounds.maxZ, position[2]))
  return [x, y, z]
}

export function createXRCameraPose(
  bounds: FloorBounds = DEFAULT_FLOOR_BOUNDS,
  eyeHeight = WEBXR_EYE_HEIGHT_METERS
): { position: Vec3; target: Vec3 } {
  const eyeY = bounds.y + eyeHeight
  return {
    position: [0, eyeY, Math.min(bounds.maxZ, 3)],
    target: [0, eyeY, 0],
  }
}
