import { useCallback, useEffect, useRef, useState } from 'react';
import { connectGanglion as connectGanglionDevice, isWebBluetoothAvailable, type GanglionConnection } from './ganglion';

export type SignalPoint = {
  time: number;
  value: number;
};

export type SignalSourceMode = 'mock' | 'live';

export type LiveConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'streaming' | 'error';

type UseSignalSourceResult = {
  signalData: SignalPoint[];
  signalSourceMode: SignalSourceMode;
  connectGanglion: () => Promise<void>;
  useMockSignal: () => Promise<void>;
  liveConnectionStatus: LiveConnectionStatus;
  liveConnectionMessage: string;
  liveDeviceName: string | null;
  livePacketCount: number;
  isBluetoothAvailable: boolean;
};

const MAX_SIGNAL_POINTS = 100;
const LIVE_BASELINE = 0.12;
const LIVE_GAIN = 0.7;
const LIVE_SMOOTHING = 0.2;
const LIVE_ENVELOPE_SCALE_COUNTS = 600000;
const LIVE_BASELINE_SMOOTHING = 0.01;

const clampSignalValue = (value: number) => Math.max(0, Math.min(1, value));

export function useSignalSource(generateMockSignalValue: () => number): UseSignalSourceResult {
  const [signalData, setSignalData] = useState<SignalPoint[]>([]);
  const [signalSourceMode, setSignalSourceMode] = useState<SignalSourceMode>('mock');
  const [liveConnectionStatus, setLiveConnectionStatus] = useState<LiveConnectionStatus>('disconnected');
  const [liveConnectionMessage, setLiveConnectionMessage] = useState('Mock signal active');
  const [liveDeviceName, setLiveDeviceName] = useState<string | null>(null);
  const [livePacketCount, setLivePacketCount] = useState(0);
  const ganglionRef = useRef<GanglionConnection | null>(null);
  const liveLevelRef = useRef(LIVE_BASELINE);
  const liveRawBaselineRef = useRef<number | null>(null);

  const pushSignalPoint = useCallback((point: SignalPoint) => {
    setSignalData(prev => [...prev, point].slice(-MAX_SIGNAL_POINTS));
  }, []);

  const disconnectGanglion = useCallback(async () => {
    const connection = ganglionRef.current;
    ganglionRef.current = null;

    if (!connection) {
      return;
    }

    try {
      await connection.stopStreaming();
    } catch {
      // Ignore stop errors when the board has already disconnected.
    }

    connection.disconnect();
  }, []);

  const useMockSignal = useCallback(async () => {
    await disconnectGanglion();
    setSignalSourceMode('mock');
    setLiveConnectionStatus('disconnected');
    setLiveConnectionMessage('Mock signal active');
    setLiveDeviceName(null);
    setLivePacketCount(0);
  }, [disconnectGanglion]);

  const connectGanglion = useCallback(async () => {
    if (!isWebBluetoothAvailable()) {
      setLiveConnectionStatus('error');
      setLiveConnectionMessage('Web Bluetooth needs Chrome or Edge on localhost/HTTPS.');
      return;
    }

    await disconnectGanglion();

    try {
      setSignalSourceMode('live');
      setSignalData([]);
      setLivePacketCount(0);
      setLiveDeviceName(null);
      liveLevelRef.current = LIVE_BASELINE;
      liveRawBaselineRef.current = null;
      setLiveConnectionStatus('connecting');
      setLiveConnectionMessage('Choose your Ganglion in the Bluetooth prompt.');

      const connection = await connectGanglionDevice();
      ganglionRef.current = connection;
      setLiveDeviceName(connection.deviceName);
      setLiveConnectionStatus('connected');
      setLiveConnectionMessage('Connected. Starting stream...');

      connection.onPacket((packet) => {
        const channelZeroSamples = packet.channelSamples.filter((_, index) => index % 4 === 0);
        const rawSample = channelZeroSamples.length > 0
          ? channelZeroSamples.reduce((sum, sample) => sum + sample, 0) / channelZeroSamples.length
          : packet.level * LIVE_ENVELOPE_SCALE_COUNTS;

        if (liveRawBaselineRef.current === null) {
          liveRawBaselineRef.current = rawSample;
        }

        liveRawBaselineRef.current += (rawSample - liveRawBaselineRef.current) * LIVE_BASELINE_SMOOTHING;

        const envelope = Math.abs(rawSample - liveRawBaselineRef.current) / LIVE_ENVELOPE_SCALE_COUNTS;
        const targetLevel = clampSignalValue(LIVE_BASELINE + envelope * LIVE_GAIN);
        liveLevelRef.current = liveLevelRef.current + (targetLevel - liveLevelRef.current) * LIVE_SMOOTHING;

        setLivePacketCount(count => count + 1);
        pushSignalPoint({
          time: Date.now(),
          value: clampSignalValue(liveLevelRef.current)
        });
      });

      connection.onDisconnected(() => {
        if (ganglionRef.current === connection) {
          ganglionRef.current = null;
        }

        setSignalSourceMode('mock');
        setLiveConnectionStatus('disconnected');
        setLiveConnectionMessage('Ganglion disconnected. Mock signal resumed.');
        setLiveDeviceName(null);
      });

      await connection.startStreaming();
      setLiveConnectionStatus('streaming');
      setLiveConnectionMessage('Live Ganglion stream active.');
    } catch (error) {
      await disconnectGanglion();
      setSignalSourceMode('mock');
      setLiveConnectionStatus('error');
      setLiveConnectionMessage(error instanceof Error ? error.message : 'Unable to connect to Ganglion.');
      setLiveDeviceName(null);
    }
  }, [disconnectGanglion, pushSignalPoint]);

  useEffect(() => {
    if (signalSourceMode !== 'mock') {
      return;
    }

    const interval = setInterval(() => {
      pushSignalPoint({
        time: Date.now(),
        value: clampSignalValue(generateMockSignalValue())
      });
    }, 50);

    return () => clearInterval(interval);
  }, [generateMockSignalValue, pushSignalPoint, signalSourceMode]);

  useEffect(() => {
    return () => {
      void disconnectGanglion();
    };
  }, [disconnectGanglion]);

  return {
    signalData,
    signalSourceMode,
    connectGanglion,
    useMockSignal,
    liveConnectionStatus,
    liveConnectionMessage,
    liveDeviceName,
    livePacketCount,
    isBluetoothAvailable: isWebBluetoothAvailable()
  };
}
