import type {
  ForgePartOperation,
  ForgeSceneManifest,
  KeyframeManifest,
  NodeManifest,
  Vec3,
} from '../../domain/sceneManifest.ts'

const BEGIN_MARKER = '// @forge:begin'
const END_MARKER = '// @forge:end'

const RESERVED_IDENTIFIERS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
  'as', 'implements', 'interface', 'let', 'package', 'private', 'protected', 'public',
  'static', 'yield', 'any', 'boolean', 'constructor', 'declare', 'get', 'module',
  'require', 'number', 'set', 'string', 'symbol', 'type', 'from', 'of', 'async',
  'await', 'eval', 'arguments', 'NaN', 'Infinity', 'undefined',
])

function fmtVec(v: Vec3): string {
  return `[${v.map((n) => Number(n.toFixed(4))).join(', ')}]`
}

function escapeJsString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

function formatJsxStringProp(value: string): string {
  if (!/["'\n\r\t\\\u2028\u2029\x00-\x1f]/.test(value)) {
    return `"${value}"`
  }
  return `{'${escapeJsString(value)}'}`
}

function sanitizeIdentifier(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_$]/g, '')
  if (!cleaned || !/^[a-zA-Z_$]/.test(cleaned)) {
    return `Forge${cleaned || 'Scene'}`
  }
  if (RESERVED_IDENTIFIERS.has(cleaned)) {
    return `Forge_${cleaned}`
  }
  return cleaned
}

function deriveAssetKey(manifest: ForgeSceneManifest): string {
  const rootNode = manifest.nodes.find((n) => n.parentId === null && n.forgeId.endsWith(':root'))
  if (rootNode) return rootNode.forgeId.slice(0, -':root'.length)
  const firstColon = manifest.nodes.find((n) => n.forgeId.includes(':'))
  if (firstColon) return firstColon.forgeId.slice(0, firstColon.forgeId.indexOf(':'))
  if (manifest.assetKey) return manifest.assetKey
  return 'model'
}

function resolveManifestDuration(manifest: ForgeSceneManifest): number {
  if (typeof manifest.duration === 'number' && Number.isFinite(manifest.duration) && manifest.duration > 0) {
    return manifest.duration
  }
  let maxTime = 5
  for (const kf of manifest.keyframes) {
    if (kf.time > maxTime) maxTime = kf.time
  }
  return maxTime
}

function resolvePartOperations(manifest: ForgeSceneManifest): ForgePartOperation[] {
  const ops: ForgePartOperation[] = [...(manifest.splits ?? [])]
  const coveredSplits = new Set<string>()
  const coveredExtracts = new Set<string>()

  for (const op of ops) {
    if (op.kind === 'split') {
      coveredSplits.add(`${op.sourceId}:${op.mode}`)
    } else {
      coveredExtracts.add(op.partId)
    }
  }

  for (const node of manifest.nodes) {
    if (node.splitMode === 'extract' && node.splitFrom && Array.isArray(node.extractedTriangles)) {
      if (!coveredExtracts.has(node.forgeId)) {
        ops.push({
          kind: 'extract',
          sourceId: node.splitFrom,
          partId: node.forgeId,
          partName: node.name,
          triangleIndices: [...node.extractedTriangles],
        })
        coveredExtracts.add(node.forgeId)
      }
      continue
    }

    const partMatch = node.forgeId.match(/^(.*):(part|mat)-(\d+)$/)
    const sourceId = node.splitFrom ?? (partMatch ? partMatch[1] : undefined)
    if (!sourceId) continue

    const mode: 'islands' | 'materials' | null =
      node.splitMode === 'materials' || partMatch?.[2] === 'mat'
        ? 'materials'
        : node.splitMode === 'islands' || partMatch?.[2] === 'part'
          ? 'islands'
          : null

    if (mode && !coveredSplits.has(`${sourceId}:${mode}`)) {
      ops.push({ kind: 'split', sourceId, mode })
      coveredSplits.add(`${sourceId}:${mode}`)
    }
  }

  return ops
}

function formatNodeEntry(n: NodeManifest): string {
  const parts = [
    `name: '${escapeJsString(n.name)}'`,
    `parentId: ${n.parentId === null ? 'null' : `'${escapeJsString(n.parentId)}'`}`,
    `type: '${escapeJsString(n.type)}'`,
    `position: ${fmtVec(n.position)}`,
    `rotation: ${fmtVec(n.rotation)}`,
    `scale: ${fmtVec(n.scale)}`,
    `visible: ${n.visible}`,
  ]
  if (n.pivot) {
    parts.push(`pivot: ${fmtVec(n.pivot)}`)
  }
  if (n.splitFrom) {
    parts.push(`splitFrom: '${escapeJsString(n.splitFrom)}'`)
  }
  if (n.splitMode) {
    parts.push(`splitMode: '${n.splitMode}'`)
  }
  if (n.splitIndex !== undefined) {
    parts.push(`splitIndex: ${n.splitIndex}`)
  }
  if (n.extractedTriangles) {
    parts.push(`extractedTriangles: ${JSON.stringify(n.extractedTriangles)}`)
  }
  return `    '${escapeJsString(n.forgeId)}': { ${parts.join(', ')} },`
}

function formatKeyframeEntry(kf: KeyframeManifest): string {
  const parts = [
    `id: '${escapeJsString(kf.id)}'`,
    `targetId: '${escapeJsString(kf.targetId)}'`,
    `time: ${Number(kf.time.toFixed(4))}`,
    `position: ${fmtVec(kf.position)}`,
    `rotation: ${fmtVec(kf.rotation)}`,
    `scale: ${fmtVec(kf.scale)}`,
  ]
  if (kf.easing) {
    parts.push(`easing: '${kf.easing}'`)
  }
  return `    { ${parts.join(', ')} },`
}

function buildSplitHelpersSource(): string {
  return `
function forgeBuildCenteredPartMesh(
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

  const center = vertCount > 0 ? min.clone().add(max).multiplyScalar(0.5) : new THREE.Vector3()
  for (let i = 0; i < vertCount; i++) {
    positions[i * 3] -= center.x
    positions[i * 3 + 1] -= center.y
    positions[i * 3 + 2] -= center.z
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (normals) geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  else if (vertCount > 0) geo.computeVertexNormals()
  if (uvs) geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geo.computeBoundingBox()
  geo.computeBoundingSphere()

  const part = new THREE.Mesh(geo, material)
  part.name = partName
  part.position.copy(center)
  part.userData.forgeId = forgeId
  part.userData.splitFrom = sourceMesh.userData.forgeId
  part.userData.__forgeGenerated = true
  part.castShadow = sourceMesh.castShadow
  part.receiveShadow = sourceMesh.receiveShadow
  return part
}

function forgeApplyTriGroups(
  geo: THREE.BufferGeometry,
  triList: readonly number[],
  triMaterialIndices: Int32Array | null
): void {
  if (!triMaterialIndices || triList.length === 0) return
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

function forgeSplitIslands(mesh: THREE.Mesh): THREE.Mesh[] {
  const posAttr = mesh.geometry?.getAttribute('position')
  if (!posAttr || posAttr.count < 3) return []
  const index = mesh.geometry.getIndex()
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3)
  if (triCount <= 1) return []
  const parent = new Int32Array(triCount)
  for (let i = 0; i < triCount; i++) parent[i] = i
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  const vertexToTri = new Map<string, number>()
  const q = (n: number) => Math.round(n * 10000)
  const getVi = (t: number, c: number) => (index ? index.getX(t * 3 + c) : t * 3 + c)
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const vi = getVi(t, c)
      const key = \`\${q(posAttr.getX(vi))},\${q(posAttr.getY(vi))},\${q(posAttr.getZ(vi))}\`
      const prev = vertexToTri.get(key)
      if (prev !== undefined) union(t, prev)
      else vertexToTri.set(key, t)
    }
  }
  const groups = new Map<number, number[]>()
  for (let t = 0; t < triCount; t++) {
    const r = find(t)
    let list = groups.get(r)
    if (!list) {
      list = []
      groups.set(r, list)
    }
    list.push(getVi(t, 0), getVi(t, 1), getVi(t, 2))
  }
  if (groups.size <= 1) return []
  const baseId = (mesh.userData.forgeId as string) || mesh.name || 'mesh'
  const baseName = mesh.name || 'Part'
  const parts: THREE.Mesh[] = []
  let idx = 0
  for (const verts of groups.values()) {
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    parts.push(forgeBuildCenteredPartMesh(mesh, verts, mat, \`\${baseName}_part_\${idx + 1}\`, \`\${baseId}:part-\${idx}\`))
    idx++
  }
  return parts
}

function forgeSplitMaterials(mesh: THREE.Mesh): THREE.Mesh[] {
  const geo = mesh.geometry
  const posAttr = geo?.getAttribute('position')
  if (!posAttr || !geo.groups || geo.groups.length <= 1) return []
  const index = geo.getIndex()
  const baseId = (mesh.userData.forgeId as string) || mesh.name || 'mesh'
  const baseName = mesh.name || 'Part'
  const parts: THREE.Mesh[] = []
  geo.groups.forEach((group, idx) => {
    const verts: number[] = []
    for (let i = group.start; i < group.start + group.count; i++) {
      verts.push(index ? index.getX(i) : i)
    }
    if (verts.length < 3) return
    const mat = Array.isArray(mesh.material)
      ? mesh.material[group.materialIndex ?? 0] ?? mesh.material[0]
      : mesh.material
    parts.push(forgeBuildCenteredPartMesh(mesh, verts, mat, \`\${baseName}_mat_\${idx + 1}\`, \`\${baseId}:mat-\${idx}\`))
  })
  return parts.length > 1 ? parts : []
}

function forgeExtractTriangles(
  sourceMesh: THREE.Mesh,
  triangleIndices: readonly number[],
  partId: string,
  partName?: string
): THREE.Mesh | null {
  const srcGeo = sourceMesh.geometry
  const posAttr = srcGeo?.getAttribute('position')
  if (!posAttr || posAttr.count < 3) return null
  const index = srcGeo.getIndex()
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3)
  const getVi = (t: number, c: number) => (index ? index.getX(t * 3 + c) : t * 3 + c)

  const extractSet = new Set<number>()
  for (const t of triangleIndices) {
    if (Number.isInteger(t) && t >= 0 && t < triCount) {
      extractSet.add(t)
    }
  }
  if (extractSet.size === 0) return null

  const extractedTris = Array.from(extractSet).sort((a, b) => a - b)
  const extractVerts: number[] = []
  for (const t of extractedTris) {
    extractVerts.push(getVi(t, 0), getVi(t, 1), getVi(t, 2))
  }

  const remainTris: number[] = []
  const remainVerts: number[] = []
  for (let t = 0; t < triCount; t++) {
    if (!extractSet.has(t)) {
      remainTris.push(t)
      remainVerts.push(getVi(t, 0), getVi(t, 1), getVi(t, 2))
    }
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

  const partMaterial = Array.isArray(sourceMesh.material)
    ? [...sourceMesh.material]
    : sourceMesh.material
  const part = forgeBuildCenteredPartMesh(
    sourceMesh,
    extractVerts,
    partMaterial,
    partName || \`\${sourceMesh.name || 'Part'}_extracted\`,
    partId
  )
  forgeApplyTriGroups(part.geometry, extractedTris, triMaterialIndices)
  sourceMesh.updateMatrix()
  part.position.applyMatrix4(sourceMesh.matrix)
  part.rotation.copy(sourceMesh.rotation)
  part.quaternion.copy(sourceMesh.quaternion)
  part.scale.copy(sourceMesh.scale)

  const normAttr = srcGeo.getAttribute('normal')
  const uvAttr = srcGeo.getAttribute('uv')
  const remainCount = remainVerts.length
  const rPos = new Float32Array(remainCount * 3)
  const rNorm = normAttr ? new Float32Array(remainCount * 3) : null
  const rUv = uvAttr ? new Float32Array(remainCount * 2) : null
  for (let i = 0; i < remainCount; i++) {
    const vi = remainVerts[i]
    rPos[i * 3] = posAttr.getX(vi)
    rPos[i * 3 + 1] = posAttr.getY(vi)
    rPos[i * 3 + 2] = posAttr.getZ(vi)
    if (rNorm && normAttr) {
      rNorm[i * 3] = normAttr.getX(vi)
      rNorm[i * 3 + 1] = normAttr.getY(vi)
      rNorm[i * 3 + 2] = normAttr.getZ(vi)
    }
    if (rUv && uvAttr) {
      rUv[i * 2] = uvAttr.getX(vi)
      rUv[i * 2 + 1] = uvAttr.getY(vi)
    }
  }
  const remainGeo = new THREE.BufferGeometry()
  remainGeo.setAttribute('position', new THREE.BufferAttribute(rPos, 3))
  if (rNorm) remainGeo.setAttribute('normal', new THREE.BufferAttribute(rNorm, 3))
  if (rUv) remainGeo.setAttribute('uv', new THREE.BufferAttribute(rUv, 2))
  forgeApplyTriGroups(remainGeo, remainTris, triMaterialIndices)
  remainGeo.computeBoundingBox()
  remainGeo.computeBoundingSphere()
  sourceMesh.geometry = remainGeo
  sourceMesh.userData.__forgeSourceGeo = remainGeo
  return part
}
`
}

function buildAnimationHelpersSource(): string {
  return `
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
`
}

export function generateR3FSceneBlock(manifest: ForgeSceneManifest): string {
  const { camera, environment, assetPath, nodes, keyframes } = manifest
  const assetKey = deriveAssetKey(manifest)
  const duration = resolveManifestDuration(manifest)
  const partOps = resolvePartOperations(manifest)
  const hasKeyframes = keyframes.length > 0
  const hasSplits = partOps.length > 0
  const envPreset = environment.preset === 'xr-stage' ? 'studio' : environment.preset

  const lightLines = environment.lights
    .map((l) => {
      if (l.type === 'hemisphere') {
        return `      <hemisphereLight args={['${escapeJsString(l.color)}', '${escapeJsString(l.groundColor ?? '#222')}', ${l.intensity}]} />`
      }
      if (l.type === 'directional') {
        return `      <directionalLight color=${formatJsxStringProp(l.color)} intensity={${l.intensity}} position={${fmtVec(l.position ?? [4, 8, 5])}} />`
      }
      if (l.type === 'ambient') {
        return `      <ambientLight color=${formatJsxStringProp(l.color)} intensity={${l.intensity}} />`
      }
      if (l.type === 'spot') {
        return `      <spotLight color=${formatJsxStringProp(l.color)} intensity={${l.intensity}} position={${fmtVec(l.position ?? [0, 5, 0])}} />`
      }
      return `      <pointLight color=${formatJsxStringProp(l.color)} intensity={${l.intensity}} position={${fmtVec(l.position ?? [0, 3, 0])}} />`
    })
    .join('\n')

  const nodeOverrides = nodes.map(formatNodeEntry).join('\n')
  const keyframeEntries = keyframes.map(formatKeyframeEntry).join('\n')
  const splitEntries = partOps
    .map((op) => `    ${JSON.stringify(op)},`)
    .join('\n')

  const helperSection =
    (hasSplits ? buildSplitHelpersSource() : '') +
    (hasKeyframes ? buildAnimationHelpersSource() : '')

  const splitReplayBlock = hasSplits
    ? `
    const splitOps = FORGE_SCENE_CONFIG.splits as ReadonlyArray<
      | { kind: 'split'; sourceId: string; mode: 'islands' | 'materials'; partIds?: readonly string[] }
      | { kind: 'extract'; sourceId: string; partId: string; partName?: string; triangleIndices: readonly number[] }
    >
    for (const op of splitOps) {
      if (op.kind === 'split') {
        const src = objectMap.get(op.sourceId) as THREE.Mesh | undefined
        if (!src || !src.isMesh) continue
        if (op.partIds && op.partIds.length > 0 && op.partIds.every((pid) => objectMap.has(pid))) continue
        const parts = op.mode === 'materials' ? forgeSplitMaterials(src) : forgeSplitIslands(src)
        if (parts.length > 0) {
          const parent = src.parent ?? scene
          const group = new THREE.Group()
          group.name = src.name || 'SplitGroup'
          group.userData.forgeId = op.sourceId
          group.userData.__forgeGenerated = true
          group.position.copy(src.position)
          group.rotation.copy(src.rotation)
          group.scale.copy(src.scale)
          group.visible = src.visible
          const srcIndex = parent.children.indexOf(src)
          parent.add(group)
          if (srcIndex >= 0) {
            const addedIndex = parent.children.indexOf(group)
            if (addedIndex !== -1 && addedIndex !== srcIndex) {
              parent.children.splice(addedIndex, 1)
              parent.children.splice(srcIndex, 0, group)
            }
          }
          parent.remove(src)
          objectMap.set(op.sourceId, group)
          for (const part of parts) {
            part.userData.__forgeGenerated = true
            group.add(part)
            objectMap.set(part.userData.forgeId as string, part)
          }
        }
      } else {
        if (objectMap.has(op.partId)) continue
        const src = objectMap.get(op.sourceId) as THREE.Mesh | undefined
        if (!src || !src.isMesh) continue
        const part = forgeExtractTriangles(src, op.triangleIndices, op.partId, op.partName)
        if (part) {
          part.userData.__forgeGenerated = true
          ;(src.parent ?? scene).add(part)
          objectMap.set(op.partId, part)
        }
      }
    }
`
    : ''

  const keyframeSetupBlock = hasKeyframes
    ? `  const objectsRef = useRef(new Map<string, any>())
  const elapsedRef = useRef(0)
  const tracksByTarget = useRef(new Map<string, typeof FORGE_SCENE_CONFIG.keyframes[number][]>())
`
    : ''

  const keyframeUseEffectSync = hasKeyframes
    ? `    objectsRef.current = objectMap
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
`
    : ''

  const useFrameBlock = hasKeyframes
    ? `
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
`
    : ''

  return `${BEGIN_MARKER}
export const FORGE_SCENE_CONFIG = {
  assetPath: '${escapeJsString(assetPath)}',
  assetKey: '${escapeJsString(assetKey)}',
  camera: {
    position: ${fmtVec(camera.position)} as [number, number, number],
    target: ${fmtVec(camera.target)} as [number, number, number],
    fov: ${camera.fov},
  },
  exposure: ${environment.exposure},
  xrEnabled: ${environment.xrEnabled},
  loopMode: '${manifest.loopMode}',
  duration: ${duration},
  nodes: {
${nodeOverrides}
  },
  keyframes: [
${keyframeEntries}
  ],
  splits: [
${splitEntries}
  ],
} as const
${helperSection}
export function ForgeStageContent() {
  const { scene } = useGLTF(FORGE_SCENE_CONFIG.assetPath)
${keyframeSetupBlock}  useEffect(() => {
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
      if (obj === scene) return \`\${FORGE_SCENE_CONFIG.assetKey}:root\`
      const path: number[] = []
      let cur = obj
      while (cur && cur !== scene && cur.parent) {
        path.unshift(cur.parent.children.indexOf(cur))
        cur = cur.parent
      }
      return \`\${FORGE_SCENE_CONFIG.assetKey}:\${path.join('.')}\`
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
        const fallbackId = \`\${item.defaultId}__unmatched_\${extraIdx++}\`
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
${splitReplayBlock}
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
${keyframeUseEffectSync}  }, [scene])
${useFrameBlock}
  return (
    <>
      <color attach="background" args={['${escapeJsString(environment.background)}']} />
${environment.fog ? `      <fog attach="fog" args={['${escapeJsString(environment.fog.color)}', ${environment.fog.near}, ${environment.fog.far}]} />\n` : ''}${lightLines ? `${lightLines}\n` : ''}      <Environment preset=${formatJsxStringProp(envPreset)} />
      <OrbitControls target={FORGE_SCENE_CONFIG.camera.target} makeDefault />
      <primitive object={scene} />
    </>
  )
}
${END_MARKER}`
}

export function generateR3FComponent(manifest: ForgeSceneManifest, componentName?: string): string {
  const resolvedName = sanitizeIdentifier(componentName ?? manifest.projectName)
  const hasKeyframes = manifest.keyframes.length > 0
  const hasSplits = resolvePartOperations(manifest).length > 0

  const reactImport = hasKeyframes
    ? `import { useEffect, useRef } from 'react'`
    : `import { useEffect } from 'react'`
  const fiberImport = hasKeyframes
    ? `import { Canvas, useFrame } from '@react-three/fiber'`
    : `import { Canvas } from '@react-three/fiber'`
  const threeImport = hasSplits ? `import * as THREE from 'three'\n` : ''
  const xrImport = manifest.environment.xrEnabled
    ? `import { XR, createXRStore } from '@react-three/xr'\nconst xrStore = createXRStore()\n`
    : ''
  const canvasBody = manifest.environment.xrEnabled
    ? `        <XR store={xrStore}>\n          <ForgeStageContent />\n        </XR>`
    : `        <ForgeStageContent />`

  return `${reactImport}
${fiberImport}
import { Environment, OrbitControls, useGLTF } from '@react-three/drei'
${threeImport}${xrImport}
${generateR3FSceneBlock(manifest)}

export function ${resolvedName}() {
  return (
    <div style={{ width: '100%', height: '100vh' }}>
      ${manifest.environment.xrEnabled ? '<button onClick={() => xrStore.enterVR()}>Enter VR</button>\n      ' : ''}<Canvas
        gl={{ toneMappingExposure: FORGE_SCENE_CONFIG.exposure }}
        camera={{
          position: FORGE_SCENE_CONFIG.camera.position,
          fov: FORGE_SCENE_CONFIG.camera.fov,
          near: ${manifest.camera.near},
          far: ${manifest.camera.far},
        }}
      >
${canvasBody}
      </Canvas>
    </div>
  )
}
`
}

function hasValueImportIdentifier(preamble: string, moduleName: string, identifier: string): boolean {
  const escapedMod = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const importRe = new RegExp(
    `import\\s+(?!type\\b)([^;]*?)\\s+from\\s+['"]${escapedMod}['"]`,
    'g'
  )
  let match: RegExpExecArray | null
  while ((match = importRe.exec(preamble)) !== null) {
    const clause = match[1]
    const braceMatch = clause.match(/\{([^}]*)\}/)
    if (braceMatch) {
      const items = braceMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      for (const item of items) {
        if (/^type\s+/.test(item)) continue
        const parts = item.split(/\s+as\s+/)
        const localName = (parts[1] ?? parts[0]).trim()
        if (localName === identifier) return true
      }
    }
  }
  return false
}

function ensureNamedImports(preamble: string, moduleName: string, requiredNames: readonly string[]): string {
  const missing = requiredNames.filter((name) => !hasValueImportIdentifier(preamble, moduleName, name))
  if (missing.length === 0) return preamble

  const escapedMod = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const namedImportRe = new RegExp(
    `(import\\s+(?!type\\b)(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{)([^}]*)(\\}\\s*from\\s*['"]${escapedMod}['"])`
  )
  if (namedImportRe.test(preamble)) {
    return preamble.replace(namedImportRe, (_full, open: string, body: string, close: string) => {
      const existing = body
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const combined = [...existing, ...missing]
      return `${open} ${combined.join(', ')} ${close}`
    })
  }
  return `import { ${missing.join(', ')} } from '${moduleName}'\n${preamble}`
}

export function patchR3FFile(existingSource: string, manifest: ForgeSceneManifest): string {
  const startIdx = existingSource.indexOf(BEGIN_MARKER)
  const endIdx = existingSource.indexOf(END_MARKER)
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return generateR3FComponent(manifest)
  }
  const nextBlock = generateR3FSceneBlock(manifest)
  let preamble = existingSource.slice(0, startIdx)
  const suffix = existingSource.slice(endIdx + END_MARKER.length)

  const hasKeyframes = manifest.keyframes.length > 0
  const hasSplits = resolvePartOperations(manifest).length > 0

  if (hasKeyframes) {
    preamble = ensureNamedImports(preamble, 'react', ['useEffect', 'useRef'])
    preamble = ensureNamedImports(preamble, '@react-three/fiber', ['useFrame'])
  } else {
    preamble = ensureNamedImports(preamble, 'react', ['useEffect'])
  }

  if (
    hasSplits &&
    !/import\s+(?:\*\s+as\s+THREE\b|THREE\b)[^;\n]*\s+from\s*['"]three['"]/.test(preamble)
  ) {
    preamble = `import * as THREE from 'three'\n${preamble}`
  }

  return preamble + nextBlock + suffix
}
