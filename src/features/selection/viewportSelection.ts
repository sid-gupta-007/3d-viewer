import * as THREE from 'three/webgpu'

export type ScreenRect = { minX: number; maxX: number; minY: number; maxY: number }

const CLIP_EPS = 1e-6
const PROJ_EPS = 1e-7
const BOX_TRIANGLE_INDICES = [
  0, 1, 3, 0, 3, 2,
  4, 6, 7, 4, 7, 5,
  0, 4, 5, 0, 5, 1,
  2, 3, 7, 2, 7, 6,
  0, 2, 6, 0, 6, 4,
  1, 5, 7, 1, 7, 3,
] as const

const projScreenMatrix = new THREE.Matrix4()
const mvpMatrix = new THREE.Matrix4()
const frustum = new THREE.Frustum()
const worldBox = new THREE.Box3()
const scratchVertex = new THREE.Vector3()
let clipBuffer = new Float64Array(4096)
let vertexSeenBuffer = new Uint8Array(1024)

const ensureClipCapacity = (floatCount: number) => {
  if (clipBuffer.length < floatCount) {
    clipBuffer = new Float64Array(Math.max(floatCount, clipBuffer.length * 2))
  }
}

const ensureVertexSeenCapacity = (vertCount: number) => {
  if (vertexSeenBuffer.length < vertCount) {
    vertexSeenBuffer = new Uint8Array(Math.max(vertCount, vertexSeenBuffer.length * 2))
  }
}

function isMeshVisible(object: THREE.Object3D): boolean {
  for (let ancestor: THREE.Object3D | null = object; ancestor; ancestor = ancestor.parent) {
    if (!ancestor.visible) return false
  }
  return true
}

function clipPolygonPlane(
  input: number[],
  output: number[],
  evalPlane: (cx: number, cy: number, cz: number, cw: number) => number,
) {
  output.length = 0
  const count = input.length / 4
  if (count === 0) return

  let prevX = input[(count - 1) * 4]
  let prevY = input[(count - 1) * 4 + 1]
  let prevZ = input[(count - 1) * 4 + 2]
  let prevW = input[(count - 1) * 4 + 3]
  let prevD = evalPlane(prevX, prevY, prevZ, prevW)
  let prevIn = prevD >= 0

  for (let i = 0; i < count; i++) {
    const base = i * 4
    const curX = input[base]
    const curY = input[base + 1]
    const curZ = input[base + 2]
    const curW = input[base + 3]
    const curD = evalPlane(curX, curY, curZ, curW)
    const curIn = curD >= 0

    if (curIn !== prevIn) {
      const denom = prevD - curD
      const t = Math.abs(denom) > 1e-12 ? prevD / denom : 0
      output.push(
        prevX + (curX - prevX) * t,
        prevY + (curY - prevY) * t,
        prevZ + (curZ - prevZ) * t,
        prevW + (curW - prevW) * t,
      )
    }
    if (curIn) {
      output.push(curX, curY, curZ, curW)
    }

    prevX = curX
    prevY = curY
    prevZ = curZ
    prevW = curW
    prevD = curD
    prevIn = curIn
  }
}

function segmentIntersectsRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rMinX: number,
  rMaxX: number,
  rMinY: number,
  rMaxY: number,
): boolean {
  let t0 = 0
  let t1 = 1
  const dx = x1 - x0
  const dy = y1 - y0

  const clipEdge = (p: number, q: number): boolean => {
    if (Math.abs(p) <= 1e-12) return q >= 0
    const r = q / p
    if (p < 0) {
      if (r > t1) return false
      if (r > t0) t0 = r
    } else {
      if (r < t0) return false
      if (r < t1) t1 = r
    }
    return true
  }

  return (
    clipEdge(-dx, x0 - rMinX) &&
    clipEdge(dx, rMaxX - x0) &&
    clipEdge(-dy, y0 - rMinY) &&
    clipEdge(dy, rMaxY - y0) &&
    t0 <= t1
  )
}

function pointInConvexPolygon(qx: number, qy: number, poly: number[]): boolean {
  const count = poly.length / 2
  if (count < 3) return false

  let area2 = 0
  let hasPos = false
  let hasNeg = false

  for (let i = 0; i < count; i++) {
    const ax = poly[i * 2]
    const ay = poly[i * 2 + 1]
    const next = (i + 1) % count
    const bx = poly[next * 2]
    const by = poly[next * 2 + 1]
    area2 += ax * by - bx * ay
    const cross = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax)
    if (cross > 1e-6) hasPos = true
    else if (cross < -1e-6) hasNeg = true
    if (hasPos && hasNeg) return false
  }

  return Math.abs(area2) > 1e-6
}

const polyScratchA: number[] = []
const polyScratchB: number[] = []
const screenPolyScratch: number[] = []

function clipAndTestTriangle2D(
  c0x: number,
  c0y: number,
  c0z: number,
  c0w: number,
  c1x: number,
  c1y: number,
  c1z: number,
  c1w: number,
  c2x: number,
  c2y: number,
  c2z: number,
  c2w: number,
  width: number,
  height: number,
  rMinX: number,
  rMaxX: number,
  rMinY: number,
  rMaxY: number,
  isWebGPU: boolean,
): boolean {
  polyScratchA.length = 0
  polyScratchA.push(c0x, c0y, c0z, c0w, c1x, c1y, c1z, c1w, c2x, c2y, c2z, c2w)

  clipPolygonPlane(polyScratchA, polyScratchB, (_cx, _cy, cz, cw) => (isWebGPU ? cz : cz + cw))
  if (polyScratchB.length < 12) return false

  clipPolygonPlane(polyScratchB, polyScratchA, (_cx, _cy, cz, cw) => cw - cz)
  if (polyScratchA.length < 12) return false

  screenPolyScratch.length = 0
  const vertCount = polyScratchA.length / 4
  let pMinX = Infinity
  let pMaxX = -Infinity
  let pMinY = Infinity
  let pMaxY = -Infinity

  for (let i = 0; i < vertCount; i++) {
    const base = i * 4
    const cw = polyScratchA[base + 3]
    if (cw <= PROJ_EPS) return false
    const sx = (polyScratchA[base] / cw + 1) * 0.5 * width
    const sy = (1 - polyScratchA[base + 1] / cw) * 0.5 * height
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return false
    screenPolyScratch.push(sx, sy)
    if (sx < pMinX) pMinX = sx
    if (sx > pMaxX) pMaxX = sx
    if (sy < pMinY) pMinY = sy
    if (sy > pMaxY) pMaxY = sy
  }

  if (pMaxX < rMinX || pMinX > rMaxX || pMaxY < rMinY || pMinY > rMaxY) return false

  for (let i = 0; i < vertCount; i++) {
    const next = (i + 1) % vertCount
    if (
      segmentIntersectsRect(
        screenPolyScratch[i * 2],
        screenPolyScratch[i * 2 + 1],
        screenPolyScratch[next * 2],
        screenPolyScratch[next * 2 + 1],
        rMinX,
        rMaxX,
        rMinY,
        rMaxY,
      )
    ) {
      return true
    }
  }

  return pointInConvexPolygon(rMinX, rMinY, screenPolyScratch)
}

function testBoxFallback(
  mesh: THREE.Mesh,
  width: number,
  height: number,
  rMinX: number,
  rMaxX: number,
  rMinY: number,
  rMaxY: number,
  crossing: boolean,
  isWebGPU: boolean,
): boolean {
  worldBox.setFromObject(mesh)
  if (worldBox.isEmpty() || !frustum.intersectsBox(worldBox)) return false

  const corners = [
    [worldBox.min.x, worldBox.min.y, worldBox.min.z],
    [worldBox.min.x, worldBox.min.y, worldBox.max.z],
    [worldBox.min.x, worldBox.max.y, worldBox.min.z],
    [worldBox.min.x, worldBox.max.y, worldBox.max.z],
    [worldBox.max.x, worldBox.min.y, worldBox.min.z],
    [worldBox.max.x, worldBox.min.y, worldBox.max.z],
    [worldBox.max.x, worldBox.max.y, worldBox.min.z],
    [worldBox.max.x, worldBox.max.y, worldBox.max.z],
  ]

  const e = projScreenMatrix.elements
  ensureClipCapacity(32)

  let allInside = true
  let anyInRect = false
  let allFrontValid = true
  let allLeft = true
  let allRight = true
  let allTop = true
  let allBottom = true

  for (let i = 0; i < 8; i++) {
    const [vx, vy, vz] = corners[i]
    const cx = e[0] * vx + e[4] * vy + e[8] * vz + e[12]
    const cy = e[1] * vx + e[5] * vy + e[9] * vz + e[13]
    const cz = e[2] * vx + e[6] * vy + e[10] * vz + e[14]
    const cw = e[3] * vx + e[7] * vy + e[11] * vz + e[15]

    const base = i * 4
    clipBuffer[base] = cx
    clipBuffer[base + 1] = cy
    clipBuffer[base + 2] = cz
    clipBuffer[base + 3] = cw

    if (cw > CLIP_EPS && (isWebGPU ? cz >= 0 : cz >= -cw) && cz <= cw) {
      const sx = (cx / cw + 1) * 0.5 * width
      const sy = (1 - cy / cw) * 0.5 * height
      const inRect = sx >= rMinX && sx <= rMaxX && sy >= rMinY && sy <= rMaxY
      if (inRect) anyInRect = true
      else allInside = false
      if (sx >= rMinX) allLeft = false
      if (sx <= rMaxX) allRight = false
      if (sy >= rMinY) allTop = false
      if (sy <= rMaxY) allBottom = false
    } else {
      allInside = false
      allFrontValid = false
    }
  }

  if (!crossing) return allInside
  if (anyInRect) return true
  if (allFrontValid && (allLeft || allRight || allTop || allBottom)) return false

  for (let i = 0; i < BOX_TRIANGLE_INDICES.length; i += 3) {
    const a = BOX_TRIANGLE_INDICES[i] * 4
    const b = BOX_TRIANGLE_INDICES[i + 1] * 4
    const c = BOX_TRIANGLE_INDICES[i + 2] * 4
    if (
      clipAndTestTriangle2D(
        clipBuffer[a],
        clipBuffer[a + 1],
        clipBuffer[a + 2],
        clipBuffer[a + 3],
        clipBuffer[b],
        clipBuffer[b + 1],
        clipBuffer[b + 2],
        clipBuffer[b + 3],
        clipBuffer[c],
        clipBuffer[c + 1],
        clipBuffer[c + 2],
        clipBuffer[c + 3],
        width,
        height,
        rMinX,
        rMaxX,
        rMinY,
        rMaxY,
        isWebGPU,
      )
    ) {
      return true
    }
  }

  return false
}

export function selectMeshesInRect(
  objects: Map<string, THREE.Object3D>,
  camera: THREE.Camera,
  width: number,
  height: number,
  rect: ScreenRect,
  crossing: boolean,
): string[] {
  if (width <= 0 || height <= 0) return []

  const rMinX = Math.min(rect.minX, rect.maxX)
  const rMaxX = Math.max(rect.minX, rect.maxX)
  const rMinY = Math.min(rect.minY, rect.maxY)
  const rMaxY = Math.max(rect.minY, rect.maxY)

  const isWebGPU = camera.coordinateSystem === THREE.WebGPUCoordinateSystem
  camera.updateMatrixWorld(true)
  projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  frustum.setFromProjectionMatrix(projScreenMatrix, camera.coordinateSystem)

  const selected: string[] = []
  for (const [id, object] of objects) {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || mesh.userData.forgeEditorHelper) continue
    if (!isMeshVisible(mesh)) continue
    mesh.updateWorldMatrix(true, false)

    const position = mesh.geometry?.getAttribute('position')
    if (!position) {
      if (testBoxFallback(mesh, width, height, rMinX, rMaxX, rMinY, rMaxY, crossing, isWebGPU)) {
        selected.push(id)
      }
      continue
    }
    if (position.count === 0) continue

    const index = mesh.geometry.getIndex()
    if (index && index.count < 3) continue

    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    if (mesh.geometry.boundingBox) {
      worldBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld)
      if (worldBox.isEmpty() || !frustum.intersectsBox(worldBox)) continue
    }

    mvpMatrix.multiplyMatrices(projScreenMatrix, mesh.matrixWorld)
    const e = mvpMatrix.elements
    const vertCount = position.count
    ensureClipCapacity(vertCount * 4)

    let allInside = true
    let anyVertexInRect = false
    let allFrontValid = true
    let allLeft = true
    let allRight = true
    let allTop = true
    let allBottom = true
    let evaluatedAny = false

    const evaluateVertex = (vi: number): boolean => {
      evaluatedAny = true
      scratchVertex.fromBufferAttribute(position, vi)
      const vx = scratchVertex.x
      const vy = scratchVertex.y
      const vz = scratchVertex.z
      const cx = e[0] * vx + e[4] * vy + e[8] * vz + e[12]
      const cy = e[1] * vx + e[5] * vy + e[9] * vz + e[13]
      const cz = e[2] * vx + e[6] * vy + e[10] * vz + e[14]
      const cw = e[3] * vx + e[7] * vy + e[11] * vz + e[15]

      const base = vi * 4
      clipBuffer[base] = cx
      clipBuffer[base + 1] = cy
      clipBuffer[base + 2] = cz
      clipBuffer[base + 3] = cw

      if (cw > CLIP_EPS && (isWebGPU ? cz >= 0 : cz >= -cw) && cz <= cw) {
        const sx = (cx / cw + 1) * 0.5 * width
        const sy = (1 - cy / cw) * 0.5 * height
        const inRect = sx >= rMinX && sx <= rMaxX && sy >= rMinY && sy <= rMaxY
        if (inRect) {
          anyVertexInRect = true
          if (crossing) return true
        } else {
          allInside = false
          if (!crossing) return true
        }
        if (sx >= rMinX) allLeft = false
        if (sx <= rMaxX) allRight = false
        if (sy >= rMinY) allTop = false
        if (sy <= rMaxY) allBottom = false
      } else {
        allInside = false
        allFrontValid = false
        if (!crossing) return true
      }
      return false
    }

    if (index) {
      const usedIndexCount = Math.floor(index.count / 3) * 3
      ensureVertexSeenCapacity(vertCount)
      vertexSeenBuffer.fill(0, 0, vertCount)
      for (let k = 0; k < usedIndexCount; k++) {
        const vi = index.getX(k)
        if (vi < 0 || vi >= vertCount || vertexSeenBuffer[vi] !== 0) continue
        vertexSeenBuffer[vi] = 1
        if (evaluateVertex(vi)) break
      }
    } else {
      for (let vi = 0; vi < vertCount; vi++) {
        if (evaluateVertex(vi)) break
      }
    }

    if (!evaluatedAny) continue

    if (!crossing) {
      if (allInside) selected.push(id)
      continue
    }

    if (anyVertexInRect) {
      selected.push(id)
      continue
    }

    if (allFrontValid && (allLeft || allRight || allTop || allBottom)) {
      continue
    }

    const triCount = index ? Math.floor(index.count / 3) : Math.floor(vertCount / 3)
    for (let t = 0; t < triCount; t++) {
      const v0 = index ? index.getX(t * 3) : t * 3
      const v1 = index ? index.getX(t * 3 + 1) : t * 3 + 1
      const v2 = index ? index.getX(t * 3 + 2) : t * 3 + 2
      if (v0 < 0 || v0 >= vertCount || v1 < 0 || v1 >= vertCount || v2 < 0 || v2 >= vertCount) continue
      const i0 = v0 * 4
      const i1 = v1 * 4
      const i2 = v2 * 4
      if (
        clipAndTestTriangle2D(
          clipBuffer[i0],
          clipBuffer[i0 + 1],
          clipBuffer[i0 + 2],
          clipBuffer[i0 + 3],
          clipBuffer[i1],
          clipBuffer[i1 + 1],
          clipBuffer[i1 + 2],
          clipBuffer[i1 + 3],
          clipBuffer[i2],
          clipBuffer[i2 + 1],
          clipBuffer[i2 + 2],
          clipBuffer[i2 + 3],
          width,
          height,
          rMinX,
          rMaxX,
          rMinY,
          rMaxY,
          isWebGPU,
        )
      ) {
        selected.push(id)
        break
      }
    }
  }

  return selected
}
