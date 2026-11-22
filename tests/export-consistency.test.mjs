import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import JSZip from 'jszip'
import * as THREE from 'three'
import ts from 'typescript'
import {
  createDefaultManifest,
  validateSceneManifest,
} from '../src/domain/sceneManifest.ts'
import {
  generateR3FComponent,
  generateR3FSceneBlock,
  patchR3FFile,
} from '../src/export/r3f/r3fCodegen.ts'
import {
  assertExportPreconditions,
  buildExportZipBundle,
  buildExportZipEntries,
  buildManifestFromEditor,
  buildProjectData,
  generateR3FFromEditor,
  generateRuntimeJs,
  getAssetResourcePath,
  normalizeResourcePath,
  resolveExportAssetPath,
  slug,
  validateExportPreconditions,
  validateProject,
} from '../src/export/forgeExporter.ts'

function assertValidModuleJsSyntax(source, label = 'generated JS') {
  const withoutImports = source.replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
  // Wrap in an async function so top-level `await renderer.init()` / `await new GLTFLoader()...` parses validly.
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(`return (async () => {\n${withoutImports}\n});`)
  }, `${label} must be syntactically valid ES module JavaScript`)
}

function assertValidTsxSyntax(source, label = 'generated TSX') {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
    },
  })
  const errors = (result.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error
  )
  assert.equal(
    errors.length,
    0,
    `${label} had TypeScript syntax diagnostics: ${errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`
  )
}

function createSampleEditorInput(overrides = {}) {
  return {
    projectName: 'Renamed Showcase',
    duration: 8,
    assetKey: 'hero_ship',
    assetFiles: [{ name: 'Spaceship_V2.glb' }],
    assetResourcePaths: ['Spaceship_V2.glb'],
    nodes: [
      {
        id: 'hero_ship:root',
        name: 'Spaceship_V2',
        type: 'imported',
        visible: true,
        parent: null,
      },
      {
        id: 'hero_ship:0',
        name: 'Fuselage',
        type: 'Mesh',
        visible: true,
        parent: 'hero_ship:root',
      },
      {
        id: 'hero_ship:1',
        name: 'Wing',
        type: 'Mesh',
        visible: false,
        parent: 'hero_ship:root',
      },
    ],
    transforms: {
      'hero_ship:root': {
        position: [0, 0.5, 0],
        rotation: [0, 0, 0],
        scale: [1.5, 1.5, 1.5],
      },
      'hero_ship:0': {
        position: [1, 2, 3],
        rotation: [0, 0.5, 0],
        scale: [1, 1, 1],
      },
      'hero_ship:1': {
        position: [-1, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      lights: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    },
    pivots: {
      'hero_ship:0': [0.25, -0.5, 0.1],
    },
    frames: [
      {
        id: 'kf-1',
        targetId: 'hero_ship:0',
        time: 0,
        position: [1, 2, 3],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        easing: 'easeInOut',
      },
      {
        id: 'kf-2',
        targetId: 'hero_ship:0',
        time: 4,
        position: [1, 4, 3],
        rotation: [0, Math.PI, 0],
        scale: [1, 1, 1],
        easing: 'step',
      },
    ],
    effects: [],
    cameraPose: {
      position: [5, 3, 7],
      target: [0, 1, 0],
      fov: 42,
    },
    envPreset: 'sunset',
    xrEnabled: true,
    loopMode: 'pingpong',
    ...overrides,
  }
}

test('resolveExportAssetPath preserves actual filenames, nested paths, spaces/underscores, modelIndex, and fallback', () => {
  assert.equal(slug('My Cool Scene!'), 'my-cool-scene')
  assert.equal(normalizeResourcePath('.\\models\\sub/../hero.glb'), 'models/sub/hero.glb')
  assert.equal(
    getAssetResourcePath({ name: 'hero.glb', webkitRelativePath: 'pkg\\hero.glb' }),
    'pkg/hero.glb'
  )

  const glb = resolveExportAssetPath(
    [{ name: 'Drone_Model v1.glb' }],
    ['Drone_Model v1.glb'],
    'Completely Renamed Project'
  )
  assert.deepEqual(glb, {
    manifestAssetPath: './assets/Drone_Model v1.glb',
    archiveAssetPath: 'assets/Drone_Model v1.glb',
    fileName: 'Drone_Model v1.glb',
  })
  assert.deepEqual(Object.keys(glb).sort(), ['archiveAssetPath', 'fileName', 'manifestAssetPath'])

  const gltfNested = resolveExportAssetPath(
    [{ name: 'albedo.png' }, { name: 'scene.gltf' }],
    ['textures/albedo.png', 'models/my mech/scene.gltf'],
    'Ignored Project Name',
    1
  )
  assert.deepEqual(gltfNested, {
    manifestAssetPath: './assets/models/my mech/scene.gltf',
    archiveAssetPath: 'assets/models/my mech/scene.gltf',
    fileName: 'scene.gltf',
  })

  const inferredIndex = resolveExportAssetPath(
    [{ name: 'diffuse.png' }, { name: 'Robot_Arm.gltf' }],
    ['diffuse.png', 'sub/Robot_Arm.gltf'],
    'Ignored'
  )
  assert.equal(inferredIndex.manifestAssetPath, './assets/sub/Robot_Arm.gltf')
  assert.equal(inferredIndex.archiveAssetPath, 'assets/sub/Robot_Arm.gltf')
  assert.equal(inferredIndex.fileName, 'Robot_Arm.gltf')

  const pathOnlyFallback = resolveExportAssetPath([], ['folder/cached_mesh.glb'], 'Ignored')
  assert.deepEqual(pathOnlyFallback, {
    manifestAssetPath: './assets/folder/cached_mesh.glb',
    archiveAssetPath: 'assets/folder/cached_mesh.glb',
    fileName: 'cached_mesh.glb',
  })

  const emptyFallback = resolveExportAssetPath([], [], 'Test Model 01')
  assert.deepEqual(emptyFallback, {
    manifestAssetPath: './assets/test-model-01.glb',
    archiveAssetPath: 'assets/test-model-01.glb',
    fileName: 'test-model-01.glb',
  })
})

test('empty-scene, missing-model, and duplicate-path guards match across .tsx, .forge.js, and .forge.zip', () => {
  const emptyInput = createSampleEditorInput({ nodes: [], assetFiles: [], assetResourcePaths: [] })
  const emptyCheck = validateExportPreconditions(emptyInput)
  assert.equal(emptyCheck.ok, false)
  assert.equal(emptyCheck.error, 'Import a GLB or glTF model before exporting.')
  assert.throws(() => assertExportPreconditions(emptyInput), /Import a GLB or glTF model before exporting\./)
  assert.throws(() => buildProjectData(emptyInput), /Import a GLB or glTF model before exporting\./)
  assert.throws(() => buildExportZipEntries(emptyInput), /Import a GLB or glTF model before exporting\./)
  assert.throws(() => generateR3FFromEditor(emptyInput), /Import a GLB or glTF model before exporting\./)

  const missingModelInput = createSampleEditorInput({
    assetFiles: [{ name: 'texture.png' }],
    assetResourcePaths: ['texture.png'],
  })
  assert.throws(
    () => buildProjectData(missingModelInput),
    /The source model is unavailable\. Reimport it before exporting\./
  )
  assert.throws(
    () => buildExportZipEntries(missingModelInput),
    /The source model is unavailable\. Reimport it before exporting\./
  )
  assert.throws(
    () => generateR3FFromEditor(missingModelInput),
    /The source model is unavailable\. Reimport it before exporting\./
  )

  const duplicatePathInput = createSampleEditorInput({
    assetFiles: [{ name: 'model.gltf' }, { name: 'tex.png' }, { name: 'tex.png' }],
    assetResourcePaths: ['model.gltf', 'tex.png', 'tex.png'],
  })
  assert.throws(
    () => buildProjectData(duplicatePathInput),
    /Two selected files have the same path\./
  )
  assert.throws(
    () => buildExportZipEntries(duplicatePathInput),
    /Two selected files have the same path\./
  )
  assert.throws(
    () => generateR3FFromEditor(duplicatePathInput),
    /Two selected files have the same path\./
  )
})

test('cross-format export consistency produces matching asset paths, camera, env, xr, loopMode, pivots, and keyframes', () => {
  const glbInput = createSampleEditorInput()
  const project = buildProjectData(glbInput)
  assert.equal(validateProject(project), true)
  assert.equal(project.assets[0].path, 'assets/Spaceship_V2.glb')
  assert.equal(project.objects.lights, undefined, 'Non-node keys like "lights" must be filtered out')
  assert.deepEqual(project.camera, {
    position: [5, 3, 7],
    target: [0, 1, 0],
    fov: 42,
    near: 0.1,
    far: 100,
  })
  assert.equal(project.environment?.preset, 'sunset')
  assert.equal(project.environment?.xrEnabled, true)
  assert.equal(project.loopMode, 'pingpong')

  const runtimeJs = generateRuntimeJs(project)
  assertValidModuleJsSyntax(runtimeJs, 'Spaceship runtime JS')
  assert.match(runtimeJs, /"path": "assets\/Spaceship_V2\.glb"/)
  assert.match(runtimeJs, /import \{ XRButton \} from 'three\/addons\/webxr\/XRButton\.js'/)
  assert.match(runtimeJs, /renderer\.xr\.enabled = true/)
  assert.match(runtimeJs, /XRButton\.createButton\(renderer\)/)
  assert.match(runtimeJs, /"loopMode": "pingpong"/)
  assert.match(runtimeJs, /"easing": "easeInOut"/)

  const zipBundle = buildExportZipBundle(glbInput)
  assert.equal(zipBundle.fileName, 'renamed-showcase.forge.zip')
  const zipPaths = zipBundle.entries.map((e) => e.path)
  assert.ok(zipPaths.includes('project.json'))
  assert.ok(zipPaths.includes('assets/Spaceship_V2.glb'))
  assert.ok(zipPaths.includes('src/main.js'))
  assert.ok(zipPaths.includes('index.html'))
  assert.ok(zipPaths.includes('package.json'))
  assert.ok(zipPaths.includes('README.md'))

  const r3f = generateR3FFromEditor(glbInput)
  assert.equal(r3f.fileName, 'renamed-showcase.tsx')
  assert.equal(validateSceneManifest(r3f.manifest), true)
  assert.equal(r3f.manifest.assetPath, './assets/Spaceship_V2.glb')
  assertValidTsxSyntax(r3f.code, 'Spaceship R3F TSX')
  assert.match(r3f.code, /assetPath: '\.\/assets\/Spaceship_V2\.glb'/)
  assert.match(r3f.code, /export function RenamedShowcase\(\)/)
  assert.match(r3f.code, /'hero_ship:root':/)
  assert.match(r3f.code, /toneMappingExposure: FORGE_SCENE_CONFIG\.exposure/)
  assert.match(r3f.code, /import \{ useEffect, useRef \} from 'react'/)
  assert.match(r3f.code, /import \{ Canvas, useFrame \} from '@react-three\/fiber'/)
  assert.match(r3f.code, /import \{ XR, createXRStore \} from '@react-three\/xr'/)

  // Multi-file .gltf + nested texture
  const gltfInput = createSampleEditorInput({
    projectName: 'Gltf Folder Project',
    assetFiles: [{ name: 'diffuse.png' }, { name: 'Mech_Rig.gltf' }],
    assetResourcePaths: ['textures/diffuse.png', 'models/Mech_Rig.gltf'],
  })
  const gltfBundle = buildExportZipBundle(gltfInput)
  const gltfR3f = generateR3FFromEditor(gltfInput)
  assert.equal(gltfBundle.project.assets[0].path, 'assets/models/Mech_Rig.gltf')
  assert.deepEqual(gltfBundle.project.assets[0].resources, [
    'assets/textures/diffuse.png',
    'assets/models/Mech_Rig.gltf',
  ])
  assert.ok(gltfBundle.entries.some((e) => e.path === 'assets/models/Mech_Rig.gltf'))
  assert.ok(gltfBundle.entries.some((e) => e.path === 'assets/textures/diffuse.png'))
  assert.equal(gltfR3f.manifest.assetPath, './assets/models/Mech_Rig.gltf')
  assert.match(gltfR3f.code, /assetPath: '\.\/assets\/models\/Mech_Rig\.gltf'/)
})

test('R3F codegen handles root transforms, deterministic forgeId + name fallback, pivots, spotLight, and conditional useFrame', () => {
  const staticManifest = createDefaultManifest('StaticProps', './assets/Crate.glb')
  staticManifest.environment.lights.push({
    id: 'spot1',
    type: 'spot',
    color: '#ffddaa',
    intensity: 4,
    position: [2, 6, 3],
  })
  staticManifest.environment.exposure = 1.35
  staticManifest.nodes.push(
    {
      forgeId: 'crate:root',
      name: 'CrateScene',
      parentId: null,
      type: 'imported',
      visible: true,
      position: [0, 0.2, 0],
      rotation: [0, 0, 0],
      scale: [2, 2, 2],
    },
    {
      forgeId: 'crate:0',
      name: 'Lid',
      parentId: 'crate:root',
      type: 'Mesh',
      visible: true,
      position: [0, 1, 0],
      rotation: [0.1, 0, 0],
      scale: [1, 1, 1],
      pivot: [0, -0.5, 0],
    }
  )

  const staticTsx = generateR3FComponent(staticManifest, 'CustomCrateViewer')
  assertValidTsxSyntax(staticTsx, 'Static R3F TSX')
  assert.match(staticTsx, /export function CustomCrateViewer\(\)/)
  assert.doesNotMatch(staticTsx, /useFrame/)
  assert.doesNotMatch(staticTsx, /useRef/)
  assert.doesNotMatch(staticTsx, /@react-three\/xr/)
  assert.match(staticTsx, /<spotLight color="#ffddaa" intensity=\{4\} position=\{\[2, 6, 3\]\} \/>/)
  assert.match(staticTsx, /exposure: 1\.35/)
  assert.match(staticTsx, /gl=\{\{ toneMappingExposure: FORGE_SCENE_CONFIG\.exposure \}\}/)
  assert.match(staticTsx, /'crate:root':/)
  assert.match(staticTsx, /__forgeSourceGeo/)
  assert.match(staticTsx, /cloned\.translate\(-p\[0\], -p\[1\], -p\[2\]\)/)
  assert.match(staticTsx, /cfg\.name === item\.obj\.name/)

  // Patching with keyframes adds useRef + useFrame while preserving custom code outside markers
  const customized = `${staticTsx}\nexport const USER_CUSTOM = 'preserved'\n`
  staticManifest.loopMode = 'once'
  staticManifest.duration = 6
  staticManifest.keyframes.push(
    {
      id: 'k0',
      targetId: 'crate:0',
      time: 0,
      position: [0, 1, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      easing: 'easeOut',
    },
    {
      id: 'k1',
      targetId: 'crate:0',
      time: 3,
      position: [0, 2, 0],
      rotation: [1.5, 0, 0],
      scale: [1, 1, 1],
    }
  )
  const patched = patchR3FFile(customized, staticManifest)
  assertValidTsxSyntax(patched, 'Patched R3F TSX')
  assert.match(patched, /import \{ useEffect, useRef \} from 'react'/)
  assert.match(patched, /import \{ Canvas, useFrame \} from '@react-three\/fiber'/)
  assert.match(patched, /loopMode: 'once'/)
  assert.match(patched, /duration: 6/)
  assert.match(patched, /forgeApplyEasing/)
  assert.match(patched, /forgeResolveLoopTime/)
  assert.match(patched, /export const USER_CUSTOM = 'preserved'/)

  const blockOnly = generateR3FSceneBlock(staticManifest)
  assert.ok(blockOnly.startsWith('// @forge:begin'))
  assert.ok(blockOnly.endsWith('// @forge:end'))
})

test('split (islands, materials) and extracted (extract / triangleIndices) parts are supported across .tsx, .forge.js, and .forge.zip', () => {
  const splitInput = createSampleEditorInput({
    nodes: [
      {
        id: 'hero_ship:root',
        name: 'Spaceship_V2',
        type: 'imported',
        visible: true,
        parent: null,
      },
      {
        id: 'hero_ship:0',
        name: 'FuselageGroup',
        type: 'Group',
        visible: true,
        parent: 'hero_ship:root',
      },
      {
        id: 'hero_ship:0:part-0',
        name: 'Fuselage_part_1',
        type: 'Mesh',
        visible: true,
        parent: 'hero_ship:0',
        splitFrom: 'hero_ship:0',
        splitMode: 'islands',
        splitIndex: 0,
      },
      {
        id: 'hero_ship:0:part-1',
        name: 'Fuselage_part_2',
        type: 'Mesh',
        visible: true,
        parent: 'hero_ship:0',
        splitFrom: 'hero_ship:0',
        splitMode: 'islands',
        splitIndex: 1,
      },
      {
        id: 'hero_ship:1',
        name: 'Wing',
        type: 'Mesh',
        visible: true,
        parent: 'hero_ship:root',
      },
      {
        id: 'hero_ship:1:extract-1',
        name: 'WingFlap',
        type: 'Mesh',
        visible: true,
        parent: 'hero_ship:root',
        splitFrom: 'hero_ship:1',
        splitMode: 'extract',
        extractedTriangles: [0, 2, 4],
      },
    ],
    transforms: {
      'hero_ship:root': { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      'hero_ship:0': { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      'hero_ship:0:part-0': { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      'hero_ship:0:part-1': { position: [-1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      'hero_ship:1': { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      'hero_ship:1:extract-1': { position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    pivots: {
      // Stale pivot on hero_ship:0 (now Group after split) must be filtered out
      'hero_ship:0': [0.5, 0, 0],
      'hero_ship:1:extract-1': [0, 0.1, 0],
    },
    effects: [
      // Stale effect on hero_ship:0 (now Group) must be filtered out
      { targetId: 'hero_ship:0', startTime: 0, endTime: 2, kind: 'dissolve', edgeColor: '#ffffff', edgeWidth: 0.08, seed: 1 },
      { targetId: 'hero_ship:0:part-0', startTime: 0, endTime: 2, kind: 'dissolve', edgeColor: '#ffffff', edgeWidth: 0.08, seed: 2 },
    ],
    splits: [
      {
        kind: 'split',
        sourceId: 'hero_ship:0',
        mode: 'islands',
        partIds: ['hero_ship:0:part-0', 'hero_ship:0:part-1'],
      },
      {
        kind: 'split',
        sourceId: 'hero_ship:2',
        mode: 'materials',
        partIds: ['hero_ship:2:mat-0', 'hero_ship:2:mat-1'],
      },
      {
        kind: 'extract',
        sourceId: 'hero_ship:1',
        partId: 'hero_ship:1:extract-1',
        partName: 'WingFlap',
        triangleIndices: [0, 2, 4],
      },
    ],
  })

  const project = buildProjectData(splitInput)
  assert.equal(validateProject(project), true)
  assert.equal(project.pivots['hero_ship:0'], undefined)
  assert.deepEqual(project.pivots['hero_ship:1:extract-1'], [0, 0.1, 0])
  assert.equal(project.effects.length, 1)
  assert.equal(project.effects[0].targetId, 'hero_ship:0:part-0')
  assert.equal(project.splits?.length, 3)

  const runtimeJs = generateRuntimeJs(project)
  assertValidModuleJsSyntax(runtimeJs, 'Split & extract runtime JS')
  assert.match(runtimeJs, /splitMeshIslands/)
  assert.match(runtimeJs, /splitMeshMaterials/)
  assert.match(runtimeJs, /extractMeshTriangles/)
  assert.match(runtimeJs, /"partId": "hero_ship:1:extract-1"/)

  const zipBundle = buildExportZipBundle(splitInput)
  const mainJsEntry = zipBundle.entries.find((e) => e.path === 'src/main.js')
  assert.ok(mainJsEntry)
  assert.equal(mainJsEntry.content, runtimeJs)

  const r3f = generateR3FFromEditor(splitInput)
  assert.equal(validateSceneManifest(r3f.manifest), true)
  assertValidTsxSyntax(r3f.code, 'Split & extract R3F TSX')
  assert.match(r3f.code, /import \* as THREE from 'three'/)
  assert.match(r3f.code, /forgeSplitIslands/)
  assert.match(r3f.code, /forgeSplitMaterials/)
  assert.match(r3f.code, /forgeExtractTriangles/)
  assert.match(r3f.code, /'hero_ship:0:part-0':/)
  assert.match(r3f.code, /'hero_ship:1:extract-1':/)

  // Also test inferred split/extract from nodes when manifest.splits is omitted
  const inferredManifest = createDefaultManifest('InferredSplit', './assets/inferred.glb')
  inferredManifest.nodes = [
    {
      forgeId: 'model:root',
      name: 'Root',
      parentId: null,
      type: 'imported',
      visible: true,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    {
      forgeId: 'model:0:mat-0',
      name: 'Mat0',
      parentId: 'model:0',
      type: 'Mesh',
      visible: true,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      splitFrom: 'model:0',
      splitMode: 'materials',
    },
    {
      forgeId: 'model:1:extract-0',
      name: 'CutPiece',
      parentId: 'model:root',
      type: 'Mesh',
      visible: true,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      splitFrom: 'model:1',
      splitMode: 'extract',
      extractedTriangles: [1, 3],
    },
  ]
  const inferredCode = generateR3FComponent(inferredManifest)
  assertValidTsxSyntax(inferredCode, 'Inferred split R3F TSX')
  assert.match(inferredCode, /"kind":"split","sourceId":"model:0","mode":"materials"/)
  assert.match(inferredCode, /"kind":"extract","sourceId":"model:1","partId":"model:1:extract-0"/)
})

test('backward compatibility with tests/fixtures/phase2-roundtrip.forge.zip', async () => {
  const archive = await JSZip.loadAsync(
    await readFile('tests/fixtures/phase2-roundtrip.forge.zip')
  )
  const project = JSON.parse(await archive.file('project.json').async('text'))
  assert.equal(validateProject(project), true)

  const runtimeJs = generateRuntimeJs(project)
  assertValidModuleJsSyntax(runtimeJs, 'phase2-roundtrip runtime JS')
  assert.match(runtimeJs, /assets\/phase2-dense\.gltf/)
  assert.match(runtimeJs, /"pivots":/)
  assert.match(runtimeJs, /"effects":/)
  assert.match(runtimeJs, /"tracks":/)
  assert.doesNotMatch(runtimeJs, /XRButton/)
})

const AMBIENT_R3F_DTS = `
declare module 'react' {
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useRef<T>(initialValue: T): { current: T };
  export function useState<T>(initialState: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void];
}
declare module 'react/jsx-runtime' {
  export const Fragment: unique symbol;
  export function jsx(type: unknown, props: unknown, key?: unknown): unknown;
  export function jsxs(type: unknown, props: unknown, key?: unknown): unknown;
}
declare namespace JSX {
  type Element = unknown;
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}
declare module 'three' {
  export class Vector3 {
    x: number; y: number; z: number;
    constructor(x?: number, y?: number, z?: number);
    set(x: number, y: number, z: number): this;
    copy(v: Vector3): this;
    add(v: Vector3): this;
    clone(): Vector3;
    multiplyScalar(s: number): this;
    applyMatrix4(m: any): this;
  }
  export class Euler {
    x: number; y: number; z: number;
    set(x: number, y: number, z: number): this;
    copy(e: Euler): this;
  }
  export class Quaternion {
    copy(q: Quaternion): this;
  }
  export class BufferAttribute {
    count: number;
    constructor(array: ArrayLike<number>, itemSize: number);
    getX(index: number): number;
    getY(index: number): number;
    getZ(index: number): number;
  }
  export class BufferGeometry {
    groups: Array<{ start: number; count: number; materialIndex?: number }>;
    getAttribute(name: string): BufferAttribute;
    setAttribute(name: string, attr: BufferAttribute): this;
    getIndex(): BufferAttribute | null;
    addGroup(start: number, count: number, materialIndex?: number): void;
    computeVertexNormals(): void;
    computeBoundingBox(): void;
    computeBoundingSphere(): void;
    clone(): BufferGeometry;
    translate(x: number, y: number, z: number): this;
    dispose(): void;
  }
  export class Material {}
  export class Object3D {
    name: string;
    parent: Object3D | null;
    children: Object3D[];
    position: Vector3;
    rotation: Euler;
    quaternion: Quaternion;
    scale: Vector3;
    visible: boolean;
    matrix: any;
    userData: Record<string, any>;
    isMesh?: boolean;
    castShadow: boolean;
    receiveShadow: boolean;
    add(...obj: Object3D[]): this;
    remove(...obj: Object3D[]): this;
    traverse(cb: (obj: Object3D) => void): void;
    updateMatrix(): void;
  }
  export class Group extends Object3D {}
  export class Mesh extends Object3D {
    geometry: BufferGeometry;
    material: Material | Material[];
    constructor(geometry?: BufferGeometry, material?: Material | Material[]);
  }
}
declare module '@react-three/fiber' {
  export function Canvas(props: Record<string, any>): any;
  export function useFrame(callback: (state: any, delta: number) => void): void;
  export function useThree(): any;
}
declare module '@react-three/drei' {
  export function Environment(props: Record<string, any>): any;
  export function OrbitControls(props: Record<string, any>): any;
  export function useGLTF(path: string): { scene: any };
}
declare module '@react-three/xr' {
  export function createXRStore(): { enterVR(): void };
  export function XR(props: Record<string, any>): any;
}
`

function assertValidTsxStrict(source, label = 'generated TSX') {
  const virtualFile = '__virtual_forge_stage.tsx'
  const ambientFile = '__virtual_forge_ambient.d.ts'
  const options = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
  }
  const baseHost = ts.createCompilerHost(options)
  const virtualFiles = new Map([
    [virtualFile, source],
    [ambientFile, AMBIENT_R3F_DTS],
  ])
  const host = {
    ...baseHost,
    fileExists: (fileName) => virtualFiles.has(fileName) || baseHost.fileExists(fileName),
    readFile: (fileName) => virtualFiles.get(fileName) ?? baseHost.readFile(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNew) => {
      const content = virtualFiles.get(fileName)
      if (content !== undefined) {
        return ts.createSourceFile(fileName, content, languageVersion)
      }
      return baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNew)
    },
  }
  const program = ts.createProgram([ambientFile, virtualFile], options, host)
  const diagnostics = ts
    .getPreEmitDiagnostics(program, program.getSourceFile(virtualFile))
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
  assert.equal(
    diagnostics.length,
    0,
    `${label} failed strict tsc: ${diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join(' | ')}`
  )
}

function executeGeneratedStageContent(tsxSource, gltfScene, strictModeRuns = 1) {
  const jsOut = ts.transpileModule(tsxSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText

  const effects = []
  const refs = []
  let refCursor = 0
  let frameCb = null

  const reactMock = {
    useEffect(fn) {
      effects.push(fn)
    },
    useRef(initial) {
      if (refCursor < refs.length) return refs[refCursor++]
      const box = { current: initial }
      refs.push(box)
      refCursor++
      return box
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
  }

  const jsxRuntimeMock = {
    Fragment: Symbol('Fragment'),
    jsx: () => null,
    jsxs: () => null,
  }

  const fiberMock = {
    Canvas: () => null,
    useFrame(cb) {
      frameCb = cb
    },
    useThree: () => ({}),
  }

  const dreiMock = {
    Environment: () => null,
    OrbitControls: () => null,
    useGLTF: () => ({ scene: gltfScene }),
  }

  const xrMock = {
    createXRStore: () => ({ enterVR() {} }),
    XR: () => null,
  }

  const mod = { exports: {} }
  const customRequire = (id) => {
    if (id === 'react') return reactMock
    if (id === 'react/jsx-runtime') return jsxRuntimeMock
    if (id === 'three') return THREE
    if (id === '@react-three/fiber') return fiberMock
    if (id === '@react-three/drei') return dreiMock
    if (id === '@react-three/xr') return xrMock
    throw new Error(`Unexpected require: ${id}`)
  }

  // eslint-disable-next-line no-new-func
  const fn = new Function('require', 'module', 'exports', jsOut)
  fn(customRequire, mod, mod.exports)

  const { ForgeStageContent, FORGE_SCENE_CONFIG } = mod.exports
  for (let r = 0; r < strictModeRuns; r++) {
    effects.length = 0
    refCursor = 0
    ForgeStageContent()
    for (const eff of effects) {
      eff()
    }
  }
  return { FORGE_SCENE_CONFIG, stepFrame: (dt) => frameCb?.({}, dt) }
}

async function executeGeneratedRuntimeJs(runtimeJs, gltfScene) {
  const withoutImports = runtimeJs
    .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace('const renderer = new THREE.WebGPURenderer({ antialias: true });', 'const renderer = mockRenderer;')
    .replace('await renderer.init();', '')

  const capturedScene = { value: null }
  const mockRenderer = {
    domElement: {},
    setPixelRatio() {},
    setSize() {},
    setAnimationLoop() {},
    render(scene) {
      capturedScene.value = scene
    },
  }
  class MockGLTFLoader {
    async loadAsync() {
      return { scene: gltfScene }
    }
  }
  const TSL = new Proxy({}, { get: () => () => ({ mul: () => ({}), add: () => ({}), sub: () => ({}), clamp: () => ({}), smoothstep: () => ({}) }) })
  const mockTHREE = Object.create(THREE, {
    WebGPURenderer: { value: function WebGPURenderer() { return mockRenderer } },
  })
  const mockDocument = { body: { appendChild() {} } }
  const mockAddEventListener = () => {}

  // eslint-disable-next-line no-new-func
  const runner = new Function(
    'THREE',
    'GLTFLoader',
    'OrbitControls',
    'XRButton',
    'TSL',
    'mockRenderer',
    'document',
    'devicePixelRatio',
    'innerWidth',
    'innerHeight',
    'addEventListener',
    `return (async () => {\n${withoutImports}\nreturn { scene, objects };\n})();`
  )
  return runner(
    mockTHREE,
    MockGLTFLoader,
    function OrbitControls() {
      this.target = new THREE.Vector3()
      this.update = () => {}
    },
    { createButton: () => ({}) },
    TSL,
    mockRenderer,
    mockDocument,
    1,
    800,
    600,
    mockAddEventListener
  )
}

function makeFourTriTwoMatMesh(name = 'MultiMatMesh') {
  // Triangles 0,1 at x in [0..2] (mat 0); triangles 2,3 at x in [4..6] (mat 1)
  const positions = new Float32Array([
    0, 0, 0,  2, 0, 0,  0, 1, 0, // tri 0 (mat 0)
    2, 0, 0,  2, 1, 0,  0, 1, 0, // tri 1 (mat 0)
    4, 0, 0,  6, 0, 0,  4, 1, 0, // tri 2 (mat 1)
    6, 0, 0,  6, 1, 0,  4, 1, 0, // tri 3 (mat 1)
  ])
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.addGroup(0, 6, 0)
  geo.addGroup(6, 6, 1)
  const mat0 = new THREE.MeshStandardMaterial({ color: 0xff0000 })
  const mat1 = new THREE.MeshStandardMaterial({ color: 0x0000ff })
  const mesh = new THREE.Mesh(geo, [mat0, mat1])
  mesh.name = name
  return mesh
}

function makeTwoIslandMesh(name = 'IslandsMesh') {
  const positions = new Float32Array([
    0, 0, 0,  1, 0, 0,  0, 1, 0,
    10, 0, 0, 11, 0, 0, 10, 1, 0,
  ])
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial())
  mesh.name = name
  return mesh
}

test('semantic tsc --strict passes on split-only (with and without partIds), extract-only, and combined .tsx', () => {
  // Case 1: split-only WITHOUT partIds (materials)
  const splitNoPartIds = createDefaultManifest('SplitMatOnly', './assets/mat.glb')
  splitNoPartIds.splits = [{ kind: 'split', sourceId: 'mat:0', mode: 'materials' }]
  assertValidTsxStrict(generateR3FComponent(splitNoPartIds), 'split-only (materials, no partIds)')

  // Case 2: split-only WITHOUT partIds (islands)
  const splitIslandsNoPartIds = createDefaultManifest('SplitIslandsOnly', './assets/isl.glb')
  splitIslandsNoPartIds.splits = [{ kind: 'split', sourceId: 'isl:0', mode: 'islands' }]
  assertValidTsxStrict(generateR3FComponent(splitIslandsNoPartIds), 'split-only (islands, no partIds)')

  // Case 3: split-only WITH partIds
  const splitWithPartIds = createDefaultManifest('SplitWithIds', './assets/isl2.glb')
  splitWithPartIds.splits = [
    { kind: 'split', sourceId: 'isl2:0', mode: 'islands', partIds: ['isl2:0:part-0', 'isl2:0:part-1'] },
  ]
  assertValidTsxStrict(generateR3FComponent(splitWithPartIds), 'split-only (with partIds)')

  // Case 4: extract-only
  const extractOnly = createDefaultManifest('ExtractOnly', './assets/ext.glb')
  extractOnly.splits = [
    { kind: 'extract', sourceId: 'ext:0', partId: 'ext:0:extract-1', triangleIndices: [0, 2] },
  ]
  assertValidTsxStrict(generateR3FComponent(extractOnly), 'extract-only')
})

test('patchR3FFile updates split/extract TSX with keyframes without duplicating THREE and handles custom named imports', () => {
  const splitManifest = createDefaultManifest('PatchSplit', './assets/split.glb')
  splitManifest.splits = [{ kind: 'split', sourceId: 'split:0', mode: 'islands' }]
  const initialSplitTsx = generateR3FComponent(splitManifest)

  splitManifest.keyframes.push(
    { id: 'k1', targetId: 'split:0:part-0', time: 0, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { id: 'k2', targetId: 'split:0:part-0', time: 2, position: [0, 2, 0], rotation: [0, 1, 0], scale: [1, 1, 1] }
  )
  const patchedSplit = patchR3FFile(initialSplitTsx, splitManifest)
  const threeMatches = patchedSplit.match(/from\s+['"]three['"]/g) ?? []
  assert.equal(threeMatches.length, 1, 'THREE must be imported exactly once after patching')
  assert.match(patchedSplit, /\buseRef\b/)
  assert.match(patchedSplit, /\buseFrame\b/)
  assertValidTsxStrict(patchedSplit, 'patched split+keyframes TSX')

  // Custom user imports in react and @react-three/fiber
  const customHeaderTsx = initialSplitTsx
    .replace("import { useEffect } from 'react'", "import { useEffect, useState } from 'react'")
    .replace("import { Canvas } from '@react-three/fiber'", "import { Canvas, useThree } from '@react-three/fiber'")
    + '\nexport function useHelper() { return [useState, useThree] }\n'

  const patchedCustom = patchR3FFile(customHeaderTsx, splitManifest)
  assert.match(patchedCustom, /import \{ useEffect, useState, useRef \} from 'react'/)
  assert.match(patchedCustom, /import \{ Canvas, useThree, useFrame \} from '@react-three\/fiber'/)
  assert.equal((patchedCustom.match(/from\s+['"]three['"]/g) ?? []).length, 1)
  assertValidTsxStrict(patchedCustom, 'patched custom imports TSX')
})

test('multi-material extract preserves geometry.groups on both source and extracted meshes in TSX and .forge.js', async () => {
  const manifest = createDefaultManifest('MultiMatExtract', './assets/mm.glb')
  manifest.assetKey = 'mm'
  manifest.splits = [
    { kind: 'extract', sourceId: 'mm:0', partId: 'mm:0:extract-1', partName: 'Half', triangleIndices: [0, 2] },
  ]
  const tsx = generateR3FComponent(manifest)
  assertValidTsxStrict(tsx, 'multi-material extract TSX')

  const root = new THREE.Group()
  const mesh = makeFourTriTwoMatMesh('MM')
  root.add(mesh)
  executeGeneratedStageContent(tsx, root, 2)

  const extracted = root.children.find((c) => c.userData.forgeId === 'mm:0:extract-1')
  assert.ok(extracted, 'Extracted mesh must be added to scene')
  assert.ok(Array.isArray(extracted.material) && extracted.material.length === 2)
  assert.deepEqual(
    extracted.geometry.groups.map((g) => ({ start: g.start, count: g.count, materialIndex: g.materialIndex })),
    [
      { start: 0, count: 3, materialIndex: 0 },
      { start: 3, count: 3, materialIndex: 1 },
    ]
  )
  assert.deepEqual(
    mesh.geometry.groups.map((g) => ({ start: g.start, count: g.count, materialIndex: g.materialIndex })),
    [
      { start: 0, count: 3, materialIndex: 0 },
      { start: 3, count: 3, materialIndex: 1 },
    ]
  )

  // Verify parity in .forge.js runtime
  const input = createSampleEditorInput({
    assetKey: 'mm',
    nodes: [
      { id: 'mm:root', name: 'Root', type: 'imported', visible: true, parent: null },
      { id: 'mm:0', name: 'MM', type: 'Mesh', visible: true, parent: 'mm:root' },
    ],
    transforms: {
      'mm:root': { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      'mm:0': { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    pivots: {},
    frames: [],
    splits: [{ kind: 'extract', sourceId: 'mm:0', partId: 'mm:0:extract-1', partName: 'Half', triangleIndices: [0, 2] }],
  })
  const project = buildProjectData(input)
  const runtimeJs = generateRuntimeJs(project)
  const rtRoot = new THREE.Group()
  const rtMesh = makeFourTriTwoMatMesh('MM')
  rtRoot.add(rtMesh)
  const { objects } = await executeGeneratedRuntimeJs(runtimeJs, rtRoot)
  const rtExtracted = objects.get('mm:0:extract-1')
  assert.ok(rtExtracted)
  assert.equal(rtExtracted.geometry.groups.length, 2)
  assert.equal(rtMesh.geometry.groups.length, 2)
})

test('StrictMode double-useEffect does not double-extract or corrupt split/sibling forgeIds when parts are omitted from nodes', () => {
  // 1) Extract-only (part omitted from nodes) under 2x useEffect
  const extManifest = createDefaultManifest('StrictExtract', './assets/se.glb')
  extManifest.assetKey = 'se'
  extManifest.splits = [
    { kind: 'extract', sourceId: 'se:0', partId: 'se:0:extract-1', triangleIndices: [0, 1] },
  ]
  const extRoot = new THREE.Group()
  const extMesh = makeFourTriTwoMatMesh('Source')
  extRoot.add(extMesh)
  executeGeneratedStageContent(generateR3FComponent(extManifest), extRoot, 2)

  assert.equal(extMesh.geometry.getAttribute('position').count, 6, 'Only 2 triangles removed, 2 remaining')
  const extractedParts = extRoot.children.filter((c) => c.userData.forgeId === 'se:0:extract-1')
  assert.equal(extractedParts.length, 1, 'Must not double-extract on 2nd useEffect')

  // 2) Split-only (parts omitted from nodes) WITH sibling node sr:1 in nodes under 2x useEffect
  const splitManifest = createDefaultManifest('StrictSplit', './assets/sr.glb')
  splitManifest.assetKey = 'sr'
  splitManifest.nodes = [
    {
      forgeId: 'sr:1',
      name: 'SiblingBox',
      parentId: 'sr:root',
      type: 'Mesh',
      visible: true,
      position: [9, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  ]
  splitManifest.splits = [{ kind: 'split', sourceId: 'sr:0', mode: 'islands' }]

  const srRoot = new THREE.Group()
  const toSplit = makeTwoIslandMesh('Islands')
  const sibling = makeTwoIslandMesh('SiblingBox')
  srRoot.add(toSplit, sibling)
  executeGeneratedStageContent(generateR3FComponent(splitManifest), srRoot, 2)

  assert.equal(srRoot.children.length, 2)
  assert.equal(srRoot.children[0].userData.forgeId, 'sr:0')
  assert.deepEqual(
    srRoot.children[0].children.map((c) => c.userData.forgeId),
    ['sr:0:part-0', 'sr:0:part-1']
  )
  assert.equal(srRoot.children[1], sibling, 'Sibling must remain at index 1')
  assert.equal(sibling.userData.forgeId, 'sr:1')
  assert.equal(sibling.position.x, 9)
})

test('index-shifted GLTF hierarchy matches by name fallback without defaultId collision', () => {
  const manifest = createDefaultManifest('ShiftedHierarchy', './assets/fb.glb')
  manifest.assetKey = 'fb'
  manifest.nodes = [
    {
      forgeId: 'fb:0',
      name: 'TargetMesh',
      parentId: 'fb:root',
      type: 'Mesh',
      visible: false,
      position: [3, 4, 5],
      rotation: [0, 0, 0],
      scale: [2, 2, 2],
    },
  ]

  const root = new THREE.Group()
  const extraWrapper = new THREE.Group()
  extraWrapper.name = 'ExtraWrapper'
  const targetMesh = makeTwoIslandMesh('TargetMesh')
  root.add(extraWrapper, targetMesh)

  executeGeneratedStageContent(generateR3FComponent(manifest), root, 2)

  assert.equal(targetMesh.userData.forgeId, 'fb:0')
  assert.deepEqual([targetMesh.position.x, targetMesh.position.y, targetMesh.position.z], [3, 4, 5])
  assert.deepEqual([targetMesh.scale.x, targetMesh.scale.y, targetMesh.scale.z], [2, 2, 2])
  assert.equal(targetMesh.visible, false)
  assert.notEqual(extraWrapper.userData.forgeId, 'fb:0')
  assert.deepEqual([extraWrapper.position.x, extraWrapper.position.y, extraWrapper.position.z], [0, 0, 0])
})

test('transform-before-extract ordering applies source transform before computing extracted part pose', async () => {
  const input = createSampleEditorInput({
    assetKey: 'eto',
    nodes: [
      { id: 'eto:root', name: 'Root', type: 'imported', visible: true, parent: null },
      { id: 'eto:0', name: 'Source', type: 'Mesh', visible: true, parent: 'eto:root' },
    ],
    transforms: {
      'eto:root': { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      'eto:0': { position: [10, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2] },
    },
    pivots: {},
    frames: [],
    splits: [{ kind: 'extract', sourceId: 'eto:0', partId: 'eto:0:extract-1', triangleIndices: [0, 1] }],
  })

  // Check TSX
  const r3f = generateR3FFromEditor(input)
  const tsxRoot = new THREE.Group()
  const tsxSrc = makeFourTriTwoMatMesh('Source')
  tsxRoot.add(tsxSrc)
  executeGeneratedStageContent(r3f.code, tsxRoot, 2)
  const tsxPart = tsxRoot.children.find((c) => c.userData.forgeId === 'eto:0:extract-1')
  assert.ok(tsxPart)
  // Triangles 0,1 span x in [0..2] -> local center x = 1; with source pos [10,0,0] and scale [2,2,2], part.position.x = 12
  assert.deepEqual([tsxPart.position.x, tsxPart.position.y, tsxPart.position.z], [12, 1, 0])
  assert.deepEqual([tsxPart.scale.x, tsxPart.scale.y, tsxPart.scale.z], [2, 2, 2])

  // Check .forge.js
  const runtimeJs = generateRuntimeJs(buildProjectData(input))
  const rtRoot = new THREE.Group()
  const rtSrc = makeFourTriTwoMatMesh('Source')
  rtRoot.add(rtSrc)
  const { objects } = await executeGeneratedRuntimeJs(runtimeJs, rtRoot)
  const rtPart = objects.get('eto:0:extract-1')
  assert.ok(rtPart)
  assert.deepEqual([rtPart.position.x, rtPart.position.y, rtPart.position.z], [12, 1, 0])
  assert.deepEqual([rtPart.scale.x, rtPart.scale.y, rtPart.scale.z], [2, 2, 2])
})

test('string escaping, JS reserved projectName keywords, and assetKey sanitization produce valid outputs', () => {
  const manifest = createDefaultManifest('class', "./assets/a'b\nc.glb")
  manifest.environment.background = "#111'\n222"
  manifest.environment.fog = { color: "#222'\n333", near: 5, far: 25 }
  manifest.environment.lights.push({ id: 'l1', type: 'spot', color: "#fff\"'\n", intensity: 2 })
  manifest.nodes.push({
    forgeId: "k:0",
    name: "Line1\nLine2\r\n'quote'\\slash\u2028end",
    parentId: null,
    type: 'Mesh',
    visible: true,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  })

  const classTsx = generateR3FComponent(manifest)
  assert.match(classTsx, /export function Forge_class\(\)/)
  assertValidTsxStrict(classTsx, 'reserved projectName "class" + multiline escaped strings')

  const fnTsx = generateR3FComponent(manifest, 'function')
  assert.match(fnTsx, /export function Forge_function\(\)/)
  assertValidTsxStrict(fnTsx, 'reserved componentName "function"')

  const badKeyInput = createSampleEditorInput({
    assetKey: 'model with spaces!',
    nodes: [
      { id: 'model with spaces!:root', name: 'Root', type: 'imported', visible: true, parent: null },
      { id: 'model with spaces!:0', name: 'Body', type: 'Mesh', visible: true, parent: 'model with spaces!:root' },
    ],
    transforms: {
      'model with spaces!:root': { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      'model with spaces!:0': { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    pivots: { 'model with spaces!:0': [0, 0.5, 0] },
    frames: [
      { id: 'kf1', targetId: 'model with spaces!:0', time: 0, position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    ],
  })
  const project = buildProjectData(badKeyInput)
  assert.equal(validateProject(project), true)
  assert.equal(project.assets[0].key, 'model-with-spaces')
  assert.equal(project.nodes[0].id, 'model-with-spaces:root')
  assert.ok(project.objects['model-with-spaces:0'])
  assert.equal(project.tracks[0].targetId, 'model-with-spaces:0')
  assert.ok(project.pivots['model-with-spaces:0'])
})
