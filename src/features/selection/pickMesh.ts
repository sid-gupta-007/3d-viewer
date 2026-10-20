import * as THREE from 'three/webgpu'

export function pickClosestVisibleMesh(objects: Map<string, THREE.Object3D>, camera: THREE.Camera, raycaster: THREE.Raycaster, pointer: THREE.Vector2) {
  camera.updateMatrixWorld(true)
  const meshes = [...objects.values()].filter((object) => {
    if (!(object as THREE.Mesh).isMesh || !object.userData.forgeId) return false
    for (let ancestor: THREE.Object3D | null = object; ancestor; ancestor = ancestor.parent) if (!ancestor.visible) return false
    object.updateWorldMatrix(true, false)
    return true
  })
  raycaster.setFromCamera(pointer, camera)
  return raycaster.intersectObjects(meshes, false).find((intersection) => intersection.object.userData.forgeId) ?? null
}
