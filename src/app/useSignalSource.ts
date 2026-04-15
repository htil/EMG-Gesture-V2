import { useCallback, useEffect, useRef, useState } from 'react';
import { connectGanglion as connectGanglionDevice, isWebBluetoothAvailable, type GanglionConnection } from './ganglion';

export type SignalPoint = {
  time: number;
  value: number;
  raw: number;
  envelope: number;
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

const MAX_SIGNAL_POINTS = 512;
const EMG_SIGNAL_MULTIPLIER = 10_000_000;
const LIVE_FILTER_CUTOFF_HZ = 3;
const LIVE_RENDER_INTERVAL_MS = 100;
const LIVE_PEAK_DECAY = 0.995;

const clampSignalValue = (value: number) => Math.max(0, Math.min(1, value));
const getLowPassAlpha = (deltaMs: number) => {
  const safeDeltaMs = Math.max(1, deltaMs);
  const dt = safeDeltaMs / 1000;
  const rc = 1 / (2 * Math.PI * LIVE_FILTER_CUTOFF_HZ);
  return dt / (rc + dt);
};

export function useSignalSource(generateMockSignalValue: () => number): UseSignalSourceResult {
  const [signalData, setSignalData] = useState<SignalPoint[]>([]);
  const [signalSourceMode, setSignalSourceMode] = useState<SignalSourceMode>('mock');
  const [liveConnectionStatus, setLiveConnectionStatus] = useState<LiveConnectionStatus>('disconnected');
  const [liveConnectionMessage, setLiveConnectionMessage] = useState('Mock signal active');
  const [liveDeviceName, setLiveDeviceName] = useState<string | null>(null);
  const [livePacketCount, setLivePacketCount] = useState(0);
  const ganglionRef = useRef<GanglionConnection | null>(null);
  const liveFilteredRef = useRef(0);
  const livePeakRef = useRef(1);
  const liveLastTimestampRef = useRef<number | null>(null);
  const pendingLivePointsRef = useRef<SignalPoint[]>([]);

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
      liveFilteredRef.current = 0;
      livePeakRef.current = 1;
      liveLastTimestampRef.current = null;
      pendingLivePointsRef.current = [];
      setLiveConnectionStatus('connecting');
      setLiveConnectionMessage('Choose your Ganglion in the Bluetooth prompt.');

      const connection = await connectGanglionDevice();
      ganglionRef.current = connection;
      setLiveDeviceName(connection.deviceName);
      setLiveConnectionStatus('connected');
      setLiveConnectionMessage('Connected. Starting stream...');

      connection.onSample((sample) => {
        const rawSample = sample.data[0] ?? 0;
        const rectified = Math.abs(rawSample * EMG_SIGNAL_MULTIPLIER);
        const previousTimestamp = liveLastTimestampRef.current;
        const deltaMs = previousTimestamp === null ? 5 : sample.timestamp - previousTimestamp;
        const alpha = getLowPassAlpha(deltaMs);
        liveLastTimestampRef.current = sample.timestamp;

        liveFilteredRef.current += (rectified - liveFilteredRef.current) * alpha;
        livePeakRef.current = Math.max(liveFilteredRef.current, livePeakRef.current * LIVE_PEAK_DECAY);

        const normalizedValue = clampSignalValue(
          liveFilteredRef.current / Math.max(livePeakRef.current, 1)
        );

        setLivePacketCount(count => count + 1);
        pendingLivePointsRef.current.push({
          time: sample.timestamp,
          value: normalizedValue,
          raw: rawSample,
          envelope: normalizedValue
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
      const value = clampSignalValue(generateMockSignalValue());
      pushSignalPoint({
        time: Date.now(),
        value,
        raw: value,
        envelope: value,
      });
    }, 50);

    return () => clearInterval(interval);
  }, [generateMockSignalValue, pushSignalPoint, signalSourceMode]);

  useEffect(() => {
    if (signalSourceMode !== 'live') {
      pendingLivePointsRef.current = [];
      return;
    }

    const interval = window.setInterval(() => {
      if (pendingLivePointsRef.current.length === 0) {
        return;
      }

      const pending = pendingLivePointsRef.current;
      pendingLivePointsRef.current = [];
      setSignalData(prev => [...prev, ...pending].slice(-MAX_SIGNAL_POINTS));
    }, LIVE_RENDER_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [signalSourceMode]);

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
