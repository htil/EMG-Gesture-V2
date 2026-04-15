import OpenBCIUtilities from '@openbci/utilities/dist/openbci-utilities.js';
import { Buffer } from 'buffer';

const { constants, utilities } = OpenBCIUtilities as {
  constants: {
    numberOfChannelsForBoardType: (boardName: string) => number;
    rawDataToSampleObjectDefault: (channelCount: number) => {
      rawDataPacket?: Buffer;
      [key: string]: unknown;
    };
  };
  utilities: {
    parseGanglion: (rawDataPacketToSample: { rawDataPacket?: Buffer }) => Array<{
      sampleNumber?: number;
      timestamp?: number;
      channelData?: number[];
      accelData?: number[];
    }>;
  };
};

const GANGLION_SERVICE_UUID = '0000fe84-0000-1000-8000-00805f9b34fb';
const GANGLION_RECEIVE_UUID = '2d30c082-f39f-4ce6-923f-3484ea480596';
const GANGLION_SEND_UUID = '2d30c083-f39f-4ce6-923f-3484ea480596';
const START_STREAM_COMMAND = 'b';
const STOP_STREAM_COMMAND = 's';
const BOARD_NAME = 'ganglion';

export interface GanglionPacket {
  packetId: number;
  level: number;
  bytes: Uint8Array;
  channelSamples: number[];
}

export interface GanglionSample {
  packetId: number;
  timestamp: number;
  data: number[];
}

export interface GanglionConnection {
  deviceName: string;
  startStreaming: () => Promise<void>;
  stopStreaming: () => Promise<void>;
  disconnect: () => void;
  onPacket: (callback: (packet: GanglionPacket) => void) => void;
  onSample: (callback: (sample: GanglionSample) => void) => void;
  onDisconnected: (callback: () => void) => void;
}

type PacketListener = (packet: GanglionPacket) => void;
type SampleListener = (sample: GanglionSample) => void;

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
const channelCount = constants.numberOfChannelsForBoardType(BOARD_NAME);

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
  const sampleListeners = new Set<SampleListener>();
  const disconnectedListeners = new Set<() => void>();
  const rawDataPacketToSample = constants.rawDataToSampleObjectDefault(channelCount);
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(GANGLION_SERVICE_UUID);
  const receiveCharacteristic = await service.getCharacteristic(GANGLION_RECEIVE_UUID);
  const sendCharacteristic = await service.getCharacteristic(GANGLION_SEND_UUID);

  receiveCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
    const characteristic = event.target as BluetoothRemoteGATTCharacteristic;
    const bytes = dataViewToBytes(characteristic.value);

    if (!bytes) {
      return;
    }

    const parsedSamples = parseSamples(bytes, rawDataPacketToSample);
    const packet = packetFromBytes(bytes, parsedSamples);

    listeners.forEach((listener) => listener(packet));
    parsedSamples.forEach((sample) => {
      sampleListeners.forEach((listener) => listener(sample));
    });
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
    onSample: (callback) => {
      sampleListeners.add(callback);
    },
    onDisconnected: (callback) => {
      disconnectedListeners.add(callback);
    },
  };
}

function dataViewToBytes(value?: DataView) {
  if (!value || value.byteLength === 0) {
    return null;
  }

  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

function parseSamples(
  bytes: Uint8Array,
  rawDataPacketToSample: { rawDataPacket?: Buffer }
): GanglionSample[] {
  rawDataPacketToSample.rawDataPacket = Buffer.from(bytes);

  return utilities.parseGanglion(rawDataPacketToSample)
    .map((sample) => renameDataProp(sample, bytes[0]))
    .filter((sample): sample is GanglionSample => sample.data.length > 0);
}

function renameDataProp(
  sample: {
    sampleNumber?: number;
    timestamp?: number;
    channelData?: number[];
  },
  packetId: number
): GanglionSample {
  return {
    packetId: sample.sampleNumber ?? packetId,
    timestamp: sample.timestamp ?? Date.now(),
    data: sample.channelData ?? [],
  };
}

function packetFromBytes(bytes: Uint8Array, parsedSamples: GanglionSample[]): GanglionPacket {
  const channelSamples = parsedSamples.flatMap((sample) => sample.data);

  return {
    packetId: bytes[0],
    level: estimateDisplayLevel(parsedSamples),
    bytes,
    channelSamples,
  };
}

function estimateDisplayLevel(samples: GanglionSample[]) {
  if (samples.length === 0) {
    return 0;
  }

  const channelZeroSamples = samples
    .map((sample) => sample.data[0] ?? 0)
    .filter((value) => Number.isFinite(value));

  if (channelZeroSamples.length === 0) {
    return 0;
  }

  const meanAbs = channelZeroSamples.reduce((sum, sample) => sum + Math.abs(sample), 0) / channelZeroSamples.length;
  return clamp01(meanAbs / 0.0002);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
