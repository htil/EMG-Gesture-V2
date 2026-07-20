import React from "react";
import { ChevronLeft, LogOut, Settings2 } from "lucide-react";

import {
    useState,
    useEffect,
    useRef,
    useCallback,
    useMemo,
  } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./components/ui/sheet";
import {
  buildInferenceSample,
  buildGestureColorMap,
  buildSessionTimeline,
  buildTrialSchedule,
  calculateOverallConfidence,
  createPredictionEngine,
  createPredictionRecord,
  calculateSessionDurationMs,
  clampSetting,
  findGesture,
  formatSessionLength,
  generateChannelMockEmgSample,
  generateNoiseMockEmgSample,
  TESTING_SESSION_LIMITS,
  type Gesture,
  type PredictionRecord,
  type TestingSessionData,
  type TestingSessionSettings,
  type TrialPhase,
  type TrialSegment,
  type TrainingSessionData,
} from "./pipeline";
import { generateMockEmgSample } from "./pipeline";
import type { LiveConnectionStatus, SignalPoint, SignalSourceMode } from "./useSignalSource";
  
  type SessionState =
    | "idle"
    | "countdown"
    | "active"
    | "paused"
    | "complete";

  type TestingInputMode =
    | "replay"
    | "mock-live"
    | "live-ganglion"
    | "channel-1"
    | "channel-2"
    | "channel-3"
    | "channel-4"
    | "noise";
  
  const SESSION_DURATION = 60;
  const TARGET_INTERVAL = 4;
  const ROLLING_WINDOW_READY_RATIO = 0.8;
  const ROLLING_WINDOW_MIN_POINTS = 8;
  const TESTING_INPUT_OPTIONS: Array<{ value: TestingInputMode; label: string }> = [
    { value: "replay", label: "Replay Training" },
    { value: "mock-live", label: "Mock Live" },
    { value: "live-ganglion", label: "Live Ganglion" },
    { value: "channel-1", label: "Channel 1" },
    { value: "channel-2", label: "Channel 2" },
    { value: "channel-3", label: "Channel 3" },
    { value: "channel-4", label: "Channel 4" },
    { value: "noise", label: "Noise" },
  ];
  function CircularProgress({
    progress,
    size,
    stroke,
    color,
    children,
  }: {
    progress: number;
    size: number;
    stroke: number;
    color: string;
    children?: React.ReactNode;
  }) {
    const r = (size - stroke) / 2;
    const circ = 2 * Math.PI * r;
    const offset = circ * (1 - progress);
    return (
      <div
        className="relative"
        style={{ width: size, height: size }}
      >
        <svg
          width={size}
          height={size}
          className="rotate-[-90deg]"
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="rgba(255,255,255,0.06)"
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeDasharray={circ}
            strokeDashoffset={offset}
            strokeLinecap="round"
            style={{
              transition: "stroke-dashoffset 0.1s linear",
              filter: `drop-shadow(0 0 6px ${color})`,
            }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          {children}
        </div>
      </div>
    );
  }
  
  function ConfidenceMeter({ value }: { value: number }) {
    const color =
      value >= 90
        ? "#4ade80"
        : value >= 75
          ? "#f5a623"
          : "#ff4d6d";
    return (
      <div className="flex flex-col gap-2">
        <div className="flex justify-between items-center">
          <span className="text-xs font-medium tracking-widest uppercase text-white/50">
            Confidence
          </span>
          <span
            className="font-mono text-lg font-semibold"
            style={{ color }}
          >
            {value.toFixed(1)}%
          </span>
        </div>
        <div
          className="h-2 rounded-full overflow-hidden"
          style={{ background: "rgba(255,255,255,0.07)" }}
        >
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${value}%`,
              background: `linear-gradient(90deg, ${color}88, ${color})`,
              boxShadow: `0 0 8px ${color}88`,
            }}
          />
        </div>
      </div>
    );
  }
  
  function GestureTag({
    gestureId,
    gestureName,
    colorMap,
  }: {
    gestureId: string;
    gestureName: string;
    colorMap: ReturnType<typeof buildGestureColorMap>;
  }) {
    const color = colorMap[gestureId]?.ring ?? "#00d4ff";
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold"
        style={{
          color,
          background: `${color}1a`,
        }}
      >
        {gestureName}
      </span>
    );
  }
  
  function NumericSettingField({
    title,
    description,
    displayValue,
    inputValue,
    bounds,
    onStep,
    onInputChange,
    onCommit,
  }: {
    title: string;
    description: string;
    displayValue: string;
    inputValue: string;
    bounds: { min: number; max: number; step: number };
    onStep: (delta: number) => void;
    onInputChange: (value: string) => void;
    onCommit: () => void;
  }) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-white/90">{title}</p>
            <p className="text-xs text-white/45">{description}</p>
          </div>
          <span className="text-sm text-white/75">{displayValue}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onStep(-bounds.step)}
            className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            -
          </button>
          <input
            type="number"
            min={bounds.min}
            max={bounds.max}
            step={bounds.step}
            value={inputValue}
            onChange={(event) => onInputChange(event.target.value)}
            onBlur={onCommit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                onCommit();
                event.currentTarget.blur();
              }
            }}
            className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-center text-sm text-white/80 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <button
            type="button"
            onClick={() => onStep(bounds.step)}
            className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            +
          </button>
        </div>
      </div>
    );
  }

  export default function TestingScreen({
    trainingSession,
    recordingSignalData,
    signalSourceMode,
    isStreaming,
    startStreamForMode,
    liveConnectionStatus,
    liveConnectionMessage,
    liveDeviceName,
    selectedChannelIndex,
    isBluetoothAvailable,
    onSessionComplete,
    onShowResults,
    onExit,
    settings,
    onSettingsChange,
  }: {
    trainingSession: TrainingSessionData;
    recordingSignalData: SignalPoint[];
    signalSourceMode: SignalSourceMode;
    isStreaming: boolean;
    startStreamForMode: (mode: SignalSourceMode) => Promise<void>;
    liveConnectionStatus: LiveConnectionStatus;
    liveConnectionMessage: string;
    liveDeviceName: string | null;
    selectedChannelIndex: number;
    isBluetoothAvailable: boolean;
    onSessionComplete?: (session: TestingSessionData) => void;
    onShowResults?: () => void;
    onExit?: () => void;
    settings: TestingSessionSettings;
    onSettingsChange: React.Dispatch<React.SetStateAction<TestingSessionSettings>>;
  }) {
    const gestures = trainingSession.gestures;
    const gestureColors = useMemo(() => buildGestureColorMap(gestures), [gestures]);
    const predictionEngine = useMemo(
      () => createPredictionEngine(trainingSession),
      [trainingSession],
    );
    const modelDebugSummary = useMemo(() => predictionEngine.getModelDebugSummary(), [predictionEngine]);
    const trainingSamplesByGesture = useMemo(
      () =>
        Object.fromEntries(
          trainingSession.gestureData.map((entry) => [entry.gesture.id, entry.samples]),
        ) as Record<string, typeof trainingSession.gestureData[number]["samples"]>,
      [trainingSession],
    );

    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isExitDialogOpen, setIsExitDialogOpen] = useState(false);
    const [trialPeriodInput, setTrialPeriodInput] = useState(
      String(settings.trialPeriodMs),
    );
    const [restPeriodInput, setRestPeriodInput] = useState(
      String(settings.restPeriodMs),
    );
    const [numberOfTrialsInput, setNumberOfTrialsInput] = useState(
      String(settings.numberOfTrials),
    );
    const [predictionFrequencyInput, setPredictionFrequencyInput] = useState(
      String(settings.predictionFrequencyMs),
    );

    const sessionDurationMs = useMemo(
      () => calculateSessionDurationMs(settings),
      [settings],
    );

    const [sessionState, setSessionState] =
      useState<SessionState>("idle");
    const [countdown, setCountdown] = useState(3);
    const [timeLeft, setTimeLeft] = useState(sessionDurationMs / 1000);
    const [sessionTotalSeconds, setSessionTotalSeconds] = useState(
      sessionDurationMs / 1000,
    );
    const [sessionPhase, setSessionPhase] = useState<TrialPhase>("trial");
    const [targetGestureId, setTargetGestureId] =
      useState<string>(gestures[0]?.id ?? "");
    const [segmentTimer, setSegmentTimer] = useState(
      settings.trialPeriodMs / 1000,
    );
    const [segmentDuration, setSegmentDuration] = useState(
      settings.trialPeriodMs / 1000,
    );
    const [predictedGestureId, setPredictedGestureId] = useState<string>(
      gestures[0]?.id ?? "",
    );
    const [confidence, setConfidence] = useState(94.0);
    const [history, setHistory] =
      useState<PredictionRecord[]>([]);
    const [testingInputMode, setTestingInputMode] =
      useState<TestingInputMode>("replay");
    const [latestDebug, setLatestDebug] = useState<PredictionRecord["debug"] | undefined>(undefined);
    const [windowSkipReason, setWindowSkipReason] = useState<string>("Idle");

    const predictionsRef = useRef<PredictionRecord[]>([]);
    const sessionStartedAtRef = useRef<number | null>(null);

    // Mutable runtime state kept in refs so the session can be paused and resumed
    // without losing progress.
    const timelineRef = useRef<TrialSegment[]>([]);
    const totalMsRef = useRef(0);
    const elapsedMsRef = useRef(0);
    const counterRef = useRef(0);
    const currentTargetIdRef = useRef<string>("");
    const currentPhaseRef = useRef<TrialPhase>("trial");
    const streamSessionCutoffTimeRef = useRef<number>(0);
    const lastPredictedPointTimeRef = useRef<number | null>(null);

    useEffect(() => {
      setTrialPeriodInput(String(settings.trialPeriodMs));
    }, [settings.trialPeriodMs]);

    useEffect(() => {
      setRestPeriodInput(String(settings.restPeriodMs));
    }, [settings.restPeriodMs]);

    useEffect(() => {
      setNumberOfTrialsInput(String(settings.numberOfTrials));
    }, [settings.numberOfTrials]);

    useEffect(() => {
      setPredictionFrequencyInput(String(settings.predictionFrequencyMs));
    }, [settings.predictionFrequencyMs]);

    useEffect(() => {
      if (sessionState !== "idle") {
        return;
      }
      setTimeLeft(sessionDurationMs / 1000);
      setSessionTotalSeconds(sessionDurationMs / 1000);
      setSegmentTimer(settings.trialPeriodMs / 1000);
      setSegmentDuration(settings.trialPeriodMs / 1000);
    }, [sessionDurationMs, sessionState, settings.trialPeriodMs]);
  
    const sessionRef = useRef<ReturnType<
      typeof setInterval
    > | null>(null);
    const predictionRef = useRef<ReturnType<
      typeof setInterval
    > | null>(null);
    const countdownRef = useRef<ReturnType<
      typeof setInterval
    > | null>(null);

    const streamBackedMode = useMemo(() => {
      if (testingInputMode === "mock-live") {
        return "mock" as SignalSourceMode;
      }

      if (testingInputMode === "live-ganglion") {
        return "live" as SignalSourceMode;
      }

      return null;
    }, [testingInputMode]);

    const buildRollingWindowSample = useCallback(() => {
      if (!streamBackedMode) {
        return { sample: null, skipReason: "Not a stream-backed mode" };
      }

      if (!isStreaming) {
        return { sample: null, skipReason: "Stream inactive" };
      }

      if (signalSourceMode !== streamBackedMode) {
        return { sample: null, skipReason: "Waiting for selected source mode" };
      }

      if (recordingSignalData.length === 0) {
        return { sample: null, skipReason: "No streamed points yet" };
      }

      const sessionEligiblePoints = recordingSignalData.filter(
        (point) => point.time >= streamSessionCutoffTimeRef.current,
      );
      if (sessionEligiblePoints.length === 0) {
        return { sample: null, skipReason: "Waiting for fresh session samples" };
      }

      const windowDurationMs = trainingSession.segmentDurationMs;
      const latestTime = sessionEligiblePoints[sessionEligiblePoints.length - 1]?.time;
      if (!latestTime) {
        return { sample: null, skipReason: "Missing newest point timestamp" };
      }

      if (
        lastPredictedPointTimeRef.current !== null &&
        latestTime <= lastPredictedPointTimeRef.current
      ) {
        return { sample: null, skipReason: "No fresh samples since last prediction" };
      }

      const windowStart = latestTime - windowDurationMs;
      const windowPoints = sessionEligiblePoints.filter((point) => point.time >= windowStart);
      if (windowPoints.length < ROLLING_WINDOW_MIN_POINTS) {
        return { sample: null, skipReason: `Need at least ${ROLLING_WINDOW_MIN_POINTS} points` };
      }

      const coverageMs = (windowPoints[windowPoints.length - 1]?.time ?? latestTime) - (windowPoints[0]?.time ?? latestTime);
      if (coverageMs < windowDurationMs * ROLLING_WINDOW_READY_RATIO) {
        return { sample: null, skipReason: `Window coverage ${coverageMs.toFixed(0)} ms is not ready` };
      }

      return {
        sample: buildInferenceSample(windowPoints, windowDurationMs),
        skipReason: null,
      };
    }, [isStreaming, recordingSignalData, signalSourceMode, streamBackedMode, trainingSession.segmentDurationMs]);

    const ensureTestingSignalStream = useCallback(async () => {
      if (!streamBackedMode) {
        return true;
      }

      if (streamBackedMode === "live" && !isBluetoothAvailable) {
        return false;
      }

      if (signalSourceMode === streamBackedMode && isStreaming) {
        return true;
      }

      try {
        await startStreamForMode(streamBackedMode);
        return true;
      } catch {
        return false;
      }
    }, [isBluetoothAvailable, isStreaming, signalSourceMode, startStreamForMode, streamBackedMode]);

    const buildTestingSample = useCallback(
      (expectedGesture: Gesture, counter: number) => {
        if (streamBackedMode) {
          return buildRollingWindowSample().sample;
        }

        if (testingInputMode === "noise") {
          return generateNoiseMockEmgSample(trainingSession.segmentDurationMs);
        }

        if (testingInputMode.startsWith("channel-")) {
          const channelIndex = Number.parseInt(testingInputMode.split("-")[1], 10) - 1;
          return generateChannelMockEmgSample(
            Number.isNaN(channelIndex) ? 0 : channelIndex,
            trainingSession.segmentDurationMs,
          );
        }

        const recordedSamples = trainingSamplesByGesture[expectedGesture.id] ?? [];
        const recordedSample = recordedSamples.length > 0
          ? recordedSamples[(counter - 1) % recordedSamples.length]
          : null;

        if (recordedSample) {
          return {
            ...recordedSample,
            id: `${recordedSample.id}-replay-${counter}`,
            timestamp: Date.now(),
          };
        }

        return generateMockEmgSample(
          expectedGesture.id,
          expectedGesture.name,
          trainingSession.segmentDurationMs,
        );
      },
      [buildRollingWindowSample, streamBackedMode, testingInputMode, trainingSamplesByGesture, trainingSession.segmentDurationMs],
    );
  
    const stopSession = useCallback(() => {
      if (sessionRef.current) clearInterval(sessionRef.current);
      if (predictionRef.current)
        clearInterval(predictionRef.current);
      if (countdownRef.current)
        clearInterval(countdownRef.current);
    }, []);

    const applySettingValue = useCallback(
      (key: keyof TestingSessionSettings, nextValue: number) => {
        onSettingsChange((prev) => ({ ...prev, [key]: clampSetting(nextValue, key) }));
      },
      [onSettingsChange],
    );

    const commitSettingInput = useCallback(
      (
        key: keyof TestingSessionSettings,
        rawValue: string,
        resetInput: (value: string) => void,
      ) => {
        const parsedValue = Number.parseInt(rawValue, 10);
        if (rawValue.trim() === "" || Number.isNaN(parsedValue)) {
          resetInput(String(settings[key]));
          return;
        }
        applySettingValue(key, parsedValue);
      },
      [applySettingValue, settings],
    );

    const buildSessionData = useCallback(
      (completedAt: number): TestingSessionData => {
        const predictions = predictionsRef.current;
        return {
          id: `testing-${completedAt}`,
          startedAt: sessionStartedAtRef.current ?? completedAt,
          completedAt,
          trainingSessionId: trainingSession.id,
          gestures,
          predictions,
          overallConfidence: calculateOverallConfidence(predictions),
          sessionDurationSeconds: parseFloat((elapsedMsRef.current / 1000).toFixed(1)),
        };
      },
      [gestures, trainingSession.id],
    );

    // Starts (or restarts, after a pause) the timing + prediction intervals,
    // reading all runtime state from refs so it can resume mid-session.
    const startTicking = useCallback(() => {
      sessionRef.current = setInterval(() => {
        elapsedMsRef.current += 100;
        const elapsedMs = elapsedMsRef.current;
        const totalMs = totalMsRef.current;
        const timeline = timelineRef.current;
        const remainingMs = Math.max(0, totalMs - elapsedMs);

        const segment =
          timeline.find((entry) => elapsedMs < entry.endMs) ??
          timeline[timeline.length - 1];

        if (segment) {
          currentPhaseRef.current = segment.phase;
          currentTargetIdRef.current = segment.gestureId;

          // During rest, surface the gesture from the upcoming trial so the UI
          // can preview (muted) what comes next.
          let displayGestureId = segment.gestureId;
          if (segment.phase === "rest") {
            const upcomingTrial = timeline.find(
              (entry) => entry.phase === "trial" && entry.startMs >= segment.endMs,
            );
            displayGestureId = upcomingTrial?.gestureId ?? segment.gestureId;
          }

          const segmentRemainingMs = Math.max(0, segment.endMs - elapsedMs);
          setSessionPhase(segment.phase);
          setTargetGestureId(displayGestureId);
          setSegmentDuration(segment.durationMs / 1000);
          setSegmentTimer(parseFloat((segmentRemainingMs / 1000).toFixed(1)));
        }

        setTimeLeft(parseFloat((remainingMs / 1000).toFixed(1)));

        if (elapsedMs >= totalMs) {
          stopSession();
          const completedAt = Date.now();
          setSessionState("complete");
          onSessionComplete?.(buildSessionData(completedAt));
        }
      }, 100);

      predictionRef.current = setInterval(() => {
        if (currentPhaseRef.current !== "trial") {
          return;
        }

        const expectedGesture = findGesture(gestures, currentTargetIdRef.current) ?? gestures[0];
        if (!expectedGesture) {
          return;
        }

        const nextCounter = counterRef.current + 1;
        const emgSample = buildTestingSample(expectedGesture, nextCounter);
        if (!emgSample) {
          if (streamBackedMode) {
            const rollingResult = buildRollingWindowSample();
            setWindowSkipReason(rollingResult.skipReason ?? "Window not ready");
          }
          return;
        }

        counterRef.current = nextCounter;
        const result = predictionEngine.predict(emgSample);
        const entry = createPredictionRecord(result, expectedGesture, nextCounter, nextCounter - 1);
        lastPredictedPointTimeRef.current = emgSample.timestamp;
        setWindowSkipReason(
          result.predictedGestureId === "unknown"
            ? "Classifier returned Unknown"
            : "Prediction accepted"
        );

        setPredictedGestureId(entry.predictedGestureId);
        setConfidence(entry.confidence);
        setLatestDebug(entry.debug);
        setHistory((prev) => {
          const next = [entry, ...prev];
          predictionsRef.current = [...predictionsRef.current, entry];
          return next;
        });
      }, settings.predictionFrequencyMs);
    }, [
      buildSessionData,
      buildTestingSample,
      gestures,
      onSessionComplete,
      predictionEngine,
      settings.predictionFrequencyMs,
      stopSession,
    ]);

    const beginSession = useCallback(() => {
      const startedAt = Date.now();
      sessionStartedAtRef.current = startedAt;

      const schedule = buildTrialSchedule(gestures, settings.numberOfTrials);
      const timeline = buildSessionTimeline(schedule, settings);
      const totalMs = calculateSessionDurationMs(settings);
      const totalSeconds = totalMs / 1000;
      const firstSegment = timeline[0];
      const firstTargetId = firstSegment?.gestureId ?? gestures[0]?.id ?? "";

      timelineRef.current = timeline;
      totalMsRef.current = totalMs;
      elapsedMsRef.current = 0;
      counterRef.current = 0;
      currentTargetIdRef.current = firstTargetId;
      currentPhaseRef.current = firstSegment?.phase ?? "trial";

      setSessionState("active");
      setSessionTotalSeconds(totalSeconds);
      setTimeLeft(totalSeconds);
      setSessionPhase(firstSegment?.phase ?? "trial");
      setTargetGestureId(firstTargetId);
      setSegmentDuration((firstSegment?.durationMs ?? settings.trialPeriodMs) / 1000);
      setSegmentTimer((firstSegment?.durationMs ?? settings.trialPeriodMs) / 1000);
      setPredictedGestureId(gestures[0]?.id ?? "");
      setConfidence(94.0);
      predictionsRef.current = [];

      startTicking();
    }, [gestures, settings, startTicking]);

    const pauseSession = useCallback(() => {
      stopSession();
      setSessionState("paused");
    }, [stopSession]);

    const resumeSession = useCallback(() => {
      setSessionState("active");
      startTicking();
    }, [startTicking]);

    const finishSession = useCallback(() => {
      stopSession();
      const completedAt = Date.now();
      setSessionState("complete");
      onSessionComplete?.(buildSessionData(completedAt));
      onShowResults?.();
    }, [buildSessionData, onSessionComplete, onShowResults, stopSession]);

    const handleExitConfirm = useCallback(() => {
      stopSession();
      setIsExitDialogOpen(false);
      onExit?.();
    }, [onExit, stopSession]);
  
    const startSession = useCallback(async () => {
      const inputReady = await ensureTestingSignalStream();
      if (!inputReady) {
        return;
      }

      setCountdown(3);
      setSessionState("countdown");
      setHistory([]);
      setLatestDebug(undefined);
      setWindowSkipReason("Waiting for countdown");
      predictionsRef.current = [];
      lastPredictedPointTimeRef.current = null;
      streamSessionCutoffTimeRef.current = Date.now();
  
      let count = 3;
      countdownRef.current = setInterval(() => {
        count -= 1;
        setCountdown(count);
        if (count < 0) {
          clearInterval(countdownRef.current!);
          beginSession();
        }
      }, 1000);
    }, [beginSession, ensureTestingSignalStream]);
  
    useEffect(() => () => stopSession(), [stopSession]);
  
    const sessionMins = Math.floor(timeLeft / 60);
    const sessionSecs = (timeLeft % 60)
      .toFixed(1)
      .padStart(4, "0");
    const sessionProgress = sessionTotalSeconds > 0 ? timeLeft / sessionTotalSeconds : 0;
    const gestureProgress = segmentDuration > 0 ? segmentTimer / segmentDuration : 0;
    const isResting = sessionPhase === "rest";
    const isPaused = sessionState === "paused";
    const sessionStatusColor =
      isPaused || sessionState === "complete" ? "#f5a623" : "#4ade80";
    const sessionStatusLabel = isPaused
      ? "Session Paused"
      : sessionState === "complete"
        ? "Session Complete"
        : "Session Active";
    const targetGesture = findGesture(gestures, targetGestureId) ?? gestures[0];
    const predictedGesture = findGesture(gestures, predictedGestureId);
    const gc = gestureColors[targetGesture?.id ?? ""] ?? { ring: "#00d4ff", bar: "#00d4ff" };
    const latestPrediction = history[0];
    const isMatch = latestPrediction?.matchStatus === "match";
    const latestBufferedPoint = recordingSignalData[recordingSignalData.length - 1];
    const rollingWindowStats = useMemo(() => {
      if (!streamBackedMode || recordingSignalData.length === 0) {
        return {
          rawPointCount: recordingSignalData.length,
          rollingPointCount: 0,
          rollingDurationMs: 0,
          newestPointAgeMs: null as number | null,
          latestRawValue: latestBufferedPoint?.raw ?? null,
          latestNormalizedActivity: latestBufferedPoint?.normalizedActivity ?? null,
          windowEligible: false,
          skipReason: streamBackedMode ? "No streamed points yet" : "Using sample-driven mode",
        };
      }

      const eligiblePoints = recordingSignalData.filter(
        (point) => point.time >= streamSessionCutoffTimeRef.current,
      );
      const latestEligiblePoint = eligiblePoints[eligiblePoints.length - 1];
      const newestTime = latestEligiblePoint?.time ?? latestBufferedPoint?.time ?? Date.now();
      const cutoffTime = newestTime - trainingSession.segmentDurationMs;
      const windowPoints = eligiblePoints.filter((point) => point.time >= cutoffTime);
      const rollingDurationMs = windowPoints.length > 1
        ? (windowPoints[windowPoints.length - 1]?.time ?? newestTime) - (windowPoints[0]?.time ?? newestTime)
        : 0;
      const windowEligible =
        windowPoints.length >= ROLLING_WINDOW_MIN_POINTS &&
        rollingDurationMs >= trainingSession.segmentDurationMs * ROLLING_WINDOW_READY_RATIO;

      return {
        rawPointCount: eligiblePoints.length,
        rollingPointCount: windowPoints.length,
        rollingDurationMs,
        newestPointAgeMs: latestEligiblePoint ? Math.max(0, Date.now() - newestTime) : null,
        latestRawValue: latestEligiblePoint?.raw ?? null,
        latestNormalizedActivity: latestEligiblePoint?.normalizedActivity ?? null,
        windowEligible,
        skipReason: latestEligiblePoint ? (windowEligible ? "Ready" : windowSkipReason) : "Waiting for fresh session samples",
      };
    }, [latestBufferedPoint, recordingSignalData, streamBackedMode, trainingSession.segmentDurationMs, windowSkipReason]);
    const testingInputStatusText = streamBackedMode
      ? streamBackedMode === "live"
        ? liveConnectionStatus === "streaming"
          ? `Streaming ${liveDeviceName ? `(${liveDeviceName})` : "Ganglion"} on channel ${selectedChannelIndex + 1}`
          : liveConnectionStatus === "connecting"
          ? "Connecting to Ganglion..."
          : liveConnectionStatus === "error"
          ? liveConnectionMessage
          : "Live Ganglion selected. Start testing to connect."
        : isStreaming && signalSourceMode === "mock"
        ? "Mock live stream active"
        : "Mock live selected. Start testing to begin streaming."
      : "Sample-driven testing mode";
  
    return (
      <div className="min-h-screen w-full bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white/90 font-['Inter',system-ui,sans-serif]">
        {/* Header */}
        <div className="border-b border-white/10 bg-slate-950/95 backdrop-blur-md px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {sessionState === "idle" ? (
              <button
                onClick={() => onExit?.()}
                className="flex items-center gap-1 text-xs font-medium text-white/45 transition-colors hover:text-white/80"
                title="Back to training"
              >
                <ChevronLeft className="w-4 h-4" />
                Back
              </button>
            ) : (
              <button
                onClick={() => setIsExitDialogOpen(true)}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold tracking-wider uppercase text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                title="Exit testing session"
              >
                <LogOut className="w-3.5 h-3.5" />
                Exit
              </button>
            )}
            {sessionState !== "idle" && (
              <div
                className="w-2 h-2 rounded-full animate-pulse"
                style={{
                  background:
                    sessionState === "active"
                      ? "#4ade80"
                      : sessionState === "paused"
                        ? "#f5a623"
                        : sessionState === "complete"
                          ? "#f5a623"
                          : sessionState === "countdown"
                            ? "#00d4ff"
                            : "#5a7a99",
                }}
              />
            )}
            {sessionState !== "idle" && (
              <span className="text-xs font-semibold tracking-[0.2em] uppercase text-white/50">
                EMG Gesture Recognition
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {sessionState === "countdown" && (
              <span
                className="text-xs px-2.5 py-1 rounded-full font-semibold tracking-wider uppercase"
                style={{
                  background: "rgba(0,212,255,0.12)",
                  color: "#00d4ff",
                  border: "1px solid rgba(0,212,255,0.25)",
                }}
              >
                Get Ready
              </span>
            )}
            {sessionState === "active" && (
              <button
                onClick={pauseSession}
                className="px-4 py-1.5 rounded-lg text-xs font-semibold tracking-wider uppercase transition-all hover:brightness-110 active:scale-95"
                style={{
                  background: "rgba(245,166,35,0.15)",
                  color: "#f5a623",
                  border: "1px solid rgba(245,166,35,0.35)",
                }}
              >
                ❚❚ Pause
              </button>
            )}
            {sessionState === "paused" && (
              <div className="flex items-center gap-2">
                <button
                  onClick={resumeSession}
                  className="px-4 py-1.5 rounded-lg text-xs font-semibold tracking-wider uppercase transition-all hover:brightness-110 active:scale-95"
                  style={{
                    background: "rgba(74,222,128,0.15)",
                    color: "#4ade80",
                    border: "1px solid rgba(74,222,128,0.35)",
                  }}
                >
                  ▶ Resume
                </button>
                <button
                  onClick={finishSession}
                  className="px-4 py-1.5 rounded-lg text-xs font-semibold tracking-wider uppercase transition-all hover:brightness-110 active:scale-95"
                  style={{
                    background: "rgba(0,212,255,0.15)",
                    color: "#00d4ff",
                    border: "1px solid rgba(0,212,255,0.35)",
                  }}
                >
                  Finish
                </button>
              </div>
            )}
            {sessionState === "complete" && (
              <button
                onClick={() => onShowResults?.()}
                className="px-4 py-1.5 rounded-lg text-xs font-semibold tracking-wider uppercase transition-all hover:brightness-110 active:scale-95"
                style={{
                  background: "rgba(0,212,255,0.15)",
                  color: "#00d4ff",
                  border: "1px solid rgba(0,212,255,0.35)",
                }}
              >
                Results
              </button>
            )}
            {sessionState === "idle" && (
              <Sheet open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
                <SheetTrigger asChild>
                  <button
                    className="flex items-center justify-center rounded-lg border border-white/10 bg-white/5 p-2 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                    title="Open testing settings"
                  >
                    <Settings2 className="w-4 h-4" />
                  </button>
                </SheetTrigger>
                <SheetContent side="right" className="border-white/10 bg-slate-900 text-white sm:max-w-md">
                  <SheetHeader className="border-b border-white/10 pb-4">
                    <SheetTitle className="text-white">Testing Settings</SheetTitle>
                    <SheetDescription className="text-white/50">
                      Configure how the testing session presents target gestures.
                    </SheetDescription>
                  </SheetHeader>

                  <div className="flex flex-col gap-6 overflow-y-auto px-4 pb-6">
                    <NumericSettingField
                      title="Trial Period"
                      description="How long each target gesture remains displayed."
                      displayValue={`${settings.trialPeriodMs} ms`}
                      inputValue={trialPeriodInput}
                      bounds={TESTING_SESSION_LIMITS.trialPeriodMs}
                      onStep={(delta) => applySettingValue("trialPeriodMs", settings.trialPeriodMs + delta)}
                      onInputChange={setTrialPeriodInput}
                      onCommit={() =>
                        commitSettingInput("trialPeriodMs", trialPeriodInput, setTrialPeriodInput)
                      }
                    />

                    <NumericSettingField
                      title="Rest Period"
                      description="Pause inserted after each target gesture before the next one."
                      displayValue={`${settings.restPeriodMs} ms`}
                      inputValue={restPeriodInput}
                      bounds={TESTING_SESSION_LIMITS.restPeriodMs}
                      onStep={(delta) => applySettingValue("restPeriodMs", settings.restPeriodMs + delta)}
                      onInputChange={setRestPeriodInput}
                      onCommit={() =>
                        commitSettingInput("restPeriodMs", restPeriodInput, setRestPeriodInput)
                      }
                    />

                    <NumericSettingField
                      title="Number of Trials"
                      description="Total target gestures shown, split evenly across gesture classes."
                      displayValue={String(settings.numberOfTrials)}
                      inputValue={numberOfTrialsInput}
                      bounds={TESTING_SESSION_LIMITS.numberOfTrials}
                      onStep={(delta) => applySettingValue("numberOfTrials", settings.numberOfTrials + delta)}
                      onInputChange={setNumberOfTrialsInput}
                      onCommit={() =>
                        commitSettingInput("numberOfTrials", numberOfTrialsInput, setNumberOfTrialsInput)
                      }
                    />

                    <NumericSettingField
                      title="Prediction Frequency"
                      description="How often a new gesture prediction is made during the session."
                      displayValue={`${settings.predictionFrequencyMs} ms`}
                      inputValue={predictionFrequencyInput}
                      bounds={TESTING_SESSION_LIMITS.predictionFrequencyMs}
                      onStep={(delta) =>
                        applySettingValue("predictionFrequencyMs", settings.predictionFrequencyMs + delta)
                      }
                      onInputChange={setPredictionFrequencyInput}
                      onCommit={() =>
                        commitSettingInput(
                          "predictionFrequencyMs",
                          predictionFrequencyInput,
                          setPredictionFrequencyInput,
                        )
                      }
                    />

                    <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                      <div>
                        <p className="text-sm font-medium text-white/90">Session Summary</p>
                        <p className="text-xs text-white/45">Derived from the settings above.</p>
                      </div>
                      <div className="grid grid-cols-2 gap-3 text-xs text-white/55">
                        <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                          <div className="text-white/40">Session Length</div>
                          <div className="mt-1 text-sm text-white/85">{formatSessionLength(sessionDurationMs)}</div>
                        </div>
                        <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                          <div className="text-white/40">Trials / Gesture</div>
                          <div className="mt-1 text-sm text-white/85">
                            {gestures.length > 0
                              ? (settings.numberOfTrials / gestures.length).toFixed(
                                  settings.numberOfTrials % gestures.length === 0 ? 0 : 1,
                                )
                              : "—"}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </SheetContent>
              </Sheet>
            )}
            <span className="text-xs font-mono text-white/50">
              v2.4.1
            </span>
          </div>
        </div>
  
        <div className="p-6 max-w-7xl mx-auto">
          {/* IDLE STATE */}
          {sessionState === "idle" && (
            <div className="flex flex-col items-center justify-center min-h-[70vh] gap-8">
              <div className="text-center space-y-3">
                <h1 className="text-4xl font-light tracking-tight text-white/90">
                  AI Gesture Testing
                </h1>
                <p className="text-base max-w-md text-white/50">
                  A {formatSessionLength(sessionDurationMs)} session evaluating
                  real-time gesture recognition accuracy across{" "}
                  {gestures.length} gesture classes.
                </p>
              </div>
  
              {/* Info cards */}
              <div className="grid grid-cols-3 gap-4 w-full max-w-xl">
                {[
                  {
                    label: "Session Length",
                    value: formatSessionLength(sessionDurationMs),
                    icon: "⏱",
                  },
                  {
                    label: "Gesture Classes",
                    value: String(gestures.length),
                    icon: "◈",
                  },
                  {
                    label: "Trial Count",
                    value: String(settings.numberOfTrials),
                    icon: "↻",
                  },
                ].map((item) => (
                  <div
                    key={item.label}
                    className="rounded-xl border border-white/10 bg-white/5 p-4 text-center"
                  >
                    <div className="text-xl mb-1">
                      {item.icon}
                    </div>
                    <div className="text-lg font-semibold text-cyan-400">
                      {item.value}
                    </div>
                    <div className="text-xs mt-0.5 text-white/50">
                      {item.label}
                    </div>
                  </div>
                ))}
              </div>

              <div className="w-full max-w-3xl rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="mb-3 text-center">
                  <div className="text-xs font-semibold tracking-[0.25em] uppercase text-white/50">
                    Testing Input
                  </div>
                  <div className="mt-1 text-sm text-white/55">
                    Choose whether testing replays recorded mock samples or probes the model with a different mock waveform.
                  </div>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  {TESTING_INPUT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => setTestingInputMode(option.value)}
                      className="rounded-lg border px-3 py-2 text-sm transition-colors"
                      style={{
                        borderColor: testingInputMode === option.value ? "rgba(0,212,255,0.35)" : "rgba(255,255,255,0.1)",
                        background: testingInputMode === option.value ? "rgba(0,212,255,0.12)" : "rgba(255,255,255,0.04)",
                        color: testingInputMode === option.value ? "#00d4ff" : "rgba(255,255,255,0.72)",
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <div className="mt-3 text-center text-xs text-white/45">
                  {testingInputStatusText}
                </div>
              </div>
  
              <button
                onClick={startSession}
                className="px-12 py-4 rounded-xl text-lg font-semibold tracking-wide transition-all duration-200 active:scale-95 hover:brightness-110"
                style={{
                  background:
                    "linear-gradient(135deg, #00d4ff22, #00d4ff11)",
                  color: "#00d4ff",
                  border: "1px solid rgba(0,212,255,0.4)",
                  boxShadow:
                    "0 0 32px rgba(0,212,255,0.15), inset 0 1px 0 rgba(0,212,255,0.1)",
                }}
              >
                Start Testing Session
              </button>
            </div>
          )}
  
          {/* COUNTDOWN STATE */}
          {sessionState === "countdown" && (
            <div className="flex flex-col items-center justify-center min-h-[70vh] gap-6">
              <p className="text-sm font-semibold tracking-[0.25em] uppercase text-white/50">
                Session starting in
              </p>
              <div
                className="relative flex items-center justify-center"
                style={{ width: 180, height: 180 }}
              >
                <svg
                  width={180}
                  height={180}
                  className="rotate-[-90deg] absolute inset-0"
                >
                  <circle
                    cx={90}
                    cy={90}
                    r={80}
                    fill="none"
                    stroke="rgba(0,212,255,0.08)"
                    strokeWidth={6}
                  />
                  <circle
                    cx={90}
                    cy={90}
                    r={80}
                    fill="none"
                    stroke="#00d4ff"
                    strokeWidth={6}
                    strokeDasharray={2 * Math.PI * 80}
                    strokeDashoffset={
                      2 *
                      Math.PI *
                      80 *
                      (1 - Math.max(countdown, 0) / 3)
                    }
                    strokeLinecap="round"
                    style={{
                      transition: "stroke-dashoffset 0.9s linear",
                      filter: "drop-shadow(0 0 10px #00d4ff)",
                    }}
                  />
                </svg>
                <span
                  className="font-mono font-light tabular-nums"
                  style={{
                    fontSize: "6rem",
                    lineHeight: 1,
                    color: "#00d4ff",
                    textShadow: "0 0 40px rgba(0,212,255,0.5)",
                  }}
                >
                  {countdown}
                </span>
              </div>
              <p className="text-base text-white/50">
                Prepare your hand — session will begin
                automatically
              </p>
              <div className="flex gap-3 mt-2">
                {gestures.map((g) => {
                  const color = gestureColors[g.id]?.ring ?? "#00d4ff";
                  return (
                  <span
                    key={g.id}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium border"
                    style={{
                      color,
                      background: `${color}1a`,
                      borderColor: `${color}33`,
                    }}
                  >
                    {g.name}
                  </span>
                  );
                })}
              </div>
            </div>
          )}
  
          {/* ACTIVE / PAUSED / COMPLETE STATE */}
          {(sessionState === "active" ||
            sessionState === "paused" ||
            sessionState === "complete") && (
            <div className="space-y-5">
              {/* Top row: session timer + status */}
              <div className="grid grid-cols-3 gap-4">
                {/* Session Timer */}
                <div className="rounded-xl border border-white/10 bg-white/5 p-5 flex items-center gap-5">
                  <CircularProgress
                    progress={sessionProgress}
                    size={72}
                    stroke={5}
                    color="#00d4ff"
                  >
                    <span
                      className="font-mono text-sm font-semibold"
                      style={{ color: "#00d4ff" }}
                    >
                      {sessionMins}:{sessionSecs}
                    </span>
                  </CircularProgress>
                  <div>
                    <div className="text-xs font-semibold tracking-widest uppercase mb-1 text-white/50">
                      Time Remaining
                    </div>
                    <div className="text-3xl font-mono font-light text-white/90">
                      {sessionMins}:{sessionSecs}
                    </div>
                  </div>
                </div>
  
                {/* Session Status */}
                <div className="rounded-xl border border-white/10 bg-white/5 p-5 flex items-center justify-center">
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-2 mb-2">
                      <div
                        className={`w-2 h-2 rounded-full ${isPaused ? "" : "animate-pulse"}`}
                        style={{ background: sessionStatusColor }}
                      />
                      <span
                        className="text-xs font-semibold tracking-widest uppercase"
                        style={{ color: sessionStatusColor }}
                      >
                        {sessionStatusLabel}
                      </span>
                    </div>
                    <div className="font-mono text-sm text-white/50">
                      {history.length} predictions captured
                    </div>
                    <div className="mt-2 text-xs text-white/45">
                      Input: {TESTING_INPUT_OPTIONS.find((option) => option.value === testingInputMode)?.label ?? "Replay Training"}
                    </div>
                  </div>
                </div>
  
                {/* Gesture / Rest Progress */}
                <div className="rounded-xl border border-white/10 bg-white/5 p-5 flex items-center gap-5">
                  <CircularProgress
                    progress={gestureProgress}
                    size={72}
                    stroke={5}
                    color={isResting ? "#94a3b8" : gc.ring}
                  >
                    <span
                      className="font-mono text-sm font-bold"
                      style={{ color: isResting ? "#94a3b8" : gc.ring }}
                    >
                      {segmentTimer.toFixed(1)}
                    </span>
                  </CircularProgress>
                  <div>
                    <div className="text-xs font-semibold tracking-widest uppercase mb-1 text-white/50">
                      {isResting ? "Rest Ends In" : "Trial Ends In"}
                    </div>
                    <div
                      className="text-3xl font-mono font-light"
                      style={{ color: isResting ? "#94a3b8" : gc.ring }}
                    >
                      {segmentTimer.toFixed(1)}
                      <span className="text-lg ml-1">s</span>
                    </div>
                  </div>
                </div>
              </div>
  
              {/* Main section: Target + Prediction */}
              <div className="grid grid-cols-5 gap-4">
                {/* Target Gesture — large, prominent */}
                <div
                  className={`col-span-3 rounded-xl border p-8 flex flex-col items-center justify-center text-center`}
                  style={{
                    background: isResting
                      ? "linear-gradient(135deg, rgba(148,163,184,0.06), rgba(148,163,184,0.02))"
                      : `linear-gradient(135deg, ${gc.ring}0a, ${gc.ring}04)`,
                    borderColor: isResting ? "rgba(148,163,184,0.25)" : `${gc.ring}40`,
                    boxShadow: isResting ? "none" : `0 0 40px ${gc.ring}59`,
                  }}
                >
                  <div className="text-xs font-semibold tracking-[0.3em] uppercase mb-6 text-white/50">
                    {isResting ? "Rest" : "Target Gesture"}
                  </div>
  
                  <div
                    className="text-5xl font-semibold tracking-wide mb-6 transition-all duration-300"
                    style={{
                      color: isResting ? "#94a3b8" : gc.ring,
                      textShadow: isResting ? "none" : `0 0 30px ${gc.ring}66`,
                      opacity: isResting ? 0.5 : 1,
                    }}
                  >
                    {targetGesture?.name}
                  </div>
  
                  {/* Gesture sequence indicator */}
                  <div className="flex items-center gap-3 mt-2">
                    {gestures.map((g) => (
                      <div
                        key={g.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-300"
                        style={{
                          background:
                            g.id === targetGestureId
                              ? (gestureColors[g.id]?.ring ?? "#00d4ff") + "22"
                              : "rgba(255,255,255,0.04)",
                          color:
                            g.id === targetGestureId
                              ? gestureColors[g.id]?.ring ?? "#00d4ff"
                              : "rgba(255,255,255,0.5)",
                          border: `1px solid ${g.id === targetGestureId ? (gestureColors[g.id]?.ring ?? "#00d4ff") + "50" : "transparent"}`,
                          transform:
                            g.id === targetGestureId
                              ? "scale(1.05)"
                              : "scale(1)",
                        }}
                      >
                        {g.name}
                      </div>
                    ))}
                  </div>
  
                  {/* Progress bar for gesture timer */}
                  <div className="w-full max-w-xs mt-5">
                    <div
                      className="h-1.5 rounded-full overflow-hidden"
                      style={{
                        background: "rgba(255,255,255,0.07)",
                      }}
                    >
                      <div
                        className="h-full rounded-full transition-all duration-100"
                        style={{
                          width: `${gestureProgress * 100}%`,
                          background: isResting
                            ? "linear-gradient(90deg, rgba(148,163,184,0.5), #94a3b8)"
                            : `linear-gradient(90deg, ${gc.ring}88, ${gc.ring})`,
                          boxShadow: isResting ? "none" : `0 0 8px ${gc.ring}`,
                        }}
                      />
                    </div>
                  </div>
                </div>
  
                {/* Prediction Panel */}
                <div className="col-span-2 flex flex-col gap-4">
                  {/* Predicted gesture */}
                  <div className="rounded-xl border border-white/10 bg-white/5 p-6 flex-1">
                    <div className="text-xs font-semibold tracking-[0.25em] uppercase mb-4 text-white/50">
                      AI Prediction
                    </div>
                    <div className="flex items-center gap-4 mb-5">
                      <div>
                        <div className="text-xs mb-0.5 text-white/50">
                          Predicted Gesture
                        </div>
                        <div
                          className="text-2xl font-semibold"
                          style={{
                            color: predictedGesture
                              ? gestureColors[predictedGestureId]?.ring ?? "#00d4ff"
                              : "#f5a623",
                          }}
                        >
                          {predictedGesture?.name ?? "Unknown"}
                        </div>
                      </div>
                    </div>
                    <ConfidenceMeter value={confidence} />
                  </div>
  
                  {/* Match indicator */}
                  <div
                    className="rounded-xl border p-4 flex items-center justify-between"
                    style={{
                      background:
                        isMatch
                          ? "rgba(74,222,128,0.06)"
                          : "rgba(255,77,109,0.06)",
                      borderColor:
                        isMatch
                          ? "rgba(74,222,128,0.25)"
                          : "rgba(255,77,109,0.25)",
                    }}
                  >
                    <span className="text-sm font-medium text-white/50">
                      Match Status
                    </span>
                    <span
                      className="text-sm font-bold px-3 py-1 rounded-full"
                      style={{
                        background:
                          isMatch
                            ? "rgba(74,222,128,0.15)"
                            : "rgba(255,77,109,0.15)",
                        color:
                          isMatch
                            ? "#4ade80"
                            : "#ff4d6d",
                      }}
                    >
                      {isMatch
                        ? "✓ Match"
                        : "✗ Mismatch"}
                    </span>
                  </div>
  
                  {/* Quick stats */}
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4 grid grid-cols-2 gap-3">
                    {[
                      {
                        label: "Predictions",
                        value: history.length,
                      },
                      {
                        label: "Avg Conf",
                        value:
                          history.length > 0
                            ? (
                                history
                                  .slice(0, 20)
                                  .reduce(
                                    (a, b) => a + b.confidence,
                                    0,
                                  ) / Math.min(history.length, 20)
                              ).toFixed(1) + "%"
                            : "—",
                      },
                    ].map((s) => (
                      <div key={s.label}>
                        <div className="text-xs mb-0.5 text-white/50">
                          {s.label}
                        </div>
                        <div className="text-lg font-mono font-semibold text-cyan-400">
                          {s.value}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-xs font-semibold tracking-[0.25em] uppercase text-white/50">
                        Model Debug
                      </span>
                      <span className="text-xs text-white/45">
                        {modelDebugSummary.trainingSampleCount} samples
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-xs text-white/55">
                      <div>
                        <div className="text-white/40">Prediction Status</div>
                        <div className="mt-1 text-sm text-white/85">
                          {latestDebug?.status === "accepted" ? "Accepted" : "Unknown / gated"}
                        </div>
                      </div>
                      <div>
                        <div className="text-white/40">Nearest Distance</div>
                        <div className="mt-1 text-sm text-white/85">
                          {latestDebug ? latestDebug.nearestDistance.toFixed(3) : "—"}
                        </div>
                      </div>
                      <div>
                        <div className="text-white/40">Support Margin</div>
                        <div className="mt-1 text-sm text-white/85">
                          {latestDebug ? `${latestDebug.supportMargin.toFixed(1)}%` : "—"}
                        </div>
                      </div>
                      <div>
                        <div className="text-white/40">Supports</div>
                        <div className="mt-1 text-sm text-white/85">
                          {latestDebug?.classSupports.slice(0, 2).map((support) => `${support.gestureName} ${support.support.toFixed(1)}%`).join(" / ") ?? "—"}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-white/55">
                      <div>
                        <div className="text-white/40">Stream Active</div>
                        <div className="mt-1 text-sm text-white/85">
                          {streamBackedMode ? (isStreaming ? "Yes" : "No") : "N/A"}
                        </div>
                      </div>
                      <div>
                        <div className="text-white/40">Buffered Raw Points</div>
                        <div className="mt-1 text-sm text-white/85">
                          {rollingWindowStats.rawPointCount}
                        </div>
                      </div>
                      <div>
                        <div className="text-white/40">Window Points</div>
                        <div className="mt-1 text-sm text-white/85">
                          {rollingWindowStats.rollingPointCount}
                        </div>
                      </div>
                      <div>
                        <div className="text-white/40">Window Duration</div>
                        <div className="mt-1 text-sm text-white/85">
                          {rollingWindowStats.rollingDurationMs.toFixed(0)} ms
                        </div>
                      </div>
                      <div>
                        <div className="text-white/40">Newest Point Age</div>
                        <div className="mt-1 text-sm text-white/85">
                          {rollingWindowStats.newestPointAgeMs === null ? "—" : `${rollingWindowStats.newestPointAgeMs.toFixed(0)} ms`}
                        </div>
                      </div>
                      <div>
                        <div className="text-white/40">Window Eligible</div>
                        <div className="mt-1 text-sm text-white/85">
                          {rollingWindowStats.windowEligible ? "Yes" : "No"}
                        </div>
                      </div>
                      <div>
                        <div className="text-white/40">Latest Raw</div>
                        <div className="mt-1 text-sm text-white/85">
                          {rollingWindowStats.latestRawValue === null ? "—" : rollingWindowStats.latestRawValue.toFixed(6)}
                        </div>
                      </div>
                      <div>
                        <div className="text-white/40">Latest Activity</div>
                        <div className="mt-1 text-sm text-white/85">
                          {rollingWindowStats.latestNormalizedActivity === null ? "—" : rollingWindowStats.latestNormalizedActivity.toFixed(3)}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 space-y-2 text-xs text-white/55">
                      <div>
                        <div className="text-white/40">Skip Reason</div>
                        <div className="mt-1 text-white/75">
                          {rollingWindowStats.skipReason}
                        </div>
                      </div>
                      <div>
                        <div className="text-white/40">Latest Prediction</div>
                        <div className="mt-1 text-white/75">
                          {latestPrediction
                            ? `${latestPrediction.predictedGestureName} (${latestPrediction.confidence.toFixed(1)}%)`
                            : "—"}
                        </div>
                      </div>
                      <div>
                        <div className="text-white/40">Class Feature Means</div>
                        <div className="mt-1 text-white/75">
                          {modelDebugSummary.classDebugSummary.map((entry) => (
                            `${entry.gestureName}: ZC ${entry.featureStats.zeroCrossings.mean.toFixed(1)}, SSC ${entry.featureStats.slopeSignChanges.mean.toFixed(1)}, WAMP ${entry.featureStats.willisonAmplitude.mean.toFixed(1)}`
                          )).join(" | ")}
                        </div>
                      </div>
                      <div>
                        <div className="text-white/40">Nearest Neighbors</div>
                        <div className="mt-1 text-white/75">
                          {latestDebug?.nearestNeighbors.length
                            ? latestDebug.nearestNeighbors
                                .map((neighbor) => `${neighbor.gestureName} d=${neighbor.distance.toFixed(2)} s=${neighbor.support.toFixed(1)}%`)
                                .join(" | ")
                            : "—"}
                        </div>
                      </div>
                      <div>
                        <div className="text-white/40">Feature Snapshot</div>
                        <div className="mt-1 text-white/75">
                          {latestDebug
                            ? `ZC ${latestDebug.features.zeroCrossings}, SSC ${latestDebug.features.slopeSignChanges}, WAMP ${latestDebug.features.willisonAmplitude}, HM ${latestDebug.features.hjorthMobility.toFixed(2)}, HC ${latestDebug.features.hjorthComplexity.toFixed(2)}`
                            : "—"}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
  
              {/* Prediction History */}
              <div className="rounded-xl border border-white/10 bg-white/5 overflow-hidden">
                <div className="px-5 py-3.5 border-b border-white/10 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-white/90">
                      Prediction History
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full font-mono bg-cyan-400/10 text-cyan-400">
                      Live
                    </span>
                  </div>
                  <span className="text-xs font-mono text-white/50">
                    {history.length} entries
                  </span>
                </div>
                <div
                  className="overflow-hidden"
                  style={{
                    maxHeight: "220px",
                    overflowY: "auto",
                  }}
                >
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10">
                        {[
                          "Timestamp",
                          "Predicted Gesture",
                          "Confidence",
                          "Status",
                        ].map((h) => (
                          <th
                            key={h}
                            className="px-5 py-2.5 text-left text-xs font-semibold tracking-widest uppercase text-white/50"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((entry, i) => (
                        <tr
                          key={entry.id}
                          className="border-b border-white/10 transition-colors"
                          style={{
                            background:
                              i === 0
                                ? "rgba(0,212,255,0.04)"
                                : "transparent",
                            opacity: Math.max(0.4, 1 - i * 0.025),
                          }}
                        >
                          <td className="px-5 py-2.5 font-mono text-xs text-white/50">
                            {entry.timestamp}
                          </td>
                          <td className="px-5 py-2.5">
                            <GestureTag
                              gestureId={entry.predictedGestureId}
                              gestureName={entry.predictedGestureName}
                              colorMap={gestureColors}
                            />
                          </td>
                          <td className="px-5 py-2.5">
                            <span
                              className="font-mono text-sm font-medium"
                              style={{
                                color:
                                  entry.confidence >= 90
                                    ? "#4ade80"
                                    : entry.confidence >= 75
                                      ? "#f5a623"
                                      : "#ff4d6d",
                              }}
                            >
                              {entry.confidence.toFixed(1)}%
                            </span>
                          </td>
                          <td className="px-5 py-2.5">
                            <span
                              className="text-xs"
                              style={{
                                color:
                                  entry.confidenceStatus === "high"
                                    ? "#4ade8088"
                                    : "#ff4d6d88",
                              }}
                            >
                              {entry.confidenceStatus === "high"
                                ? "High"
                                : "Low"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Exit confirmation dialog */}
        {isExitDialogOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setIsExitDialogOpen(false)}
          >
            <div
              className="w-full max-w-sm rounded-xl border border-white/10 bg-slate-900 p-6 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <h2 className="text-lg font-semibold text-white/90">
                Exit Testing Session?
              </h2>
              <p className="mt-2 text-sm text-white/50">
                Leaving now discards this session's progress and returns you to the
                training screen.
              </p>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  onClick={() => setIsExitDialogOpen(false)}
                  className="rounded-lg border border-white/10 bg-white/5 px-5 py-2 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                >
                  No
                </button>
                <button
                  onClick={handleExitConfirm}
                  className="rounded-lg px-5 py-2 text-sm font-semibold transition-all hover:brightness-110 active:scale-95"
                  style={{
                    background: "rgba(255,77,109,0.15)",
                    color: "#ff4d6d",
                    border: "1px solid rgba(255,77,109,0.35)",
                  }}
                >
                  Yes
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
