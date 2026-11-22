import { useEffect, useRef } from 'react'
import { Canvas, useFrame, useFrame } from '@react-three/fiber'
import { Environment, OrbitControls, useGLTF } from '@react-three/drei'

// @forge:begin
export const FORGE_SCENE_CONFIG = {
  assetPath: './assets/car-and-driver.gltf',
  assetKey: 'car',
  camera: {
    position: [-0.36, 1.18, 0.12] as [number, number, number],
    target: [0, 0.8, 0] as [number, number, number],
    fov: 38,
  },
  exposure: 1,
  xrEnabled: false,
  loopMode: 'loop',
  duration: 5,
  nodes: {
    'car:root': { name: 'Racing_Car', parentId: null, type: 'Group', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], visible: true },
    'car:door': { name: 'Car_Door_Left', parentId: 'car:root', type: 'Mesh', position: [-0.78, 0.48, 0.4], rotation: [0, 1.22, 0], scale: [0.1, 0.42, 1.05], visible: true, pivot: [0, 0, -0.52] },
    'car:steer': { name: 'Steering_Wheel', parentId: 'car:root', type: 'Mesh', position: [-0.36, 0.68, 0.35], rotation: [0, 0, 0.65], scale: [0.3, 0.3, 0.06], visible: true },
    'person:root': { name: 'Driver_Person', parentId: 'car:root', type: 'Group', position: [-0.36, -0.18, 0], rotation: [0, 0, 0], scale: [1, 0.82, 1], visible: true },
  },
  keyframes: [
    { id: 'kf-door-0', targetId: 'car:door', time: 0, position: [-0.78, 0.48, 0.4], rotation: [0, 0, 0], scale: [0.1, 0.42, 1.05] },
    { id: 'kf-door-1', targetId: 'car:door', time: 1, position: [-0.78, 0.48, 0.4], rotation: [0, 1.22, 0], scale: [0.1, 0.42, 1.05] },
    { id: 'kf-drive-0', targetId: 'car:root', time: 1.5, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { id: 'kf-drive-1', targetId: 'car:root', time: 3.5, position: [1.4, 0, 8.5], rotation: [-0.04, 0.25, 0.05], scale: [1, 1, 1] },
  ],
  splits: [

  ],
} as const

function forgeClamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function forgeApplyEasing(t: number, easing: string = 'linear'): number {
  const u = forgeClamp01(t)
  switch (easing) {
    case 'easeIn':
      return u * u
    case 'easeOut':
      return 1 - (1 - u) * (1 - u)
    case 'easeInOut':
      return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2
    case 'step':
      return u >= 1 ? 1 : 0
    default:
      return u
  }
}

function forgeResolveLoopTime(time: number, duration: number, loopMode: string): number {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(time) || time <= 0) {
    return 0
  }
  switch (loopMode) {
    case 'once':
      return time >= duration ? duration : time
    case 'pingpong': {
      const cycle = duration * 2
      const mod = time % cycle
      return mod <= duration ? mod : cycle - mod
    }
    default:
      return time % duration
  }
}

function forgeSampleTrack(
  track: readonly { time: number; position: readonly number[]; rotation: readonly number[]; scale: readonly number[]; easing?: string }[],
  time: number
) {
  if (track.length === 0) return null
  const first = track[0]
  const last = track[track.length - 1]
  if (time <= first.time) return first
  if (time >= last.time) return last
  for (let i = 0; i < track.length - 1; i++) {
    const prev = track[i]
    const next = track[i + 1]
    if (time >= prev.time && time <= next.time) {
      const span = next.time - prev.time
      if (span <= 0) return next
      const rawAlpha = (time - prev.time) / span
      const alpha = forgeApplyEasing(rawAlpha, prev.easing ?? next.easing ?? 'linear')
      return {
        position: [
          prev.position[0] + (next.position[0] - prev.position[0]) * alpha,
          prev.position[1] + (next.position[1] - prev.position[1]) * alpha,
          prev.position[2] + (next.position[2] - prev.position[2]) * alpha,
        ],
        rotation: [
          prev.rotation[0] + (next.rotation[0] - prev.rotation[0]) * alpha,
          prev.rotation[1] + (next.rotation[1] - prev.rotation[1]) * alpha,
          prev.rotation[2] + (next.rotation[2] - prev.rotation[2]) * alpha,
        ],
        scale: [
          prev.scale[0] + (next.scale[0] - prev.scale[0]) * alpha,
          prev.scale[1] + (next.scale[1] - prev.scale[1]) * alpha,
          prev.scale[2] + (next.scale[2] - prev.scale[2]) * alpha,
        ],
      }
    }
  }
  return last
}

export function ForgeStageContent() {
  const { scene } = useGLTF(FORGE_SCENE_CONFIG.assetPath)
  const objectsRef = useRef(new Map<string, any>())
  const elapsedRef = useRef(0)
  const tracksByTarget = useRef(new Map<string, typeof FORGE_SCENE_CONFIG.keyframes[number][]>())
  useEffect(() => {
    const nodeConfigs = FORGE_SCENE_CONFIG.nodes as Record<
      string,
      {
        name: string
        parentId: string | null
        type: string
        position: readonly [number, number, number]
        rotation: readonly [number, number, number]
        scale: readonly [number, number, number]
        visible: boolean
        pivot?: readonly [number, number, number]
        splitFrom?: string
      }
    >
    const initialObjects: any[] = []
    scene.traverse((obj: any) => initialObjects.push(obj))

    const computeDefaultForgeId = (obj: any): string => {
      if (obj === scene) return `${FORGE_SCENE_CONFIG.assetKey}:root`
      const path: number[] = []
      let cur = obj
      while (cur && cur !== scene && cur.parent) {
        path.unshift(cur.parent.children.indexOf(cur))
        cur = cur.parent
      }
      return `${FORGE_SCENE_CONFIG.assetKey}:${path.join('.')}`
    }

    const matchedIds = new Set<string>()
    const pending: { obj: any; defaultId: string }[] = []
    const objectMap = new Map<string, any>()

    // Pass 1: preserve existing forgeIds (including generated split/extract parts), or claim exact defaultId when name matches
    for (const obj of initialObjects) {
      const existingId = typeof obj.userData?.forgeId === 'string' ? obj.userData.forgeId : undefined
      if (existingId) {
        if (Object.prototype.hasOwnProperty.call(nodeConfigs, existingId)) {
          matchedIds.add(existingId)
        }
        objectMap.set(existingId, obj)
        continue
      }
      const defaultId = computeDefaultForgeId(obj)
      const cfg = Object.prototype.hasOwnProperty.call(nodeConfigs, defaultId) ? nodeConfigs[defaultId] : undefined
      if (cfg && (!cfg.name || cfg.name === obj.name)) {
        obj.userData.forgeId = defaultId
        matchedIds.add(defaultId)
        objectMap.set(defaultId, obj)
      } else {
        pending.push({ obj, defaultId })
      }
    }

    // Pass 2: match shifted hierarchies by unique/unmatched node name
    const configEntries = Object.entries(nodeConfigs)
    const stillUnmatched: { obj: any; defaultId: string }[] = []
    for (const item of pending) {
      let fallback = item.obj.name
        ? configEntries.find(
            ([cfgId, cfg]) => !matchedIds.has(cfgId) && !cfg.splitFrom && cfg.name === item.obj.name
          )
        : undefined
      if (!fallback && item.obj.name) {
        fallback = configEntries.find(([cfgId, cfg]) => !matchedIds.has(cfgId) && cfg.name === item.obj.name)
      }
      if (fallback) {
        item.obj.userData.forgeId = fallback[0]
        matchedIds.add(fallback[0])
        objectMap.set(fallback[0], item.obj)
      } else {
        stillUnmatched.push(item)
      }
    }

    // Pass 3: fallback to unclaimed defaultId (when GLTF node was renamed or unnamed), avoiding collisions
    let extraIdx = 0
    for (const item of stillUnmatched) {
      if (
        Object.prototype.hasOwnProperty.call(nodeConfigs, item.defaultId) &&
        !matchedIds.has(item.defaultId)
      ) {
        item.obj.userData.forgeId = item.defaultId
        matchedIds.add(item.defaultId)
        objectMap.set(item.defaultId, item.obj)
      } else if (!matchedIds.has(item.defaultId) && !objectMap.has(item.defaultId)) {
        item.obj.userData.forgeId = item.defaultId
        objectMap.set(item.defaultId, item.obj)
      } else {
        const fallbackId = `${item.defaultId}__unmatched_${extraIdx++}`
        item.obj.userData.forgeId = fallbackId
        objectMap.set(fallbackId, item.obj)
      }
    }

    // Apply transforms & visibility before split/extract replay so extracted parts inherit source transforms
    for (const [id, obj] of objectMap) {
      const override = nodeConfigs[id]
      if (!override) continue
      obj.position.set(override.position[0], override.position[1], override.position[2])
      obj.rotation.set(override.rotation[0], override.rotation[1], override.rotation[2])
      obj.scale.set(override.scale[0], override.scale[1], override.scale[2])
      obj.visible = override.visible
    }

    for (const [id, obj] of objectMap) {
      const override = nodeConfigs[id]
      if (!override) continue
      obj.position.set(override.position[0], override.position[1], override.position[2])
      obj.rotation.set(override.rotation[0], override.rotation[1], override.rotation[2])
      obj.scale.set(override.scale[0], override.scale[1], override.scale[2])
      obj.visible = override.visible
      if (obj.isMesh && obj.geometry) {
        if (!obj.userData.__forgeSourceGeo) {
          obj.userData.__forgeSourceGeo = obj.geometry
        }
        const baseGeo = obj.userData.__forgeSourceGeo
        const p = override.pivot
        if (p && (Math.abs(p[0]) > 1e-8 || Math.abs(p[1]) > 1e-8 || Math.abs(p[2]) > 1e-8)) {
          const cloned = baseGeo.clone()
          cloned.translate(-p[0], -p[1], -p[2])
          if (obj.geometry !== baseGeo) obj.geometry.dispose()
          obj.geometry = cloned
        } else if (obj.geometry !== baseGeo) {
          obj.geometry.dispose()
          obj.geometry = baseGeo
        }
      }
    }
    objectsRef.current = objectMap
    elapsedRef.current = 0
    const grouped = new Map<string, typeof FORGE_SCENE_CONFIG.keyframes[number][]>()
    for (const kf of FORGE_SCENE_CONFIG.keyframes) {
      const list = grouped.get(kf.targetId) ?? []
      list.push(kf)
      grouped.set(kf.targetId, list)
    }
    for (const list of grouped.values()) {
      list.sort((a, b) => a.time - b.time)
    }
    tracksByTarget.current = grouped
  }, [scene])

  useFrame((_, delta) => {
    if (tracksByTarget.current.size === 0) return
    elapsedRef.current += delta
    const resolvedTime = forgeResolveLoopTime(
      elapsedRef.current,
      FORGE_SCENE_CONFIG.duration,
      FORGE_SCENE_CONFIG.loopMode
    )
    for (const [targetId, track] of tracksByTarget.current) {
      const obj = objectsRef.current.get(targetId)
      if (!obj) continue
      const sample = forgeSampleTrack(track, resolvedTime)
      if (!sample) continue
      obj.position.set(sample.position[0], sample.position[1], sample.position[2])
      obj.rotation.set(sample.rotation[0], sample.rotation[1], sample.rotation[2])
      obj.scale.set(sample.scale[0], sample.scale[1], sample.scale[2])
    }
  })

  return (
    <>
      <color attach="background" args={['#111317']} />
      <fog attach="fog" args={['#111317', 12, 32]} />
      <hemisphereLight args={['#dce9ff', '#242a3b', 2.1]} />
      <directionalLight color="#fff0d9" intensity={3.5} position={[4, 8, 5]} />
      <directionalLight color="#617eff" intensity={2.7} position={[-5, 3, -4]} />
      <Environment preset="sunset" />
      <OrbitControls target={FORGE_SCENE_CONFIG.camera.target} makeDefault />
      <primitive object={scene} />
    </>
  )
}
// @forge:end

export function CarRacingGame() {
  return (
    <div style={{ width: '100%', height: '100vh' }}>
      <Canvas
        gl={{ toneMappingExposure: FORGE_SCENE_CONFIG.exposure }}
        camera={{
          position: FORGE_SCENE_CONFIG.camera.position,
          fov: FORGE_SCENE_CONFIG.camera.fov,
          near: 0.1,
          far: 100,
        }}
      >
        <ForgeStageContent />
      </Canvas>
    </div>
  )
}

// Custom User Game Logic (preserved across Forge 3D live syncs!)
export const GAME_KEYBINDINGS = {
  E: { target: 'Car_Door_Left', action: 'hinge90' },
  F: { target: 'Driver_Person', action: 'enterCarSeat' },
  W: { target: 'Racing_Car', action: 'driveForwardWithInertia' },
  A: { target: 'Steering_Wheel', action: 'turnLeft' },
  D: { target: 'Steering_Wheel', action: 'turnRight' },
  C: { target: 'Person_Head', action: 'toggleFirstPersonFpsPov' },
} as const
