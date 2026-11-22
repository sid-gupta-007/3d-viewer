import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createDefaultManifest } from '../../../src/domain/sceneManifest.ts'
import { readSceneManifest, writeSceneManifest } from '../src/manifestStore.ts'
import { handleJsonRpcMessage, startStdioServer } from '../src/server.ts'
import { executeTool, TOOL_DEFINITIONS } from '../src/tools.ts'

async function withTempProject(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-3d-mcp-test-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('get_scene_summary errors when .forge/scene.json is missing and returns summary when present', async () => {
  await withTempProject(async (root) => {
    await assert.rejects(
      () => executeTool('get_scene_summary', {}, { defaultProjectRoot: root }),
      /Scene manifest not found/
    )

    const manifest = createDefaultManifest('TestStage', './assets/robot.glb')
    manifest.nodes.push({
      forgeId: 'robot:0',
      name: 'Head',
      parentId: 'robot:root',
      type: 'Mesh',
      visible: true,
      position: [0, 1.5, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    })
    await writeSceneManifest(root, manifest)

    const res = await executeTool('get_scene_summary', {}, { defaultProjectRoot: root })
    const summary = JSON.parse(res.content[0].text)
    assert.equal(summary.projectName, 'TestStage')
    assert.equal(summary.assetPath, './assets/robot.glb')
    assert.equal(summary.nodeCount, 1)
    assert.equal(summary.nodes[0].forgeId, 'robot:0')
    assert.equal(summary.keyframeCount, 0)
  })
})

test('set_camera_pose creates default manifest when missing and validates camera bounds', async () => {
  await withTempProject(async (root) => {
    const res = await executeTool(
      'set_camera_pose',
      { position: [2, 3, 4], target: [0, 1, 0], fov: 45 },
      { defaultProjectRoot: root }
    )
    const payload = JSON.parse(res.content[0].text)
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.camera.position, [2, 3, 4])
    assert.deepEqual(payload.camera.target, [0, 1, 0])
    assert.equal(payload.camera.fov, 45)

    const saved = await readSceneManifest(root)
    assert.deepEqual(saved.camera.position, [2, 3, 4])

    await assert.rejects(
      () => executeTool('set_camera_pose', { fov: 200 }, { defaultProjectRoot: root }),
      /fov must be between 0 and 180/
    )
    await assert.rejects(
      () => executeTool('set_camera_pose', { near: 50, far: 10 }, { defaultProjectRoot: root }),
      /near must be strictly less than far/
    )
  })
})

test('set_node_transform updates existing nodes and supports createIfMissing', async () => {
  await withTempProject(async (root) => {
    await writeSceneManifest(root, createDefaultManifest())

    await assert.rejects(
      () =>
        executeTool(
          'set_node_transform',
          { forgeId: 'drone:0', position: [1, 2, 3] },
          { defaultProjectRoot: root }
        ),
      /Node "drone:0" not found/
    )

    const created = await executeTool(
      'set_node_transform',
      {
        forgeId: 'drone:0',
        name: 'Rotor',
        parentId: 'drone:root',
        position: [1, 2, 3],
        createIfMissing: true,
      },
      { defaultProjectRoot: root }
    )
    assert.equal(JSON.parse(created.content[0].text).node.name, 'Rotor')

    const updated = await executeTool(
      'set_node_transform',
      {
        forgeId: 'drone:0',
        rotation: [0, 1.57, 0],
        scale: [2, 2, 2],
        visible: false,
      },
      { defaultProjectRoot: root }
    )
    const node = JSON.parse(updated.content[0].text).node
    assert.deepEqual(node.position, [1, 2, 3])
    assert.deepEqual(node.rotation, [0, 1.57, 0])
    assert.deepEqual(node.scale, [2, 2, 2])
    assert.equal(node.visible, false)
  })
})

test('add_animation_keyframe upserts, inherits node defaults, and sorts by time', async () => {
  await withTempProject(async (root) => {
    const manifest = createDefaultManifest()
    manifest.nodes.push({
      forgeId: 'arm:0',
      name: 'Arm',
      parentId: 'arm:root',
      type: 'Mesh',
      visible: true,
      position: [0, 1, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    })
    await writeSceneManifest(root, manifest)

    await executeTool(
      'add_animation_keyframe',
      { targetId: 'arm:0', time: 2.5, position: [0, 3, 0], easing: 'easeInOut' },
      { defaultProjectRoot: root }
    )
    await executeTool(
      'add_animation_keyframe',
      { targetId: 'arm:0', time: 0.5, easing: 'linear' },
      { defaultProjectRoot: root }
    )
    // Upsert at time 2.5
    const upserted = await executeTool(
      'add_animation_keyframe',
      { targetId: 'arm:0', time: 2.5, position: [0, 4, 0], easing: 'easeOut' },
      { defaultProjectRoot: root }
    )

    const result = JSON.parse(upserted.content[0].text)
    assert.equal(result.updatedExisting, true)
    assert.equal(result.totalKeyframes, 2)

    const saved = await readSceneManifest(root)
    assert.deepEqual(
      saved.keyframes.map((k) => k.time),
      [0.5, 2.5]
    )
    assert.deepEqual(saved.keyframes[0].position, [0, 1, 0])
    assert.deepEqual(saved.keyframes[1].position, [0, 4, 0])
    assert.equal(saved.keyframes[1].easing, 'easeOut')
  })
})

test('sync_code_export creates new R3F file and patches existing file preserving user code', async () => {
  await withTempProject(async (root) => {
    const manifest = createDefaultManifest('MechViewer', './assets/mech.glb')
    manifest.camera.position = [1, 2, 3]
    await writeSceneManifest(root, manifest)

    const createdRes = await executeTool(
      'sync_code_export',
      { outputPath: 'src/MechStage.tsx' },
      { defaultProjectRoot: root }
    )
    const createdInfo = JSON.parse(createdRes.content[0].text)
    assert.equal(createdInfo.mode, 'created')

    const targetFile = path.join(root, 'src/MechStage.tsx')
    const initialContent = await readFile(targetFile, 'utf8')
    assert.match(initialContent, /export function MechViewer\(\)/)
    assert.match(initialContent, /position: \[1, 2, 3\]/)

    // Append custom user code outside @forge markers and update camera
    await writeFile(
      targetFile,
      `${initialContent}\nexport const USER_CUSTOM_BANNER = 'keep-me'\n`,
      'utf8'
    )
    await executeTool(
      'set_camera_pose',
      { position: [7, 8, 9] },
      { defaultProjectRoot: root }
    )

    const patchedRes = await executeTool(
      'sync_code_export',
      { outputPath: 'src/MechStage.tsx' },
      { defaultProjectRoot: root }
    )
    const patchedInfo = JSON.parse(patchedRes.content[0].text)
    assert.equal(patchedInfo.mode, 'patched')

    const patchedContent = await readFile(targetFile, 'utf8')
    assert.match(patchedContent, /position: \[7, 8, 9\]/)
    assert.match(patchedContent, /export const USER_CUSTOM_BANNER = 'keep-me'/)
  })
})

test('MCP JSON-RPC handler supports initialize, tools/list, tools/call, and error codes', async () => {
  await withTempProject(async (root) => {
    const ctx = { defaultProjectRoot: root }

    const initRes = await handleJsonRpcMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      ctx
    )
    assert.equal(initRes?.id, 1)
    assert.equal((initRes?.result as { serverInfo: { name: string } }).serverInfo.name, 'forge-3d-mcp')

    const notifRes = await handleJsonRpcMessage(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      ctx
    )
    assert.equal(notifRes, null)

    const listRes = await handleJsonRpcMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx)
    const tools = (listRes?.result as { tools: typeof TOOL_DEFINITIONS }).tools
    assert.deepEqual(
      tools.map((t) => t.name),
      [
        'get_scene_summary',
        'set_camera_pose',
        'set_node_transform',
        'add_animation_keyframe',
        'sync_code_export',
      ]
    )

    const unknownMethod = await handleJsonRpcMessage(
      { jsonrpc: '2.0', id: 3, method: 'resources/list' },
      ctx
    )
    assert.equal(unknownMethod?.error?.code, -32601)

    const unknownTool = await handleJsonRpcMessage(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } },
      ctx
    )
    assert.equal(unknownTool?.error?.code, -32602)
  })
})

test('stdio server processes newline-delimited JSON-RPC requests end-to-end', async () => {
  await withTempProject(async (root) => {
    const input = new PassThrough()
    const output = new PassThrough()
    const lines: string[] = []
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) lines.push(line)
      }
    })

    const rl = startStdioServer({ defaultProjectRoot: root }, input, output)

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`)
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'set_camera_pose', arguments: { position: [5, 5, 5] } },
      })}\n`
    )
    input.end()

    await new Promise<void>((resolve) => {
      rl.on('close', () => setTimeout(resolve, 20))
    })

    assert.equal(lines.length, 2)
    assert.deepEqual(JSON.parse(lines[0]), { jsonrpc: '2.0', id: 1, result: {} })
    const callPayload = JSON.parse(JSON.parse(lines[1]).result.content[0].text)
    assert.deepEqual(callPayload.camera.position, [5, 5, 5])
  })
})
