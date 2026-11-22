import * as THREE from 'three/webgpu'

export type SplitResult = {
  parts: THREE.Mesh[]
  reason?: string
}

class UnionFind {
  private parent: Int32Array
  constructor(size: number) {
    this.parent = new Int32Array(size)
    for (let i = 0; i < size; i++) this.parent[i] = i
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]
      x = this.parent[x]
    }
    return x
  }
  union(a: number, b: number) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[rb] = ra
  }
}

function buildCenteredPartMesh(
  sourceMesh: THREE.Mesh,
  triangleVertexIndices: number[],
  material: THREE.Material | THREE.Material[],
  partName: string,
  forgeId: string
): THREE.Mesh {
  const srcGeo = sourceMesh.geometry
  const posAttr = srcGeo.getAttribute('position')
  const normAttr = srcGeo.getAttribute('normal')
  const uvAttr = srcGeo.getAttribute('uv')

  const vertCount = triangleVertexIndices.length
  const positions = new Float32Array(vertCount * 3)
  const normals = normAttr ? new Float32Array(vertCount * 3) : null
  const uvs = uvAttr ? new Float32Array(vertCount * 2) : null

  const min = new THREE.Vector3(Infinity, Infinity, Infinity)
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)

  for (let i = 0; i < vertCount; i++) {
    const vi = triangleVertexIndices[i]
    const x = posAttr.getX(vi)
    const y = posAttr.getY(vi)
    const z = posAttr.getZ(vi)
    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = z
    if (x < min.x) min.x = x
    if (y < min.y) min.y = y
    if (z < min.z) min.z = z
    if (x > max.x) max.x = x
    if (y > max.y) max.y = y
    if (z > max.z) max.z = z

    if (normals && normAttr) {
      normals[i * 3] = normAttr.getX(vi)
      normals[i * 3 + 1] = normAttr.getY(vi)
      normals[i * 3 + 2] = normAttr.getZ(vi)
    }
    if (uvs && uvAttr) {
      uvs[i * 2] = uvAttr.getX(vi)
      uvs[i * 2 + 1] = uvAttr.getY(vi)
    }
  }

  // Center local geometry at its bounding-box center so the pivot sits on the part
  const center = min.clone().add(max).multiplyScalar(0.5)
  for (let i = 0; i < vertCount; i++) {
    positions[i * 3] -= center.x
    positions[i * 3 + 1] -= center.y
    positions[i * 3 + 2] -= center.z
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (normals) geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  else geo.computeVertexNormals()
  if (uvs) geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  for (const extraName of ['skinIndex', 'skinWeight', 'color', 'uv1', 'tangent']) {
    const extraAttr = srcGeo.getAttribute(extraName) as THREE.BufferAttribute | undefined
    if (!extraAttr) continue
    const itemSize = extraAttr.itemSize
    const isSkinIndex = extraName === 'skinIndex'
    const out = isSkinIndex ? new Uint16Array(vertCount * itemSize) : new Float32Array(vertCount * itemSize)
    for (let i = 0; i < vertCount; i++) {
      const vi = triangleVertexIndices[i]
      for (let k = 0; k < itemSize; k++) out[i * itemSize + k] = extraAttr.getComponent(vi, k)
    }
    geo.setAttribute(extraName, new THREE.BufferAttribute(out, itemSize))
  }
  geo.computeBoundingBox()
  geo.computeBoundingSphere()

  const part = new THREE.Mesh(geo, material)
  part.name = partName
  part.position.copy(center)
  part.userData.forgeId = forgeId
  part.userData.splitFrom = sourceMesh.userData.forgeId
  part.castShadow = sourceMesh.castShadow
  part.receiveShadow = sourceMesh.receiveShadow
  return part
}

export function splitMeshByConnectedIslands(mesh: THREE.Mesh): SplitResult {
  const posAttr = mesh.geometry?.getAttribute('position')
  if (!posAttr || posAttr.count < 3) {
    return { parts: [], reason: 'Mesh has no triangles to split' }
  }

  const index = mesh.geometry.getIndex()
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3)
  if (triCount <= 1) {
    return { parts: [], reason: 'Mesh is already a single connected part' }
  }

  const uf = new UnionFind(triCount)
  const vertexToTri = new Map<string, number>()
  const quantize = (n: number) => Math.round(n * 10000)

  const getVertexIndex = (tri: number, corner: number) => (index ? index.getX(tri * 3 + corner) : tri * 3 + corner)

  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const vi = getVertexIndex(t, c)
      const key = `${quantize(posAttr.getX(vi))},${quantize(posAttr.getY(vi))},${quantize(posAttr.getZ(vi))}`
      const prevTri = vertexToTri.get(key)
      if (prevTri !== undefined) {
        uf.union(t, prevTri)
      } else {
        vertexToTri.set(key, t)
      }
    }
  }

  const groups = new Map<number, number[]>()
  for (let t = 0; t < triCount; t++) {
    const root = uf.find(t)
    let list = groups.get(root)
    if (!list) {
      list = []
      groups.set(root, list)
    }
    list.push(getVertexIndex(t, 0), getVertexIndex(t, 1), getVertexIndex(t, 2))
  }

  if (groups.size <= 1) {
    return { parts: [], reason: 'Mesh is already a single connected part' }
  }

  const baseId = (mesh.userData.forgeId as string | undefined) ?? mesh.name ?? 'mesh'
  const baseName = mesh.name || 'Part'
  const parts: THREE.Mesh[] = []
  let idx = 0
  for (const vertIndices of groups.values()) {
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    parts.push(buildCenteredPartMesh(mesh, vertIndices, mat, `${baseName}_part_${idx + 1}`, `${baseId}:part-${idx}`))
    idx++
  }
  return { parts }
}

export function splitMeshByMaterialGroups(mesh: THREE.Mesh): SplitResult {
  const geo = mesh.geometry
  const posAttr = geo?.getAttribute('position')
  if (!posAttr || !geo.groups || geo.groups.length <= 1) {
    return { parts: [], reason: 'Mesh does not have multiple material groups' }
  }

  const index = geo.getIndex()
  const baseId = (mesh.userData.forgeId as string | undefined) ?? mesh.name ?? 'mesh'
  const baseName = mesh.name || 'Part'
  const parts: THREE.Mesh[] = []

  geo.groups.forEach((group, idx) => {
    const vertIndices: number[] = []
    for (let i = group.start; i < group.start + group.count; i++) {
      vertIndices.push(index ? index.getX(i) : i)
    }
    if (vertIndices.length < 3) return
    const mat = Array.isArray(mesh.material)
      ? mesh.material[group.materialIndex ?? 0] ?? mesh.material[0]
      : mesh.material
    parts.push(buildCenteredPartMesh(mesh, vertIndices, mat, `${baseName}_mat_${idx + 1}`, `${baseId}:mat-${idx}`))
  })

  if (parts.length <= 1) {
    return { parts: [], reason: 'Mesh does not have multiple material groups' }
  }
  return { parts }
}
