export type TriggerSource = 'button' | 'signal' | 'scheduled';
export type RecorderState = 'idle' | 'recording' | 'cooldown';
export interface RecorderPoint { time: number; raw: number; normalizedActivity: number; sequence?: number }
export interface WaveformPoint { time: number; value: number }
export interface Segment {
  id: string;
  triggerSource: TriggerSource;
  points: WaveformPoint[];
  triggeredAt: number;
  completedAt: number;
  durationMs: number;
  preTriggerPointCount: number;
}
export interface RecorderEvent {
  type: 'capture_triggered' | 'capture_completed' | 'capture_failed';
  time: number;
  attemptId: string;
  triggerSource: TriggerSource;
  reason?: string;
  rawPointCount?: number;
}
export interface RecorderConfig {
  durationMs: number;
  threshold: number;
  triggerMode: 'signal' | 'manual';
  preTriggerMs: number;
  cooldownMs: number;
  hysteresisRatio: number;
  minPoints: number;
  maxGapMs: number;
}

// Both trigger adapters feed this capture path. Display values never enter the waveform.
export class RecorderMachine {
  state: RecorderState = 'idle';
  activity = 0;
  active: Segment | null = null;
  completed: Segment[] = [];
  events: RecorderEvent[] = [];
  private pre: WaveformPoint[] = [];
  private enabled = false;
  private above = true;
  private watermark = -Infinity;
  private lastPointTime: number | null = null;
  private cooldownUntil = 0;
  private serial = 0;
  constructor(public config: RecorderConfig, private id = () => crypto.randomUUID()) {}

  enable(enabled: boolean, boundary: number, reason = 'context_changed', now = Date.now()) {
    this.abort(reason, now);
    this.enabled = enabled;
    this.watermark = boundary;
    this.lastPointTime = null;
    this.above = true;
    this.pre = [];
    this.completed = [];
    this.state = 'idle';
  }

  trigger(source: TriggerSource, time: number) {
    if (!this.canTrigger(source, time)) return false;
    const pre = this.pre.filter(p => p.time >= time - this.config.preTriggerMs && p.time < time);
    this.active = {
      id: `${this.id()}-${++this.serial}`, triggerSource: source,
      points: [...pre], triggeredAt: time,
      completedAt: time + this.config.durationMs, durationMs: this.config.durationMs,
      preTriggerPointCount: pre.length,
    };
    this.state = 'recording';
    this.events.push({ type: 'capture_triggered', time, attemptId: this.active.id, triggerSource: source });
    return true;
  }

  canTrigger(source: TriggerSource, time: number) {
    return this.enabled && this.state === 'idle' && this.completed.length === 0 &&
      (source === 'signal' || (this.lastPointTime !== null && time - this.lastPointTime <= this.config.maxGapMs));
  }

  feed(points: RecorderPoint[]) {
    if (!this.enabled) return;
    const boundary = this.watermark;
    const fresh = points.filter(p => (p.sequence ?? p.time) > boundary);
    for (const p of fresh) {
      this.watermark = Math.max(this.watermark, p.sequence ?? p.time);
      if (!Number.isFinite(p.raw) || !Number.isFinite(p.normalizedActivity)) {
        this.abort('invalid_signal', p.time);
        continue;
      }
      if (this.lastPointTime !== null && p.time - this.lastPointTime > this.config.maxGapMs) this.abort('signal_gap', p.time);
      this.lastPointTime = p.time;
      this.activity = p.normalizedActivity;
      const lower = this.config.threshold * this.config.hysteresisRatio;
      const crossed = !this.above && this.activity >= this.config.threshold;
      if (this.activity >= this.config.threshold) this.above = true;
      else if (this.activity <= lower) this.above = false;
      if (this.state === 'cooldown' && p.time >= this.cooldownUntil &&
          (this.config.triggerMode === 'manual' || this.activity <= lower)) this.state = 'idle';
      if (this.state === 'idle' && this.config.triggerMode === 'signal' && crossed) this.trigger('signal', p.time);
      if (this.active) {
        // Half-open windows give both conditions an identical fixed capture duration.
        if (p.time >= this.active.triggeredAt && p.time < this.active.completedAt) {
          this.active.points.push({ time: p.time, value: p.raw });
        }
        if (p.time >= this.active.completedAt) this.finish(p.time);
      }
      this.pre.push({ time: p.time, value: p.raw });
      this.pre = this.pre.filter(q => q.time >= p.time - this.config.preTriggerMs);
    }
  }

  checkStall(now: number) {
    if (this.active && this.lastPointTime !== null && now - this.lastPointTime > this.config.maxGapMs) this.abort('signal_stalled', now);
  }

  abort(reason: string, time: number) {
    if (this.active) {
      this.events.push({ type: 'capture_failed', time, attemptId: this.active.id,
        triggerSource: this.active.triggerSource, reason, rawPointCount: this.active.points.length });
    }
    this.active = null;
    this.state = 'cooldown';
    this.cooldownUntil = time + this.config.cooldownMs;
    this.above = true;
    this.pre = [];
  }

  private finish(time: number) {
    const segment = this.active!;
    if (segment.points.length < this.config.minPoints) {
      this.abort('insufficient_points', time);
      return;
    }
    this.completed.push(segment);
    this.events.push({ type: 'capture_completed', time, attemptId: segment.id,
      triggerSource: segment.triggerSource, rawPointCount: segment.points.length });
    this.active = null;
    this.state = 'cooldown';
    this.cooldownUntil = time + this.config.cooldownMs;
    this.pre = [];
  }
}
