import * as THREE from 'three/webgpu'

export type TriangleSelectionMode = 'centroid' | 'intersects'

export interface ExtractTrianglesResult {
  part: THREE.Mesh
  remainingGeometry: THREE.BufferGeometry
  removedCount: number
  remainingCount: number
  center: [number, number, number]
}

const ATTRIBUTE_NAMES = ['position', 'normal', 'uv', 'uv1', 'color', 'tangent'] as const

const scratchBox = new THREE.Box3()
const scratchV0 = new THREE.Vector3()
const scratchV1 = new THREE.Vector3()
const scratchV2 = new THREE.Vector3()
const scratchCentroid = new THREE.Vector3()
const scratchTri = new THREE.Triangle(scratchV0, scratchV1, scratchV2)

function isMeshVisible(object: THREE.Object3D): boolean {
  for (let ancestor: THREE.Object3D | null = object; ancestor; ancestor = ancestor.parent) {
    if (!ancestor.visible) return false
  }
  return true
}

function getVertexInWorld(mesh: THREE.Mesh, posAttr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, vi: number, target: THREE.Vector3): THREE.Vector3 {
  target.fromBufferAttribute(posAttr, vi)
  const skinned = mesh as THREE.SkinnedMesh
  if (skinned.isSkinnedMesh && typeof skinned.applyBoneTransform === 'function' && skinned.skeleton) {
    try {
      skinned.applyBoneTransform(vi, target)
    } catch {
      // Fallback to raw attribute if skeleton bind data is incomplete
    }
  }
  return target.applyMatrix4(mesh.matrixWorld)
}

export function selectMeshesInBox(objects: Map<string, THREE.Object3D>, worldBox: THREE.Box3): string[] {
  if (!worldBox || worldBox.isEmpty()) return []
  const selected: string[] = []

  for (const [id, object] of objects) {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || object.userData.forgeEditorHelper) continue
    if (!isMeshVisible(mesh)) continue

    mesh.updateWorldMatrix(true, false)
    const skinned = mesh as THREE.SkinnedMesh
    if (skinned.isSkinnedMesh && skinned.skeleton) {
      skinned.skeleton.update()
    }
    const posAttr = mesh.geometry?.getAttribute('position')
    if (!posAttr || posAttr.count < 3) continue

    if (!skinned.isSkinnedMesh) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      if (!mesh.geometry.boundingBox || mesh.geometry.boundingBox.isEmpty()) continue
      scratchBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld)
      if (!worldBox.intersectsBox(scratchBox)) continue
    }

    const index = mesh.geometry.getIndex()
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3)
    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2
      getVertexInWorld(mesh, posAttr, i0, scratchV0)
      getVertexInWorld(mesh, posAttr, i1, scratchV1)
      getVertexInWorld(mesh, posAttr, i2, scratchV2)
      if (worldBox.intersectsTriangle(scratchTri)) {
        selected.push(id)
        break
      }
    }
  }

  return selected
}

export function selectTrianglesInBox(
  mesh: THREE.Mesh,
  worldBox: THREE.Box3,
  mode: TriangleSelectionMode = 'centroid',
): number[] {
  if (!mesh || !(mesh as THREE.Mesh).isMesh || !mesh.geometry || !worldBox || worldBox.isEmpty()) return []
  const posAttr = mesh.geometry.getAttribute('position')
  if (!posAttr || posAttr.count < 3) return []

  mesh.updateWorldMatrix(true, false)
  const skinned = mesh as THREE.SkinnedMesh
  if (skinned.isSkinnedMesh && skinned.skeleton) {
    skinned.skeleton.update()
  }
  if (!skinned.isSkinnedMesh) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    if (!mesh.geometry.boundingBox || mesh.geometry.boundingBox.isEmpty()) return []
    scratchBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld)
    if (!worldBox.intersectsBox(scratchBox)) return []
  }

  const index = mesh.geometry.getIndex()
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3)
  const selected: number[] = []

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2
    getVertexInWorld(mesh, posAttr, i0, scratchV0)
    getVertexInWorld(mesh, posAttr, i1, scratchV1)
    getVertexInWorld(mesh, posAttr, i2, scratchV2)

    if (mode === 'intersects') {
      if (worldBox.intersectsTriangle(scratchTri)) selected.push(t)
    } else {
      scratchCentroid.copy(scratchV0).add(scratchV1).add(scratchV2).multiplyScalar(1 / 3)
      if (worldBox.containsPoint(scratchCentroid)) selected.push(t)
    }
  }

  return selected
}

function buildGeometryFromTriangles(
  srcGeo: THREE.BufferGeometry,
  index: THREE.BufferAttribute | null,
  triList: number[],
  triMaterialIndices: Int32Array | null,
  centerOffset?: THREE.Vector3,
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  const vertCount = triList.length * 3
  const attrNames = Array.from(new Set([...ATTRIBUTE_NAMES, ...Object.keys(srcGeo.attributes)]))

  for (const attrName of attrNames) {
    const srcAttr = srcGeo.getAttribute(attrName) as THREE.BufferAttribute | undefined
    if (!srcAttr) continue
    const itemSize = srcAttr.itemSize
    const isSkinIndex = attrName === 'skinIndex'
    const out = isSkinIndex ? new Uint16Array(Math.max(0, vertCount * itemSize)) : new Float32Array(Math.max(0, vertCount * itemSize))

    for (let i = 0; i < triList.length; i++) {
      const t = triList[i]
      for (let c = 0; c < 3; c++) {
        const vi = index ? index.getX(t * 3 + c) : t * 3 + c
        const dstVertex = i * 3 + c
        for (let k = 0; k < itemSize; k++) {
          let value = srcAttr.getComponent(vi, k)
          if (attrName === 'position' && centerOffset) {
            if (k === 0) value -= centerOffset.x
            else if (k === 1) value -= centerOffset.y
            else if (k === 2) value -= centerOffset.z
          }
          out[dstVertex * itemSize + k] = value
        }
      }
    }

    geo.setAttribute(attrName, new THREE.BufferAttribute(out, itemSize))
  }

  if (!geo.getAttribute('normal')) {
    if (vertCount > 0) {
      geo.computeVertexNormals()
    } else {
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(0), 3))
    }
  }

  if (triMaterialIndices && triList.length > 0) {
    let groupStartTri = 0
    let currentMat = triMaterialIndices[triList[0]]
    for (let i = 1; i < triList.length; i++) {
      const mat = triMaterialIndices[triList[i]]
      if (mat !== currentMat) {
        geo.addGroup(groupStartTri * 3, (i - groupStartTri) * 3, currentMat)
        groupStartTri = i
        currentMat = mat
      }
    }
    geo.addGroup(groupStartTri * 3, (triList.length - groupStartTri) * 3, currentMat)
  }

  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  return geo
}

export function extractTrianglesAsPart(
  mesh: THREE.Mesh,
  triangleIndices: number[],
  options?: { name?: string; forgeId?: string },
): ExtractTrianglesResult | null {
  if (!mesh || !(mesh as THREE.Mesh).isMesh || !mesh.geometry) return null
  const srcGeo = mesh.geometry
  const posAttr = srcGeo.getAttribute('position')
  if (!posAttr || posAttr.count < 3) return null

  const index = srcGeo.getIndex()
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3)
  if (triCount === 0) return null

  const selectedSet = new Set<number>()
  for (const idx of triangleIndices) {
    if (Number.isInteger(idx) && idx >= 0 && idx < triCount) selectedSet.add(idx)
  }
  if (selectedSet.size === 0) return null

  const extractedTris = Array.from(selectedSet).sort((a, b) => a - b)
  const remainingTris: number[] = []
  for (let t = 0; t < triCount; t++) {
    if (!selectedSet.has(t)) remainingTris.push(t)
  }

  let triMaterialIndices: Int32Array | null = null
  if (srcGeo.groups && srcGeo.groups.length > 0) {
    triMaterialIndices = new Int32Array(triCount)
    for (const group of srcGeo.groups) {
      const startTri = Math.max(0, Math.floor(group.start / 3))
      const endTri = Math.min(triCount, Math.floor((group.start + group.count) / 3))
      const matIdx = group.materialIndex ?? 0
      for (let t = startTri; t < endTri; t++) {
        triMaterialIndices[t] = matIdx
      }
    }
  }

  const min = new THREE.Vector3(Infinity, Infinity, Infinity)
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  for (const t of extractedTris) {
    for (let c = 0; c < 3; c++) {
      const vi = index ? index.getX(t * 3 + c) : t * 3 + c
      scratchV0.fromBufferAttribute(posAttr, vi)
      min.min(scratchV0)
      max.max(scratchV0)
    }
  }
  const center = min.clone().add(max).multiplyScalar(0.5)

  const partGeo = buildGeometryFromTriangles(srcGeo, index, extractedTris, triMaterialIndices, center)
  const remainingGeometry = buildGeometryFromTriangles(srcGeo, index, remainingTris, triMaterialIndices)

  const partMaterial = Array.isArray(mesh.material) ? [...mesh.material] : mesh.material
  const part = new THREE.Mesh(partGeo, partMaterial)
  part.rotation.copy(mesh.rotation)
  part.quaternion.copy(mesh.quaternion)
  part.scale.copy(mesh.scale)
  const worldOffset = center.clone().multiply(mesh.scale).applyQuaternion(mesh.quaternion)
  part.position.copy(mesh.position).add(worldOffset)

  const baseId = (mesh.userData.forgeId as string | undefined) || mesh.name || 'mesh'
  part.name = options?.name ?? `${mesh.name || 'Part'}_extracted`
  part.userData.forgeId = options?.forgeId ?? `${baseId}:extract`
  part.userData.splitFrom = mesh.userData.forgeId ?? baseId
  if (mesh.userData.forgeImported) part.userData.forgeImported = true
  part.castShadow = mesh.castShadow
  part.receiveShadow = mesh.receiveShadow
  part.visible = mesh.visible

  return {
    part,
    remainingGeometry,
    removedCount: extractedTris.length,
    remainingCount: remainingTris.length,
    center: [center.x, center.y, center.z],
  }
}

type ClipVertex = {
  world: THREE.Vector3
  attrs: Record<string, number[]>
}

type BoxPlane = {
  axis: 'x' | 'y' | 'z'
  value: number
  keepGreaterOrEqual: boolean
}

function lerpClipVertex(a: ClipVertex, b: ClipVertex, t: number): ClipVertex {
  const clamped = Math.max(0, Math.min(1, t))
  const world = a.world.clone().lerp(b.world, clamped)
  const attrs: Record<string, number[]> = {}
  for (const [name, aVals] of Object.entries(a.attrs)) {
    const bVals = b.attrs[name] ?? aVals
    if (name === 'skinIndex') {
      attrs[name] = (clamped < 0.5 ? aVals : bVals).slice()
    } else {
      const out = new Array<number>(aVals.length)
      for (let k = 0; k < aVals.length; k++) {
        out[k] = aVals[k] + ((bVals[k] ?? aVals[k]) - aVals[k]) * clamped
      }
      attrs[name] = out
    }
  }
  return { world, attrs }
}

function splitPolygonByPlane(poly: ClipVertex[], plane: BoxPlane): { inside: ClipVertex[]; outside: ClipVertex[] } {
  if (poly.length < 3) return { inside: [], outside: [] }
  const signedDist = (v: ClipVertex) =>
    plane.keepGreaterOrEqual ? v.world[plane.axis] - plane.value : plane.value - v.world[plane.axis]

  const inside: ClipVertex[] = []
  const outside: ClipVertex[] = []

  for (let i = 0; i < poly.length; i++) {
    const curr = poly[i]
    const next = poly[(i + 1) % poly.length]
    const dCurr = signedDist(curr)
    const dNext = signedDist(next)
    const currIn = dCurr >= -1e-7
    const nextIn = dNext >= -1e-7

    if (currIn) inside.push(curr)
    else outside.push(curr)

    if ((currIn && !nextIn) || (!currIn && nextIn)) {
      const denom = dCurr - dNext
      const t = Math.abs(denom) > 1e-12 ? dCurr / denom : 0.5
      const hit = lerpClipVertex(curr, next, t)
      inside.push(hit)
      outside.push(hit)
    }
  }

  return {
    inside: inside.length >= 3 ? inside : [],
    outside: outside.length >= 3 ? outside : [],
  }
}

export function sliceMeshWithBox(
  mesh: THREE.Mesh,
  worldBox: THREE.Box3,
  options?: { name?: string; forgeId?: string },
): ExtractTrianglesResult | null {
  if (!mesh || !(mesh as THREE.Mesh).isMesh || !mesh.geometry || !worldBox || worldBox.isEmpty()) return null
  const srcGeo = mesh.geometry
  const posAttr = srcGeo.getAttribute('position')
  if (!posAttr || posAttr.count < 3) return null

  mesh.updateWorldMatrix(true, false)
  const index = srcGeo.getIndex()
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3)
  if (triCount === 0) return null

  const attrNames = Array.from(new Set([...ATTRIBUTE_NAMES, ...Object.keys(srcGeo.attributes)])).filter((name) =>
    Boolean(srcGeo.getAttribute(name)),
  )

  let triMaterialIndices: Int32Array | null = null
  if (srcGeo.groups && srcGeo.groups.length > 0) {
    triMaterialIndices = new Int32Array(triCount)
    for (const group of srcGeo.groups) {
      const startTri = Math.max(0, Math.floor(group.start / 3))
      const endTri = Math.min(triCount, Math.floor((group.start + group.count) / 3))
      const matIdx = group.materialIndex ?? 0
      for (let t = startTri; t < endTri; t++) triMaterialIndices[t] = matIdx
    }
  }

  const planes: BoxPlane[] = [
    { axis: 'x', value: worldBox.min.x, keepGreaterOrEqual: true },
    { axis: 'x', value: worldBox.max.x, keepGreaterOrEqual: false },
    { axis: 'y', value: worldBox.min.y, keepGreaterOrEqual: true },
    { axis: 'y', value: worldBox.max.y, keepGreaterOrEqual: false },
    { axis: 'z', value: worldBox.min.z, keepGreaterOrEqual: true },
    { axis: 'z', value: worldBox.max.z, keepGreaterOrEqual: false },
  ]

  const readClipVertex = (vi: number): ClipVertex => {
    const world = new THREE.Vector3()
    getVertexInWorld(mesh, posAttr, vi, world)
    const attrs: Record<string, number[]> = {}
    for (const name of attrNames) {
      const attr = srcGeo.getAttribute(name)!
      const vals = new Array<number>(attr.itemSize)
      for (let k = 0; k < attr.itemSize; k++) vals[k] = attr.getComponent(vi, k)
      attrs[name] = vals
    }
    return { world, attrs }
  }

  type ClippedTri = { verts: [ClipVertex, ClipVertex, ClipVertex]; matIdx: number }
  const extractedTris: ClippedTri[] = []
  const remainingTris: ClippedTri[] = []
  let touchedOriginalTris = 0

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2
    const matIdx = triMaterialIndices ? triMaterialIndices[t] : 0

    getVertexInWorld(mesh, posAttr, i0, scratchV0)
    getVertexInWorld(mesh, posAttr, i1, scratchV1)
    getVertexInWorld(mesh, posAttr, i2, scratchV2)

    const in0 = worldBox.containsPoint(scratchV0)
    const in1 = worldBox.containsPoint(scratchV1)
    const in2 = worldBox.containsPoint(scratchV2)

    if (in0 && in1 && in2) {
      extractedTris.push({ verts: [readClipVertex(i0), readClipVertex(i1), readClipVertex(i2)], matIdx })
      touchedOriginalTris++
      continue
    }

    if (!in0 && !in1 && !in2 && !worldBox.intersectsTriangle(scratchTri)) {
      remainingTris.push({ verts: [readClipVertex(i0), readClipVertex(i1), readClipVertex(i2)], matIdx })
      continue
    }

    // Triangle crosses the 3D box boundary — slice it cleanly across all 6 box planes!
    let insidePolys: ClipVertex[][] = [[readClipVertex(i0), readClipVertex(i1), readClipVertex(i2)]]
    const outsidePolys: ClipVertex[][] = []

    for (const plane of planes) {
      const nextInside: ClipVertex[][] = []
      for (const poly of insidePolys) {
        const { inside, outside } = splitPolygonByPlane(poly, plane)
        if (inside.length >= 3) nextInside.push(inside)
        if (outside.length >= 3) outsidePolys.push(outside)
      }
      insidePolys = nextInside
      if (insidePolys.length === 0) break
    }

    if (insidePolys.length > 0) {
      touchedOriginalTris++
      for (const poly of insidePolys) {
        for (let k = 1; k < poly.length - 1; k++) {
          extractedTris.push({ verts: [poly[0], poly[k], poly[k + 1]], matIdx })
        }
      }
      for (const poly of outsidePolys) {
        for (let k = 1; k < poly.length - 1; k++) {
          remainingTris.push({ verts: [poly[0], poly[k], poly[k + 1]], matIdx })
        }
      }
    } else {
      remainingTris.push({ verts: [readClipVertex(i0), readClipVertex(i1), readClipVertex(i2)], matIdx })
    }
  }

  if (extractedTris.length === 0) return null

  const min = new THREE.Vector3(Infinity, Infinity, Infinity)
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  for (const tri of extractedTris) {
    for (const v of tri.verts) {
      const p = v.attrs.position
      if (p) {
        if (p[0] < min.x) min.x = p[0]
        if (p[1] < min.y) min.y = p[1]
        if (p[2] < min.z) min.z = p[2]
        if (p[0] > max.x) max.x = p[0]
        if (p[1] > max.y) max.y = p[1]
        if (p[2] > max.z) max.z = p[2]
      }
    }
  }
  const center = min.clone().add(max).multiplyScalar(0.5)

  const buildClippedGeo = (tris: ClippedTri[], offset?: THREE.Vector3) => {
    const geo = new THREE.BufferGeometry()
    const vCount = tris.length * 3
    for (const name of attrNames) {
      const srcAttr = srcGeo.getAttribute(name)!
      const itemSize = srcAttr.itemSize
      const isSkin = name === 'skinIndex'
      const out = isSkin ? new Uint16Array(Math.max(0, vCount * itemSize)) : new Float32Array(Math.max(0, vCount * itemSize))
      for (let t = 0; t < tris.length; t++) {
        for (let c = 0; c < 3; c++) {
          const vals = tris[t].verts[c].attrs[name]
          const dst = (t * 3 + c) * itemSize
          for (let k = 0; k < itemSize; k++) {
            let val = vals[k] ?? 0
            if (name === 'position' && offset) {
              if (k === 0) val -= offset.x
              else if (k === 1) val -= offset.y
              else if (k === 2) val -= offset.z
            }
            out[dst + k] = val
          }
        }
      }
      geo.setAttribute(name, new THREE.BufferAttribute(out, itemSize))
    }
    if (!geo.getAttribute('normal')) {
      if (vCount > 0) geo.computeVertexNormals()
      else geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(0), 3))
    }
    if (triMaterialIndices && tris.length > 0) {
      let groupStart = 0
      let curMat = tris[0].matIdx
      for (let i = 1; i < tris.length; i++) {
        if (tris[i].matIdx !== curMat) {
          geo.addGroup(groupStart * 3, (i - groupStart) * 3, curMat)
          groupStart = i
          curMat = tris[i].matIdx
        }
      }
      geo.addGroup(groupStart * 3, (tris.length - groupStart) * 3, curMat)
    }
    geo.computeBoundingBox()
    geo.computeBoundingSphere()
    return geo
  }

  const partGeo = buildClippedGeo(extractedTris, center)
  const remainingGeometry = buildClippedGeo(remainingTris)

  const partMaterial = Array.isArray(mesh.material) ? [...mesh.material] : mesh.material
  const part = new THREE.Mesh(partGeo, partMaterial)
  part.rotation.copy(mesh.rotation)
  part.quaternion.copy(mesh.quaternion)
  part.scale.copy(mesh.scale)
  const worldOffset = center.clone().multiply(mesh.scale).applyQuaternion(mesh.quaternion)
  part.position.copy(mesh.position).add(worldOffset)

  const baseId = (mesh.userData.forgeId as string | undefined) || mesh.name || 'mesh'
  part.name = options?.name ?? `${mesh.name || 'Part'}_extracted`
  part.userData.forgeId = options?.forgeId ?? `${baseId}:extract`
  part.userData.splitFrom = mesh.userData.forgeId ?? baseId
  if (mesh.userData.forgeImported) part.userData.forgeImported = true
  part.castShadow = mesh.castShadow
  part.receiveShadow = mesh.receiveShadow
  part.visible = mesh.visible

  return {
    part,
    remainingGeometry,
    removedCount: touchedOriginalTris,
    remainingCount: remainingTris.length,
    center: [center.x, center.y, center.z],
  }
}

export function smoothSpikyMeshEdges(mesh: THREE.Mesh, passes = 3): number {
  const geo = mesh?.geometry
  const posAttr = geo?.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!posAttr || posAttr.count < 3) return 0

  const index = geo.getIndex()
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3)
  if (triCount < 1) return 0

  const quantize = (n: number) => Math.round(n * 10000)
  const keyOf = (vi: number) => `${quantize(posAttr.getX(vi))},${quantize(posAttr.getY(vi))},${quantize(posAttr.getZ(vi))}`

  let smoothedVertices = 0
  for (let pass = 0; pass < passes; pass++) {
    const keyToVerts = new Map<string, number[]>()
    const keyCoords = new Map<string, THREE.Vector3>()
    const keyTriCount = new Map<string, number>()
    const edgeCount = new Map<string, { a: string; b: string; count: number }>()
    const triKeys: Array<[string, string, string]> = []

    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2
      const k0 = keyOf(i0)
      const k1 = keyOf(i1)
      const k2 = keyOf(i2)
      triKeys.push([k0, k1, k2])

      for (const [vi, k] of [
        [i0, k0],
        [i1, k1],
        [i2, k2],
      ] as const) {
        let list = keyToVerts.get(k)
        if (!list) {
          list = []
          keyToVerts.set(k, list)
          keyCoords.set(k, new THREE.Vector3(posAttr.getX(vi), posAttr.getY(vi), posAttr.getZ(vi)))
        }
        list.push(vi)
      }
      keyTriCount.set(k0, (keyTriCount.get(k0) ?? 0) + 1)
      keyTriCount.set(k1, (keyTriCount.get(k1) ?? 0) + 1)
      keyTriCount.set(k2, (keyTriCount.get(k2) ?? 0) + 1)

      for (const [a, b] of [
        [k0, k1],
        [k1, k2],
        [k2, k0],
      ] as const) {
        if (a === b) continue
        const ek = a < b ? `${a}|${b}` : `${b}|${a}`
        const prev = edgeCount.get(ek)
        if (prev) prev.count++
        else edgeCount.set(ek, { a, b, count: 1 })
      }
    }

    const boundaryNeighbors = new Map<string, Set<string>>()
    for (const { a, b, count } of edgeCount.values()) {
      if (count === 1) {
        if (!boundaryNeighbors.has(a)) boundaryNeighbors.set(a, new Set())
        if (!boundaryNeighbors.has(b)) boundaryNeighbors.set(b, new Set())
        boundaryNeighbors.get(a)!.add(b)
        boundaryNeighbors.get(b)!.add(a)
      }
    }

    const newPositions = new Map<string, THREE.Vector3>()
    // First: collapse 1-triangle saw-tooth icicle tips right onto their base edge midpoint
    for (const [k0, k1, k2] of triKeys) {
      for (const [tip, baseA, baseB] of [
        [k0, k1, k2],
        [k1, k2, k0],
        [k2, k0, k1],
      ] as const) {
        if ((keyTriCount.get(tip) ?? 0) === 1 && boundaryNeighbors.has(tip)) {
          const pA = keyCoords.get(baseA)
          const pB = keyCoords.get(baseB)
          const pTip = keyCoords.get(tip)
          if (pA && pB && pTip) {
            const mid = pA.clone().add(pB).multiplyScalar(0.5)
            newPositions.set(tip, pTip.clone().lerp(mid, 0.85))
          }
        }
      }
    }

    // Second: Laplacian smooth open boundary vertices along the cut rim
    for (const [k, neighbors] of boundaryNeighbors) {
      if (newPositions.has(k) || neighbors.size < 2) continue
      const pos = keyCoords.get(k)
      if (!pos) continue
      const avg = new THREE.Vector3()
      let count = 0
      for (const nk of neighbors) {
        const np = keyCoords.get(nk)
        if (np) {
          avg.add(np)
          count++
        }
      }
      if (count >= 2) {
        avg.multiplyScalar(1 / count)
        newPositions.set(k, pos.clone().lerp(avg, 0.55))
      }
    }

    for (const [k, nextPos] of newPositions) {
      const verts = keyToVerts.get(k)
      if (!verts) continue
      for (const vi of verts) {
        posAttr.setXYZ(vi, nextPos.x, nextPos.y, nextPos.z)
        smoothedVertices++
      }
    }
  }

  if (smoothedVertices > 0) {
    posAttr.needsUpdate = true
    geo.computeVertexNormals()
    geo.computeBoundingBox()
    geo.computeBoundingSphere()
  }
  return smoothedVertices
}
