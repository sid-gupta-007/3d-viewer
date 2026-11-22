import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import JSZip from 'jszip'

const modelPath = 'tests/fixtures/phase2-dense.gltf'
const model = await readFile(modelPath)
const key = `model-${createHash('sha256').update(model).digest().subarray(0, 12).toString('hex')}`
const id = (path) => `${key}:${path}`
const root = `${key}:root`
const nodes = [
  { id: root, name: 'phase2-dense', type: 'imported', visible: true, parent: null },
  { id: id('0'), name: 'Test_Assembly', type: 'Group', visible: true, parent: root },
  { id: id('0.0'), name: 'Body', type: 'Mesh', visible: true, parent: id('0') },
  { id: id('0.1'), name: 'Rotor_Hinge', type: 'Group', visible: true, parent: id('0') },
  { id: id('0.1.0'), name: 'Rotor_Blade', type: 'Mesh', visible: true, parent: id('0.1') },
]
const transform = (position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) => ({ position, rotation, scale })
const project = {
  format: 'forge-scene', version: 1, name: 'phase2-roundtrip-check', duration: 8,
  assets: [{ key, path: 'assets/phase2-dense.gltf', resources: ['assets/phase2-dense.gltf'] }],
  nodes,
  objects: {
    [root]: transform([0, 0.259, 0], [0, 0, 0], [1.294, 1.294, 1.294]),
    [id('0')]: transform(), [id('0.0')]: transform(), [id('0.1')]: transform([0, 0.712, 0]),
    [id('0.1.0')]: transform(),
  },
  tracks: [
    { id: 'rotor-start', targetId: id('0.1.0'), time: 0, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { id: 'rotor-spin', targetId: id('0.1.0'), time: 8, position: [0, 0, 0], rotation: [0, 6.283185, 0], scale: [1, 1, 1] },
  ],
  effects: [
    { kind: 'burn', targetId: id('0.0'), startTime: 3, endTime: 5, seed: 42, edgeColor: '#ff7a27', edgeWidth: 0.08, flameColor: '#ffb02e' },
    { kind: 'particles', targetId: id('0.0'), startTime: 3, endTime: 5, seed: 84, color: '#ff9b36', particleCount: 256, particleSize: 14 },
  ],
  pivots: { [id('0.0')]: [0.12, 0, 0] },
}
const zip = new JSZip()
zip.file('project.json', JSON.stringify(project, null, 2))
zip.file('assets/phase2-dense.gltf', model)
const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
await writeFile('tests/fixtures/phase2-roundtrip.forge.zip', archive)
console.log(`Wrote tests/fixtures/phase2-roundtrip.forge.zip (${archive.length} bytes)`)
