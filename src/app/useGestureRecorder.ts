import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FrozenCalibration } from './study/frozenCalibration.mjs';
import type { SignalPoint } from './useSignalSource';

export type RecorderState = 'idle' | 'recording' | 'cooldown';
export type CaptureTriggerMode = 'threshold' | 'button';
export type ThresholdReadiness = 'unavailable' | 'rest' | 'ready' | 'movement';

export type RecorderWaveformPoint = {
  time: number;
  value: number;
};

export interface CompletedGestureSegment {
  points: RecorderWaveformPoint[];
  triggeredAt: number;
  completedAt: number;
  preTriggerPointCount: number;
  triggerMode: CaptureTriggerMode;
  firstCrossingAt?: number | null;
  calibration?: FrozenCalibration | null;
}

interface UseGestureRecorderOptions {
  signalPoints: SignalPoint[];
  threshold: number;
  frozenCalibration?: FrozenCalibration | null;
  segmentDurationMs: number;
  isStreaming: boolean;
  resetKey: string;
  minSegmentPoints?: number;
  preTriggerWindowMs?: number;
  cooldownMs?: number;
  hysteresisRatio?: number;
  triggerMode?: CaptureTriggerMode;
  manualTriggerToken?: number;
  isArmed?: boolean;
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
  thresholdReadiness: ThresholdReadiness;
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
  frozenCalibration,
  segmentDurationMs,
  isStreaming,
  resetKey,
  minSegmentPoints = 6,
  preTriggerWindowMs = DEFAULT_PRE_TRIGGER_WINDOW_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  hysteresisRatio = DEFAULT_HYSTERESIS_RATIO,
  triggerMode = 'threshold',
  manualTriggerToken = 0,
  isArmed = true,
}: UseGestureRecorderOptions): UseGestureRecorderResult {
  const [recorderState, setRecorderState] = useState<RecorderState>('idle');
  const [thresholdReadiness, setThresholdReadiness] = useState<ThresholdReadiness>('unavailable');
  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(null);
  const [recordingProgress, setRecordingProgress] = useState(0);
  const [currentCapturedSegment, setCurrentCapturedSegment] = useState<RecorderWaveformPoint[]>([]);
  const [completedSegment, setCompletedSegment] = useState<CompletedGestureSegment | null>(null);
  const [normalizedActivity, setNormalizedActivity] = useState(0);
  const [thresholdCrossingDetected, setThresholdCrossingDetected] = useState(false);
  const [elapsedCaptureDurationMs, setElapsedCaptureDurationMs] = useState(0);
  const [preTriggerPointCount, setPreTriggerPointCount] = useState(0);

  const seenRef = useRef(new WeakSet<SignalPoint>());
  const holdRef = useRef<{ rest: number | null; onset: number | null; ready: boolean }>({ rest: null, onset: null, ready: false });
  const firstCrossingRef = useRef<number | null>(null);
  const endpointRef = useRef<number | null>(null);
  const lastProcessedTimeRef = useRef<number | null>(null);
  const preTriggerBufferRef = useRef<RecorderWaveformPoint[]>([]);
  const recordedSegmentRef = useRef<RecorderWaveformPoint[]>([]);
  const recordingTriggerTimeRef = useRef<number | null>(null);
  const cooldownUntilRef = useRef<number | null>(null);
  const aboveThresholdRef = useRef(false);
  const hasSeenRestingSignalRef = useRef(false);
  const recorderStateRef = useRef<RecorderState>('idle');
  const preTriggerPointCountRef = useRef(0);
  const lastManualTriggerTokenRef = useRef(manualTriggerToken);
  const manualTriggerPendingRef = useRef(false);

  useEffect(() => {
    if (manualTriggerToken !== lastManualTriggerTokenRef.current) {
      lastManualTriggerTokenRef.current = manualTriggerToken;
      if (triggerMode === 'button' && isArmed) {
        manualTriggerPendingRef.current = true;
      }
    }
  }, [isArmed, manualTriggerToken, triggerMode]);

  const resetRecorder = useCallback(() => {
    seenRef.current = new WeakSet();
    holdRef.current = { rest: null, onset: null, ready: false };
    setThresholdReadiness('unavailable');
    firstCrossingRef.current = null; endpointRef.current = null;
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
    hasSeenRestingSignalRef.current = false;
    recorderStateRef.current = 'idle';
    preTriggerPointCountRef.current = 0;
    manualTriggerPendingRef.current = false;
  }, []);

  const resetThreshold = frozenCalibration === undefined ? threshold : null;
  useEffect(() => {
    resetRecorder();
    // A method switch must not replay the previous method's buffered points.
    lastProcessedTimeRef.current = signalPoints[signalPoints.length - 1]?.time ?? null;
    seenRef.current = new WeakSet(signalPoints);
    setNormalizedActivity(0);
  }, [isStreaming, resetKey, frozenCalibration?.revision, isArmed, triggerMode, segmentDurationMs, preTriggerWindowMs, resetThreshold]);

  useEffect(() => {
    if (signalPoints.length === 0) {
      return;
    }

    if (!isStreaming) return;
    const newPoints = signalPoints.filter(point => !seenRef.current.has(point));

    if (newPoints.length === 0) {
      return;
    }

    const lowerThreshold = Math.max(0, threshold * hysteresisRatio);

    for (const point of newPoints) {
      seenRef.current.add(point);
      const previousTime = lastProcessedTimeRef.current;
      if (![point.time, point.raw, point.activityEnvelope].every(Number.isFinite) || point.activityEnvelope < 0
        || (previousTime !== null && (point.time < previousTime || point.time - previousTime > (frozenCalibration?.maxGapMs ?? 500)))) {
        resetRecorder();
        seenRef.current = new WeakSet(signalPoints);
        lastProcessedTimeRef.current = Number.isFinite(point.time) ? point.time : null;
        break;
      }
      lastProcessedTimeRef.current = point.time;
      setNormalizedActivity(point.normalizedActivity);

      const wasAboveThreshold = aboveThresholdRef.current;
      const crossesThreshold = hasSeenRestingSignalRef.current && !wasAboveThreshold && point.normalizedActivity >= threshold;
      const manualTriggerRequested = triggerMode === 'button' && manualTriggerPendingRef.current;
      let fixedTrigger = false;
      const hold = holdRef.current;
      if (frozenCalibration && isArmed && triggerMode === 'threshold') {
        if (point.activityEnvelope < frozenCalibration.threshold) {
          hold.onset = null;
          hold.rest ??= point.time;
          if (point.time - hold.rest >= frozenCalibration.restHoldMs) hold.ready = true;
        } else {
          hold.rest = null;
          if (hold.ready && recorderStateRef.current === 'idle') {
            hold.onset ??= point.time;
            if (point.time - hold.onset >= frozenCalibration.activationHoldMs) {
              fixedTrigger = true; firstCrossingRef.current = hold.onset;
              hold.ready = false; hold.onset = null;
            }
          }
        }
      }
      const shouldTrigger = isArmed && (
        triggerMode === 'threshold' ? (frozenCalibration === undefined ? crossesThreshold : fixedTrigger) : manualTriggerRequested
      );

      if (point.normalizedActivity >= threshold) {
        aboveThresholdRef.current = true;
      } else if (point.normalizedActivity <= lowerThreshold) {
        aboveThresholdRef.current = false;
        hasSeenRestingSignalRef.current = true;
      }

      const currentRecorderState = recorderStateRef.current;

      if (currentRecorderState === 'idle') {
        if (shouldTrigger) {
          manualTriggerPendingRef.current = false;
          const preTriggerPoints = preTriggerBufferRef.current.filter(p => p.time >= point.time - preTriggerWindowMs);
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
        const closing = endpointRef.current !== null && point.time > endpointRef.current;
        const nextSegment = closing ? recordedSegmentRef.current : [...recordedSegmentRef.current, { time: point.time, value: point.raw }];
        recordedSegmentRef.current = nextSegment;
        setCurrentCapturedSegment(nextSegment);

        const elapsedMs = point.time - triggerTime;
        setElapsedCaptureDurationMs(elapsedMs);
        setRecordingProgress(
          Math.max(0, Math.min(1, elapsedMs / Math.max(segmentDurationMs, 1))),
        );

        if (elapsedMs < segmentDurationMs) continue;
        if (!closing) { endpointRef.current ??= point.time; continue; }
        const completedAt = endpointRef.current!;
        endpointRef.current = null;

        recorderStateRef.current = 'cooldown';
        setRecorderState('cooldown');
        setRecordingStartTime(null);
        setRecordingProgress(0);
        setCurrentCapturedSegment([]);
        setElapsedCaptureDurationMs(segmentDurationMs);
        cooldownUntilRef.current = completedAt + cooldownMs;
        recordingTriggerTimeRef.current = null;
        preTriggerBufferRef.current = [];
        recordedSegmentRef.current = [];

        if (nextSegment.length >= minSegmentPoints) {
          setCompletedSegment({
            points: nextSegment,
            triggeredAt: triggerTime,
            completedAt,
            ...(frozenCalibration !== undefined ? { calibration: frozenCalibration, firstCrossingAt: triggerMode === 'threshold' ? firstCrossingRef.current : null } : {}),
            preTriggerPointCount: preTriggerPointCountRef.current,
            triggerMode,
          });
        }

        continue;
      }

      if (currentRecorderState === 'cooldown') {
        const cooldownElapsed = point.time >= (cooldownUntilRef.current ?? point.time);
        const belowHysteresis = frozenCalibration === undefined || triggerMode === 'button' ? point.normalizedActivity <= lowerThreshold
          : !!frozenCalibration && holdRef.current.ready && point.activityEnvelope < frozenCalibration.threshold;

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
    // Read-only projection of the detector's own holds, never a second detector.
    const hold = holdRef.current;
    setThresholdReadiness(!isArmed || !frozenCalibration || triggerMode !== 'threshold' || recorderStateRef.current === 'recording'
      ? 'unavailable'
      : recorderStateRef.current !== 'idle' || !hold.ready ? 'rest'
        : hold.onset !== null ? 'movement' : 'ready');
  }, [
    hysteresisRatio,
    frozenCalibration,
    isStreaming,
    minSegmentPoints,
    preTriggerWindowMs,
    segmentDurationMs,
    signalPoints,
    threshold,
    cooldownMs,
    isArmed,
    triggerMode,
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
    thresholdReadiness,
    isRecording: recorderState === 'recording',
    recordingStartTime,
    recordingProgress,
    currentCapturedSegment,
    completedSegment,
    acknowledgeCompletedSegment,
    diagnostics,
  };
}
