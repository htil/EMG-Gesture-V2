import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FrozenCalibration } from './study/frozenCalibration.mjs';
import type { SignalPoint } from './useSignalSource';
import { CaptureContextRecorder, type AttemptMetadata } from './study/captureContext';

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
  centerDurationMs: number;
  attemptId: string;
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
  contextRecorder?: CaptureContextRecorder;
  attemptMetadata?: AttemptMetadata;
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
  cancelledOpportunityId: string | null;
  contextRecorder: CaptureContextRecorder;
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

// Surrounding points are context only, never labeled training input.
const DEFAULT_PRE_TRIGGER_WINDOW_MS = 0;
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
  contextRecorder: suppliedContextRecorder,
  attemptMetadata,
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

  const localContextRef = useRef<CaptureContextRecorder | null>(null);
  if (!localContextRef.current) localContextRef.current = new CaptureContextRecorder({ participantId: 'unscoped', sessionId: resetKey, condition: triggerMode, source: 'mock', sourceEpoch: 0, channel: 0 });
  const contextRecorder = suppliedContextRecorder ?? localContextRef.current;
  const cancelledHandledRef = useRef<string | null>(null);
  const activeAttemptRef = useRef<string | null>(null);
  const contextBoundaryRef = useRef({ resetKey, isStreaming });
  const seenRef = useRef(new WeakSet<SignalPoint>());
  const consumedIdsRef = useRef(new Set<number>());
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
    if (activeAttemptRef.current) contextRecorder.interruptAttempt(activeAttemptRef.current, 'capture_cancelled');
    activeAttemptRef.current = null;
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
  }, [contextRecorder]);

  const cueIdentityRef = useRef(attemptMetadata?.attemptId);
  useEffect(() => {
    if (cueIdentityRef.current === attemptMetadata?.attemptId) return;
    cueIdentityRef.current = attemptMetadata?.attemptId;
    resetRecorder();
    seenRef.current = new WeakSet(signalPoints);
    signalPoints.forEach(point => { if (point.consumptionId !== undefined) consumedIdsRef.current.add(point.consumptionId); });
    lastProcessedTimeRef.current = signalPoints[signalPoints.length - 1]?.time ?? null;
  }, [attemptMetadata?.attemptId, contextRecorder, resetRecorder]);

  const resetThreshold = frozenCalibration === undefined ? threshold : null;
  useEffect(() => {
    // A supplied recorder owns participant/session/source boundaries itself.
    // A gesture/settings reset only cancels the active detector, not an already
    // completed center's independent five-second post-context.
    if ((contextBoundaryRef.current.resetKey !== resetKey && !suppliedContextRecorder) || (contextBoundaryRef.current.isStreaming && !isStreaming)) contextRecorder.flush(!isStreaming ? 'disconnected' : 'recorder_scope_changed');
    contextBoundaryRef.current = { resetKey, isStreaming };
    resetRecorder();
    // A method switch must not replay the previous method's buffered points.
    lastProcessedTimeRef.current = signalPoints[signalPoints.length - 1]?.time ?? null;
    seenRef.current = new WeakSet(signalPoints);
    consumedIdsRef.current = new Set(signalPoints.flatMap(point => point.consumptionId === undefined ? [] : [point.consumptionId]));
    setNormalizedActivity(0);
  }, [isStreaming, resetKey, frozenCalibration?.revision, isArmed, triggerMode, segmentDurationMs, preTriggerWindowMs, resetThreshold]);

  useEffect(() => {
    if (attemptMetadata && contextRecorder.isAttemptCancelled(attemptMetadata.attemptId)) {
      if (cancelledHandledRef.current !== attemptMetadata.attemptId) {
        cancelledHandledRef.current = attemptMetadata.attemptId;
        resetRecorder();
      }
      return;
    }
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
      // Deduplicate acquisition identity BEFORE clocks, holds or capture state.
      // Normalized/display clones and tied packet splits are not new history.
      if (point.consumptionId !== undefined) {
        if (consumedIdsRef.current.has(point.consumptionId)) continue;
        consumedIdsRef.current.add(point.consumptionId);
      }
      seenRef.current.add(point);
      contextRecorder.push(point);
      // Raw subscribers may already have interrupted this attempt before the
      // corresponding React batch arrives. Never publish its cancelled center.
      if (activeAttemptRef.current && !contextRecorder.hasAttempt(activeAttemptRef.current)) resetRecorder();
      const previousTime = lastProcessedTimeRef.current;
      if (![point.time, point.raw, point.activityEnvelope].every(Number.isFinite) || point.activityEnvelope < 0
        || (previousTime !== null && (point.time < previousTime || point.time - previousTime > (frozenCalibration?.maxGapMs ?? 500)))) {
        contextRecorder.flush('invalid_or_discontinuous_source');
        resetRecorder();
        seenRef.current.add(point);
        lastProcessedTimeRef.current = Number.isFinite(point.time) ? point.time : null;
        continue;
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
          if (!contextRecorder.canCapture(point)) { resetRecorder(); continue; }
          manualTriggerPendingRef.current = false;
          const attempt = attemptMetadata ?? { attemptId: crypto.randomUUID(), gestureId: 'unspecified', cueAt: point.time };
          if (!contextRecorder.canTriggerAttempt(attempt.attemptId)) continue;
          if (!contextRecorder.hasAttempt(attempt.attemptId)) contextRecorder.beginAttempt(attempt);
          contextRecorder.capture(attempt.attemptId, point, segmentDurationMs);
          activeAttemptRef.current = attempt.attemptId;
          const seededSegment = [{ time: point.time, value: point.raw }];

          recordedSegmentRef.current = seededSegment;
          recordingTriggerTimeRef.current = point.time;
          recorderStateRef.current = 'recording';
          preTriggerPointCountRef.current = 0;
          setRecorderState('recording');
          setRecordingStartTime(point.time);
          setRecordingProgress(0);
          setCurrentCapturedSegment(seededSegment);
          setThresholdCrossingDetected(true);
          setElapsedCaptureDurationMs(0);
          setPreTriggerPointCount(0);
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
        const closing = point.time >= triggerTime + segmentDurationMs;
        const nextSegment = closing ? recordedSegmentRef.current : [...recordedSegmentRef.current, { time: point.time, value: point.raw }];
        recordedSegmentRef.current = nextSegment;
        setCurrentCapturedSegment(nextSegment);

        const elapsedMs = point.time - triggerTime;
        setElapsedCaptureDurationMs(elapsedMs);
        setRecordingProgress(
          Math.max(0, Math.min(1, elapsedMs / Math.max(segmentDurationMs, 1))),
        );

        if (elapsedMs < segmentDurationMs) continue;
        if (!closing) continue;
        const completedAt = triggerTime + segmentDurationMs;
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
            centerDurationMs: segmentDurationMs,
            attemptId: activeAttemptRef.current!,
            triggeredAt: triggerTime,
            completedAt,
            ...(frozenCalibration !== undefined ? { calibration: frozenCalibration, firstCrossingAt: triggerMode === 'threshold' ? firstCrossingRef.current : null } : {}),
            preTriggerPointCount: preTriggerPointCountRef.current,
            triggerMode,
          });
          contextRecorder.finishCapture(activeAttemptRef.current!);
        } else if (activeAttemptRef.current) {
          contextRecorder.endAttempt(activeAttemptRef.current, 'failed', completedAt);
        }
        activeAttemptRef.current = null;

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
    contextRecorder,
    attemptMetadata,
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

  const cancelledOpportunityId = attemptMetadata && contextRecorder.isAttemptCancelled(attemptMetadata.attemptId) ? attemptMetadata.attemptId : null;
  return {
    cancelledOpportunityId,
    contextRecorder,
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
