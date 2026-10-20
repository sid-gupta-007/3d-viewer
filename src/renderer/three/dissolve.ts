import * as THREE from 'three/webgpu'
import * as TSL from 'three/tsl'
import { dissolveProgress, effectSeedOffset, isSurfaceEffect, type SceneEffect, type SurfaceEffect } from '../../features/effects/dissolve.ts'

type SurfaceMaterial = THREE.MeshPhysicalNodeMaterial & { __forgeProgress?: ReturnType<typeof TSL.uniform>; __forgeWidth?: ReturnType<typeof TSL.uniform> }
type AppliedSurface = { materials: SurfaceMaterial[] }
type ParticleSystem = { points: THREE.Points; time: ReturnType<typeof TSL.uniform>; active: ReturnType<typeof TSL.uniform> }
export type DissolveController = {
  update: (objects: Map<string, THREE.Object3D>, effects: SceneEffect[], time: number) => void
  clear: () => void
}

function copyMaterial(source: THREE.Material) {
  const material = new THREE.MeshPhysicalNodeMaterial()
  const blocked = new Set(['id', 'uuid', 'type', 'version', 'userData', '_listeners', 'needsUpdate'])
  for (const key of Object.keys(source)) {
    if (blocked.has(key) || !(key in material)) continue
    const value = (source as unknown as Record<string, unknown>)[key]
    if (key === 'userData') material.userData = JSON.parse(JSON.stringify(value ?? {}))
    else (material as unknown as Record<string, unknown>)[key] = value
  }
  return material as SurfaceMaterial
}

function makeSurfaceMaterial(source: THREE.Material, effect: SurfaceEffect, progressValue: number, geometry: THREE.BufferGeometry) {
  const material = copyMaterial(source)
  const progress = TSL.uniform(progressValue)
  const width = TSL.uniform(effect.edgeWidth)
  const seed = effectSeedOffset(effect.seed)
  const sample = TSL.positionLocal.mul(3).add(TSL.vec3(seed, seed * 1.7, seed * 2.3))
  geometry.computeBoundingBox()
  const bounds = geometry.boundingBox ?? new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5))
  const size = bounds.getSize(new THREE.Vector3())
  const axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2
  const span = Math.max(size.getComponent(axis), 1e-5)
  const minimum = bounds.min.getComponent(axis)
  const position = axis === 0 ? TSL.positionLocal.x : axis === 1 ? TSL.positionLocal.y : TSL.positionLocal.z
  const sweep = position.sub(minimum).div(span).clamp(0, 1)
  const noisySweep = sweep.add(TSL.mx_noise_float(sample).mul(0.08)).clamp(0, 1)
  const edge = TSL.float(1).sub(sweep.sub(progress).abs().smoothstep(0, width))
  const glow = effect.kind === 'burn' ? TSL.color(effect.flameColor).mul(2.5) : TSL.color(effect.edgeColor)
  // A smooth normalized sweep keeps a visible part of the mesh at intermediate
  // times. The edge width controls the transition band, while the small noise
  // offset breaks up its silhouette without shifting the whole object away.
  material.opacityNode = noisySweep.smoothstep(progress.sub(width), progress.add(width))
  material.alphaTestNode = TSL.float(0.5)
  material.emissiveNode = TSL.emissive.add(glow.mul(edge))
  material.__forgeProgress = progress
  material.__forgeWidth = width
  material.needsUpdate = true
  return material
}

function randomGenerator(seed: number) {
  let value = seed >>> 0
  return () => {
    value += 0x6D2B79F5
    let next = value
    next = Math.imul(next ^ (next >>> 15), next | 1)
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61)
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

function makeParticles(mesh: THREE.Mesh, effect: Extract<SceneEffect, { kind: 'particles' }>) : ParticleSystem | null {
  const positions = mesh.geometry.getAttribute('position')
  if (!positions?.count) return null
  const random = randomGenerator(effect.seed)
  const samples = new Float32Array(effect.particleCount * 3)
  const velocities = new Float32Array(effect.particleCount * 3)
  const phases = new Float32Array(effect.particleCount)
  const point = new THREE.Vector3()
  for (let index = 0; index < effect.particleCount; index++) {
    point.fromBufferAttribute(positions, Math.floor(random() * positions.count))
    samples.set([point.x, point.y, point.z], index * 3)
    const vx = random() * 2 - 1
    const vy = 0.25 + random() * 0.9
    const vz = random() * 2 - 1
    const velocity = new THREE.Vector3(vx, vy, vz).normalize().multiplyScalar(0.22 + random() * 0.5)
    velocities.set([velocity.x, velocity.y, velocity.z], index * 3)
    phases[index] = random()
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(samples, 3))
  geometry.setAttribute('forgeVelocity', new THREE.Float32BufferAttribute(velocities, 3))
  geometry.setAttribute('forgePhase', new THREE.Float32BufferAttribute(phases, 1))
  const material = new THREE.PointsNodeMaterial({ size: effect.particleSize, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
  const time = TSL.uniform(0)
  const active = TSL.uniform(0)
  const phase = TSL.attribute('forgePhase')
  const life = TSL.fract(phase.add(time.mul(0.72)))
  const velocity = TSL.attribute('forgeVelocity', 'vec3')
  const sway = life.mul(6).add(phase).sin().mul(0.08)
  material.positionNode = TSL.positionLocal.add(velocity.mul(life)).add(TSL.vec3(sway, life.mul(0.8), sway.mul(0.65)))
  material.colorNode = TSL.color(effect.color).mul(TSL.float(0.7).add(life.mul(0.8)))
  material.opacityNode = active.mul(TSL.smoothstep(0, 0.12, life)).mul(TSL.float(1).sub(TSL.smoothstep(0.82, 1, life)))
  // PointsNodeMaterial in the pinned Three.js release exposes fixed point size.
  // Keep seeded size variance in geometry via the base size attribute for newer runtimes.
  material.needsUpdate = true
  const points = new THREE.Points(geometry, material)
  points.name = `Forge ${effect.kind} effect`
  points.userData.forgeEditorHelper = true
  points.frustumCulled = false
  mesh.add(points)
  return { points, time, active }
}

export function createDissolveController(): DissolveController {
  const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
  const applied = new Map<string, AppliedSurface>()
  const particleSystems = new Map<string, ParticleSystem>()
  let activeSignature = ''

  const clear = () => {
    for (const [mesh, original] of originals) mesh.material = original
    for (const surface of applied.values()) for (const material of surface.materials) material.dispose()
    for (const system of particleSystems.values()) {
      system.points.removeFromParent()
      system.points.geometry.dispose()
      const material = system.points.material
      if (Array.isArray(material)) material.forEach((item) => item.dispose())
      else material.dispose()
    }
    originals.clear()
    applied.clear()
    particleSystems.clear()
    activeSignature = ''
  }

  const update = (objects: Map<string, THREE.Object3D>, effects: SceneEffect[], time: number) => {
    const signature = JSON.stringify(effects)
    if (signature !== activeSignature) {
      clear()
      activeSignature = signature
      const surfaceEffects = new Map<string, SurfaceEffect>()
      for (const effect of effects) if (isSurfaceEffect(effect)) surfaceEffects.set(effect.targetId, effect)
      for (const effect of surfaceEffects.values()) {
        const target = objects.get(effect.targetId)
        if (!target || !(target as THREE.Mesh).isMesh) continue
        const mesh = target as THREE.Mesh
        const sources = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        const materials = sources.map((source) => makeSurfaceMaterial(source, effect, dissolveProgress(effect, time), mesh.geometry))
        originals.set(mesh, mesh.material)
        mesh.material = Array.isArray(mesh.material) ? materials : materials[0]
        applied.set(effect.targetId, { materials })
      }
      for (const effect of effects) {
        if (effect.kind !== 'particles') continue
        const target = objects.get(effect.targetId)
        if (!target || !(target as THREE.Mesh).isMesh) continue
        const system = makeParticles(target as THREE.Mesh, effect)
        if (system) particleSystems.set(effect.targetId, system)
      }
    }
    for (const effect of effects) {
      const progress = dissolveProgress(effect, time)
      if (effect.kind === 'particles') {
        const system = particleSystems.get(effect.targetId)
        if (system) {
          system.time.value = time - effect.startTime
          system.active.value = time >= effect.startTime && time <= effect.endTime ? 1 : 0
        }
        continue
      }
      const surface = applied.get(effect.targetId)
      if (!surface) continue
      for (const material of surface.materials) {
        if (material.__forgeProgress) material.__forgeProgress.value = progress
        if (material.__forgeWidth) material.__forgeWidth.value = effect.edgeWidth
      }
    }
  }

  return { update, clear }
}
