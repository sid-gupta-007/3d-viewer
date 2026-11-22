export type Vec3 = [number, number, number];

export interface ForgeSceneManifest {
  version: 1;
  projectName: string;
  assetPath: string;
  camera: {
    position: Vec3;
    target: Vec3;
    fov: number;
    near: number;
    far: number;
  };
  environment: {
    preset: string;
    background: string;
    fog?: { color: string; near: number; far: number };
    exposure: number;
    xrEnabled: boolean;
    lights: Array<{
      id: string;
      type: 'ambient' | 'hemisphere' | 'directional' | 'point' | 'spot';
      color: string;
      groundColor?: string;
      intensity: number;
      position?: Vec3;
    }>;
  };
  nodes: Array<{
    forgeId: string;
    name: string;
    parentId: string | null;
    type: string;
    visible: boolean;
    position: Vec3;
    rotation: Vec3;
    scale: Vec3;
    pivot?: Vec3;
    splitFrom?: string;
  }>;
  keyframes: Array<{
    id: string;
    targetId: string;
    time: number;
    position: Vec3;
    rotation: Vec3;
    scale: Vec3;
    easing?: string;
  }>;
  loopMode: 'once' | 'loop' | 'pingpong';
}

export type WebviewToExtensionMessage =
  | { type: 'forge:ready' }
  | { type: 'forge:readScene'; requestId?: string; path?: string }
  | { type: 'forge:writeScene'; requestId?: string; path?: string; manifest: unknown }
  | {
      type: 'forge:patchFile';
      requestId?: string;
      targetPath?: string;
      content?: string;
      manifest?: ForgeSceneManifest;
    }
  | { type: 'forge:readAsset'; requestId?: string; uri?: string }
  | { type: 'forge:listWorkspaceFiles'; requestId?: string; include?: string };

export type ExtensionToWebviewMessage =
  | {
      type: 'forge:init';
      workspaceRoot: string | null;
      activeAssetPath: string | null;
      activeAssetUri: string | null;
      scenePath: string;
      sceneManifest: unknown | null;
    }
  | {
      type: 'forge:sceneData';
      requestId?: string;
      ok: boolean;
      path: string;
      manifest: unknown | null;
      error?: string;
    }
  | {
      type: 'forge:writeSceneResult';
      requestId?: string;
      ok: boolean;
      path: string;
      error?: string;
    }
  | {
      type: 'forge:patchFileResult';
      requestId?: string;
      ok: boolean;
      path: string;
      mode?: 'marker-replace' | 'create' | 'replace';
      error?: string;
    }
  | {
      type: 'forge:assetData';
      requestId?: string;
      ok: boolean;
      uri: string;
      mimeType: string;
      base64?: string;
      error?: string;
    }
  | {
      type: 'forge:workspaceFiles';
      requestId?: string;
      ok: boolean;
      files: string[];
      error?: string;
    }
  | {
      type: 'forge:error';
      requestId?: string;
      message: string;
    };
