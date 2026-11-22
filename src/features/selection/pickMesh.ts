import * as THREE from 'three/webgpu'

function getVisiblePickableMeshes(objects: Map<string, THREE.Object3D>) {
  return [...objects.values()].filter((object) => {
    if (!(object as THREE.Mesh).isMesh || !object.userData.forgeId || object.userData.forgeEditorHelper) return false
    for (let ancestor: THREE.Object3D | null = object; ancestor; ancestor = ancestor.parent) if (!ancestor.visible) return false
    object.updateWorldMatrix(true, false)
    return true
  })
}

export function pickAllVisibleMeshes(objects: Map<string, THREE.Object3D>, camera: THREE.Camera, raycaster: THREE.Raycaster, pointer: THREE.Vector2): THREE.Intersection[] {
  camera.updateMatrixWorld(true)
  const meshes = getVisiblePickableMeshes(objects)
  raycaster.setFromCamera(pointer, camera)
  const hits = raycaster.intersectObjects(meshes, false)
  const seen = new Set<string>()
  const unique: THREE.Intersection[] = []
  for (const hit of hits) {
    const id = hit.object.userData.forgeId as string | undefined
    if (!id || seen.has(id)) continue
    seen.add(id)
    unique.push(hit)
  }
  return unique
}

export function cycleMeshHit(hits: THREE.Intersection[], currentSelectedId: string | null): THREE.Intersection | null {
  if (hits.length === 0) return null
  if (!currentSelectedId) return hits[0]
  const index = hits.findIndex((hit) => hit.object.userData.forgeId === currentSelectedId)
  if (index === -1) return hits[0]
  return hits[(index + 1) % hits.length]
}

export function pickClosestVisibleMesh(objects: Map<string, THREE.Object3D>, camera: THREE.Camera, raycaster: THREE.Raycaster, pointer: THREE.Vector2) {
  return pickAllVisibleMeshes(objects, camera, raycaster, pointer)[0] ?? null
}
