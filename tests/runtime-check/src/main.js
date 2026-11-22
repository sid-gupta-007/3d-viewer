import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as TSL from 'three/tsl';

const project = {
  "format": "forge-scene",
  "version": 1,
  "name": "phase2-roundtrip-check",
  "duration": 8,
  "assets": [
    {
      "key": "model-e627820fabfbc6db535ad73d",
      "path": "assets/phase2-dense.gltf",
      "resources": [
        "assets/phase2-dense.gltf"
      ]
    }
  ],
  "nodes": [
    {
      "id": "model-e627820fabfbc6db535ad73d:root",
      "name": "phase2-dense",
      "type": "imported",
      "visible": true,
      "parent": null
    },
    {
      "id": "model-e627820fabfbc6db535ad73d:0",
      "name": "Test_Assembly",
      "type": "Group",
      "visible": true,
      "parent": "model-e627820fabfbc6db535ad73d:root"
    },
    {
      "id": "model-e627820fabfbc6db535ad73d:0.0",
      "name": "Body",
      "type": "Mesh",
      "visible": true,
      "parent": "model-e627820fabfbc6db535ad73d:0"
    },
    {
      "id": "model-e627820fabfbc6db535ad73d:0.1",
      "name": "Rotor_Hinge",
      "type": "Group",
      "visible": true,
      "parent": "model-e627820fabfbc6db535ad73d:0"
    },
    {
      "id": "model-e627820fabfbc6db535ad73d:0.1.0",
      "name": "Rotor_Blade",
      "type": "Mesh",
      "visible": true,
      "parent": "model-e627820fabfbc6db535ad73d:0.1"
    }
  ],
  "objects": {
    "model-e627820fabfbc6db535ad73d:root": {
      "position": [
        0,
        0.259,
        0
      ],
      "rotation": [
        0,
        0,
        0
      ],
      "scale": [
        1.294,
        1.294,
        1.294
      ]
    },
    "model-e627820fabfbc6db535ad73d:0": {
      "position": [
        0,
        0,
        0
      ],
      "rotation": [
        0,
        0,
        0
      ],
      "scale": [
        1,
        1,
        1
      ]
    },
    "model-e627820fabfbc6db535ad73d:0.0": {
      "position": [
        0,
        0,
        0
      ],
      "rotation": [
        0,
        0,
        0
      ],
      "scale": [
        1,
        1,
        1
      ]
    },
    "model-e627820fabfbc6db535ad73d:0.1": {
      "position": [
        0,
        0.712,
        0
      ],
      "rotation": [
        0,
        0,
        0
      ],
      "scale": [
        1,
        1,
        1
      ]
    },
    "model-e627820fabfbc6db535ad73d:0.1.0": {
      "position": [
        0,
        0,
        0
      ],
      "rotation": [
        0,
        0,
        0
      ],
      "scale": [
        1,
        1,
        1
      ]
    }
  },
  "tracks": [
    {
      "id": "rotor-start",
      "targetId": "model-e627820fabfbc6db535ad73d:0.1.0",
      "time": 0,
      "position": [
        0,
        0,
        0
      ],
      "rotation": [
        0,
        0,
        0
      ],
      "scale": [
        1,
        1,
        1
      ]
    },
    {
      "id": "rotor-spin",
      "targetId": "model-e627820fabfbc6db535ad73d:0.1.0",
      "time": 8,
      "position": [
        0,
        0,
        0
      ],
      "rotation": [
        0,
        6.283185,
        0
      ],
      "scale": [
        1,
        1,
        1
      ]
    }
  ],
  "effects": [
    {
      "kind": "burn",
      "targetId": "model-e627820fabfbc6db535ad73d:0.0",
      "startTime": 3,
      "endTime": 5,
      "seed": 42,
      "edgeColor": "#ff7a27",
      "edgeWidth": 0.08,
      "flameColor": "#ffb02e"
    },
    {
      "kind": "particles",
      "targetId": "model-e627820fabfbc6db535ad73d:0.0",
      "startTime": 3,
      "endTime": 5,
      "seed": 84,
      "color": "#ff9b36",
      "particleCount": 256,
      "particleSize": 14
    }
  ],
  "pivots": {
    "model-e627820fabfbc6db535ad73d:0.0": [
      0.12,
      0,
      0
    ]
  }
};
const renderer = new THREE.WebGPURenderer({ antialias: true });
await renderer.init();
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
const envCfg = project.environment;
if (typeof envCfg?.exposure === 'number') {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = envCfg.exposure;
}
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(envCfg?.background ?? '#111317');
if (envCfg?.fog) {
  scene.fog = new THREE.Fog(envCfg.fog.color, envCfg.fog.near, envCfg.fog.far);
}
const camCfg = project.camera ?? {};
const camera = new THREE.PerspectiveCamera(camCfg.fov ?? 45, innerWidth / innerHeight, camCfg.near ?? 0.1, camCfg.far ?? 1000);
const camPos = camCfg.position ?? [4, 3, 6];
camera.position.set(camPos[0], camPos[1], camPos[2]);
const controls = new OrbitControls(camera, renderer.domElement);
const camTarget = camCfg.target ?? [0, 1, 0];
controls.target.set(camTarget[0], camTarget[1], camTarget[2]);
controls.enableDamping = true;
if (Array.isArray(envCfg?.lights) && envCfg.lights.length > 0) {
  for (const l of envCfg.lights) {
    if (l.type === 'hemisphere') {
      scene.add(new THREE.HemisphereLight(l.color, l.groundColor ?? '#222', l.intensity));
    } else if (l.type === 'directional') {
      const light = new THREE.DirectionalLight(l.color, l.intensity);
      if (l.position) light.position.set(l.position[0], l.position[1], l.position[2]);
      scene.add(light);
    } else if (l.type === 'ambient') {
      scene.add(new THREE.AmbientLight(l.color, l.intensity));
    } else if (l.type === 'spot') {
      const light = new THREE.SpotLight(l.color, l.intensity);
      if (l.position) light.position.set(l.position[0], l.position[1], l.position[2]);
      scene.add(light);
    } else {
      const light = new THREE.PointLight(l.color, l.intensity);
      if (l.position) light.position.set(l.position[0], l.position[1], l.position[2]);
      scene.add(light);
    }
  }
} else {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x252a35, 2));
  const key = new THREE.DirectionalLight(0xffffff, 3);
  key.position.set(4, 7, 5);
  scene.add(key);
}
const objects = new Map();
const effectMaterials = new Map();
const effectParticles = [];
const makeDissolveMaterial = (source, effect, geometry) => {
  const material = new THREE.MeshPhysicalNodeMaterial();
  const blockedProperties = new Set(['id', 'uuid', 'type', 'version', 'userData', '_listeners', 'needsUpdate']);
  for (const key of Object.keys(source)) {
    if (blockedProperties.has(key) || !(key in material)) continue;
    material[key] = key === 'userData' ? JSON.parse(JSON.stringify(source[key] ?? {})) : source[key];
  }
  const progress = TSL.uniform(0);
  const width = TSL.uniform(effect.edgeWidth);
  const seed = (effect.seed >>> 0) / 0xffffffff * 64;
  const sample = TSL.positionLocal.mul(3).add(TSL.vec3(seed, seed * 1.7, seed * 2.3));
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox ?? new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  const size = bounds.getSize(new THREE.Vector3());
  const axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
  const span = Math.max(size.getComponent(axis), 1e-5);
  const minimum = bounds.min.getComponent(axis);
  const position = axis === 0 ? TSL.positionLocal.x : axis === 1 ? TSL.positionLocal.y : TSL.positionLocal.z;
  const sweep = position.sub(minimum).div(span).clamp(0, 1);
  const noisySweep = sweep.add(TSL.mx_noise_float(sample).mul(0.08)).clamp(0, 1);
  const edge = TSL.float(1).sub(sweep.sub(progress).abs().smoothstep(0, width));
  material.opacityNode = noisySweep.smoothstep(progress.sub(width), progress.add(width));
  material.alphaTestNode = TSL.float(0.5);
  const glow = effect.kind === 'burn' ? TSL.color(effect.flameColor).mul(2.5) : TSL.color(effect.edgeColor);
  material.emissiveNode = TSL.emissive.add(glow.mul(edge));
  material.userData.forgeEffectProgress = progress;
  material.userData.forgeEffectWidth = width;
  return material;
};
const buildCenteredPartMesh = (sourceMesh, triangleVertexIndices, material, partName, forgeId) => {
  const srcGeo = sourceMesh.geometry;
  const posAttr = srcGeo.getAttribute('position');
  const normAttr = srcGeo.getAttribute('normal');
  const uvAttr = srcGeo.getAttribute('uv');
  const vertCount = triangleVertexIndices.length;
  const positions = new Float32Array(vertCount * 3);
  const normals = normAttr ? new Float32Array(vertCount * 3) : null;
  const uvs = uvAttr ? new Float32Array(vertCount * 2) : null;
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < vertCount; i++) {
    const vi = triangleVertexIndices[i];
    const x = posAttr.getX(vi), y = posAttr.getY(vi), z = posAttr.getZ(vi);
    positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
    if (x < min.x) min.x = x; if (y < min.y) min.y = y; if (z < min.z) min.z = z;
    if (x > max.x) max.x = x; if (y > max.y) max.y = y; if (z > max.z) max.z = z;
    if (normals && normAttr) { normals[i * 3] = normAttr.getX(vi); normals[i * 3 + 1] = normAttr.getY(vi); normals[i * 3 + 2] = normAttr.getZ(vi); }
    if (uvs && uvAttr) { uvs[i * 2] = uvAttr.getX(vi); uvs[i * 2 + 1] = uvAttr.getY(vi); }
  }
  const center = vertCount > 0 ? min.clone().add(max).multiplyScalar(0.5) : new THREE.Vector3();
  for (let i = 0; i < vertCount; i++) { positions[i * 3] -= center.x; positions[i * 3 + 1] -= center.y; positions[i * 3 + 2] -= center.z; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (normals) geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  else if (vertCount > 0) geo.computeVertexNormals();
  if (uvs) geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const part = new THREE.Mesh(geo, material);
  part.name = partName;
  part.position.copy(center);
  part.userData.forgeId = forgeId;
  part.userData.splitFrom = sourceMesh.userData.forgeId;
  part.castShadow = sourceMesh.castShadow;
  part.receiveShadow = sourceMesh.receiveShadow;
  return part;
};
const splitMeshIslands = (mesh) => {
  const posAttr = mesh.geometry?.getAttribute('position');
  if (!posAttr || posAttr.count < 3) return [];
  const index = mesh.geometry.getIndex();
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3);
  if (triCount <= 1) return [];
  const parent = new Int32Array(triCount);
  for (let i = 0; i < triCount; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const vertexToTri = new Map();
  const q = (n) => Math.round(n * 10000);
  const getVi = (t, c) => (index ? index.getX(t * 3 + c) : t * 3 + c);
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const vi = getVi(t, c);
      const key = q(posAttr.getX(vi)) + ',' + q(posAttr.getY(vi)) + ',' + q(posAttr.getZ(vi));
      const prev = vertexToTri.get(key);
      if (prev !== undefined) union(t, prev); else vertexToTri.set(key, t);
    }
  }
  const groups = new Map();
  for (let t = 0; t < triCount; t++) {
    const r = find(t);
    let list = groups.get(r);
    if (!list) { list = []; groups.set(r, list); }
    list.push(getVi(t, 0), getVi(t, 1), getVi(t, 2));
  }
  if (groups.size <= 1) return [];
  const baseId = mesh.userData.forgeId ?? mesh.name ?? 'mesh';
  const baseName = mesh.name || 'Part';
  const parts = [];
  let idx = 0;
  for (const verts of groups.values()) {
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    parts.push(buildCenteredPartMesh(mesh, verts, mat, baseName + '_part_' + (idx + 1), baseId + ':part-' + idx));
    idx++;
  }
  return parts;
};
const splitMeshMaterials = (mesh) => {
  const geo = mesh.geometry;
  const posAttr = geo?.getAttribute('position');
  if (!posAttr || !geo.groups || geo.groups.length <= 1) return [];
  const index = geo.getIndex();
  const baseId = mesh.userData.forgeId ?? mesh.name ?? 'mesh';
  const baseName = mesh.name || 'Part';
  const parts = [];
  geo.groups.forEach((group, idx) => {
    const verts = [];
    for (let i = group.start; i < group.start + group.count; i++) verts.push(index ? index.getX(i) : i);
    if (verts.length < 3) return;
    const mat = Array.isArray(mesh.material) ? (mesh.material[group.materialIndex ?? 0] ?? mesh.material[0]) : mesh.material;
    parts.push(buildCenteredPartMesh(mesh, verts, mat, baseName + '_mat_' + (idx + 1), baseId + ':mat-' + idx));
  });
  return parts.length > 1 ? parts : [];
};
const applyTriGroups = (geo, triList, triMaterialIndices) => {
  if (!triMaterialIndices || triList.length === 0) return;
  let groupStartTri = 0;
  let currentMat = triMaterialIndices[triList[0]];
  for (let i = 1; i < triList.length; i++) {
    const mat = triMaterialIndices[triList[i]];
    if (mat !== currentMat) {
      geo.addGroup(groupStartTri * 3, (i - groupStartTri) * 3, currentMat);
      groupStartTri = i;
      currentMat = mat;
    }
  }
  geo.addGroup(groupStartTri * 3, (triList.length - groupStartTri) * 3, currentMat);
};
const extractMeshTriangles = (sourceMesh, triangleIndices, partId, partName) => {
  const srcGeo = sourceMesh.geometry;
  const posAttr = srcGeo?.getAttribute('position');
  if (!posAttr || posAttr.count < 3) return null;
  const index = srcGeo.getIndex();
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3);
  const getVi = (t, c) => (index ? index.getX(t * 3 + c) : t * 3 + c);
  const extractSet = new Set();
  for (const t of triangleIndices) {
    if (Number.isInteger(t) && t >= 0 && t < triCount) extractSet.add(t);
  }
  if (extractSet.size === 0) return null;
  const extractedTris = Array.from(extractSet).sort((a, b) => a - b);
  const extractVerts = [];
  for (const t of extractedTris) extractVerts.push(getVi(t, 0), getVi(t, 1), getVi(t, 2));
  const remainTris = [];
  const remainVerts = [];
  for (let t = 0; t < triCount; t++) {
    if (!extractSet.has(t)) {
      remainTris.push(t);
      remainVerts.push(getVi(t, 0), getVi(t, 1), getVi(t, 2));
    }
  }
  let triMaterialIndices = null;
  if (srcGeo.groups && srcGeo.groups.length > 0) {
    triMaterialIndices = new Int32Array(triCount);
    for (const group of srcGeo.groups) {
      const startTri = Math.max(0, Math.floor(group.start / 3));
      const endTri = Math.min(triCount, Math.floor((group.start + group.count) / 3));
      const matIdx = group.materialIndex ?? 0;
      for (let t = startTri; t < endTri; t++) triMaterialIndices[t] = matIdx;
    }
  }
  const partMaterial = Array.isArray(sourceMesh.material) ? [...sourceMesh.material] : sourceMesh.material;
  const part = buildCenteredPartMesh(sourceMesh, extractVerts, partMaterial, partName || (sourceMesh.name || 'Part') + '_extracted', partId);
  applyTriGroups(part.geometry, extractedTris, triMaterialIndices);
  sourceMesh.updateMatrix();
  part.position.applyMatrix4(sourceMesh.matrix);
  part.rotation.copy(sourceMesh.rotation);
  part.quaternion.copy(sourceMesh.quaternion);
  part.scale.copy(sourceMesh.scale);
  const normAttr = srcGeo.getAttribute('normal');
  const uvAttr = srcGeo.getAttribute('uv');
  const remainCount = remainVerts.length;
  const rPos = new Float32Array(remainCount * 3);
  const rNorm = normAttr ? new Float32Array(remainCount * 3) : null;
  const rUv = uvAttr ? new Float32Array(remainCount * 2) : null;
  for (let i = 0; i < remainCount; i++) {
    const vi = remainVerts[i];
    rPos[i * 3] = posAttr.getX(vi); rPos[i * 3 + 1] = posAttr.getY(vi); rPos[i * 3 + 2] = posAttr.getZ(vi);
    if (rNorm && normAttr) { rNorm[i * 3] = normAttr.getX(vi); rNorm[i * 3 + 1] = normAttr.getY(vi); rNorm[i * 3 + 2] = normAttr.getZ(vi); }
    if (rUv && uvAttr) { rUv[i * 2] = uvAttr.getX(vi); rUv[i * 2 + 1] = uvAttr.getY(vi); }
  }
  const remainGeo = new THREE.BufferGeometry();
  remainGeo.setAttribute('position', new THREE.BufferAttribute(rPos, 3));
  if (rNorm) remainGeo.setAttribute('normal', new THREE.BufferAttribute(rNorm, 3));
  if (rUv) remainGeo.setAttribute('uv', new THREE.BufferAttribute(rUv, 2));
  applyTriGroups(remainGeo, remainTris, triMaterialIndices);
  remainGeo.computeBoundingBox();
  remainGeo.computeBoundingSphere();
  sourceMesh.geometry = remainGeo;
  return part;
};
for (const asset of project.assets) {
  const gltf = await new GLTFLoader().loadAsync('./' + asset.path);
  const root = gltf.scene;
  const initialObjects = [];
  root.traverse((object) => initialObjects.push(object));
  root.userData.forgeId = asset.key + ':root';
  objects.set(root.userData.forgeId, root);
  for (const object of initialObjects) {
    if (object === root) continue;
    const path = [];
    let node = object;
    while (node.parent && node.parent !== root) { path.unshift(node.parent.children.indexOf(node)); node = node.parent; }
    path.unshift(root.children.indexOf(node));
    object.userData.forgeId = asset.key + ':' + path.join('.');
    objects.set(object.userData.forgeId, object);
  }
  scene.add(root);
}
const partOps = [...(project.splits ?? [])];
const coveredSplits = new Set();
const coveredExtracts = new Set();
for (const op of partOps) {
  if (op.kind === 'split') coveredSplits.add(op.sourceId + ':' + op.mode);
  else coveredExtracts.add(op.partId);
}
for (const node of project.nodes ?? []) {
  if (node.splitMode === 'extract' && node.splitFrom && Array.isArray(node.extractedTriangles)) {
    if (!coveredExtracts.has(node.id)) {
      partOps.push({ kind: 'extract', sourceId: node.splitFrom, partId: node.id, partName: node.name, triangleIndices: node.extractedTriangles });
      coveredExtracts.add(node.id);
    }
    continue;
  }
  const match = node.id.match(/^(.*):(part|mat)-(\d+)$/);
  const sourceId = node.splitFrom ?? (match ? match[1] : undefined);
  if (!sourceId) continue;
  const mode = node.splitMode === 'materials' || match?.[2] === 'mat' ? 'materials' : (node.splitMode === 'islands' || match?.[2] === 'part' ? 'islands' : null);
  if (mode && !coveredSplits.has(sourceId + ':' + mode)) {
    partOps.push({ kind: 'split', sourceId, mode });
    coveredSplits.add(sourceId + ':' + mode);
  }
}
for (const saved of project.nodes ?? []) {
  const object = objects.get(saved.id);
  if (object) object.visible = saved.visible;
}
for (const [id, transform] of Object.entries(project.objects ?? {})) {
  const object = objects.get(id);
  if (!object) continue;
  object.position.fromArray(transform.position);
  object.rotation.set(...transform.rotation);
  object.scale.fromArray(transform.scale);
}
for (const op of partOps) {
  if (op.kind === 'split') {
    const src = objects.get(op.sourceId);
    if (!src?.isMesh) continue;
    const parts = op.mode === 'materials' ? splitMeshMaterials(src) : splitMeshIslands(src);
    if (parts.length > 0) {
      const parent = src.parent ?? scene;
      const group = new THREE.Group();
      group.name = src.name || 'SplitGroup';
      group.userData.forgeId = op.sourceId;
      group.position.copy(src.position);
      group.rotation.copy(src.rotation);
      group.scale.copy(src.scale);
      group.visible = src.visible;
      const srcIndex = parent.children.indexOf(src);
      parent.add(group);
      if (srcIndex >= 0) {
        const addedIndex = parent.children.indexOf(group);
        if (addedIndex !== -1 && addedIndex !== srcIndex) {
          parent.children.splice(addedIndex, 1);
          parent.children.splice(srcIndex, 0, group);
        }
      }
      parent.remove(src);
      objects.set(op.sourceId, group);
      for (const part of parts) {
        group.add(part);
        objects.set(part.userData.forgeId, part);
      }
    }
  } else if (!objects.has(op.partId)) {
    const src = objects.get(op.sourceId);
    if (!src?.isMesh) continue;
    const part = extractMeshTriangles(src, op.triangleIndices, op.partId, op.partName);
    if (part) {
      (src.parent ?? scene).add(part);
      objects.set(op.partId, part);
    }
  }
}
for (const saved of project.nodes ?? []) {
  const object = objects.get(saved.id);
  if (object) object.visible = saved.visible;
}
for (const [id, transform] of Object.entries(project.objects ?? {})) {
  const object = objects.get(id);
  if (!object) continue;
  object.position.fromArray(transform.position);
  object.rotation.set(...transform.rotation);
  object.scale.fromArray(transform.scale);
}
for (const [id, pivot] of Object.entries(project.pivots ?? {})) {
  const object = objects.get(id);
  if (!object?.isMesh) continue;
  object.geometry = object.geometry.clone();
  object.geometry.translate(-pivot[0], -pivot[1], -pivot[2]);
}
const makeParticles = (mesh, effect) => {
  const source = mesh.geometry.getAttribute('position');
  if (!source?.count) return;
  let seed = effect.seed >>> 0;
  const random = () => { seed += 0x6D2B79F5; let next = seed; next = Math.imul(next ^ (next >>> 15), next | 1); next ^= next + Math.imul(next ^ (next >>> 7), next | 61); return ((next ^ (next >>> 14)) >>> 0) / 4294967296; };
  const count = effect.particleCount;
  const positions = new Float32Array(count * 3), velocities = new Float32Array(count * 3), phases = new Float32Array(count);
  const point = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    point.fromBufferAttribute(source, Math.floor(random() * source.count)); positions.set([point.x, point.y, point.z], i * 3);
    const velocity = new THREE.Vector3(random() * 2 - 1, 0.25 + random() * 0.9, random() * 2 - 1).normalize().multiplyScalar(0.22 + random() * 0.5);
    velocities.set([velocity.x, velocity.y, velocity.z], i * 3); phases[i] = random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('forgeVelocity', new THREE.Float32BufferAttribute(velocities, 3));
  geometry.setAttribute('forgePhase', new THREE.Float32BufferAttribute(phases, 1));
  const material = new THREE.PointsNodeMaterial({ size: effect.particleSize, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const timeNode = TSL.uniform(0), activeNode = TSL.uniform(0);
  const phase = TSL.attribute('forgePhase'), life = TSL.fract(phase.add(timeNode.mul(0.72)));
  const velocity = TSL.attribute('forgeVelocity', 'vec3'), sway = life.mul(6).add(phase).sin().mul(0.08);
  material.positionNode = TSL.positionLocal.add(velocity.mul(life)).add(TSL.vec3(sway, life.mul(0.8), sway.mul(0.65)));
  material.colorNode = TSL.color(effect.color).mul(TSL.float(0.7).add(life.mul(0.8)));
  material.opacityNode = activeNode.mul(TSL.smoothstep(0, 0.12, life)).mul(TSL.float(1).sub(TSL.smoothstep(0.82, 1, life)));
  material.needsUpdate = true;
  const points = new THREE.Points(geometry, material); points.frustumCulled = false; mesh.add(points);
  effectParticles.push({ effect, points, timeNode, activeNode });
};
for (const effect of project.effects ?? []) {
  const target = objects.get(effect.targetId);
  if (!target) continue;
  if (effect.kind === 'particles') { if (target.isMesh) makeParticles(target, effect); continue; }
  const materials = [];
  if (target.isMesh) {
    const object = target;
    const sources = Array.isArray(object.material) ? object.material : [object.material];
    const replacements = sources.map((source) => makeDissolveMaterial(source, effect, target.geometry));
    object.material = Array.isArray(object.material) ? replacements : replacements[0];
    materials.push(...replacements);
  }
  effectMaterials.set(effect.targetId, { effect, materials });
}
const clamp01 = (v) => (!Number.isFinite(v) || v <= 0 ? 0 : v >= 1 ? 1 : v);
const applyEasing = (t, easing = 'linear') => {
  const u = clamp01(t);
  switch (easing) {
    case 'easeIn': return u * u;
    case 'easeOut': return 1 - (1 - u) * (1 - u);
    case 'easeInOut': return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    case 'step': return u >= 1 ? 1 : 0;
    default: return u;
  }
};
const resolveLoopTime = (elapsed, duration, loopMode = 'loop') => {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(elapsed) || elapsed <= 0) return 0;
  if (loopMode === 'once') return elapsed >= duration ? duration : elapsed;
  if (loopMode === 'pingpong') {
    const cycle = duration * 2;
    const mod = elapsed % cycle;
    return mod <= duration ? mod : cycle - mod;
  }
  return elapsed % duration;
};
const tracks = project.tracks ?? [];
const tracksByTarget = new Map();
for (const track of tracks) {
  const list = tracksByTarget.get(track.targetId) ?? [];
  list.push(track);
  tracksByTarget.set(track.targetId, list);
}
for (const list of tracksByTarget.values()) list.sort((a, b) => a.time - b.time);
const animStart = performance.now() / 1000;
renderer.setAnimationLoop(render);
function render() {
  const time = resolveLoopTime((performance.now() / 1000) - animStart, project.duration, project.loopMode ?? 'loop');
  controls.update();
  for (const [id, keys] of tracksByTarget) {
    const object = objects.get(id);
    if (!object || !keys.length) continue;
    const first = keys[0];
    const last = keys[keys.length - 1];
    let before = first, after = first, amount = 0;
    if (time <= first.time) {
      before = first; after = first; amount = 0;
    } else if (time >= last.time) {
      before = last; after = last; amount = 0;
    } else {
      for (let i = 0; i < keys.length - 1; i++) {
        if (time >= keys[i].time && time <= keys[i + 1].time) {
          before = keys[i];
          after = keys[i + 1];
          const span = after.time - before.time;
          amount = span <= 0 ? 1 : applyEasing((time - before.time) / span, before.easing ?? after.easing ?? 'linear');
          break;
        }
      }
    }
    for (const field of ['position', 'rotation', 'scale']) {
      object[field].fromArray(before[field].map((value, index) => value + (after[field][index] - value) * amount));
    }
  }
  for (const { effect, materials } of effectMaterials.values()) {
    const progress = time <= effect.startTime ? 0 : time >= effect.endTime ? 1 : (time - effect.startTime) / (effect.endTime - effect.startTime);
    for (const material of materials) {
      material.userData.forgeEffectProgress.value = progress;
      material.userData.forgeEffectWidth.value = effect.edgeWidth;
    }
  }
  for (const system of effectParticles) {
    system.timeNode.value = time - system.effect.startTime;
    system.activeNode.value = time >= system.effect.startTime && time <= system.effect.endTime ? 1 : 0;
  }
  renderer.render(scene, camera);
}
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
