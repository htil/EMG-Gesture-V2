const GANGLION_SERVICE_UUID = '0000fe84-0000-1000-8000-00805f9b34fb';
const GANGLION_RECEIVE_UUID = '2d30c082-f39f-4ce6-923f-3484ea480596';
const GANGLION_SEND_UUID = '2d30c083-f39f-4ce6-923f-3484ea480596';
const START_STREAM_COMMAND = 'b';
const STOP_STREAM_COMMAND = 's';

export interface GanglionPacket {
  packetId: number;
  level: number;
  bytes: Uint8Array;
  channelSamples: number[];
}

export interface GanglionConnection {
  deviceName: string;
  startStreaming: () => Promise<void>;
  stopStreaming: () => Promise<void>;
  disconnect: () => void;
  onPacket: (callback: (packet: GanglionPacket) => void) => void;
  onDisconnected: (callback: () => void) => void;
}

type PacketListener = (packet: GanglionPacket) => void;

declare global {
  interface Navigator {
    bluetooth?: Bluetooth;
  }

  interface Bluetooth {
    requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
  }

  interface BluetoothDevice extends EventTarget {
    readonly name?: string;
    readonly gatt?: BluetoothRemoteGATTServer;
  }

  interface BluetoothRemoteGATTServer {
    readonly connected: boolean;
    connect(): Promise<BluetoothRemoteGATTServer>;
    disconnect(): void;
    getPrimaryService(service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService>;
  }

  interface BluetoothRemoteGATTService {
    getCharacteristic(characteristic: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic>;
  }

  interface BluetoothRemoteGATTCharacteristic extends EventTarget {
    readonly value?: DataView;
    startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
    writeValue(value: BufferSource): Promise<void>;
  }

  type BluetoothServiceUUID = number | string;
  type BluetoothCharacteristicUUID = number | string;

  interface RequestDeviceOptions {
    filters?: BluetoothLEScanFilter[];
    optionalServices?: BluetoothServiceUUID[];
  }

  interface BluetoothLEScanFilter {
    name?: string;
    namePrefix?: string;
    services?: BluetoothServiceUUID[];
  }
}

const textEncoder = new TextEncoder();

export function isWebBluetoothAvailable() {
  return typeof navigator !== 'undefined' && Boolean(navigator.bluetooth);
}

export async function connectGanglion(): Promise<GanglionConnection> {
  if (!navigator.bluetooth) {
    throw new Error('Web Bluetooth is not available. Use Chrome or Edge on localhost/HTTPS.');
  }

  const device = await navigator.bluetooth.requestDevice({
    filters: [
      { services: [GANGLION_SERVICE_UUID] },
      { namePrefix: 'Ganglion' },
      { namePrefix: 'OpenBCI' },
    ],
    optionalServices: [GANGLION_SERVICE_UUID],
  });

  if (!device.gatt) {
    throw new Error('The selected Bluetooth device did not expose a GATT server.');
  }

  const listeners = new Set<PacketListener>();
  const disconnectedListeners = new Set<() => void>();
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(GANGLION_SERVICE_UUID);
  const receiveCharacteristic = await service.getCharacteristic(GANGLION_RECEIVE_UUID);
  const sendCharacteristic = await service.getCharacteristic(GANGLION_SEND_UUID);

  receiveCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
    const characteristic = event.target as BluetoothRemoteGATTCharacteristic;
    const packet = packetFromDataView(characteristic.value);

    if (!packet) {
      return;
    }

    listeners.forEach((listener) => listener(packet));
  });

  device.addEventListener('gattserverdisconnected', () => {
    disconnectedListeners.forEach((listener) => listener());
  });

  await receiveCharacteristic.startNotifications();

  const writeCommand = (command: string) => sendCharacteristic.writeValue(textEncoder.encode(command));

  return {
    deviceName: device.name ?? 'OpenBCI Ganglion',
    startStreaming: () => writeCommand(START_STREAM_COMMAND),
    stopStreaming: () => writeCommand(STOP_STREAM_COMMAND),
    disconnect: () => {
      if (server.connected) {
        server.disconnect();
      }
    },
    onPacket: (callback) => {
      listeners.add(callback);
    },
    onDisconnected: (callback) => {
      disconnectedListeners.add(callback);
    },
  };
}

function packetFromDataView(value?: DataView): GanglionPacket | null {
  if (!value || value.byteLength === 0) {
    return null;
  }

  const bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));

  return {
    packetId: bytes[0],
    level: estimateDisplayLevel(bytes),
    bytes,
    channelSamples: decodeChannelSamples(bytes),
  };
}

function estimateDisplayLevel(bytes: Uint8Array) {
  const samples = decodeChannelSamples(bytes);

  if (samples.length > 0) {
    const channelZeroSamples = samples.filter((_, index) => index % 4 === 0);
    const meanAbs = channelZeroSamples.reduce((sum, sample) => sum + Math.abs(sample), 0) / channelZeroSamples.length;

    return clamp01(meanAbs / 2000000);
  }

  return 0;
}

function decodeChannelSamples(bytes: Uint8Array) {
  const packetId = bytes[0];

  if (packetId === 0 && bytes.length >= 13) {
    return [1, 4, 7, 10].map((offset) => readSigned24(bytes, offset));
  }

  if (packetId >= 101 && packetId <= 200) {
    return unpackCompressedSamples(bytes.slice(1), 19, 5);
  }

  if (packetId >= 1 && packetId <= 100) {
    return unpackCompressedSamples(bytes.slice(1, 19), 18, 6);
  }

  return [];
}

function unpackCompressedSamples(payload: Uint8Array, bitsPerSample: number, restoreShift: number) {
  const samples: number[] = [];
  const expectedSampleCount = Math.floor((payload.length * 8) / bitsPerSample);

  for (let sampleIndex = 0; sampleIndex < expectedSampleCount; sampleIndex += 1) {
    const packedSample = readBits(payload, sampleIndex * bitsPerSample, bitsPerSample);
    const signBit = packedSample & 1;
    const magnitudeBits = packedSample >> 1;
    const restored = (signBit << (bitsPerSample - 1)) | magnitudeBits;
    samples.push(signExtend(restored, bitsPerSample) << restoreShift);
  }

  return samples;
}

function readBits(bytes: Uint8Array, bitOffset: number, bitLength: number) {
  let value = 0;

  for (let bitIndex = 0; bitIndex < bitLength; bitIndex += 1) {
    const absoluteBit = bitOffset + bitIndex;
    const byte = bytes[Math.floor(absoluteBit / 8)];
    const bit = (byte >> (7 - (absoluteBit % 8))) & 1;
    value = (value << 1) | bit;
  }

  return value;
}

function signExtend(value: number, bitLength: number) {
  const signMask = 1 << (bitLength - 1);
  return (value & signMask) ? value - (1 << bitLength) : value;
}

function readSigned24(bytes: Uint8Array, offset: number) {
  let value = (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];

  if (value & 0x800000) {
    value -= 0x1000000;
  }

  return value;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
