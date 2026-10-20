import { mkdir, writeFile } from 'node:fs/promises'

const chunks = []
const views = []
const accessors = []
let offset = 0

function append(values, componentBytes, componentType, type, target, min, max) {
  const bytes = Buffer.alloc(values.length * componentBytes)
  values.forEach((value, index) => componentBytes === 4 ? bytes.writeFloatLE(value, index * 4) : bytes.writeUInt16LE(value, index * 2))
  const view = views.length
  views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target })
  chunks.push(bytes)
  offset += bytes.length
  const accessor = accessors.length
  accessors.push({ bufferView: view, componentType, count: values.length / (type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 1), type, ...(min ? { min } : {}), ...(max ? { max } : {}) })
  return accessor
}

function box(min, max) {
  const subdivisions = 10
  const faces = [
    [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
    [[0, 0, -1], [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]]],
    [[1, 0, 0], [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]]],
    [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
    [[0, 1, 0], [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]],
    [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
  ]
  const positions = []
  const normals = []
  const indices = []
  for (const [normal, corners] of faces) {
    const pointOnFace = (u, v) => {
      const blend = (a, b, amount) => a.map((value, axis) => value + (b[axis] - value) * amount)
      const normalized = blend(blend(corners[0], corners[1], u), blend(corners[3], corners[2], u), v)
      return normalized.map((value, axis) => min[axis] + value * (max[axis] - min[axis]))
    }
    for (let row = 0; row < subdivisions; row++) for (let column = 0; column < subdivisions; column++) {
      const first = positions.length / 3
      const u0 = column / subdivisions, u1 = (column + 1) / subdivisions
      const v0 = row / subdivisions, v1 = (row + 1) / subdivisions
      for (const point of [pointOnFace(u0, v0), pointOnFace(u1, v0), pointOnFace(u1, v1), pointOnFace(u0, v1)]) {
        positions.push(...point)
        normals.push(...normal)
      }
      indices.push(first, first + 1, first + 2, first, first + 2, first + 3)
    }
  }
  const position = append(positions, 4, 5126, 'VEC3', 34962, min, max)
  const normal = append(normals, 4, 5126, 'VEC3', 34962)
  const index = append(indices, 2, 5123, 'SCALAR', 34963)
  return { position, normal, index }
}

const body = box([-0.65, -0.2, -0.45], [0.65, 0.2, 0.45])
const blade = box([-0.85, -0.035, -0.12], [0.85, 0.035, 0.12])
const binary = Buffer.concat(chunks)
const gltf = {
  asset: { version: '2.0', generator: 'Forge Phase 2 verification fixture' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [
    { name: 'Test Assembly', children: [1, 2] },
    { name: 'Body', mesh: 0 },
    { name: 'Rotor Hinge', translation: [0, 0.55, 0], children: [3] },
    { name: 'Rotor Blade', mesh: 1 },
  ],
  meshes: [body, blade].map((part, index) => ({ name: index === 0 ? 'Body Mesh' : 'Rotor Mesh', primitives: [{ attributes: { POSITION: part.position, NORMAL: part.normal }, indices: part.index, material: index }] })),
  materials: [
    { name: 'Body Green', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.78, 0.25, 1], metallicFactor: 0.15, roughnessFactor: 0.45 } },
    { name: 'Rotor Orange', pbrMetallicRoughness: { baseColorFactor: [1, 0.35, 0.08, 1], metallicFactor: 0.2, roughnessFactor: 0.3 } },
  ],
  buffers: [{ byteLength: binary.length, uri: `data:application/octet-stream;base64,${binary.toString('base64')}` }],
  bufferViews: views,
  accessors,
}

await mkdir('tests/fixtures', { recursive: true })
await writeFile('tests/fixtures/phase2-articulated-fixture.gltf', JSON.stringify(gltf))
console.log('Created tests/fixtures/phase2-articulated-fixture.gltf')
