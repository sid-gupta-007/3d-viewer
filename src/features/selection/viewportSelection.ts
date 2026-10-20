import * as THREE from 'three/webgpu'

export type ScreenRect = { minX: number; maxX: number; minY: number; maxY: number }

const boxCorners = (box: THREE.Box3) => [
  new THREE.Vector3(box.min.x, box.min.y, box.min.z), new THREE.Vector3(box.min.x, box.min.y, box.max.z),
  new THREE.Vector3(box.min.x, box.max.y, box.min.z), new THREE.Vector3(box.min.x, box.max.y, box.max.z),
  new THREE.Vector3(box.max.x, box.min.y, box.min.z), new THREE.Vector3(box.max.x, box.min.y, box.max.z),
  new THREE.Vector3(box.max.x, box.max.y, box.min.z), new THREE.Vector3(box.max.x, box.max.y, box.max.z),
]

export function selectMeshesInRect(objects: Map<string, THREE.Object3D>, camera: THREE.Camera, width: number, height: number, rect: ScreenRect, crossing: boolean): string[] {
  camera.updateMatrixWorld(true)
  const selected: string[] = []
  for (const [id, object] of objects) {
    if (!(object as THREE.Mesh).isMesh) continue
    let visible = true
    for (let ancestor: THREE.Object3D | null = object; ancestor; ancestor = ancestor.parent) {
      if (!ancestor.visible) { visible = false; break }
    }
    if (!visible) continue
    const bounds = new THREE.Box3().setFromObject(object)
    if (bounds.isEmpty()) continue
    const projected = boxCorners(bounds).map((corner) => corner.project(camera))
    const depths = projected.map((point) => point.z)
    if (Math.min(...depths) > 1 || Math.max(...depths) < -1) continue
    const x1 = (Math.min(...projected.map((point) => point.x)) + 1) * 0.5 * width
    const x2 = (Math.max(...projected.map((point) => point.x)) + 1) * 0.5 * width
    const y1 = (1 - Math.max(...projected.map((point) => point.y))) * 0.5 * height
    const y2 = (1 - Math.min(...projected.map((point) => point.y))) * 0.5 * height
    const overlaps = x2 >= rect.minX && x1 <= rect.maxX && y2 >= rect.minY && y1 <= rect.maxY
    const contained = x1 >= rect.minX && x2 <= rect.maxX && y1 >= rect.minY && y2 <= rect.maxY
    if (crossing ? overlaps : contained) selected.push(id)
  }
  return selected
}
