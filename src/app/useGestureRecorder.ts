import { useCallback, useEffect, useRef, useState } from 'react';
import type { SignalPoint } from './useSignalSource';
import { RecorderMachine, type RecorderEvent, type TriggerSource } from './recorder/recorderMachine';
export type { RecorderState, Segment as CompletedGestureSegment, WaveformPoint as RecorderWaveformPoint } from './recorder/recorderMachine';

interface Options {
  signalPoints: SignalPoint[];
  threshold: number;
  segmentDurationMs: number;
  isStreaming: boolean;
  resetKey: string;
  minSegmentPoints?: number;
  preTriggerWindowMs?: number;
  cooldownMs?: number;
  hysteresisRatio?: number;
  triggerMode?: 'signal' | 'manual';
  onEvent?: (event: RecorderEvent) => void;
}

export function useGestureRecorder({ signalPoints, threshold, segmentDurationMs, isStreaming, resetKey,
  minSegmentPoints = 6, preTriggerWindowMs = 175, cooldownMs = 350, hysteresisRatio = 0.7,
  triggerMode = 'signal', onEvent }: Options) {
  const machineRef = useRef<RecorderMachine | null>(null);
  const config = { durationMs: segmentDurationMs, threshold, triggerMode, preTriggerMs: preTriggerWindowMs,
    cooldownMs, hysteresisRatio, minPoints: minSegmentPoints, maxGapMs: 250 };
  if (!machineRef.current) machineRef.current = new RecorderMachine(config);
  const machine = machineRef.current;
  const eventRef = useRef(onEvent);
  eventRef.current = onEvent;
  const pointsRef = useRef(signalPoints);
  pointsRef.current = signalPoints;
  const [, render] = useState(0);
  const flush = useCallback(() => {
    machine.events.splice(0).forEach(event => eventRef.current?.(event));
    render(n => n + 1);
  }, [machine]);

  useEffect(() => {
    machine.config = config;
    const last = pointsRef.current.at(-1);
    machine.enable(isStreaming, last ? (last.sequence ?? last.time) : -Infinity);
    flush();
    return () => {
      machine.abort('context_changed_or_stopped', Date.now());
      machine.events.splice(0).forEach(event => eventRef.current?.(event));
    };
  }, [isStreaming, resetKey, threshold, segmentDurationMs, triggerMode, preTriggerWindowMs,
    cooldownMs, hysteresisRatio, minSegmentPoints, machine, flush]);

  useEffect(() => {
    if (!isStreaming) return;
    machine.feed(signalPoints);
    flush();
  }, [isStreaming, signalPoints, machine, flush]);

  useEffect(() => {
    if (!isStreaming) return;
    const timer = window.setInterval(() => {
      if (machine.active) { machine.checkStall(Date.now()); flush(); }
    }, 100);
    return () => window.clearInterval(timer);
  }, [isStreaming, machine, flush]);

  const startRecording = useCallback((source: TriggerSource = 'button', time = Date.now()) => {
    const accepted = machine.trigger(source, time);
    flush();
    return accepted;
  }, [machine, flush]);
  const acknowledgeCompletedSegment = useCallback(() => { machine.completed.shift(); flush(); }, [machine, flush]);
  const active = machine.active;
  const elapsed = active ? Math.max(0, Math.min(Date.now() - active.triggeredAt, active.durationMs)) : 0;
  return {
    recorderState: machine.state,
    isRecording: machine.state === 'recording',
    recordingStartTime: active?.triggeredAt ?? null,
    recordingProgress: active ? elapsed / active.durationMs : 0,
    currentCapturedSegment: active?.points ?? [],
    completedSegment: machine.completed[0] ?? null,
    acknowledgeCompletedSegment,
    startRecording,
    canStartRecording: machine.canTrigger('button', Date.now()),
    diagnostics: {
      normalizedActivity: machine.activity, threshold,
      thresholdCrossingDetected: active?.triggerSource === 'signal',
      capturedRawPointCount: active?.points.length ?? 0,
      elapsedCaptureDurationMs: elapsed,
      preTriggerPointCount: active?.preTriggerPointCount ?? 0,
    },
  };
}
