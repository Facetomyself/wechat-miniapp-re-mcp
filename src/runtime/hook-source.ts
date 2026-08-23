import { OffsetProfile } from '../types.js';

export function buildHookSource(profile: OffsetProfile): string {
  const config = JSON.stringify(profile);
  return `
'use strict';
const PROFILE = ${config};
const STATE = {
  moduleName: null,
  moduleBase: null,
  moduleSize: null,
  wmpfVersion: PROFILE.wmpfVersion,
  cdpFilterAttached: false,
  loadStartAttached: false,
  ready: false,
  lastScene: null,
  lastPatchedScene: false,
  cdpFilterEntered: 0,
  cdpFilterPatched: 0,
  loadStartEntered: 0,
  forceDebugTriggerCalls: 0,
};

function emit(type, data) {
  send({ source: 'wxmp-hook', type, data, timestamp: Date.now() });
}

function snapshot() {
  return {
    moduleName: STATE.moduleName,
    moduleBase: STATE.moduleBase,
    moduleSize: STATE.moduleSize,
    wmpfVersion: STATE.wmpfVersion,
    cdpFilterAttached: STATE.cdpFilterAttached,
    loadStartAttached: STATE.loadStartAttached,
    ready: STATE.ready,
    lastScene: STATE.lastScene,
    lastPatchedScene: STATE.lastPatchedScene,
    cdpFilterEntered: STATE.cdpFilterEntered,
    cdpFilterPatched: STATE.cdpFilterPatched,
    loadStartEntered: STATE.loadStartEntered,
    forceDebugTriggerCalls: STATE.forceDebugTriggerCalls,
  };
}

function safePointer(address) {
  try {
    if (!address || address.isNull()) return null;
    const value = address.readPointer();
    return value && !value.isNull() ? value : null;
  } catch (_) {
    return null;
  }
}

function patchCdpFilter(base) {
  const target = base.add(ptr(PROFILE.cdpFilterOffset));
  Interceptor.attach(target, {
    onEnter(args) {
      this.inputValue = args[0];
      STATE.cdpFilterEntered += 1;
    },
    onLeave() {
      try {
        const ptrValue = safeReadPointer(this.inputValue);
        if (!ptrValue) return;
        const flag = ptrValue.add(8);
        if (flag.isNull()) return;
        const current = flag.readU32();
        if (current === 6) {
          flag.writeU32(0);
          STATE.cdpFilterPatched += 1;
          emit('cdp_filter_patched', { previous: current });
        }
      } catch (error) {
        emit('cdp_filter_error', String(error));
      }
    }
  });
  STATE.cdpFilterAttached = true;
  emit('cdp_filter_attached', { address: target.toString() });
}

function safeReadPointer(address) {
  try {
    if (!address || address.isNull()) return null;
    const value = address.readPointer();
    if (!value || value.isNull()) return null;
    return value;
  } catch (_) {
    return null;
  }
}

function resolveScenePointer(root) {
  let current = root;
  for (let index = 0; index < PROFILE.sceneOffsets.length; index += 1) {
    current = current.add(PROFILE.sceneOffsets[index]);
    if (index < PROFILE.sceneOffsets.length - 1) current = current.readPointer();
  }
  return current;
}

function patchLoadStart(base) {
  const target = base.add(ptr(PROFILE.loadStartOffset));
  Interceptor.attach(target, {
    onEnter() {
      try {
        STATE.loadStartEntered += 1;
        if (Process.platform === 'windows') {
          this.context.rdx = this.context.rdx.or(ptr(1));
          const scenePointer = resolveScenePointer(this.context.rcx);
          const scene = scenePointer.readInt();
          const patchedScene = PROFILE.sceneWhitelist.indexOf(scene) !== -1;
          STATE.lastScene = scene;
          STATE.lastPatchedScene = patchedScene;
          if (patchedScene) scenePointer.writeInt(1101);
          emit('load_start', { scene, patchedScene });
        }
      } catch (error) {
        emit('load_start_error', String(error));
      }
    }
  });
  STATE.loadStartAttached = true;
  emit('load_start_attached', { address: target.toString() });
}

function main() {
  const module = Process.findModuleByName(PROFILE.moduleName);
  if (!module) throw new Error('module not found: ' + PROFILE.moduleName);
  STATE.moduleName = module.name;
  STATE.moduleBase = module.base.toString();
  STATE.moduleSize = module.size;
  emit('module', { name: module.name, base: module.base.toString(), size: module.size, version: PROFILE.wmpfVersion });
  patchCdpFilter(module.base);
  patchLoadStart(module.base);
  STATE.ready = true;
  emit('ready', { version: PROFILE.wmpfVersion });
}

rpc.exports = {
  status() {
    return snapshot();
  },
  forceDebugTrigger() {
    STATE.forceDebugTriggerCalls += 1;
    const observation = Object.assign({ mode: 'observation', attemptedNativeCall: false }, snapshot());
    emit('force_debug_trigger', observation);
    return observation;
  }
};

try { main(); } catch (error) { emit('fatal', { message: String(error), stack: error && error.stack }); throw error; }
`;
}
