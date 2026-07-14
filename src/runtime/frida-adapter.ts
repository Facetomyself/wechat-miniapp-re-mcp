import { OffsetProfile, TargetProcess } from '../types.js';
import { WxmpError } from '../errors.js';
import { buildHookSource } from './hook-source.js';

export interface FridaHandle {
  detach(): Promise<void>;
}

export class FridaRuntimeAdapter {
  async attach(
    target: TargetProcess,
    profile: OffsetProfile,
    onEvent: (event: unknown) => void,
  ): Promise<FridaHandle> {
    let frida: typeof import('frida');
    try {
      frida = await import('frida');
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

    const script = await session.createScript(buildHookSource(profile), {
      name: `wxmp-wmpf-${target.version ?? 'unknown'}`,
    });
    script.message.connect((message, data) => {
      onEvent({ message, dataLength: data?.byteLength ?? 0 });
    });

    try {
      await script.load();
    } catch (error) {
      await session.detach().catch(() => undefined);
      throw new WxmpError('FRIDA_SCRIPT_FAILED', 'The WMPF hook script failed to load', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    let detached = false;
    return {
      detach: async () => {
        if (detached) return;
        detached = true;
        await script.unload().catch(() => undefined);
        await session.detach().catch(() => undefined);
      },
    };
  }
}
