import { OffsetProfile, TargetProcess } from '../types.js';
import { WxmpError } from '../errors.js';
import { buildHookSource } from './hook-source.js';

export interface FridaHandle {
  detach(): Promise<void>;
}

type FridaModule = Pick<typeof import('frida'), 'getLocalDevice'>;
type FridaLoader = () => Promise<FridaModule>;

export class FridaRuntimeAdapter {
  constructor(private readonly loadFrida: FridaLoader = () => import('frida')) {}

  async attach(
    target: TargetProcess,
    profile: OffsetProfile,
    onEvent: (event: unknown) => void,
    onDetached?: (event: { reason: string; crash: unknown }) => void,
  ): Promise<FridaHandle> {
    let frida: FridaModule;
    try {
      frida = await this.loadFrida();
    } catch (error) {
      throw new WxmpError('FRIDA_UNAVAILABLE', 'The Node.js Frida binding could not be loaded', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const device = await frida.getLocalDevice();
    let session: Awaited<ReturnType<typeof device.attach>>;
    try {
      session = await device.attach(target.pid);
    } catch (error) {
      throw new WxmpError('FRIDA_ATTACH_FAILED', `Failed to attach to WMPF process ${target.pid}`, {
        pid: target.pid,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    let script: Awaited<ReturnType<typeof session.createScript>> | null = null;
    let detached = false;
    try {
      session.detached.connect((reason, crash) => {
        if (detached) return;
        detached = true;
        onDetached?.({ reason: String(reason), crash });
      });
      script = await session.createScript(buildHookSource(profile), {
        name: `wxmp-wmpf-${target.version ?? 'unknown'}`,
      });
      script.message.connect((message, data) => {
        onEvent({ message, dataLength: data?.byteLength ?? 0 });
      });
      await script.load();
    } catch (error) {
      detached = true;
      if (script) await script.unload().catch(() => undefined);
      await session.detach().catch(() => undefined);
      throw new WxmpError('FRIDA_SCRIPT_FAILED', 'The WMPF hook script failed to initialize', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      detach: async () => {
        if (detached) return;
        detached = true;
        if (script) await script.unload().catch(() => undefined);
        await session.detach().catch(() => undefined);
      },
    };
  }
}
