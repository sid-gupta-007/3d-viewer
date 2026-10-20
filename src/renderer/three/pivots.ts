import * as THREE from 'three/webgpu'

export type PivotPoint = [number, number, number]
type PivotEntry = { mesh: THREE.Mesh; source: THREE.BufferGeometry; pivot: PivotPoint }

export function createPivotController() {
  const entries = new Map<string, PivotEntry>()

  const get = (id: string): PivotPoint => entries.get(id)?.pivot ?? [0, 0, 0]

  const apply = (id: string, object: THREE.Object3D, pivot: PivotPoint, preservePose = true) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return false
    let entry = entries.get(id)
    if (!entry) {
      entry = { mesh, source: mesh.geometry, pivot: [0, 0, 0] }
      entries.set(id, entry)
    }
    const delta = new THREE.Vector3(pivot[0] - entry.pivot[0], pivot[1] - entry.pivot[1], pivot[2] - entry.pivot[2])
    if (preservePose) mesh.position.add(delta.multiply(mesh.scale).applyQuaternion(mesh.quaternion))
    if (pivot.every((value) => Math.abs(value) < 1e-8)) {
      const generated = mesh.geometry
      mesh.geometry = entry.source
      if (generated !== entry.source) generated.dispose()
      entries.delete(id)
      return true
    }
    const geometry = entry.source.clone()
    geometry.translate(-pivot[0], -pivot[1], -pivot[2])
    if (mesh.geometry !== entry.source) mesh.geometry.dispose()
    mesh.geometry = geometry
    entry.pivot = [...pivot]
    return true
  }

  const reset = (id: string) => {
    const entry = entries.get(id)
    if (!entry) return
    const generated = entry.mesh.geometry
    entry.mesh.geometry = entry.source
    if (generated !== entry.source) generated.dispose()
    entries.delete(id)
  }

  const clear = () => {
    for (const [id, entry] of entries) {
      if (entry.mesh.geometry !== entry.source) entry.mesh.geometry.dispose()
      entry.mesh.geometry = entry.source
      entries.delete(id)
    }
  }

  const snapshot = (): Record<string, PivotPoint> => Object.fromEntries([...entries].map(([id, entry]) => [id, [...entry.pivot] as PivotPoint]))

  return { get, apply, reset, clear, snapshot }
}
