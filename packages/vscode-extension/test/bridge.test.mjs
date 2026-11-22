import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  assertSceneFilePath,
  assertTsPatchTarget,
  computePatchedTsSource,
  FORGE_BEGIN_MARKER,
  FORGE_END_MARKER,
  generateForgeBlock,
  resolveWorkspacePath,
} from '../out/patchLogic.js';

test('resolveWorkspacePath allows paths inside workspace and rejects traversal', () => {
  const root = path.resolve('/tmp/forge-workspace');
  const valid = resolveWorkspacePath(root, '.forge/scene.json');
  assert.equal(valid, path.join(root, '.forge', 'scene.json'));

  assert.throws(() => resolveWorkspacePath(root, '../outside.json'), /escapes workspace root/i);
  assert.throws(
    () => resolveWorkspacePath(root, path.resolve('/tmp/other/file.ts')),
    /escapes workspace root/i
  );
});

test('assertSceneFilePath and assertTsPatchTarget enforce allowed file types', () => {
  assert.doesNotThrow(() => assertSceneFilePath('/ws/.forge/scene.json'));
  assert.doesNotThrow(() => assertSceneFilePath('/ws/assets/demo.forge.json'));
  assert.throws(() => assertSceneFilePath('/ws/package.json'), /Scene path must target/);

  assert.doesNotThrow(() => assertTsPatchTarget('/ws/src/Scene.tsx'));
  assert.doesNotThrow(() => assertTsPatchTarget('/ws/src/scene.ts'));
  assert.throws(() => assertTsPatchTarget('/ws/src/scene.js'), /must be a \.ts or \.tsx file/);
});

test('computePatchedTsSource replaces only @forge:begin..@forge:end block', () => {
  const existing = [
    "import { Canvas } from '@react-three/fiber';",
    FORGE_BEGIN_MARKER,
    'export const FORGE_SCENE_CONFIG = { old: true };',
    FORGE_END_MARKER,
    'export function App() { return <Canvas />; }',
  ].join('\n');

  const manifest = {
    version: 1,
    projectName: 'DroneDemo',
    assetPath: './drone.glb',
    camera: { position: [1, 2, 3], target: [0, 0, 0], fov: 40, near: 0.1, far: 100 },
    environment: { preset: 'studio', background: '#111317', exposure: 1, xrEnabled: false, lights: [] },
    nodes: [
      {
        forgeId: 'rotor_1',
        name: 'Rotor 1',
        parentId: 'root',
        type: 'Mesh',
        visible: true,
        position: [0, 1, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    ],
    keyframes: [],
    loopMode: 'loop',
  };

  const outcome = computePatchedTsSource(existing, undefined, manifest);
  assert.equal(outcome.mode, 'marker-replace');
  assert.ok(outcome.nextSource.includes("import { Canvas } from '@react-three/fiber';"));
  assert.ok(outcome.nextSource.includes('export function App() { return <Canvas />; }'));
  assert.ok(outcome.nextSource.includes("assetPath: './drone.glb'"));
  assert.ok(!outcome.nextSource.includes('old: true'));
});

test('generateForgeBlock wraps config with markers', () => {
  const block = generateForgeBlock({
    version: 1,
    projectName: 'Test',
    assetPath: './model.glb',
    camera: { position: [0, 1, 2], target: [0, 0, 0], fov: 45, near: 0.1, far: 50 },
    environment: { preset: 'studio', background: '#000', exposure: 1, xrEnabled: true, lights: [] },
    nodes: [],
    keyframes: [],
    loopMode: 'once',
  });
  assert.ok(block.startsWith(FORGE_BEGIN_MARKER));
  assert.ok(block.endsWith(FORGE_END_MARKER));
  assert.ok(block.includes('xrEnabled: true'));
});
