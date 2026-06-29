import React from "react";

import {
    useState,
    useEffect,
    useRef,
    useCallback,
    useMemo,
  } from "react";
import {
  buildGestureColorMap,
  calculateOverallConfidence,
  createPredictionEngine,
  createPredictionRecord,
  findGesture,
  generateChannelMockEmgSample,
  generateNoiseMockEmgSample,
  type PredictionRecord,
  type TestingSessionData,
  type TrainingSessionData,
} from "./pipeline";
import { generateMockEmgSample } from "./pipeline";
  
  type SessionState =
    | "idle"
    | "countdown"
    | "active"
    | "complete";

  type TestingInputMode =
    | "replay"
    | "channel-1"
    | "channel-2"
    | "channel-3"
    | "channel-4"
    | "noise";
  
  const SESSION_DURATION = 60;
  const TARGET_INTERVAL = 4;
  const TESTING_INPUT_OPTIONS: Array<{ value: TestingInputMode; label: string }> = [
    { value: "replay", label: "Replay Training" },
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
  
  export default function TestingScreen({
    trainingSession,
    onSessionComplete,
    onShowResults,
  }: {
    trainingSession: TrainingSessionData;
    onSessionComplete?: (session: TestingSessionData) => void;
    onShowResults?: () => void;
  }) {
    const gestures = trainingSession.gestures;
    const gestureColors = useMemo(() => buildGestureColorMap(gestures), [gestures]);
    const predictionEngine = useMemo(
      () => createPredictionEngine(trainingSession),
      [trainingSession],
    );
    const trainingSamplesByGesture = useMemo(
      () =>
        Object.fromEntries(
          trainingSession.gestureData.map((entry) => [entry.gesture.id, entry.samples]),
        ) as Record<string, typeof trainingSession.gestureData[number]["samples"]>,
      [trainingSession],
    );

    const [sessionState, setSessionState] =
      useState<SessionState>("idle");
    const [countdown, setCountdown] = useState(3);
    const [timeLeft, setTimeLeft] = useState(SESSION_DURATION);
    const [targetGestureId, setTargetGestureId] =
      useState<string>(gestures[0]?.id ?? "");
    const [gestureTimer, setGestureTimer] =
      useState(TARGET_INTERVAL);
    const [predictedGestureId, setPredictedGestureId] = useState<string>(
      gestures[0]?.id ?? "",
    );
    const [confidence, setConfidence] = useState(94.0);
    const [history, setHistory] =
      useState<PredictionRecord[]>([]);
    const [testingInputMode, setTestingInputMode] =
      useState<TestingInputMode>("replay");

    const predictionsRef = useRef<PredictionRecord[]>([]);
    const sessionStartedAtRef = useRef<number | null>(null);
  
    const sessionRef = useRef<ReturnType<
      typeof setInterval
    > | null>(null);
    const predictionRef = useRef<ReturnType<
      typeof setInterval
    > | null>(null);
    const countdownRef = useRef<ReturnType<
      typeof setInterval
    > | null>(null);

    const buildTestingSample = useCallback(
      (expectedGesture: Gesture, counter: number) => {
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
      [testingInputMode, trainingSamplesByGesture, trainingSession.segmentDurationMs],
    );
  
    const stopSession = useCallback(() => {
      if (sessionRef.current) clearInterval(sessionRef.current);
      if (predictionRef.current)
        clearInterval(predictionRef.current);
      if (countdownRef.current)
        clearInterval(countdownRef.current);
    }, []);
  
    const beginSession = useCallback(() => {
      const startedAt = Date.now();
      sessionStartedAtRef.current = startedAt;
      setSessionState("active");
      setTimeLeft(SESSION_DURATION);
      setGestureTimer(TARGET_INTERVAL);
      setTargetGestureId(gestures[0]?.id ?? "");
      setPredictedGestureId(gestures[0]?.id ?? "");
      setConfidence(94.0);
      predictionsRef.current = [];
  
      let tLeft = SESSION_DURATION;
      let gTimer = TARGET_INTERVAL;
      let currentTargetId = gestures[0]?.id ?? "";
      let counter = 0;
  
      sessionRef.current = setInterval(() => {
        tLeft -= 0.1;
        gTimer -= 0.1;
  
        if (gTimer <= 0) {
          gTimer = TARGET_INTERVAL;
          const currentIndex = gestures.findIndex((gesture) => gesture.id === currentTargetId);
          const nextGesture = gestures[(currentIndex + 1) % gestures.length];
          currentTargetId = nextGesture?.id ?? currentTargetId;
          setTargetGestureId(currentTargetId);
        }
  
        setTimeLeft(parseFloat(tLeft.toFixed(1)));
        setGestureTimer(
          parseFloat(Math.max(0, gTimer).toFixed(1)),
        );
  
        if (tLeft <= 0) {
          stopSession();
          const completedAt = Date.now();
          setSessionState("complete");

          const predictions = predictionsRef.current;
          const testingSession: TestingSessionData = {
            id: `testing-${completedAt}`,
            startedAt: sessionStartedAtRef.current ?? completedAt,
            completedAt,
            trainingSessionId: trainingSession.id,
            gestures,
            predictions,
            overallConfidence: calculateOverallConfidence(predictions),
            sessionDurationSeconds: SESSION_DURATION,
          };
          onSessionComplete?.(testingSession);
        }
      }, 100);
  
      predictionRef.current = setInterval(() => {
        const expectedGesture = findGesture(gestures, currentTargetId) ?? gestures[0];
        if (!expectedGesture) {
          return;
        }

        counter++;
        const emgSample = buildTestingSample(expectedGesture, counter);
        const result = predictionEngine.predict(expectedGesture, emgSample);
        const entry = createPredictionRecord(result, counter, counter - 1);

        setPredictedGestureId(entry.predictedGestureId);
        setConfidence(entry.confidence);
        setHistory((prev) => {
          const next = [entry, ...prev];
          predictionsRef.current = [...predictionsRef.current, entry];
          return next;
        });
      }, 300);
    }, [buildTestingSample, gestures, onSessionComplete, predictionEngine, stopSession, trainingSession.id]);
  
    const startSession = useCallback(() => {
      setCountdown(3);
      setSessionState("countdown");
      setHistory([]);
      predictionsRef.current = [];
  
      let count = 3;
      countdownRef.current = setInterval(() => {
        count -= 1;
        setCountdown(count);
        if (count < 0) {
          clearInterval(countdownRef.current!);
          beginSession();
        }
      }, 1000);
    }, [beginSession]);
  
    useEffect(() => () => stopSession(), [stopSession]);
  
    const sessionMins = Math.floor(timeLeft / 60);
    const sessionSecs = (timeLeft % 60)
      .toFixed(1)
      .padStart(4, "0");
    const sessionProgress = timeLeft / SESSION_DURATION;
    const gestureProgress = gestureTimer / TARGET_INTERVAL;
    const targetGesture = findGesture(gestures, targetGestureId) ?? gestures[0];
    const predictedGesture = findGesture(gestures, predictedGestureId) ?? gestures[0];
    const gc = gestureColors[targetGesture?.id ?? ""] ?? { ring: "#00d4ff", bar: "#00d4ff" };
    const latestPrediction = history[0];
    const isMatch = latestPrediction?.matchStatus === "match";
  
    return (
      <div className="min-h-screen w-full bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white/90 font-['Inter',system-ui,sans-serif]">
        {/* Header */}
        <div className="border-b border-white/10 bg-slate-950/95 backdrop-blur-md px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-2 h-2 rounded-full animate-pulse"
              style={{
                background:
                  sessionState === "active"
                    ? "#4ade80"
                    : sessionState === "complete"
                      ? "#f5a623"
                      : sessionState === "countdown"
                        ? "#00d4ff"
                        : "#5a7a99",
              }}
            />
            <span className="text-xs font-semibold tracking-[0.2em] uppercase text-white/50">
              EMG Gesture Recognition
            </span>
            <span className="mx-2 text-white/20">/</span>
            <span className="text-sm font-medium text-white/90">
              Testing Session
            </span>
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
              <span
                className="text-xs px-2.5 py-1 rounded-full font-semibold tracking-wider uppercase"
                style={{
                  background: "rgba(74,222,128,0.12)",
                  color: "#4ade80",
                  border: "1px solid rgba(74,222,128,0.25)",
                }}
              >
                ● Live
              </span>
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
                  A one-minute session evaluating real-time
                  gesture recognition accuracy across{" "}
                  {gestures.length} gesture classes.
                </p>
              </div>
  
              {/* Info cards */}
              <div className="grid grid-cols-3 gap-4 w-full max-w-xl">
                {[
                  {
                    label: "Session Length",
                    value: "60 s",
                    icon: "⏱",
                  },
                  {
                    label: "Gesture Classes",
                    value: String(gestures.length),
                    icon: "◈",
                  },
                  {
                    label: "Target Interval",
                    value: "4 s",
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
  
          {/* ACTIVE / COMPLETE STATE */}
          {(sessionState === "active" ||
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
                        className="w-2 h-2 rounded-full animate-pulse"
                        style={{ background: "#4ade80" }}
                      />
                      <span
                        className="text-xs font-semibold tracking-widest uppercase"
                        style={{ color: "#4ade80" }}
                      >
                        Session Active
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
  
                {/* Gesture Progress */}
                <div className="rounded-xl border border-white/10 bg-white/5 p-5 flex items-center gap-5">
                  <CircularProgress
                    progress={gestureProgress}
                    size={72}
                    stroke={5}
                    color={gc.ring}
                  >
                    <span
                      className="font-mono text-sm font-bold"
                      style={{ color: gc.ring }}
                    >
                      {gestureTimer.toFixed(1)}
                    </span>
                  </CircularProgress>
                  <div>
                    <div className="text-xs font-semibold tracking-widest uppercase mb-1 text-white/50">
                      Next Target In
                    </div>
                    <div
                      className="text-3xl font-mono font-light"
                      style={{ color: gc.ring }}
                    >
                      {gestureTimer.toFixed(1)}
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
                    background: `linear-gradient(135deg, ${gc.ring}0a, ${gc.ring}04)`,
                    borderColor: `${gc.ring}40`,
                    boxShadow: `0 0 40px ${gc.ring}59`,
                  }}
                >
                  <div className="text-xs font-semibold tracking-[0.3em] uppercase mb-6 text-white/50">
                    Target Gesture
                  </div>
  
                  <div
                    className="text-5xl font-semibold tracking-wide mb-6 transition-all duration-300"
                    style={{
                      color: gc.ring,
                      textShadow: `0 0 30px ${gc.ring}66`,
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
                          width: `${(gestureTimer / TARGET_INTERVAL) * 100}%`,
                          background: `linear-gradient(90deg, ${gc.ring}88, ${gc.ring})`,
                          boxShadow: `0 0 8px ${gc.ring}`,
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
                            color: gestureColors[predictedGestureId]?.ring ?? "#00d4ff",
                          }}
                        >
                          {predictedGesture?.name}
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
      </div>
    );
  }
