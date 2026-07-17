import React from 'react';

import { useState, useEffect, useRef, useCallback } from 'react';
import { AreaChart, Area, XAxis, YAxis, ReferenceArea, ReferenceLine, ResponsiveContainer } from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import { X, Settings2, RotateCcw, Trash2, ChevronDown } from 'lucide-react';
import * as dfd from 'danfojs';
import { useSignalSource, type SignalSourceMode } from './useSignalSource';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from './components/ui/sheet';
import ResultScreen from './ResultScreen';
import TestingScreen from './TestingScreen';
import {
  DEFAULT_GESTURES,
  DEFAULT_TESTING_SESSION_SETTINGS,
  buildTrainingSession,
  createGesture,
  getChannelMockSignalValue,
  type Gesture,
  type TestingSessionData,
  type TestingSessionSettings,
  type TrainingSessionData,
} from './pipeline';

type AppScreen = 'training' | 'testing' | 'results';

type FeedbackState = 'ready' | 'recording' | 'good' | 'weak' | 'noisy' | 'short';
type SampleQuality = 'good' | 'weak' | 'noisy';
type SampleStatus = 'empty' | 'collected' | 'flagged' | 'rejected';
type WaveformPoint = { time: number; value: number };

interface Sample {
  id: number;
  status: SampleStatus;
  timestamp?: number;
  waveformData?: WaveformPoint[];
  quality?: SampleQuality;
}

interface GestureData {
  samples: Sample[];
}

interface ExportSample {
  id: string;
  label: string;
  timestamp: number;
  data: number[];
  duration: number;
}

type SignalSourceLabel = Record<SignalSourceMode, string>;

const DEFAULT_SEGMENT_DURATION_MS = 1200;
const MIN_SEGMENT_POINTS = 6;
const DEFAULT_DISPLAY_WINDOW_MS = 3000;
const DEFAULT_ACTIVITY_DISPLAY_SENSITIVITY = 1.0;
const RECORDED_SAMPLE_STATUSES: SampleStatus[] = ['collected', 'flagged', 'rejected'];

export default function TrainingScreen() {
  const [feedbackState, setFeedbackState] = useState<FeedbackState>('ready');
  const [threshold, setThreshold] = useState(0.6);
  const [segmentDurationMs, setSegmentDurationMs] = useState(DEFAULT_SEGMENT_DURATION_MS);
  const [displayWindowMs, setDisplayWindowMs] = useState(DEFAULT_DISPLAY_WINDOW_MS);
  const [activityDisplaySensitivity, setActivityDisplaySensitivity] = useState(DEFAULT_ACTIVITY_DISPLAY_SENSITIVITY);
  const [selectedChannelIndex, setSelectedChannelIndex] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(null);
  const [recordingProgress, setRecordingProgress] = useState(0);
  const [currentCapturedSegment, setCurrentCapturedSegment] = useState<WaveformPoint[]>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [minRequired, setMinRequired] = useState(8);
  const [sampleTarget, setSampleTarget] = useState(12);
  const [targetSamplesInputValue, setTargetSamplesInputValue] = useState('12');
  const [segmentDurationInputValue, setSegmentDurationInputValue] = useState(String(DEFAULT_SEGMENT_DURATION_MS));
  const [displayWindowInputValue, setDisplayWindowInputValue] = useState((DEFAULT_DISPLAY_WINDOW_MS / 1000).toFixed(1));
  const [activityDisplaySensitivityInputValue, setActivityDisplaySensitivityInputValue] = useState(
    DEFAULT_ACTIVITY_DISPLAY_SENSITIVITY.toFixed(1)
  );
  const [selectedSampleId, setSelectedSampleId] = useState<number | null>(null);
  const [gestures, setGestures] = useState<Gesture[]>(DEFAULT_GESTURES);
  const [currentGestureId, setCurrentGestureId] = useState<string>(DEFAULT_GESTURES[0].id);
  const [newGestureName, setNewGestureName] = useState('');
  const [isGestureDropdownOpen, setIsGestureDropdownOpen] = useState(false);
  const [showGestureChangeMessage, setShowGestureChangeMessage] = useState(false);
  const [showRawSignal, setShowRawSignal] = useState(false);
  const [activeScreen, setActiveScreen] = useState<AppScreen>('training');
  const [trainingSession, setTrainingSession] = useState<TrainingSessionData | null>(null);
  const [testingSession, setTestingSession] = useState<TestingSessionData | null>(null);
  const [testingSettings, setTestingSettings] = useState<TestingSessionSettings>(
    DEFAULT_TESTING_SESSION_SETTINGS,
  );
  const previewPanelRef = useRef<HTMLDivElement>(null);
  const gestureDropdownRef = useRef<HTMLDivElement>(null);
  const recordingStartTimeRef = useRef<number | null>(null);
  const currentCapturedSegmentRef = useRef<WaveformPoint[]>([]);
  const wasAboveThresholdRef = useRef(false);
  const lastLivePointTimeRef = useRef<number | null>(null);

  const generateMockSignalValue = useCallback(() => {
    const cycleDurationMs = Math.max(segmentDurationMs, 1);
    const progress = (Date.now() % cycleDurationMs) / cycleDurationMs;

    switch (feedbackState) {
      case 'recording':
      case 'good':
        return getChannelMockSignalValue(selectedChannelIndex, progress, 'active');
      case 'weak':
        return getChannelMockSignalValue(selectedChannelIndex, progress, 'weak');
      case 'noisy':
        return getChannelMockSignalValue(selectedChannelIndex, progress, 'noisy');
      case 'short':
        return getChannelMockSignalValue(selectedChannelIndex, progress, 'short');
      default:
        return getChannelMockSignalValue(selectedChannelIndex, progress, 'idle');
    }
  }, [feedbackState, segmentDurationMs, selectedChannelIndex]);

  const {
    signalData,
    recordingSignalData,
    signalSourceMode,
    isStreaming,
    selectSignalSourceMode,
    startStream,
    stopStream,
    liveConnectionStatus,
    liveConnectionMessage,
    liveDeviceName,
    livePacketCount,
    liveDisplayScale,
    liveSampleRateHz,
    isBluetoothAvailable
  } = useSignalSource(
    generateMockSignalValue,
    displayWindowMs,
    selectedChannelIndex,
    activityDisplaySensitivity
  );
  
  const isRecordedSampleStatus = (status: SampleStatus) => RECORDED_SAMPLE_STATUSES.includes(status);

  const createEmptySamples = (totalCount: number = 12): Sample[] =>
    Array.from({ length: totalCount }, (_, i) => ({
      id: i,
      status: 'empty' as const,
    }));

  const initializeGestureData = (gestureList: Gesture[]): Record<string, GestureData> =>
    Object.fromEntries(gestureList.map((gesture) => [gesture.id, { samples: createEmptySamples() }]));

  const [gestureData, setGestureData] = useState<Record<string, GestureData>>(() =>
    initializeGestureData(DEFAULT_GESTURES),
  );

  const currentGesture = gestures.find((gesture) => gesture.id === currentGestureId) ?? gestures[0];
  const currentSamples = gestureData[currentGesture?.id ?? '']?.samples ?? [];
  const [hoveredSample, setHoveredSample] = useState<number | null>(null);
  const [highlightSegment, setHighlightSegment] = useState<'good' | 'bad' | null>(null);

  const samplesCollected = currentSamples.filter((sample) => isRecordedSampleStatus(sample.status)).length;
  const samplesPerGesture = gestures.map((gesture) => ({
    gesture: gesture.name,
    gestureId: gesture.id,
    count: gestureData[gesture.id]?.samples.filter((sample) => isRecordedSampleStatus(sample.status)).length ?? 0,
  }));
  const totalSamplesCollected = samplesPerGesture.reduce((sum, entry) => sum + entry.count, 0);
  const isAllSamplesCollected = gestures.every(
    (gesture) => gestureData[gesture.id]?.samples.every((sample) => sample.status !== 'empty') ?? false,
  );
  useEffect(() => {
    setTargetSamplesInputValue(String(sampleTarget));
  }, [sampleTarget]);

  useEffect(() => {
    setSegmentDurationInputValue(String(segmentDurationMs));
  }, [segmentDurationMs]);

  useEffect(() => {
    setDisplayWindowInputValue((displayWindowMs / 1000).toFixed(1));
  }, [displayWindowMs]);

  useEffect(() => {
    setActivityDisplaySensitivityInputValue(activityDisplaySensitivity.toFixed(1));
  }, [activityDisplaySensitivity]);

  // Simulate state changes for demonstration
  useEffect(() => {
    if (signalSourceMode !== 'mock' || !isStreaming || isRecording) {
      return;
    }

    const stateSequence: FeedbackState[] = ['ready', 'recording', 'good', 'ready', 'weak', 'ready', 'noisy', 'ready'];
    let currentIndex = 0;

    const stateInterval = setInterval(() => {
      currentIndex = (currentIndex + 1) % stateSequence.length;
      const newState = stateSequence[currentIndex];
      setFeedbackState(newState);
      
      // Simulate segment highlights
      if (newState === 'good') {
        setHighlightSegment('good');
        setTimeout(() => setHighlightSegment(null), 800);
      } else if (newState === 'weak' || newState === 'noisy') {
        setHighlightSegment('bad');
        setTimeout(() => setHighlightSegment(null), 800);
      }
    }, 3000);

    return () => clearInterval(stateInterval);
  }, [isRecording, isStreaming, signalSourceMode]);

  useEffect(() => {
    if (signalSourceMode === 'mock' || isRecording) {
      return;
    }

    const latestEnvelope = recordingSignalData.at(-1)?.envelope ?? 0;

    if (latestEnvelope > threshold) {
      setFeedbackState('recording');
      setHighlightSegment('good');
      return;
    }

    setFeedbackState('ready');
    setHighlightSegment(null);
  }, [isRecording, recordingSignalData, signalSourceMode, threshold]);

  useEffect(() => {
    if (!isRecording) {
      return;
    }

    setFeedbackState('recording');
    setHighlightSegment('good');
  }, [isRecording]);

  useEffect(() => {
    recordingStartTimeRef.current = null;
    currentCapturedSegmentRef.current = [];
    wasAboveThresholdRef.current = false;
    lastLivePointTimeRef.current = null;
    setIsRecording(false);
    setRecordingStartTime(null);
    setRecordingProgress(0);
    setCurrentCapturedSegment([]);
    setHighlightSegment(null);
  }, [signalSourceMode]);

  useEffect(() => {
    if (isStreaming) {
      return;
    }

    recordingStartTimeRef.current = null;
    currentCapturedSegmentRef.current = [];
    wasAboveThresholdRef.current = false;
    lastLivePointTimeRef.current = null;
    setIsRecording(false);
    setRecordingStartTime(null);
    setRecordingProgress(0);
    setCurrentCapturedSegment([]);
    setHighlightSegment(null);
    setFeedbackState('ready');
  }, [isStreaming]);

  useEffect(() => {
    if (recordingSignalData.length === 0) {
      return;
    }

    const lastProcessedTime = lastLivePointTimeRef.current;
    const newPoints = lastProcessedTime === null
      ? recordingSignalData
      : recordingSignalData.filter((point) => point.time > lastProcessedTime);

    if (newPoints.length === 0) {
      return;
    }
    for (const point of newPoints) {
      lastLivePointTimeRef.current = point.time;
      const isActive = point.envelope > threshold;
      const crossedThreshold = !wasAboveThresholdRef.current && isActive;
      wasAboveThresholdRef.current = isActive;

      if (!isRecording) {
        if (!crossedThreshold) {
          continue;
        }

        const seededSegment = [{ time: point.time, value: point.raw }];
        recordingStartTimeRef.current = point.time;
        currentCapturedSegmentRef.current = seededSegment;
        setIsRecording(true);
        setRecordingStartTime(point.time);
        setRecordingProgress(0);
        setCurrentCapturedSegment(seededSegment);
        setFeedbackState('recording');
        setHighlightSegment('good');
        continue;
      }

      const startedAt = recordingStartTimeRef.current ?? point.time;
      const nextSegment = [...currentCapturedSegmentRef.current, { time: point.time, value: point.raw }];
      currentCapturedSegmentRef.current = nextSegment;
      setCurrentCapturedSegment(nextSegment);

      const elapsedMs = point.time - startedAt;
      const progress = Math.max(0, Math.min(1, elapsedMs / Math.max(segmentDurationMs, 1)));
      setRecordingProgress(progress);

      if (elapsedMs < segmentDurationMs) {
        continue;
      }

      recordingStartTimeRef.current = null;
      setIsRecording(false);
      setRecordingStartTime(null);
      setRecordingProgress(0);

      if (nextSegment.length < MIN_SEGMENT_POINTS) {
        currentCapturedSegmentRef.current = [];
        setCurrentCapturedSegment([]);
        setFeedbackState('ready');
        setHighlightSegment(null);
        continue;
      }

      const peak = nextSegment.reduce((max, samplePoint) => Math.max(max, samplePoint.value), 0);
      const quality: SampleQuality = peak >= threshold + 0.08 ? 'good' : 'weak';
      const waveformData = nextSegment;

      setGestureData((prev) => {
        const gesture = prev[currentGestureId];
        if (!gesture) {
          return prev;
        }
        const targetIndex = gesture.samples.findIndex((sample) => sample.status === 'empty');

        if (targetIndex === -1) {
          return prev;
        }

        return {
          ...prev,
          [currentGestureId]: {
            samples: gesture.samples.map((sample, index) =>
              index === targetIndex
                ? {
                    ...sample,
                    status: 'collected',
                    timestamp: Date.now(),
                    waveformData,
                    quality,
                  }
                : sample
            ),
          },
        };
      });

      currentCapturedSegmentRef.current = [];
      setCurrentCapturedSegment([]);
      setHighlightSegment(quality === 'good' ? 'good' : 'bad');
      setTimeout(() => setHighlightSegment(null), 800);
    }
  }, [currentGestureId, isRecording, recordingSignalData, segmentDurationMs, threshold]);

  // Close preview when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (selectedSampleId !== null && 
          previewPanelRef.current && 
          !previewPanelRef.current.contains(event.target as Node)) {
        // Check if click is not on a sample slot
        const target = event.target as HTMLElement;
        if (!target.closest('[data-sample-slot]')) {
          setSelectedSampleId(null);
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [selectedSampleId]);

  // Close gesture dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (isGestureDropdownOpen && 
          gestureDropdownRef.current && 
          !gestureDropdownRef.current.contains(event.target as Node)) {
        setIsGestureDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isGestureDropdownOpen]);

  const handleRemoveSample = (sampleId: number) => {
    setGestureData(prev => ({
      ...prev,
      [currentGestureId]: {
        samples: prev[currentGestureId]?.samples.map(s =>
          s.id === sampleId ? { ...s, status: 'empty', timestamp: undefined, waveformData: undefined, quality: undefined } : s
        )
      }
    }));
    setSelectedSampleId(null);
  };

  const handleRedoLast = () => {
    const lastCollectedIndex = currentSamples.map((s, i) => isRecordedSampleStatus(s.status) ? i : -1)
      .filter(i => i !== -1)
      .pop();
    
    if (lastCollectedIndex !== undefined) {
      handleRemoveSample(lastCollectedIndex);
    }
  };

  const handleClearDataset = () => {
    const confirmed = window.confirm('Clear all recorded samples across every gesture? This cannot be undone.');
    if (!confirmed) {
      return;
    }

    setGestureData(prev => {
      const nextGestureData = { ...prev };

      for (const gesture of gestures) {
        nextGestureData[gesture.id] = {
          samples: prev[gesture.id]?.samples.map((sample) => ({
            id: sample.id,
            status: 'empty' as const
          }))
        };
      }

      return nextGestureData;
    });

    setSelectedSampleId(null);
  };

  const handleThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setThreshold(parseFloat(e.target.value));
  };

  const applyTargetSampleValue = (nextValue: number) => {
    const clampedValue = Math.max(1, Math.min(50, nextValue));
    setSampleTarget(clampedValue);
    setMinRequired(clampedValue);

    setGestureData(prev => {
      const nextGestureData = { ...prev };

      for (const gesture of gestures) {
        const existingSamples = prev[gesture.id]?.samples ?? createEmptySamples();

        if (clampedValue > existingSamples.length) {
          nextGestureData[gesture.id] = {
            samples: [
              ...existingSamples,
              ...Array.from({ length: clampedValue - existingSamples.length }, (_, i) => ({
                id: existingSamples.length + i,
                status: 'empty' as const
              }))
            ]
          };
          continue;
        }

        if (clampedValue < existingSamples.length) {
          nextGestureData[gesture.id] = {
            samples: existingSamples.slice(0, clampedValue)
          };
          continue;
        }

        nextGestureData[gesture.id] = prev[gesture.id] ?? { samples: createEmptySamples() };
      }

      return nextGestureData;
    });
  };

  const handleTargetSampleChange = (delta: number) => {
    applyTargetSampleValue(sampleTarget + delta);
  };

  const handleTargetSampleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTargetSamplesInputValue(e.target.value);
  };

  const commitTargetSamplesInputValue = () => {
    const parsedValue = Number.parseInt(targetSamplesInputValue, 10);
    if (targetSamplesInputValue.trim() === '' || Number.isNaN(parsedValue)) {
      setTargetSamplesInputValue(String(sampleTarget));
      return;
    }

    applyTargetSampleValue(parsedValue);
  };

  const applySegmentDurationValue = (nextValue: number) => {
    setSegmentDurationMs(Math.max(400, Math.min(3000, nextValue)));
  };

  const handleSegmentDurationChange = (delta: number) => {
    applySegmentDurationValue(segmentDurationMs + delta);
  };

  const handleSegmentDurationInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSegmentDurationInputValue(e.target.value);
  };

  const commitSegmentDurationInputValue = () => {
    const parsedValue = Number.parseInt(segmentDurationInputValue, 10);
    if (segmentDurationInputValue.trim() === '' || Number.isNaN(parsedValue)) {
      setSegmentDurationInputValue(String(segmentDurationMs));
      return;
    }

    applySegmentDurationValue(parsedValue);
  };

  const applyDisplayWindowValue = (nextValueMs: number) => {
    const clampedValue = Math.max(2000, Math.min(10000, nextValueMs));
    setDisplayWindowMs(Math.round(clampedValue / 100) * 100);
  };

  const handleDisplayWindowChange = (deltaSeconds: number) => {
    applyDisplayWindowValue(displayWindowMs + deltaSeconds * 1000);
  };

  const handleDisplayWindowInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDisplayWindowInputValue(e.target.value);
  };

  const commitDisplayWindowInputValue = () => {
    const parsedValue = Number.parseFloat(displayWindowInputValue);
    if (displayWindowInputValue.trim() === '' || Number.isNaN(parsedValue)) {
      setDisplayWindowInputValue((displayWindowMs / 1000).toFixed(1));
      return;
    }

    applyDisplayWindowValue(parsedValue * 1000);
  };

  const applyActivityDisplaySensitivityValue = (nextValue: number) => {
    const clampedValue = Math.max(0.5, Math.min(1.5, nextValue));
    setActivityDisplaySensitivity(Math.round(clampedValue * 10) / 10);
  };

  const handleActivityDisplaySensitivityChange = (delta: number) => {
    applyActivityDisplaySensitivityValue(activityDisplaySensitivity + delta);
  };

  const handleActivityDisplaySensitivityInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setActivityDisplaySensitivityInputValue(e.target.value);
  };

  const commitActivityDisplaySensitivityInputValue = () => {
    const parsedValue = Number.parseFloat(activityDisplaySensitivityInputValue);
    if (activityDisplaySensitivityInputValue.trim() === '' || Number.isNaN(parsedValue)) {
      setActivityDisplaySensitivityInputValue(activityDisplaySensitivity.toFixed(1));
      return;
    }

    applyActivityDisplaySensitivityValue(parsedValue);
  };

  const handleNumericInputKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    commitValue: () => void
  ) => {
    if (e.key !== 'Enter') {
      return;
    }

    commitValue();
    e.currentTarget.blur();
  };

  const handleSignalSourceChange = (mode: SignalSourceMode) => {
    void selectSignalSourceMode(mode);
  };

  const handleMainStreamToggle = () => {
    if (liveConnectionStatus === 'connecting') {
      return;
    }

    if (isStreaming) {
      void stopStream();
      return;
    }

    void startStream();
  };

  const getFeedbackConfig = () => {
    switch (feedbackState) {
      case 'ready':
        return {
          text: 'Start',
          color: 'text-cyan-400',
          bgColor: 'bg-cyan-400/10',
          borderColor: 'border-cyan-400/30',
          instruction: 'Pinch and hold above the line'
        };
      case 'recording':
        return {
          text: 'Recording',
          color: 'text-blue-400',
          bgColor: 'bg-blue-400/10',
          borderColor: 'border-blue-400/30',
          instruction: 'Keep the signal steady'
        };
      case 'good':
        return {
          text: 'Good Sample',
          color: 'text-emerald-400',
          bgColor: 'bg-emerald-400/10',
          borderColor: 'border-emerald-400/30',
          instruction: 'Well done! Continue...'
        };
      case 'weak':
        return {
          text: 'Too Weak',
          color: 'text-amber-400',
          bgColor: 'bg-amber-400/10',
          borderColor: 'border-amber-400/30',
          instruction: 'Use stronger activation'
        };
      case 'noisy':
        return {
          text: 'Too Noisy',
          color: 'text-orange-400',
          bgColor: 'bg-orange-400/10',
          borderColor: 'border-orange-400/30',
          instruction: 'Relax and try again'
        };
      case 'short':
        return {
          text: 'Too Short',
          color: 'text-red-400',
          bgColor: 'bg-red-400/10',
          borderColor: 'border-red-400/30',
          instruction: 'Hold the gesture longer'
        };
    }
  };
  
  const getSampleQualityConfig = (quality?: SampleQuality) => {
    switch (quality) {
      case 'good':
        return {
          text: 'Good Sample',
          color: 'text-emerald-400',
          borderColor: 'border-emerald-400/40',
          shadowColor: 'shadow-emerald-400/20',
          gradientStart: '#10b981',
          gradientEnd: '#059669'
        };
      case 'weak':
        return {
          text: 'Too Weak',
          color: 'text-amber-400',
          borderColor: 'border-amber-400/40',
          shadowColor: 'shadow-amber-400/20',
          gradientStart: '#f59e0b',
          gradientEnd: '#d97706'
        };
      case 'noisy':
        return {
          text: 'Too Noisy',
          color: 'text-orange-400',
          borderColor: 'border-orange-400/40',
          shadowColor: 'shadow-orange-400/20',
          gradientStart: '#fb923c',
          gradientEnd: '#ea580c'
        };
      default:
        return {
          text: 'Unknown',
          color: 'text-white/60',
          borderColor: 'border-white/20',
          shadowColor: 'shadow-white/10',
          gradientStart: '#22d3ee',
          gradientEnd: '#06b6d4'
        };
    }
  };

  const feedback = getFeedbackConfig();
  const latestRecordingSignal = recordingSignalData[recordingSignalData.length - 1];
  const latestDisplaySignal = signalData[signalData.length - 1];
  const latestSignal = latestRecordingSignal ?? latestDisplaySignal;
  const recordingSecondsRemaining = Math.max(
    0,
    (segmentDurationMs - Math.round(recordingProgress * segmentDurationMs)) / 1000
  );
  const progressCircleRadius = 26;
  const progressCircleCircumference = 2 * Math.PI * progressCircleRadius;
  const progressCircleOffset = progressCircleCircumference * (1 - recordingProgress);
  const chartWindowEnd = Math.max(
    signalData[signalData.length - 1]?.time ?? 0,
    recordingSignalData[recordingSignalData.length - 1]?.time ?? 0,
    Date.now()
  );
  const chartWindowStart = chartWindowEnd - displayWindowMs;
  const activityChartData = signalData.filter((point) => point.time >= chartWindowStart);
  const rawChartData = recordingSignalData.filter((point) => point.time >= chartWindowStart);
  const activeSegmentEnd = recordingStartTime !== null
    ? Math.min(recordingStartTime + segmentDurationMs, chartWindowEnd)
    : null;
  const rawValues = rawChartData.map((point) => point.raw);
  const rawMin = rawValues.length > 0 ? Math.min(...rawValues) : -1;
  const rawMax = rawValues.length > 0 ? Math.max(...rawValues) : 1;
  const rawRange = Math.max(rawMax - rawMin, 0.0001);
  const rawDomain: [number, number] = [
    rawMin - rawRange * 0.15,
    rawMax + rawRange * 0.15,
  ];
  const chartWindowSeconds = displayWindowMs / 1000;
  const activityTickCount = 4;
  const activityTimeTicks = Array.from({ length: activityTickCount }, (_, index) => {
    const ratio = index / (activityTickCount - 1);
    const secondsFromNow = chartWindowSeconds * (1 - ratio);
    return {
      key: index,
      left: `${ratio * 100}%`,
      label: index === activityTickCount - 1 ? 'now' : `-${secondsFromNow.toFixed(secondsFromNow >= 2 ? 0 : 1)}s`,
    };
  });
  const segmentLabelLeft = recordingStartTime !== null
    ? Math.max(0, Math.min(84, ((recordingStartTime - chartWindowStart) / displayWindowMs) * 100))
    : null;
  // Determine graph glow based on signal crossing threshold
  const isAboveThreshold = signalSourceMode === 'live'
    ? (latestSignal?.envelope ?? 0) > threshold
    : (latestSignal?.value ?? 0) > threshold;
  const signalSourceLabels: SignalSourceLabel = {
    mock: 'Mock',
    live: 'Connect Ganglion'
  };
  const liveStatusText =
    !isStreaming && liveConnectionStatus !== 'connecting' && liveConnectionStatus !== 'error'
      ? `${signalSourceMode === 'live' ? 'Live' : 'Mock'}: Idle`
      : liveConnectionStatus === 'streaming'
      ? `Ganglion: Streaming${liveDeviceName ? ` (${liveDeviceName})` : ''}`
      : liveConnectionStatus === 'connected'
      ? `Ganglion: Connected${liveDeviceName ? ` (${liveDeviceName})` : ''}`
      : liveConnectionStatus === 'connecting'
      ? 'Ganglion: Connecting'
      : liveConnectionStatus === 'error'
      ? `Ganglion: ${liveConnectionMessage}`
      : 'Ganglion: Disconnected';
  const selectedChannelLabel = `Channel ${selectedChannelIndex + 1}`;
  const mainStreamControlLabel =
    liveConnectionStatus === 'connecting'
      ? 'Connecting...'
      : isStreaming
      ? signalSourceMode === 'live'
        ? 'Stop Live'
        : 'Pause'
      : signalSourceMode === 'live'
      ? 'Connect'
      : 'Start';
  const sourceModeLabel = signalSourceMode === 'live' ? 'Live Training' : 'Mock Training';
  const sourceModeDescription =
    signalSourceMode === 'live'
      ? liveDeviceName
        ? `Ganglion ready: ${liveDeviceName}`
        : 'Use Ganglion for real EMG sample collection'
      : 'Use synthetic signal for development and UI checks';
  const connectionStatusLabel =
    !isStreaming && liveConnectionStatus !== 'connecting' && liveConnectionStatus !== 'error'
      ? 'Idle'
      : 
    liveConnectionStatus === 'streaming' || liveConnectionStatus === 'connected'
      ? 'Connected'
      : liveConnectionStatus === 'connecting'
      ? 'Connecting...'
      : liveConnectionStatus === 'error'
      ? 'Error'
      : 'Disconnected';
  const statusDotClass =
    liveConnectionStatus === 'streaming' || liveConnectionStatus === 'connected'
      ? 'bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.35)]'
      : liveConnectionStatus === 'connecting'
      ? 'bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.25)]'
      : 'bg-white/25';

  const buildExportSamplesByLabel = (): Record<string, ExportSample[]> => {
    const exportedSamples: Record<string, ExportSample[]> = {};

    for (const gesture of gestures) {
      exportedSamples[gesture.name] = (gestureData[gesture.id]?.samples ?? [])
        .filter((sample) => isRecordedSampleStatus(sample.status) && sample.waveformData && sample.waveformData.length > 0)
        .map((sample) => {
          const waveformData = sample.waveformData ?? [];
          const firstPointTime = waveformData[0]?.time ?? sample.timestamp ?? Date.now();
          const lastPointTime = waveformData[waveformData.length - 1]?.time ?? firstPointTime;
          const timestamp = sample.timestamp ?? firstPointTime;
          const duration = waveformData.length > 1
            ? Math.max(0, lastPointTime - firstPointTime)
            : segmentDurationMs;

          return {
            id: `${gesture.id}-${sample.id}-${timestamp}`,
            label: gesture.name,
            timestamp,
            data: waveformData.map((point) => point.value),
            duration
          };
        });
    }

    return exportedSamples;
  };

  const handleStartTesting = () => {
    const session = buildTrainingSession({
      gestures,
      gestureSamples: Object.fromEntries(
        gestures.map((gesture) => [gesture.id, gestureData[gesture.id]?.samples ?? []]),
      ),
      sampleTarget,
      segmentDurationMs,
    });
    setTrainingSession(session);
    setTestingSession(null);
    setActiveScreen('testing');
  };

  const handleAddGesture = () => {
    const trimmedName = newGestureName.trim();
    if (!trimmedName) {
      return;
    }

    const duplicate = gestures.some(
      (gesture) => gesture.name.toLowerCase() === trimmedName.toLowerCase(),
    );
    if (duplicate) {
      return;
    }

    const nextGesture = createGesture(trimmedName);
    setGestures((prev) => [...prev, nextGesture]);
    setGestureData((prev) => ({
      ...prev,
      [nextGesture.id]: { samples: createEmptySamples(sampleTarget) },
    }));
    setNewGestureName('');
  };

  const handleRemoveGesture = (gestureId: string) => {
    if (gestures.length <= 1) {
      return;
    }

    const hasRecordedSamples = (gestureData[gestureId]?.samples ?? []).some((sample) =>
      isRecordedSampleStatus(sample.status),
    );
    if (hasRecordedSamples) {
      return;
    }

    const nextGestures = gestures.filter((gesture) => gesture.id !== gestureId);
    setGestures(nextGestures);
    setGestureData((prev) => {
      const next = { ...prev };
      delete next[gestureId];
      return next;
    });

    if (currentGestureId === gestureId) {
      setCurrentGestureId(nextGestures[0]?.id ?? '');
      setSelectedSampleId(null);
    }
  };

  const downloadBlob = (content: BlobPart, fileName: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleExportJson = () => {
    const exportTimestamp = Date.now();
    const samplesByLabel = buildExportSamplesByLabel();
    const payload = {
      exportedAt: exportTimestamp,
      samplesByLabel
    };

    downloadBlob(
      JSON.stringify(payload, null, 2),
      `emg_dataset_${exportTimestamp}.json`,
      'application/json'
    );
  };

  const handleExportCsv = async () => {
    const exportTimestamp = Date.now();
    const samplesByLabel = buildExportSamplesByLabel();
    const allSamples = Object.values(samplesByLabel).flat();

    const metadataRows = allSamples.map((sample) => ({
      sampleId: sample.id,
      label: sample.label,
      timestamp: sample.timestamp,
      duration: sample.duration,
      sampleLength: sample.data.length
    }));

    const timeseriesRows = allSamples.flatMap((sample) => {
      const stepMs = sample.data.length > 1
        ? sample.duration / Math.max(sample.data.length - 1, 1)
        : 0;

      return sample.data.map((value, index) => ({
        sampleId: sample.id,
        label: sample.label,
        index,
        timeOffset: Number((index * stepMs).toFixed(3)),
        value
      }));
    });

    const metadataFrame = new dfd.DataFrame(metadataRows);
    const timeseriesFrame = new dfd.DataFrame(timeseriesRows);
    const metadataCsv = await Promise.resolve(dfd.toCSV(metadataFrame, { download: false })) as string;
    const timeseriesCsv = await Promise.resolve(dfd.toCSV(timeseriesFrame, { download: false })) as string;

    downloadBlob(metadataCsv, `emg_dataset_${exportTimestamp}_metadata.csv`, 'text/csv;charset=utf-8;');
    downloadBlob(timeseriesCsv, `emg_dataset_${exportTimestamp}_timeseries.csv`, 'text/csv;charset=utf-8;');
  };

  if (activeScreen === 'testing' && trainingSession) {
    return (
      <TestingScreen
        trainingSession={trainingSession}
        onSessionComplete={setTestingSession}
        onShowResults={() => setActiveScreen('results')}
        onExit={() => setActiveScreen('training')}
        settings={testingSettings}
        onSettingsChange={setTestingSettings}
      />
    );
  }

  if (activeScreen === 'results' && testingSession) {
    return (
      <ResultScreen
        testingSession={testingSession}
        onRetrain={() => setActiveScreen('training')}
        onTestAgain={() => setActiveScreen('testing')}
      />
    );
  }

  return (
    <div className="size-full bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center p-8">
      <div className="w-full max-w-5xl flex flex-col gap-8">
        {/* 1. Objective Header */}
        <div className="flex items-end justify-between">
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline gap-3">
              <h1 className="text-3xl font-light text-white/90">
                Perform Gesture:
              </h1>
              
              {/* Gesture Selector */}
              <div className="relative" ref={gestureDropdownRef}>
                <button
                  onClick={() => setIsGestureDropdownOpen(!isGestureDropdownOpen)}
                  className="flex items-center gap-2 px-4 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-colors group"
                >
                  <span className="text-2xl font-medium text-white">{currentGesture?.name}</span>
                  <ChevronDown className={`w-5 h-5 text-white/60 transition-transform ${isGestureDropdownOpen ? 'rotate-180' : ''}`} />
                </button>
                
                <AnimatePresence>
                  {isGestureDropdownOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: -8, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -8, scale: 0.95 }}
                      transition={{ duration: 0.15 }}
                      className="absolute top-full mt-2 left-0 min-w-[140px] bg-slate-800/95 backdrop-blur-sm border border-white/10 rounded-lg shadow-2xl overflow-hidden z-10"
                    >
                      {gestures.map((gesture) => (
                        <button
                          key={gesture.id}
                          onClick={() => {
                            if (gesture.id !== currentGestureId) {
                              setCurrentGestureId(gesture.id);
                              setSelectedSampleId(null);
                              setShowGestureChangeMessage(true);
                              setTimeout(() => setShowGestureChangeMessage(false), 2000);
                            }
                            setIsGestureDropdownOpen(false);
                          }}
                          className={`w-full px-4 py-2.5 text-left text-sm transition-colors ${
                            gesture.id === currentGestureId
                              ? 'bg-cyan-400/10 text-cyan-400'
                              : 'text-white/70 hover:bg-white/10 hover:text-white'
                          }`}
                        >
                          {gesture.name}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              
              {/* Gesture Change Message */}
              <AnimatePresence>
                {showGestureChangeMessage && (
                  <motion.div
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    transition={{ duration: 0.2 }}
                    className="px-3 py-1 bg-cyan-400/10 border border-cyan-400/30 rounded-lg text-sm text-cyan-400"
                  >
                    Now training: {currentGesture?.name}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            
            <div className="flex flex-col gap-1">
              <p className="text-lg text-white/50">
                Minimum required: {minRequired}
              </p>
              <p className="text-lg text-emerald-400/80">
                Collected: {samplesCollected}
              </p>
            </div>
          </div>
          
          <Sheet open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
            <SheetTrigger asChild>
              <button
                className="flex items-center justify-center rounded-lg border border-white/10 bg-white/5 p-2 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                title="Open settings"
              >
                <Settings2 className="w-4 h-4" />
              </button>
            </SheetTrigger>
            <SheetContent side="right" className="border-white/10 bg-slate-900 text-white sm:max-w-md">
              <SheetHeader className="border-b border-white/10 pb-4">
                <SheetTitle className="text-white">Session Settings</SheetTitle>
                <SheetDescription className="text-white/50">
                  Adjust capture behavior without changing the training screen.
                </SheetDescription>
              </SheetHeader>

              <div className="flex flex-col gap-6 overflow-y-auto px-4 pb-6">
                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div>
                    <p className="text-sm font-medium text-white/90">Signal Source</p>
                    <p className="text-xs text-white/45">Switch between local mock data and the Ganglion connection.</p>
                  </div>
                  <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-slate-950/50 p-1">
                    <button
                      onClick={() => handleSignalSourceChange('mock')}
                      className={`flex-1 px-3 py-1.5 text-sm rounded-md transition-colors ${
                        signalSourceMode === 'mock'
                          ? 'bg-cyan-400/15 text-cyan-300'
                          : 'text-white/60 hover:text-white hover:bg-white/5'
                      }`}
                      title="Use mock signal source"
                    >
                      {signalSourceLabels.mock}
                    </button>
                    <button
                      onClick={() => handleSignalSourceChange('live')}
                      className={`flex-1 px-3 py-1.5 text-sm rounded-md transition-colors ${
                        signalSourceMode === 'live'
                          ? 'bg-cyan-400/15 text-cyan-300'
                          : 'text-white/60 hover:text-white hover:bg-white/5'
                      }`}
                      title="Use OpenBCI Ganglion over browser Bluetooth"
                    >
                      {signalSourceLabels.live}
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void startStream()}
                      disabled={isStreaming || liveConnectionStatus === 'connecting'}
                      className="flex-1 rounded-lg border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-sm text-cyan-200 transition-colors hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {liveConnectionStatus === 'connecting' ? 'Connecting...' : 'Start Stream'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void stopStream()}
                      disabled={!isStreaming && liveConnectionStatus !== 'connecting'}
                      className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-sm text-white/75 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Stop Stream
                    </button>
                  </div>
                  <div className="space-y-1 text-xs text-white/45">
                    <div>{signalSourceMode === 'live' ? liveStatusText : isStreaming ? 'Mock: Running' : 'Mock: Idle'}</div>
                    <div>
                      {signalSourceMode === 'live'
                        ? `Samples: ${livePacketCount}`
                        : isStreaming
                        ? 'Mock stream running'
                        : `Browser BLE: ${isBluetoothAvailable ? 'Available' : 'Unavailable'}`}
                    </div>
                    <div>
                      {signalSourceMode === 'live'
                        ? `${selectedChannelLabel} | Display ${(latestDisplaySignal?.value ?? 0).toFixed(2)}`
                        : `Value ${(latestSignal?.value ?? 0).toFixed(2)}`}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${statusDotClass}`} />
                    <p className="text-sm font-medium text-white/90">Connection Status</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-xs text-white/55">
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Signal Mode</div>
                      <div className="mt-1 text-sm text-white/85">{signalSourceMode === 'live' ? 'Live' : 'Mock'}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Status</div>
                      <div className="mt-1 text-sm text-white/85">{connectionStatusLabel}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Ganglion Channel</div>
                      <div className="mt-1 text-sm text-white/85">{selectedChannelLabel}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Device</div>
                      <div className="mt-1 text-sm text-white/85">
                        {signalSourceMode === 'live' ? (liveDeviceName ?? 'Not connected') : 'Mock source'}
                      </div>
                    </div>
                  </div>
                  {liveConnectionStatus === 'error' && (
                    <p className="text-xs text-amber-300/85">{liveConnectionMessage}</p>
                  )}
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-white/90">Ganglion Channel</p>
                      <p className="text-xs text-white/45">Select which decoded Ganglion channel drives live capture and display.</p>
                    </div>
                    <span className="text-sm text-white/75">{selectedChannelIndex + 1}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {[0, 1, 2, 3].map((channelIndex) => (
                      <button
                        key={channelIndex}
                        type="button"
                        onClick={() => setSelectedChannelIndex(channelIndex)}
                        className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                          selectedChannelIndex === channelIndex
                            ? 'border-cyan-400/30 bg-cyan-400/15 text-cyan-300'
                            : 'border-white/10 bg-slate-950/50 text-white/70 hover:bg-white/10 hover:text-white'
                        }`}
                      >
                        {channelIndex + 1}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div>
                    <p className="text-sm font-medium text-white/90">Gesture Classes</p>
                    <p className="text-xs text-white/45">Add or remove gestures used for training and testing.</p>
                  </div>
                  <div className="flex flex-col gap-2">
                    {gestures.map((gesture) => {
                      const recordedCount =
                        gestureData[gesture.id]?.samples.filter((sample) =>
                          isRecordedSampleStatus(sample.status),
                        ).length ?? 0;
                      const canRemove = gestures.length > 1 && recordedCount === 0;

                      return (
                        <div
                          key={gesture.id}
                          className="flex items-center justify-between rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2"
                        >
                          <span className="text-sm text-white/85">{gesture.name}</span>
                          <button
                            type="button"
                            onClick={() => handleRemoveGesture(gesture.id)}
                            disabled={!canRemove}
                            className="rounded-md border border-white/10 px-2 py-1 text-xs text-white/60 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Remove
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={newGestureName}
                      onChange={(event) => setNewGestureName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          handleAddGesture();
                        }
                      }}
                      placeholder="New gesture name"
                      className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-sm text-white/80"
                    />
                    <button
                      type="button"
                      onClick={handleAddGesture}
                      className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-sm text-cyan-300 transition-colors hover:bg-cyan-400/15"
                    >
                      Add
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-white/90">Threshold</p>
                      <p className="text-xs text-white/45">Set the signal level that starts a recording.</p>
                    </div>
                    <span className="text-sm text-white/75">{(threshold * 100).toFixed(0)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0.2"
                    max="0.9"
                    step="0.05"
                    value={threshold}
                    onChange={handleThresholdChange}
                    className="w-full accent-amber-500"
                  />
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-white/90">Target Samples</p>
                      <p className="text-xs text-white/45">Set how many samples to collect for the current gesture.</p>
                    </div>
                    <span className="text-sm text-white/75">{sampleTarget}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleTargetSampleChange(-1)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      step={1}
                      value={targetSamplesInputValue}
                      onChange={handleTargetSampleInputChange}
                      onBlur={commitTargetSamplesInputValue}
                      onKeyDown={(e) => handleNumericInputKeyDown(e, commitTargetSamplesInputValue)}
                      className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-center text-sm text-white/80 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <button
                      onClick={() => handleTargetSampleChange(1)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      +
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-white/90">Segment Duration</p>
                      <p className="text-xs text-white/45">Fixed capture length after threshold crossing.</p>
                    </div>
                    <span className="text-sm text-white/75">{segmentDurationMs} ms ({(segmentDurationMs / 1000).toFixed(1)} s)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleSegmentDurationChange(-100)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={400}
                      max={3000}
                      step={100}
                      value={segmentDurationInputValue}
                      onChange={handleSegmentDurationInputChange}
                      onBlur={commitSegmentDurationInputValue}
                      onKeyDown={(e) => handleNumericInputKeyDown(e, commitSegmentDurationInputValue)}
                      className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-center text-sm text-white/80 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <button
                      onClick={() => handleSegmentDurationChange(100)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      +
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-white/90">Display Window</p>
                      <p className="text-xs text-white/45">Set how many seconds are visible in both live charts.</p>
                    </div>
                    <span className="text-sm text-white/75">{(displayWindowMs / 1000).toFixed(1)} s</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleDisplayWindowChange(-0.5)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={2}
                      max={10}
                      step={0.5}
                      value={displayWindowInputValue}
                      onChange={handleDisplayWindowInputChange}
                      onBlur={commitDisplayWindowInputValue}
                      onKeyDown={(e) => handleNumericInputKeyDown(e, commitDisplayWindowInputValue)}
                      className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-center text-sm text-white/80 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <button
                      onClick={() => handleDisplayWindowChange(0.5)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      +
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-white/90">Activity Display Sensitivity</p>
                      <p className="text-xs text-white/45">Lower values add headroom. Higher values make weaker signals easier to see.</p>
                    </div>
                    <span className="text-sm text-white/75">{activityDisplaySensitivity.toFixed(1)}x</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleActivityDisplaySensitivityChange(-0.1)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={0.5}
                      max={1.5}
                      step={0.1}
                      value={activityDisplaySensitivityInputValue}
                      onChange={handleActivityDisplaySensitivityInputChange}
                      onBlur={commitActivityDisplaySensitivityInputValue}
                      onKeyDown={(e) => handleNumericInputKeyDown(e, commitActivityDisplaySensitivityInputValue)}
                      className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-center text-sm text-white/80 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <button
                      onClick={() => handleActivityDisplaySensitivityChange(0.1)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      +
                    </button>
                  </div>
                </div>

                <details className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <summary className="cursor-pointer list-none text-sm font-medium text-white/90">
                    Live Diagnostics
                  </summary>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-white/55">
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Channel</div>
                      <div className="mt-1 text-sm text-white/85">{selectedChannelLabel}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Sample Rate</div>
                      <div className="mt-1 text-sm text-white/85">{liveSampleRateHz.toFixed(0)} Hz</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Raw</div>
                      <div className="mt-1 text-sm text-white/85">{(latestRecordingSignal?.raw ?? 0).toFixed(6)}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Envelope</div>
                      <div className="mt-1 text-sm text-white/85">{(latestRecordingSignal?.envelope ?? 0).toFixed(3)}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Display</div>
                      <div className="mt-1 text-sm text-white/85">{(latestDisplaySignal?.value ?? 0).toFixed(3)}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Display Scale</div>
                      <div className="mt-1 text-sm text-white/85">{liveDisplayScale.toFixed(3)}</div>
                    </div>
                  </div>
                </details>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div>
                    <p className="text-sm font-medium text-white/90">Dataset Summary</p>
                    <p className="text-xs text-white/45">Quick overview of collected samples and current session settings.</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-[11px] text-white/40">Total Samples</div>
                      <div className="mt-1 text-lg text-white/90">{totalSamplesCollected}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-[11px] text-white/40">{currentGesture?.name} Samples</div>
                      <div className="mt-1 text-lg text-white/90">{samplesCollected}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {samplesPerGesture.map(({ gesture, count }) => (
                      <div
                        key={gesture}
                        className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2 text-center"
                      >
                        <div className="text-[11px] text-white/40">{gesture}</div>
                        <div className="mt-1 text-sm text-white/85">{count}</div>
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-xs text-white/55">
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Segment Duration</div>
                      <div className="mt-1 text-sm text-white/85">{(segmentDurationMs / 1000).toFixed(1)} s</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Display Window</div>
                      <div className="mt-1 text-sm text-white/85">{(displayWindowMs / 1000).toFixed(1)} s</div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div>
                    <p className="text-sm font-medium text-white/90">Export Dataset</p>
                    <p className="text-xs text-white/45">Download the current recorded samples as JSON or CSV.</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleExportJson}
                      className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      Export JSON
                    </button>
                    <button
                      onClick={() => void handleExportCsv()}
                      className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      Export CSV
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div>
                    <p className="text-sm font-medium text-white/90">Clear Dataset</p>
                    <p className="text-xs text-white/45">Remove all recorded samples for demos, resets, or a fresh study session.</p>
                  </div>
                  <button
                    type="button"
                    onClick={handleClearDataset}
                    className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300 transition-colors hover:bg-red-500/20 hover:text-red-200"
                  >
                    Clear Dataset
                  </button>
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>

        {/* 2. Main Signal Visualization */}
        <div className={`bg-slate-900/50 rounded-2xl border transition-all duration-300 p-6 shadow-2xl backdrop-blur-sm ${
          highlightSegment === 'good' 
            ? 'border-emerald-400/40 shadow-emerald-400/20' 
            : highlightSegment === 'bad'
            ? 'border-amber-400/40 shadow-amber-400/20'
            : isAboveThreshold
            ? 'border-cyan-400/30 shadow-cyan-400/10'
            : 'border-white/5'
        }`}>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-white/90">Activity / Envelope</p>
              <p className="text-xs text-white/45">Smoothed activity signal used for thresholding and segmentation.</p>
            </div>
            <button
              type="button"
              onClick={() => setShowRawSignal((prev) => !prev)}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2 text-xs text-white/75 transition-colors hover:bg-white/10 hover:text-white"
            >
              <span>{showRawSignal ? 'Hide Raw Signal' : 'Show Raw Signal'}</span>
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showRawSignal ? 'rotate-180' : ''}`} />
            </button>
          </div>
          <div className="h-80 relative">
            <div className="pointer-events-none absolute left-3 top-2 z-10 rounded-md bg-slate-950/45 px-2 py-1 text-[11px] text-white/55 backdrop-blur-sm">
              Window: {chartWindowSeconds.toFixed(1)} s
            </div>
            {recordingStartTime !== null && activeSegmentEnd !== null && segmentLabelLeft !== null && (
              <div
                className="pointer-events-none absolute top-10 z-10 rounded-md bg-cyan-400/10 px-2 py-1 text-[11px] text-cyan-200/85 backdrop-blur-sm"
                style={{ left: `${segmentLabelLeft}%` }}
              >
                Segment: {(segmentDurationMs / 1000).toFixed(1)} s
              </div>
            )}
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={activityChartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="mainSignalGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={highlightSegment === 'good' ? '#10b981' : highlightSegment === 'bad' ? '#f59e0b' : '#22d3ee'} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={highlightSegment === 'good' ? '#059669' : highlightSegment === 'bad' ? '#d97706' : '#06b6d4'} stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <XAxis 
                  dataKey="time"
                  type="number"
                  domain={[chartWindowStart, chartWindowEnd]}
                  hide 
                />
                <YAxis 
                  domain={[0, 1]}
                  hide
                />
                {recordingStartTime !== null && activeSegmentEnd !== null && (
                  <ReferenceArea
                    x1={recordingStartTime}
                    x2={activeSegmentEnd}
                    fill="#22d3ee"
                    fillOpacity={0.08}
                    ifOverflow="extendDomain"
                  />
                )}
                {/* Threshold line */}
                <ReferenceLine 
                  key="main-threshold"
                  y={threshold} 
                  stroke="#f59e0b" 
                  strokeWidth={2}
                  strokeDasharray="8 4"
                  opacity={0.6}
                />
                {/* Baseline */}
                <ReferenceLine 
                  key="main-baseline"
                  y={0}
                  stroke="#ffffff" 
                  strokeWidth={1}
                  opacity={0.2}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={highlightSegment === 'good' ? '#10b981' : highlightSegment === 'bad' ? '#f59e0b' : '#22d3ee'}
                  strokeWidth={2}
                  fill="url(#mainSignalGradient)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-x-4 bottom-2 z-10 flex items-end justify-between">
              {activityTimeTicks.map((tick) => (
                <div
                  key={tick.key}
                  className={`flex flex-col items-center ${tick.key === activityTickCount - 1 ? 'items-end' : tick.key === 0 ? 'items-start' : ''}`}
                  style={{ width: tick.key === 0 || tick.key === activityTickCount - 1 ? 'auto' : undefined }}
                >
                  <div className="mb-1 h-2 w-px bg-white/12" />
                  <span className="text-[10px] text-white/45">{tick.label}</span>
                </div>
              ))}
            </div>
          </div>
          {showRawSignal && (
            <div className="mt-4 border-t border-white/10 pt-4">
              <div className="mb-2">
                <p className="text-xs font-medium text-white/80">Raw Signal</p>
                <p className="text-[11px] text-white/45">Unchanged trace for signal quality and timing checks.</p>
              </div>
              <div className="h-28">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={rawChartData} margin={{ top: 6, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="rawSignalGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#cbd5e1" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="#475569" stopOpacity={0.03} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="time"
                      type="number"
                      domain={[chartWindowStart, chartWindowEnd]}
                      hide
                    />
                    <YAxis domain={rawDomain} hide />
                    <ReferenceLine
                      y={0}
                      stroke="#ffffff"
                      strokeWidth={1}
                      opacity={0.16}
                    />
                    <Area
                      type="monotone"
                      dataKey="raw"
                      stroke="#cbd5e1"
                      strokeWidth={1.5}
                      fill="url(#rawSignalGradient)"
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>

        {/* 3. Capture Feedback */}
        <AnimatePresence mode="wait">
          <motion.div
            key={feedbackState}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.3 }}
            className="flex flex-col gap-3 items-center"
          >
            <div className="flex flex-col items-center gap-3">
              <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-900/50 px-3 py-2 backdrop-blur-sm">
                <button
                  type="button"
                  onClick={() => handleSignalSourceChange('mock')}
                  disabled={signalSourceMode === 'mock'}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-default ${
                    signalSourceMode === 'mock'
                      ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-300'
                      : 'border-white/10 bg-transparent text-white/65 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  Mock Data
                </button>
                <button
                  type="button"
                  onClick={() => handleSignalSourceChange('live')}
                  disabled={!isBluetoothAvailable || signalSourceMode === 'live'}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    signalSourceMode === 'live'
                      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                      : 'border-white/10 bg-transparent text-white/65 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  Live Ganglion
                </button>
                <div className="ml-1 flex items-center gap-2 text-xs text-white/55">
                  <span className={`h-2 w-2 rounded-full ${statusDotClass}`} />
                  <span>{connectionStatusLabel}</span>
                </div>
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-white/85">{sourceModeLabel}</p>
                <p className="text-xs text-white/45">{sourceModeDescription}</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={handleMainStreamToggle}
                disabled={liveConnectionStatus === 'connecting'}
                className={`px-8 py-4 rounded-xl border ${feedback.borderColor} ${feedback.bgColor} backdrop-blur-sm transition-colors disabled:cursor-not-allowed disabled:opacity-70 hover:bg-white/10`}
              >
                <p className={`text-2xl font-medium ${feedback.color}`}>
                  {mainStreamControlLabel}
                </p>
              </button>
              <div className="flex h-20 w-20 items-center justify-center rounded-xl border border-white/10 bg-slate-900/50 backdrop-blur-sm">
                <div
                  className={`relative flex h-16 w-16 items-center justify-center rounded-full border bg-slate-900/60 transition-opacity ${
                    isRecording
                      ? 'border-cyan-400/20 opacity-100'
                      : 'border-white/10 opacity-35'
                  }`}
                >
                  <svg className="absolute inset-0 -rotate-90" viewBox="0 0 64 64">
                    <circle
                      cx="32"
                      cy="32"
                      r={progressCircleRadius}
                      fill="none"
                      stroke="rgba(255,255,255,0.12)"
                      strokeWidth="4"
                    />
                    <circle
                      cx="32"
                      cy="32"
                      r={progressCircleRadius}
                      fill="none"
                      stroke={isRecording ? '#22d3ee' : 'rgba(255,255,255,0.18)'}
                      strokeWidth="4"
                      strokeLinecap="round"
                      strokeDasharray={progressCircleCircumference}
                      strokeDashoffset={isRecording ? progressCircleOffset : progressCircleCircumference}
                    />
                  </svg>
                  <div className="relative text-center">
                    <div className={`text-xs font-medium ${isRecording ? 'text-cyan-300' : 'text-white/45'}`}>
                      {isRecording ? `${Math.ceil(recordingSecondsRemaining * 10) / 10}s` : '--'}
                    </div>
                    <div className="text-[10px] text-white/50">
                      {isRecording ? `${Math.round(recordingProgress * 100)}%` : 'idle'}
                    </div>
                  </div>
                </div>
              </div>
              {isAllSamplesCollected && (
                <button
                  type="button"
                  onClick={handleStartTesting}
                  className="px-8 py-4 rounded-xl border border-cyan-400/30 bg-cyan-400/10 backdrop-blur-sm transition-colors hover:bg-cyan-400/15"
                >
                  <p className="text-2xl font-medium text-cyan-400">Test</p>
                </button>
              )}
            </div>
            <p className="text-lg text-white/60 font-light">
              {feedback.instruction}
            </p>
          </motion.div>
        </AnimatePresence>

        {/* 4. Interactive Sample Slots */}
        <div className="flex flex-col gap-4">
          {/* Sample Preview Panel - appears above sample row */}
          <AnimatePresence>
            {selectedSampleId !== null && currentSamples[selectedSampleId] && isRecordedSampleStatus(currentSamples[selectedSampleId].status) && (
              <motion.div
                ref={previewPanelRef}
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.95 }}
                transition={{ duration: 0.2 }}
                className={`bg-slate-900/80 rounded-xl border ${getSampleQualityConfig(currentSamples[selectedSampleId].quality).borderColor} ${getSampleQualityConfig(currentSamples[selectedSampleId].quality).shadowColor} shadow-xl backdrop-blur-sm p-4`}
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-sm font-medium text-white/90">Sample #{selectedSampleId + 1}</h3>
                    <p className={`text-xs ${getSampleQualityConfig(currentSamples[selectedSampleId].quality).color} mt-0.5`}>
                      {getSampleQualityConfig(currentSamples[selectedSampleId].quality).text}
                    </p>
                  </div>
                  <button
                    onClick={() => setSelectedSampleId(null)}
                    className="p-1 rounded hover:bg-white/10 transition-colors"
                    title="Close preview"
                  >
                    <X className="w-4 h-4 text-white/60" />
                  </button>
                </div>
                
                {/* Mini waveform preview */}
                <div className="h-24 mb-3">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={currentSamples[selectedSampleId].waveformData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                      <defs>
                        <linearGradient id={`previewGradient-${selectedSampleId}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={getSampleQualityConfig(currentSamples[selectedSampleId].quality).gradientStart} stopOpacity={0.4} />
                          <stop offset="95%" stopColor={getSampleQualityConfig(currentSamples[selectedSampleId].quality).gradientEnd} stopOpacity={0.05} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="time" hide />
                      <YAxis domain={[0, 1]} hide />
                      <ReferenceLine 
                        y={threshold} 
                        stroke="#f59e0b" 
                        strokeWidth={1}
                        strokeDasharray="4 2"
                        opacity={0.5}
                      />
                      <Area
                        type="monotone"
                        dataKey="value"
                        stroke={getSampleQualityConfig(currentSamples[selectedSampleId].quality).gradientStart}
                        strokeWidth={1.5}
                        fill={`url(#previewGradient-${selectedSampleId})`}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                
                {/* Action buttons */}
                <div className="flex gap-2">
                  <button
                    onClick={() => handleRemoveSample(selectedSampleId)}
                    className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 rounded-lg transition-colors text-red-400 text-sm"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete Sample
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          
          {/* Sample slots row */}
          <div className="flex gap-2 justify-center flex-wrap">
            {currentSamples.map((sample) => (
              <motion.div
                key={sample.id}
                data-sample-slot
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: sample.id * 0.03 }}
                onMouseEnter={() => isRecordedSampleStatus(sample.status) && setHoveredSample(sample.id)}
                onMouseLeave={() => setHoveredSample(null)}
                onClick={() => isRecordedSampleStatus(sample.status) && setSelectedSampleId(selectedSampleId === sample.id ? null : sample.id)}
                className="relative group"
              >
                <button
                  disabled={sample.status === 'empty'}
                  className={`h-3 w-12 rounded-full transition-all duration-300 ${
                    isRecordedSampleStatus(sample.status)
                      ? `${
                          sample.quality === 'weak' 
                            ? 'bg-amber-400 shadow-lg shadow-amber-400/30'
                            : sample.quality === 'noisy'
                            ? 'bg-orange-400 shadow-lg shadow-orange-400/30'
                            : 'bg-emerald-400 shadow-lg shadow-emerald-400/30'
                        } cursor-pointer hover:brightness-110`
                      : 'bg-white/10 cursor-default'
                  } ${selectedSampleId === sample.id ? 'ring-2 ring-white/50 brightness-125' : ''} ${hoveredSample === sample.id && selectedSampleId !== sample.id ? 'ring-2 ring-white/30' : ''}`}
                />
              </motion.div>
            ))}
          </div>
          
          {/* Redo Last Sample button */}
          <div className="flex justify-center">
            <button
              onClick={handleRedoLast}
              disabled={samplesCollected === 0}
              className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 disabled:bg-white/5 disabled:opacity-40 border border-white/10 rounded-lg transition-colors text-white/70 disabled:text-white/40 text-sm"
            >
              <RotateCcw className="w-4 h-4" />
              Redo Last Sample
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
