import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { generateRuntimeJs, validateProject } from '../src/export/forgeExporter.ts'

const archive = await JSZip.loadAsync(await readFile('tests/fixtures/phase2-roundtrip.forge.zip'))
const project = JSON.parse(await archive.file('project.json').async('text'))
assert.equal(validateProject(project), true, 'Round-trip project fixture must pass validateProject')
const runtime = generateRuntimeJs(project)
const root = 'tests/runtime-check'
await mkdir(`${root}/src`, { recursive: true })
await mkdir(`${root}/assets`, { recursive: true })
await writeFile(`${root}/src/main.js`, runtime)
await writeFile(`${root}/assets/phase2-dense.gltf`, await archive.file('assets/phase2-dense.gltf').async('nodebuffer'))
await writeFile(`${root}/index.html`, '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Forge runtime export check</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111317}</style></head><body><script type="module" src="./src/main.js"></script></body></html>')
console.log('Generated tests/runtime-check from forgeExporter and round-trip project fixture.')
