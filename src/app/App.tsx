import { useState, useEffect, useRef, useCallback } from 'react';
import { AreaChart, Area, XAxis, YAxis, ReferenceLine, ResponsiveContainer } from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import { X, Settings2, RotateCcw, Target, Trash2, ChevronDown } from 'lucide-react';
import { useSignalSource, type SignalSourceMode } from './useSignalSource';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from './components/ui/sheet';

type FeedbackState = 'ready' | 'recording' | 'good' | 'weak' | 'noisy' | 'short';
type SampleQuality = 'good' | 'weak' | 'noisy';
type GestureName = 'Pinch' | 'Squeeze' | 'Relax';

interface Sample {
  id: number;
  status: 'collected' | 'empty';
  timestamp?: number;
  waveformData?: { time: number; value: number }[];
  quality?: SampleQuality;
}

interface GestureData {
  samples: Sample[];
}

type SignalSourceLabel = Record<SignalSourceMode, string>;

const DEFAULT_SEGMENT_DURATION_MS = 1200;
const MIN_SEGMENT_POINTS = 6;

export default function App() {
  const [feedbackState, setFeedbackState] = useState<FeedbackState>('ready');
  const [threshold, setThreshold] = useState(0.6);
  const [segmentDurationMs, setSegmentDurationMs] = useState(DEFAULT_SEGMENT_DURATION_MS);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(null);
  const [recordingProgress, setRecordingProgress] = useState(0);
  const [currentCapturedSegment, setCurrentCapturedSegment] = useState<{ time: number; value: number }[]>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [minRequired, setMinRequired] = useState(8);
  const [sampleTarget, setSampleTarget] = useState(12);
  const [selectedSampleId, setSelectedSampleId] = useState<number | null>(null);
  const [currentGesture, setCurrentGesture] = useState<GestureName>('Pinch');
  const [isGestureDropdownOpen, setIsGestureDropdownOpen] = useState(false);
  const [showGestureChangeMessage, setShowGestureChangeMessage] = useState(false);
  const previewPanelRef = useRef<HTMLDivElement>(null);
  const gestureDropdownRef = useRef<HTMLDivElement>(null);
  const recordingStartTimeRef = useRef<number | null>(null);
  const currentCapturedSegmentRef = useRef<{ time: number; value: number }[]>([]);
  const wasAboveThresholdRef = useRef(false);
  const lastLivePointTimeRef = useRef<number | null>(null);

  const generateMockSignalValue = useCallback(() => {
    const time = Date.now();
    const baseNoise = (Math.random() - 0.5) * 0.1;

    switch (feedbackState) {
      case 'recording':
      case 'good':
        return 0.7 + Math.sin(time * 0.01) * 0.15 + baseNoise * 0.3;
      case 'weak':
        return 0.3 + Math.sin(time * 0.01) * 0.1 + baseNoise * 0.5;
      case 'noisy':
        return 0.65 + (Math.random() - 0.5) * 0.4 + Math.sin(time * 0.02) * 0.1;
      case 'short':
        return 0.75 + baseNoise * 0.2;
      default:
        return 0.15 + baseNoise * 0.8;
    }
  }, [feedbackState]);

  const {
    signalData,
    signalSourceMode,
    connectGanglion,
    useMockSignal,
    liveConnectionStatus,
    liveConnectionMessage,
    liveDeviceName,
    livePacketCount,
    isBluetoothAvailable
  } = useSignalSource(generateMockSignalValue);
  
  const availableGestures: GestureName[] = ['Pinch', 'Squeeze', 'Relax'];
  
  // Generate mock waveform data for samples
  const generateMockWaveform = (quality: SampleQuality): { time: number; value: number }[] => {
    const data: { time: number; value: number }[] = [];
    const baseTime = Date.now();
    
    for (let i = 0; i < 60; i++) {
      const time = baseTime + i * 50;
      let value = 0;
      
      switch (quality) {
        case 'good':
          value = 0.7 + Math.sin(i * 0.3) * 0.15 + (Math.random() - 0.5) * 0.05;
          break;
        case 'weak':
          value = 0.35 + Math.sin(i * 0.3) * 0.1 + (Math.random() - 0.5) * 0.08;
          break;
        case 'noisy':
          value = 0.65 + (Math.random() - 0.5) * 0.35 + Math.sin(i * 0.4) * 0.08;
          break;
      }
      
      data.push({ time, value: Math.max(0, Math.min(1, value)) });
    }
    
    return data;
  };
  
  // Initialize gesture data with different sample counts for each gesture
  const initializeGestureData = (): Record<GestureName, GestureData> => {
    const createSamples = (collectedCount: number, totalCount: number = 12): Sample[] => {
      return Array.from({ length: totalCount }, (_, i) => {
        if (i < collectedCount) {
          const qualities: SampleQuality[] = ['good', 'good', 'weak', 'good', 'noisy', 'good', 'good'];
          const quality = qualities[i % qualities.length];
          return {
            id: i,
            status: 'collected' as const,
            timestamp: Date.now() - (collectedCount - 1 - i) * 1000,
            waveformData: generateMockWaveform(quality),
            quality
          };
        }
        return {
          id: i,
          status: 'empty' as const
        };
      });
    };
    
    return {
      Pinch: { samples: createSamples(7) },
      Squeeze: { samples: createSamples(4) },
      Relax: { samples: createSamples(10) }
    };
  };
  
  const [gestureData, setGestureData] = useState<Record<GestureName, GestureData>>(initializeGestureData());
  
  const currentSamples = gestureData[currentGesture].samples;
  const [hoveredSample, setHoveredSample] = useState<number | null>(null);
  const [highlightSegment, setHighlightSegment] = useState<'good' | 'bad' | null>(null);

  const samplesCollected = currentSamples.filter(s => s.status === 'collected').length;

  // Simulate state changes for demonstration
  useEffect(() => {
    if (signalSourceMode !== 'mock' || isRecording) {
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
  }, [isRecording, signalSourceMode]);

  useEffect(() => {
    if (signalSourceMode === 'mock' || isRecording) {
      return;
    }

    const latestEnvelope = signalData.at(-1)?.envelope ?? 0;

    if (latestEnvelope > threshold) {
      setFeedbackState('recording');
      setHighlightSegment('good');
      return;
    }

    setFeedbackState('ready');
    setHighlightSegment(null);
  }, [isRecording, signalData, signalSourceMode, threshold]);

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
    if (signalData.length === 0) {
      return;
    }

    const lastProcessedTime = lastLivePointTimeRef.current;
    const newPoints = lastProcessedTime === null
      ? signalData
      : signalData.filter((point) => point.time > lastProcessedTime);

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

        const seededSegment = [{ time: point.time, value: point.value }];
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
      const nextSegment = [...currentCapturedSegmentRef.current, { time: point.time, value: point.value }];
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
        const gesture = prev[currentGesture];
        const targetIndex = gesture.samples.findIndex((sample) => sample.status === 'empty');

        if (targetIndex === -1) {
          return prev;
        }

        return {
          ...prev,
          [currentGesture]: {
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
  }, [currentGesture, isRecording, segmentDurationMs, signalData, threshold]);

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
      [currentGesture]: {
        samples: prev[currentGesture].samples.map(s => 
          s.id === sampleId ? { ...s, status: 'empty', timestamp: undefined, waveformData: undefined, quality: undefined } : s
        )
      }
    }));
    setSelectedSampleId(null);
  };

  const handleRedoLast = () => {
    const lastCollectedIndex = currentSamples.map((s, i) => s.status === 'collected' ? i : -1)
      .filter(i => i !== -1)
      .pop();
    
    if (lastCollectedIndex !== undefined) {
      handleRemoveSample(lastCollectedIndex);
    }
  };

  const handleThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setThreshold(parseFloat(e.target.value));
  };

  const handleMinRequiredChange = (delta: number) => {
    setMinRequired(prev => Math.max(1, Math.min(sampleTarget, prev + delta)));
  };

  const handleSegmentDurationChange = (delta: number) => {
    setSegmentDurationMs(prev => Math.max(400, Math.min(3000, prev + delta)));
  };

  const handleSignalSourceChange = (mode: SignalSourceMode) => {
    if (mode === 'live') {
      void connectGanglion();
      return;
    }

    void useMockSignal();
  };

  const handleTargetChange = (delta: number) => {
    const newTarget = Math.max(minRequired, Math.min(20, sampleTarget + delta));
    setSampleTarget(newTarget);
    setMinRequired(prev => Math.min(prev, newTarget));
    // Adjust samples array
    if (newTarget > currentSamples.length) {
      setGestureData(prev => ({
        ...prev,
        [currentGesture]: {
          samples: [...prev[currentGesture].samples, ...Array.from({ length: newTarget - prev[currentGesture].samples.length }, (_, i) => ({
            id: prev[currentGesture].samples.length + i,
            status: 'empty' as const
          }))]
        }
      }));
    } else if (newTarget < currentSamples.length) {
      setGestureData(prev => ({
        ...prev,
        [currentGesture]: {
          samples: prev[currentGesture].samples.slice(0, newTarget)
        }
      }));
    }
  };

  const getFeedbackConfig = () => {
    switch (feedbackState) {
      case 'ready':
        return {
          text: 'Ready',
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
  const latestSignal = signalData[signalData.length - 1];
  const recordingSecondsRemaining = Math.max(
    0,
    (segmentDurationMs - Math.round(recordingProgress * segmentDurationMs)) / 1000
  );
  const progressCircleRadius = 26;
  const progressCircleCircumference = 2 * Math.PI * progressCircleRadius;
  const progressCircleOffset = progressCircleCircumference * (1 - recordingProgress);
  // Determine graph glow based on signal crossing threshold
  const isAboveThreshold = signalSourceMode === 'live'
    ? (latestSignal?.envelope ?? 0) > threshold
    : (latestSignal?.value ?? 0) > threshold;
  const signalSourceLabels: SignalSourceLabel = {
    mock: 'Mock',
    live: 'Connect Ganglion'
  };
  const liveStatusText =
    liveConnectionStatus === 'streaming'
      ? `Ganglion: Streaming${liveDeviceName ? ` (${liveDeviceName})` : ''}`
      : liveConnectionStatus === 'connected'
      ? `Ganglion: Connected${liveDeviceName ? ` (${liveDeviceName})` : ''}`
      : liveConnectionStatus === 'connecting'
      ? 'Ganglion: Connecting'
      : liveConnectionStatus === 'error'
      ? `Ganglion: ${liveConnectionMessage}`
      : 'Ganglion: Disconnected';

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
                  <span className="text-2xl font-medium text-white">{currentGesture}</span>
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
                      {availableGestures.map((gesture) => (
                        <button
                          key={gesture}
                          onClick={() => {
                            if (gesture !== currentGesture) {
                              setCurrentGesture(gesture);
                              setSelectedSampleId(null);
                              setShowGestureChangeMessage(true);
                              setTimeout(() => setShowGestureChangeMessage(false), 2000);
                            }
                            setIsGestureDropdownOpen(false);
                          }}
                          className={`w-full px-4 py-2.5 text-left text-sm transition-colors ${
                            gesture === currentGesture
                              ? 'bg-cyan-400/10 text-cyan-400'
                              : 'text-white/70 hover:bg-white/10 hover:text-white'
                          }`}
                        >
                          {gesture}
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
                    Now training: {currentGesture}
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
                      disabled={liveConnectionStatus === 'connecting' || liveConnectionStatus === 'streaming'}
                      className={`flex-1 px-3 py-1.5 text-sm rounded-md transition-colors ${
                        signalSourceMode === 'live'
                          ? 'bg-cyan-400/15 text-cyan-300'
                          : 'text-white/60 hover:text-white hover:bg-white/5'
                      }`}
                      title="Connect OpenBCI Ganglion over browser Bluetooth"
                    >
                      {liveConnectionStatus === 'connecting' ? 'Connecting...' : signalSourceLabels.live}
                    </button>
                  </div>
                  <div className="space-y-1 text-xs text-white/45">
                    <div>{signalSourceMode === 'live' ? liveStatusText : 'Mock: Local'}</div>
                    <div>
                      {signalSourceMode === 'live'
                        ? `Samples: ${livePacketCount}`
                        : `Browser BLE: ${isBluetoothAvailable ? 'Available' : 'Unavailable'}`}
                    </div>
                    <div>
                      {signalSourceMode === 'live'
                        ? `Signal ${(latestSignal?.value ?? 0).toFixed(2)}`
                        : `Value ${(latestSignal?.value ?? 0).toFixed(2)}`}
                    </div>
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
                      <p className="text-sm font-medium text-white/90">Minimum Required Samples</p>
                      <p className="text-xs text-white/45">Set the collection goal shown for the current gesture.</p>
                    </div>
                    <span className="text-sm text-white/75">{minRequired}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleMinRequiredChange(-1)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      -
                    </button>
                    <div className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-center text-sm text-white/80">
                      Minimum required: {minRequired}
                    </div>
                    <button
                      onClick={() => handleMinRequiredChange(1)}
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
                    <span className="text-sm text-white/75">{(segmentDurationMs / 1000).toFixed(1)}s</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleSegmentDurationChange(-100)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      -
                    </button>
                    <div className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-center text-sm text-white/80">
                      Duration: {segmentDurationMs} ms
                    </div>
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
                      <p className="text-sm font-medium text-white/90">Sample Slots</p>
                      <p className="text-xs text-white/45">Adjust the number of available sample slots for this gesture.</p>
                    </div>
                    <Target className="w-4 h-4 text-white/45" />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleTargetChange(-1)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      -
                    </button>
                    <div className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-center text-sm text-white/80">
                      Target: {sampleTarget}
                    </div>
                    <button
                      onClick={() => handleTargetChange(1)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      +
                    </button>
                  </div>
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
          <div className="h-80 relative">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={signalData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="mainSignalGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={highlightSegment === 'good' ? '#10b981' : highlightSegment === 'bad' ? '#f59e0b' : '#22d3ee'} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={highlightSegment === 'good' ? '#059669' : highlightSegment === 'bad' ? '#d97706' : '#06b6d4'} stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <XAxis 
                  dataKey="time" 
                  hide 
                />
                <YAxis 
                  domain={[0, 1]}
                  hide
                />
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
          </div>
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
            <div className="flex items-center gap-4">
              <div className={`px-8 py-4 rounded-xl border ${feedback.borderColor} ${feedback.bgColor} backdrop-blur-sm`}>
                <p className={`text-2xl font-medium ${feedback.color}`}>
                  {feedback.text}
                </p>
              </div>
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
            {selectedSampleId !== null && currentSamples[selectedSampleId]?.status === 'collected' && (
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
                onMouseEnter={() => sample.status === 'collected' && setHoveredSample(sample.id)}
                onMouseLeave={() => setHoveredSample(null)}
                onClick={() => sample.status === 'collected' && setSelectedSampleId(selectedSampleId === sample.id ? null : sample.id)}
                className="relative group"
              >
                <button
                  disabled={sample.status === 'empty'}
                  className={`h-3 w-12 rounded-full transition-all duration-300 ${
                    sample.status === 'collected'
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
