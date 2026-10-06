export interface WavePoint {
  time: number;
  value: number;
}

export interface WaveDomain {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export function alignWaveform(
  points: Array<{ time: number; value: number }>,
  preTriggerPointCount: number,
  triggeredAt: number,
): WavePoint[] {
  const triggerOffset = points[preTriggerPointCount]?.time ?? triggeredAt;
  return points.map((point) => ({
    time: Math.round(point.time - triggerOffset),
    value: point.value,
  }));
}

export function sharedWaveDomain(series: WavePoint[][]): WaveDomain {
  let xMin = 0;
  let xMax = 1;
  let yMin = -1;
  let yMax = 1;
  let seen = false;

  series.forEach((points) => {
    points.forEach((point) => {
      if (!seen) {
        xMin = point.time;
        xMax = point.time;
        yMin = point.value;
        yMax = point.value;
        seen = true;
        return;
      }
      xMin = Math.min(xMin, point.time);
      xMax = Math.max(xMax, point.time);
      yMin = Math.min(yMin, point.value);
      yMax = Math.max(yMax, point.value);
    });
  });

  if (xMax <= xMin) xMax = xMin + 1;
  const yPad = Math.max((yMax - yMin) * 0.08, 0.05);
  return {
    xMin,
    xMax,
    yMin: yMin - yPad,
    yMax: yMax + yPad,
  };
}
