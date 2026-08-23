import { FridaRuntimeAdapter } from '../runtime/frida-adapter.js';
import { discoverTargets, resolveTarget } from '../runtime/target-discovery.js';
import { TargetProcess } from '../types.js';
import { BridgeHooks, WmpfBridgeServer } from '../transport/bridge-server.js';

export type Clock = () => Date;
export type TargetDiscovery = () => Promise<TargetProcess[]>;
export type TargetResolver = (pid?: number) => Promise<TargetProcess>;
export type BridgeFactory = (host: string, port: number, hooks: BridgeHooks) => WmpfBridgeServer;

export interface SessionRuntimeDeps {
  now?: Clock;
  discoverTargets?: TargetDiscovery;
  resolveTarget?: TargetResolver;
  frida?: FridaRuntimeAdapter;
  createBridge?: BridgeFactory;
}

export function defaultClock(): Date {
  return new Date();
}

export function defaultBridgeFactory(host: string, port: number, hooks: BridgeHooks): WmpfBridgeServer {
  return new WmpfBridgeServer(host, port, hooks);
}

export const defaultSessionRuntimeDeps = {
  now: defaultClock,
  discoverTargets,
  resolveTarget,
  createBridge: defaultBridgeFactory,
} as const;
