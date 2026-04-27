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
  recordingSignalData: SignalPoint[];
  signalSourceMode: SignalSourceMode;
  connectGanglion: () => Promise<void>;
  useMockSignal: () => Promise<void>;
  liveConnectionStatus: LiveConnectionStatus;
  liveConnectionMessage: string;
  liveDeviceName: string | null;
  livePacketCount: number;
  isBluetoothAvailable: boolean;
};

const EMG_SIGNAL_MULTIPLIER = 10_000_000;
const LIVE_RENDER_INTERVAL_MS = 100;
const FEATURE_WINDOW_MS = 75;
const FEATURE_SIGNAL_SCALE = 30000;
const DISPLAY_WINDOW_MS = 3000;
const RECORDING_WINDOW_MS = 5000;

const clampSignalValue = (value: number) => Math.max(0, Math.min(1, value));
const trimPointsToTimeWindow = (points: SignalPoint[], windowMs: number) => {
  if (points.length === 0) {
    return points;
  }

  const newestTime = points[points.length - 1].time;
  const cutoffTime = newestTime - windowMs;
  return points.filter((point) => point.time >= cutoffTime);
};

export function useSignalSource(generateMockSignalValue: () => number): UseSignalSourceResult {
  const [signalData, setSignalData] = useState<SignalPoint[]>([]);
  const [recordingSignalData, setRecordingSignalData] = useState<SignalPoint[]>([]);
  const [signalSourceMode, setSignalSourceMode] = useState<SignalSourceMode>('mock');
  const [liveConnectionStatus, setLiveConnectionStatus] = useState<LiveConnectionStatus>('disconnected');
  const [liveConnectionMessage, setLiveConnectionMessage] = useState('Mock signal active');
  const [liveDeviceName, setLiveDeviceName] = useState<string | null>(null);
  const [livePacketCount, setLivePacketCount] = useState(0);
  const ganglionRef = useRef<GanglionConnection | null>(null);
  const featureWindowRef = useRef<{ time: number; value: number }[]>([]);
  const pendingRecordingPointsRef = useRef<SignalPoint[]>([]);

  const pushMockSignalPoint = useCallback((point: SignalPoint) => {
    setRecordingSignalData(prev => trimPointsToTimeWindow([...prev, point], RECORDING_WINDOW_MS));
    setSignalData(prev => trimPointsToTimeWindow([...prev, point], DISPLAY_WINDOW_MS));
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
    setSignalData([]);
    setRecordingSignalData([]);
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
      setRecordingSignalData([]);
      setLivePacketCount(0);
      setLiveDeviceName(null);
      featureWindowRef.current = [];
      pendingRecordingPointsRef.current = [];
      setLiveConnectionStatus('connecting');
      setLiveConnectionMessage('Choose your Ganglion in the Bluetooth prompt.');

      const connection = await connectGanglionDevice();
      ganglionRef.current = connection;
      setLiveDeviceName(connection.deviceName);
      setLiveConnectionStatus('connected');
      setLiveConnectionMessage('Connected. Starting stream...');

      connection.onSample((sample) => {
        const rawSample = sample.data[0] ?? 0;
        const scaledRawSample = rawSample * EMG_SIGNAL_MULTIPLIER;
        featureWindowRef.current.push({
          time: sample.timestamp,
          value: scaledRawSample
        });
        featureWindowRef.current = featureWindowRef.current.filter((point) => (
          point.time >= sample.timestamp - FEATURE_WINDOW_MS
        ));

        const rms = Math.sqrt(
          featureWindowRef.current.reduce((sum, point) => sum + point.value * point.value, 0) /
            Math.max(featureWindowRef.current.length, 1)
        );
        const featureValue = Math.max(0, rms / FEATURE_SIGNAL_SCALE);

        setLivePacketCount(count => count + 1);
        pendingRecordingPointsRef.current.push({
          time: sample.timestamp,
          value: featureValue,
          raw: rawSample,
          envelope: featureValue,
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
  }, [disconnectGanglion]);

  useEffect(() => {
    if (signalSourceMode !== 'mock') {
      return;
    }

    const interval = setInterval(() => {
      const value = clampSignalValue(generateMockSignalValue());
      pushMockSignalPoint({
        time: Date.now(),
        value,
        raw: value,
        envelope: value,
      });
    }, 50);

    return () => clearInterval(interval);
  }, [generateMockSignalValue, pushMockSignalPoint, signalSourceMode]);

  useEffect(() => {
    if (signalSourceMode !== 'live') {
      pendingRecordingPointsRef.current = [];
      return;
    }

    const interval = window.setInterval(() => {
      if (pendingRecordingPointsRef.current.length === 0) {
        return;
      }

      const pending = pendingRecordingPointsRef.current;
      pendingRecordingPointsRef.current = [];

      setRecordingSignalData(prev => trimPointsToTimeWindow([...prev, ...pending], RECORDING_WINDOW_MS));
      setSignalData(prev => trimPointsToTimeWindow([...prev, ...pending], DISPLAY_WINDOW_MS));
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
    recordingSignalData,
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
