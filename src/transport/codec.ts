import zlib from 'node:zlib';
import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

const DebugMessage = new Type('WARemoteDebug_DebugMessage')
  .add(new Field('seq', 1, 'uint32'))
  .add(new Field('after', 2, 'uint32'))
  .add(new Field('category', 3, 'string'))
  .add(new Field('data', 4, 'bytes'))
  .add(new Field('compressAlgo', 5, 'uint32'))
  .add(new Field('originalSize', 6, 'uint32'));

const ChromeDevtools = new Type('WARemoteDebug_ChromeDevtools')
  .add(new Field('opId', 1, 'uint64'))
  .add(new Field('payload', 2, 'string'))
  .add(new Field('jscontextId', 3, 'string'));

const AddJsContext = new Type('WARemoteDebug_AddJsContext')
  .add(new Field('jscontextId', 1, 'string'))
  .add(new Field('jscontextName', 2, 'string'));

const RemoveJsContext = new Type('WARemoteDebug_RemoveJsContext').add(new Field('jscontextId', 1, 'string'));

export interface DebugEnvelope {
  seq: number;
  after: number;
  category: string;
  data: Buffer;
  compressAlgo: number;
  originalSize: number;
}

export interface CdpPayload {
  opId: string;
  payload: string;
  jscontextId: string;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return Number((value as { toString?: () => string })?.toString?.() ?? 0);
}

export function decodeEnvelope(buffer: Buffer): DebugEnvelope {
  const decoded = DebugMessage.toObject(DebugMessage.decode(buffer), {
    bytes: Buffer,
    longs: String,
    defaults: true,
  }) as Record<string, unknown>;
  let data = Buffer.from(decoded.data as Uint8Array);
  const compressAlgo = asNumber(decoded.compressAlgo);
  if (data.length > 0 && (compressAlgo & 1) !== 0) data = zlib.inflateSync(data);
  return {
    seq: asNumber(decoded.seq),
    after: asNumber(decoded.after),
    category: String(decoded.category ?? ''),
    data,
    compressAlgo,
    originalSize: asNumber(decoded.originalSize),
  };
}

export function decodeCdpPayload(data: Buffer): CdpPayload {
  const decoded = ChromeDevtools.toObject(ChromeDevtools.decode(data), { longs: String, defaults: true }) as Record<string, unknown>;
  return {
    opId: String(decoded.opId ?? '0'),
    payload: String(decoded.payload ?? ''),
    jscontextId: String(decoded.jscontextId ?? ''),
  };
}

export function decodeContext(category: string, data: Buffer): { id: string; name?: string } | null {
  if (category === 'addJsContext') {
    const decoded = AddJsContext.toObject(AddJsContext.decode(data), { defaults: true }) as Record<string, unknown>;
    return { id: String(decoded.jscontextId ?? ''), name: String(decoded.jscontextName ?? '') };
  }
  if (category === 'removeJsContext') {
    const decoded = RemoveJsContext.toObject(RemoveJsContext.decode(data), { defaults: true }) as Record<string, unknown>;
    return { id: String(decoded.jscontextId ?? '') };
  }
  return null;
}

export function encodeCdpEnvelope(seq: number, payload: string, jscontextId = ''): Buffer {
  return encodeCdpMessage('chromeDevtools', seq, payload, jscontextId);
}

export function encodeCdpResultEnvelope(seq: number, payload: string, jscontextId = ''): Buffer {
  return encodeCdpMessage('chromeDevtoolsResult', seq, payload, jscontextId);
}

function encodeCdpMessage(category: 'chromeDevtools' | 'chromeDevtoolsResult', seq: number, payload: string, jscontextId: string): Buffer {
  const inner = Buffer.from(
    ChromeDevtools.encode(
      ChromeDevtools.create({ opId: BigInt(seq).toString(), payload, jscontextId }),
    ).finish(),
  );
  return Buffer.from(
    DebugMessage.encode(
      DebugMessage.create({
        seq,
        after: 0,
        category,
        data: inner,
        compressAlgo: 0,
        originalSize: 0,
      }),
    ).finish(),
  );
}
