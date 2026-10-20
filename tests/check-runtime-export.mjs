import { mkdir, readFile, writeFile } from 'node:fs/promises'
import JSZip from 'jszip'

const archive = await JSZip.loadAsync(await readFile('tests/fixtures/phase2-roundtrip.forge.zip'))
const project = JSON.parse(await archive.file('project.json').async('text'))
const source = await readFile('src/App.tsx', 'utf8')
const match = source.match(/const runtimeSource = `([\s\S]*?)`\r?\n\r?\nconst createRuntimeSource =/)
if (!match) throw new Error('Could not locate the Three.js runtime template in App.tsx')
const runtime = match[1]
  .replace('__FORGE_PROJECT__', JSON.stringify(project, null, 2))
const root = 'tests/runtime-check'
await mkdir(`${root}/src`, { recursive: true })
await mkdir(`${root}/assets`, { recursive: true })
await writeFile(`${root}/src/main.js`, runtime)
await writeFile(`${root}/assets/phase2-dense.gltf`, await archive.file('assets/phase2-dense.gltf').async('nodebuffer'))
await writeFile(`${root}/index.html`, '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Forge runtime export check</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111317}</style></head><body><script type="module" src="./src/main.js"></script></body></html>')
console.log('Generated tests/runtime-check from the runtime source template and round-trip project fixture.')


