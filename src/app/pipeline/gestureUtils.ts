import type { Gesture } from './types';

export const DEFAULT_GESTURES: Gesture[] = [
  { id: 'pinch', name: 'Pinch' },
  { id: 'squeeze', name: 'Squeeze' },
  { id: 'relax', name: 'Relax' },
];

export function createGesture(name: string): Gesture {
  const trimmed = name.trim();
  const baseId = trimmed
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  return {
    id: baseId || `gesture-${Date.now()}`,
    name: trimmed,
  };
}

export function gestureIdFromName(name: string): string {
  return createGesture(name).id;
}

export function findGesture(gestures: Gesture[], id: string): Gesture | undefined {
  return gestures.find((gesture) => gesture.id === id);
}

export function findGestureByName(gestures: Gesture[], name: string): Gesture | undefined {
  return gestures.find((gesture) => gesture.name.toLowerCase() === name.toLowerCase());
}

export interface GestureColorScheme {
  ring: string;
  bar: string;
}

const PALETTE: GestureColorScheme[] = [
  { ring: '#00d4ff', bar: '#00d4ff' },
  { ring: '#f5a623', bar: '#f5a623' },
  { ring: '#4ade80', bar: '#4ade80' },
  { ring: '#a78bfa', bar: '#a78bfa' },
  { ring: '#fb7185', bar: '#fb7185' },
  { ring: '#38bdf8', bar: '#38bdf8' },
  { ring: '#fbbf24', bar: '#fbbf24' },
  { ring: '#34d399', bar: '#34d399' },
];

export function buildGestureColorMap(gestures: Gesture[]): Record<string, GestureColorScheme> {
  const map: Record<string, GestureColorScheme> = {};

  gestures.forEach((gesture, index) => {
    map[gesture.id] = PALETTE[index % PALETTE.length];
  });

  return map;
}

export function getGestureBarColor(gestureId: string, gestures: Gesture[]): string {
  const index = gestures.findIndex((gesture) => gesture.id === gestureId);
  return PALETTE[(index >= 0 ? index : 0) % PALETTE.length].bar;
}
