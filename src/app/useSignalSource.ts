import { useCallback, useEffect, useRef, useState } from 'react';
import { connectGanglion as connectGanglionDevice, isWebBluetoothAvailable, type GanglionConnection } from './ganglion';

export type SignalPoint = {
  time: number;
  value: number;
  raw: number;
  activityEnvelope: number;
  normalizedActivity: number;
};

export type SignalSourceMode = 'mock' | 'live';

export type LiveConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'streaming' | 'error';

type UseSignalSourceResult = {
  signalData: SignalPoint[];
  recordingSignalData: SignalPoint[];
  signalSourceMode: SignalSourceMode;
  isStreaming: boolean;
  selectSignalSourceMode: (mode: SignalSourceMode) => Promise<void>;
  startStream: () => Promise<void>;
  startStreamForMode: (mode: SignalSourceMode) => Promise<void>;
  stopStream: () => Promise<void>;
  liveConnectionStatus: LiveConnectionStatus;
  liveConnectionMessage: string;
  liveDeviceName: string | null;
  livePacketCount: number;
  liveDisplayScale: number;
  liveSampleRateHz: number;
  isBluetoothAvailable: boolean;
};

const EMG_SIGNAL_MULTIPLIER = 10_000_000;
const LIVE_RENDER_INTERVAL_MS = 100;
const FEATURE_WINDOW_MS = 75;
const FEATURE_SIGNAL_SCALE = 30000;
const RECORDING_WINDOW_MS = 5000;
const ACTIVITY_REFERENCE_WINDOW_MS = 8000;
const BASELINE_PERCENTILE = 0.2;
const ACTIVE_REFERENCE_PERCENTILE = 0.98;
const MIN_ACTIVITY_RANGE = 0.12;
const BASELINE_SMOOTHING = 0.15;
const ACTIVE_REFERENCE_SMOOTHING = 0.18;
const ACTIVE_REFERENCE_HEADROOM = 1.1;

const clampSignalValue = (value: number) => Math.max(0, Math.min(1, value));
const trimPointsToTimeWindow = (points: SignalPoint[], windowMs: number) => {
  if (points.length === 0) {
    return points;
  }

  const newestTime = points[points.length - 1].time;
  const cutoffTime = newestTime - windowMs;
  return points.filter((point) => point.time >= cutoffTime);
};

const getPercentile = (values: number[], percentile: number) => {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentile) - 1)
  );
  return sorted[index];
};

export function useSignalSource(
  generateMockSignalValue: () => number,
  displayWindowMs: number = 3000,
  selectedChannelIndex: number = 0,
  displaySensitivity: number = 1
): UseSignalSourceResult {
  const [signalData, setSignalData] = useState<SignalPoint[]>([]);
  const [recordingSignalData, setRecordingSignalData] = useState<SignalPoint[]>([]);
  const [signalSourceMode, setSignalSourceMode] = useState<SignalSourceMode>('mock');
  const [isStreaming, setIsStreaming] = useState(false);
  const [liveConnectionStatus, setLiveConnectionStatus] = useState<LiveConnectionStatus>('disconnected');
  const [liveConnectionMessage, setLiveConnectionMessage] = useState('Idle. Select a source and start stream.');
  const [liveDeviceName, setLiveDeviceName] = useState<string | null>(null);
  const [livePacketCount, setLivePacketCount] = useState(0);
  const [liveDisplayScale, setLiveDisplayScale] = useState(1);
  const [liveSampleRateHz, setLiveSampleRateHz] = useState(0);
  const ganglionRef = useRef<GanglionConnection | null>(null);
  const featureWindowRef = useRef<{ time: number; value: number }[]>([]);
  const activityReferenceWindowRef = useRef<{ time: number; value: number }[]>([]);
  const pendingRecordingPointsRef = useRef<SignalPoint[]>([]);
  const activityBaselineRef = useRef(0);
  const activityUpperReferenceRef = useRef(MIN_ACTIVITY_RANGE);
  const selectedChannelIndexRef = useRef(selectedChannelIndex);
  const sampleRateTimesRef = useRef<number[]>([]);
  const displaySensitivityRef = useRef(displaySensitivity);

  useEffect(() => {
    displaySensitivityRef.current = displaySensitivity;
  }, [displaySensitivity]);

  useEffect(() => {
    selectedChannelIndexRef.current = selectedChannelIndex;
    featureWindowRef.current = [];
    activityReferenceWindowRef.current = [];
    pendingRecordingPointsRef.current = [];
    sampleRateTimesRef.current = [];
    activityBaselineRef.current = 0;
    activityUpperReferenceRef.current = MIN_ACTIVITY_RANGE;
    setLiveDisplayScale(1);
    setLiveSampleRateHz(0);

    if (signalSourceMode === 'live') {
      setSignalData([]);
      setRecordingSignalData([]);
    }
  }, [selectedChannelIndex, signalSourceMode]);

  const pushMockSignalPoint = useCallback((point: SignalPoint) => {
    setRecordingSignalData(prev => trimPointsToTimeWindow([...prev, point], RECORDING_WINDOW_MS));
    setSignalData(prev => trimPointsToTimeWindow([...prev, point], displayWindowMs));
  }, [displayWindowMs]);

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

  const resetDisplayState = useCallback(() => {
    setSignalData([]);
    setRecordingSignalData([]);
    setLivePacketCount(0);
    setLiveSampleRateHz(0);
    activityBaselineRef.current = 0;
    activityUpperReferenceRef.current = MIN_ACTIVITY_RANGE;
    setLiveDisplayScale(1);
    featureWindowRef.current = [];
    activityReferenceWindowRef.current = [];
    pendingRecordingPointsRef.current = [];
    sampleRateTimesRef.current = [];
  }, []);

  const selectSignalSourceMode = useCallback(async (mode: SignalSourceMode) => {
    await disconnectGanglion();
    setIsStreaming(false);
    setSignalSourceMode(mode);
    resetDisplayState();
    setLiveConnectionStatus('disconnected');
    setLiveDeviceName(null);
    setLiveConnectionMessage(
      mode === 'mock'
        ? 'Mock selected. Click Start Stream to begin.'
        : 'Live selected. Click Start Stream to connect.'
    );
  }, [disconnectGanglion, resetDisplayState]);

  const startMockStream = useCallback(async () => {
    await disconnectGanglion();
    resetDisplayState();
    setSignalSourceMode('mock');
    setIsStreaming(true);
    setLiveConnectionStatus('disconnected');
    setLiveConnectionMessage('Mock signal active');
    setLiveDeviceName(null);
  }, [disconnectGanglion, resetDisplayState]);

  const connectGanglion = useCallback(async () => {
    if (!isWebBluetoothAvailable()) {
      setLiveConnectionStatus('error');
      setLiveConnectionMessage('Web Bluetooth needs Chrome or Edge on localhost/HTTPS.');
      return;
    }

    await disconnectGanglion();

    try {
      setSignalSourceMode('live');
      resetDisplayState();
      setLiveDeviceName(null);
      setLiveConnectionStatus('connecting');
      setLiveConnectionMessage('Choose your Ganglion in the Bluetooth prompt.');

      const connection = await connectGanglionDevice();
      ganglionRef.current = connection;
      setLiveDeviceName(connection.deviceName);
      setLiveConnectionStatus('connected');
      setLiveConnectionMessage('Connected. Starting stream...');

      connection.onSample((sample) => {
        const rawSample = sample.data[selectedChannelIndexRef.current] ?? 0;
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
        const activityEnvelope = Math.max(0, rms / FEATURE_SIGNAL_SCALE);

        setLivePacketCount(count => count + 1);
        sampleRateTimesRef.current.push(sample.timestamp);
        sampleRateTimesRef.current = sampleRateTimesRef.current.filter((time) => time >= sample.timestamp - 1000);
        pendingRecordingPointsRef.current.push({
          time: sample.timestamp,
          value: activityEnvelope,
          raw: rawSample,
          activityEnvelope,
          normalizedActivity: 0,
        });
      });

      connection.onDisconnected(() => {
        if (ganglionRef.current === connection) {
          ganglionRef.current = null;
        }

        setIsStreaming(false);
        setLiveConnectionStatus('disconnected');
        setLiveConnectionMessage('Ganglion disconnected.');
        setLiveDeviceName(null);
      });

      await connection.startStreaming();
      setIsStreaming(true);
      setLiveConnectionStatus('streaming');
      setLiveConnectionMessage('Live Ganglion stream active.');
    } catch (error) {
      await disconnectGanglion();
      setIsStreaming(false);
      setLiveConnectionStatus('error');
      setLiveConnectionMessage(error instanceof Error ? error.message : 'Unable to connect to Ganglion.');
      setLiveDeviceName(null);
    }
  }, [disconnectGanglion, resetDisplayState]);

  const startStreamForMode = useCallback(async (mode: SignalSourceMode) => {
    if (mode === 'live') {
      await connectGanglion();
      return;
    }

    await startMockStream();
  }, [connectGanglion, startMockStream]);

  const startStream = useCallback(async () => {
    await startStreamForMode(signalSourceMode);
  }, [signalSourceMode, startStreamForMode]);

  const stopStream = useCallback(async () => {
    await disconnectGanglion();
    setIsStreaming(false);
    resetDisplayState();
    setLiveConnectionStatus('disconnected');
    setLiveDeviceName(null);
    setLiveConnectionMessage(
      signalSourceMode === 'live'
        ? 'Live stream stopped.'
        : 'Mock stream stopped.'
    );
  }, [disconnectGanglion, resetDisplayState, signalSourceMode]);

  useEffect(() => {
    if (signalSourceMode !== 'mock' || !isStreaming) {
      return;
    }

    const interval = setInterval(() => {
      const value = clampSignalValue(generateMockSignalValue());
      pushMockSignalPoint({
        time: Date.now(),
        value,
        raw: value,
        activityEnvelope: value,
        normalizedActivity: value,
      });
    }, 50);

    return () => clearInterval(interval);
  }, [generateMockSignalValue, isStreaming, pushMockSignalPoint, signalSourceMode]);

  useEffect(() => {
    if (signalSourceMode !== 'live' || !isStreaming) {
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
      setSignalData(prev => {
        const trimmedPreviousPoints = trimPointsToTimeWindow(prev, displayWindowMs);
        activityReferenceWindowRef.current = trimPointsToTimeWindow(
          [...activityReferenceWindowRef.current, ...pending.map((point) => ({
            time: point.time,
            value: point.activityEnvelope,
          }))],
          ACTIVITY_REFERENCE_WINDOW_MS,
        );

        const recentEnvelopeValues = activityReferenceWindowRef.current.map((point) => point.value);
        const targetBaseline = getPercentile(recentEnvelopeValues, BASELINE_PERCENTILE);
        const baseline = activityBaselineRef.current + (targetBaseline - activityBaselineRef.current) * BASELINE_SMOOTHING;
        activityBaselineRef.current = baseline;

        const targetUpperReference = Math.max(
          getPercentile(recentEnvelopeValues, ACTIVE_REFERENCE_PERCENTILE) *
            (ACTIVE_REFERENCE_HEADROOM / Math.max(displaySensitivityRef.current, 0.1)),
          baseline + MIN_ACTIVITY_RANGE,
        );
        const upperReference =
          activityUpperReferenceRef.current +
          (targetUpperReference - activityUpperReferenceRef.current) * ACTIVE_REFERENCE_SMOOTHING;
        activityUpperReferenceRef.current = Math.max(upperReference, baseline + MIN_ACTIVITY_RANGE);
        setLiveDisplayScale(activityUpperReferenceRef.current);
        setLiveSampleRateHz(sampleRateTimesRef.current.length);

        const normalizedPending = pending.map((point) => ({
          ...point,
          normalizedActivity: clampSignalValue(
            (point.activityEnvelope - activityBaselineRef.current) /
              Math.max(activityUpperReferenceRef.current - activityBaselineRef.current, MIN_ACTIVITY_RANGE),
          ),
          value: clampSignalValue(
            (point.activityEnvelope - activityBaselineRef.current) /
              Math.max(activityUpperReferenceRef.current - activityBaselineRef.current, MIN_ACTIVITY_RANGE),
          ),
        }));

        return trimPointsToTimeWindow([...trimmedPreviousPoints, ...normalizedPending], displayWindowMs);
      });
    }, LIVE_RENDER_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [displayWindowMs, isStreaming, signalSourceMode]);

  useEffect(() => {
    setSignalData(prev => {
      const trimmedPoints = trimPointsToTimeWindow(prev, displayWindowMs);
      return trimmedPoints;
    });
  }, [displayWindowMs]);

  useEffect(() => {
    return () => {
      void disconnectGanglion();
    };
  }, [disconnectGanglion]);

  return {
    signalData,
    recordingSignalData,
    signalSourceMode,
    isStreaming,
    selectSignalSourceMode,
    startStream,
    startStreamForMode,
    stopStream,
    liveConnectionStatus,
    liveConnectionMessage,
    liveDeviceName,
    livePacketCount,
    liveDisplayScale,
    liveSampleRateHz,
    isBluetoothAvailable: isWebBluetoothAvailable()
  };
}
