import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SignalPoint } from './useSignalSource';

export type RecorderState = 'idle' | 'recording' | 'cooldown';

export type RecorderWaveformPoint = {
  time: number;
  value: number;
};

export interface CompletedGestureSegment {
  points: RecorderWaveformPoint[];
  triggeredAt: number;
  completedAt: number;
  preTriggerPointCount: number;
}

interface UseGestureRecorderOptions {
  signalPoints: SignalPoint[];
  threshold: number;
  segmentDurationMs: number;
  isStreaming: boolean;
  resetKey: string;
  minSegmentPoints?: number;
  preTriggerWindowMs?: number;
  cooldownMs?: number;
  hysteresisRatio?: number;
}

interface GestureRecorderDiagnostics {
  normalizedActivity: number;
  threshold: number;
  thresholdCrossingDetected: boolean;
  capturedRawPointCount: number;
  elapsedCaptureDurationMs: number;
  preTriggerPointCount: number;
}

interface UseGestureRecorderResult {
  recorderState: RecorderState;
  isRecording: boolean;
  recordingStartTime: number | null;
  recordingProgress: number;
  currentCapturedSegment: RecorderWaveformPoint[];
  completedSegment: CompletedGestureSegment | null;
  acknowledgeCompletedSegment: () => void;
  diagnostics: GestureRecorderDiagnostics;
}

const DEFAULT_PRE_TRIGGER_WINDOW_MS = 175;
const DEFAULT_COOLDOWN_MS = 350;
const DEFAULT_HYSTERESIS_RATIO = 0.7;

export function useGestureRecorder({
  signalPoints,
  threshold,
  segmentDurationMs,
  isStreaming,
  resetKey,
  minSegmentPoints = 6,
  preTriggerWindowMs = DEFAULT_PRE_TRIGGER_WINDOW_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  hysteresisRatio = DEFAULT_HYSTERESIS_RATIO,
}: UseGestureRecorderOptions): UseGestureRecorderResult {
  const [recorderState, setRecorderState] = useState<RecorderState>('idle');
  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(null);
  const [recordingProgress, setRecordingProgress] = useState(0);
  const [currentCapturedSegment, setCurrentCapturedSegment] = useState<RecorderWaveformPoint[]>([]);
  const [completedSegment, setCompletedSegment] = useState<CompletedGestureSegment | null>(null);
  const [normalizedActivity, setNormalizedActivity] = useState(0);
  const [thresholdCrossingDetected, setThresholdCrossingDetected] = useState(false);
  const [elapsedCaptureDurationMs, setElapsedCaptureDurationMs] = useState(0);
  const [preTriggerPointCount, setPreTriggerPointCount] = useState(0);

  const lastProcessedTimeRef = useRef<number | null>(null);
  const preTriggerBufferRef = useRef<RecorderWaveformPoint[]>([]);
  const recordedSegmentRef = useRef<RecorderWaveformPoint[]>([]);
  const recordingTriggerTimeRef = useRef<number | null>(null);
  const cooldownUntilRef = useRef<number | null>(null);
  const aboveThresholdRef = useRef(false);
  const recorderStateRef = useRef<RecorderState>('idle');
  const preTriggerPointCountRef = useRef(0);

  const resetRecorder = useCallback(() => {
    setRecorderState('idle');
    setRecordingStartTime(null);
    setRecordingProgress(0);
    setCurrentCapturedSegment([]);
    setCompletedSegment(null);
    setThresholdCrossingDetected(false);
    setElapsedCaptureDurationMs(0);
    setPreTriggerPointCount(0);
    lastProcessedTimeRef.current = null;
    preTriggerBufferRef.current = [];
    recordedSegmentRef.current = [];
    recordingTriggerTimeRef.current = null;
    cooldownUntilRef.current = null;
    aboveThresholdRef.current = false;
    recorderStateRef.current = 'idle';
    preTriggerPointCountRef.current = 0;
  }, []);

  useEffect(() => {
    resetRecorder();
    setNormalizedActivity(0);
  }, [isStreaming, resetKey]);

  useEffect(() => {
    if (signalPoints.length === 0) {
      return;
    }

    const lastProcessedTime = lastProcessedTimeRef.current;
    const newPoints = lastProcessedTime === null
      ? signalPoints
      : signalPoints.filter((point) => point.time > lastProcessedTime);

    if (newPoints.length === 0) {
      return;
    }

    const lowerThreshold = Math.max(0, threshold * hysteresisRatio);

    for (const point of newPoints) {
      lastProcessedTimeRef.current = point.time;
      setNormalizedActivity(point.normalizedActivity);

      const wasAboveThreshold = aboveThresholdRef.current;
      const crossesThreshold = !wasAboveThreshold && point.normalizedActivity >= threshold;

      if (point.normalizedActivity >= threshold) {
        aboveThresholdRef.current = true;
      } else if (point.normalizedActivity <= lowerThreshold) {
        aboveThresholdRef.current = false;
      }

      const currentRecorderState = recorderStateRef.current;

      if (currentRecorderState === 'idle') {
        if (crossesThreshold) {
          const preTriggerPoints = [...preTriggerBufferRef.current];
          const seededSegment = [...preTriggerPoints, { time: point.time, value: point.raw }];

          recordedSegmentRef.current = seededSegment;
          recordingTriggerTimeRef.current = point.time;
          recorderStateRef.current = 'recording';
          preTriggerPointCountRef.current = preTriggerPoints.length;
          setRecorderState('recording');
          setRecordingStartTime(point.time);
          setRecordingProgress(0);
          setCurrentCapturedSegment(seededSegment);
          setThresholdCrossingDetected(true);
          setElapsedCaptureDurationMs(0);
          setPreTriggerPointCount(preTriggerPoints.length);
          continue;
        }

        preTriggerBufferRef.current = [
          ...preTriggerBufferRef.current,
          { time: point.time, value: point.raw },
        ].filter((bufferPoint) => bufferPoint.time >= point.time - preTriggerWindowMs);
        continue;
      }

      if (currentRecorderState === 'recording') {
        const triggerTime = recordingTriggerTimeRef.current ?? point.time;
        const nextSegment = [...recordedSegmentRef.current, { time: point.time, value: point.raw }];
        recordedSegmentRef.current = nextSegment;
        setCurrentCapturedSegment(nextSegment);

        const elapsedMs = point.time - triggerTime;
        setElapsedCaptureDurationMs(elapsedMs);
        setRecordingProgress(
          Math.max(0, Math.min(1, elapsedMs / Math.max(segmentDurationMs, 1))),
        );

        if (elapsedMs < segmentDurationMs) {
          continue;
        }

        recorderStateRef.current = 'cooldown';
        setRecorderState('cooldown');
        setRecordingStartTime(null);
        setRecordingProgress(0);
        setCurrentCapturedSegment([]);
        setElapsedCaptureDurationMs(segmentDurationMs);
        cooldownUntilRef.current = point.time + cooldownMs;
        recordingTriggerTimeRef.current = null;
        preTriggerBufferRef.current = [];
        recordedSegmentRef.current = [];

        if (nextSegment.length >= minSegmentPoints) {
          setCompletedSegment({
            points: nextSegment,
            triggeredAt: triggerTime,
            completedAt: point.time,
            preTriggerPointCount: preTriggerPointCountRef.current,
          });
        }

        continue;
      }

      if (currentRecorderState === 'cooldown') {
        const cooldownElapsed = point.time >= (cooldownUntilRef.current ?? point.time);
        const belowHysteresis = point.normalizedActivity <= lowerThreshold;

        if (cooldownElapsed && belowHysteresis) {
          recorderStateRef.current = 'idle';
          preTriggerPointCountRef.current = 0;
          setRecorderState('idle');
          setThresholdCrossingDetected(false);
          setElapsedCaptureDurationMs(0);
          setPreTriggerPointCount(0);
          preTriggerBufferRef.current = [{ time: point.time, value: point.raw }];
        }
      }
    }
  }, [
    hysteresisRatio,
    isStreaming,
    minSegmentPoints,
    preTriggerWindowMs,
    segmentDurationMs,
    signalPoints,
    threshold,
    cooldownMs,
  ]);

  const acknowledgeCompletedSegment = () => {
    setCompletedSegment(null);
  };

  const diagnostics = useMemo<GestureRecorderDiagnostics>(() => ({
    normalizedActivity,
    threshold,
    thresholdCrossingDetected,
    capturedRawPointCount: currentCapturedSegment.length,
    elapsedCaptureDurationMs,
    preTriggerPointCount,
  }), [
    currentCapturedSegment.length,
    elapsedCaptureDurationMs,
    normalizedActivity,
    preTriggerPointCount,
    threshold,
    thresholdCrossingDetected,
  ]);

  return {
    recorderState,
    isRecording: recorderState === 'recording',
    recordingStartTime,
    recordingProgress,
    currentCapturedSegment,
    completedSegment,
    acknowledgeCompletedSegment,
    diagnostics,
  };
}
