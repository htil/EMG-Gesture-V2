import { useCallback, useEffect, useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { Activity, ArrowRight, BarChart3, Gamepad2, Hand, RotateCcw, Waves, Zap } from 'lucide-react';
import type { CaptureTriggerMode } from './useGestureRecorder';
import type { SignalPoint } from './useSignalSource';

type Stage = 'capture' | 'review' | 'game' | 'compare';

export interface FlowTrialPreview {
  id: string;
  method: CaptureTriggerMode;
  gestureName: string;
  pairIndex: number;
  points: Array<{ time: number; value: number }>;
}

interface StudyNodeData extends Record<string, unknown> {
  label: string;
  signalData?: SignalPoint[];
  rawData?: SignalPoint[];
  isStreaming?: boolean;
  isRecording?: boolean;
  gestureName?: string;
  threshold?: number;
  method?: CaptureTriggerMode;
  activeMethod?: CaptureTriggerMode;
  trialCount?: number;
  trials?: FlowTrialPreview[];
  onOpen?: () => void;
  onTrigger?: () => void;
  triggerEnabled?: boolean;
  connected?: boolean;
}

type StudyNode = Node<StudyNodeData>;

const allowedPairs = new Set([
  'signal:threshold',
  'signal:button',
  'threshold:review',
  'button:review',
  'review:game',
  'game:compare',
]);

export const STUDY_INITIAL_EDGES: Edge[] = [
  { id: 'signal-threshold', source: 'signal', target: 'threshold', type: 'smoothstep' },
  { id: 'signal-button', source: 'signal', target: 'button', type: 'smoothstep' },
  { id: 'threshold-review', source: 'threshold', target: 'review', type: 'smoothstep' },
  { id: 'button-review', source: 'button', target: 'review', type: 'smoothstep' },
  { id: 'review-game', source: 'review', target: 'game', type: 'smoothstep' },
  { id: 'game-compare', source: 'game', target: 'compare', type: 'smoothstep' },
];

const initialNodes: StudyNode[] = [
  { id: 'signal', type: 'signalNode', position: { x: 0, y: 180 }, data: { label: 'Live signal' } },
  { id: 'threshold', type: 'triggerNode', position: { x: 420, y: 24 }, data: { label: 'Threshold', method: 'threshold' } },
  { id: 'button', type: 'triggerNode', position: { x: 420, y: 390 }, data: { label: 'Button', method: 'button' } },
  { id: 'review', type: 'reviewNode', position: { x: 800, y: 180 }, data: { label: 'Captured pairs' } },
  { id: 'game', type: 'gameNode', position: { x: 1180, y: 150 }, data: { label: 'Review game' } },
  { id: 'compare', type: 'compareNode', position: { x: 1580, y: 175 }, data: { label: 'Comparison' } },
];

function pointsToPolyline(values: number[], width: number, height: number, min?: number, max?: number) {
  if (values.length < 2) return '';
  const low = min ?? Math.min(...values);
  const high = max ?? Math.max(...values);
  const spread = Math.max(high - low, 0.0001);
  return values.map((value, index) => (
    `${((index / (values.length - 1)) * width).toFixed(1)},${(height - ((value - low) / spread) * height).toFixed(1)}`
  )).join(' ');
}

function SignalNode({ data }: NodeProps<StudyNode>) {
  const activity = (data.signalData ?? []).slice(-72).map((point) => point.normalizedActivity);
  const raw = (data.rawData ?? []).slice(-72).map((point) => point.raw);
  const threshold = data.threshold ?? 0.6;
  return (
    <div className="study-node study-node-signal">
      <div className="study-node-heading">
        <span className="study-node-icon cyan"><Waves size={17} /></span>
        <div><strong>Live signal</strong><small>Shared input · channel stream</small></div>
        <span className={`study-live-dot ${data.isStreaming ? 'active' : ''}`} />
      </div>
      <div className="study-node-inner">
        <div className="study-chart-label"><span>ACTIVITY ENVELOPE</span><span>{data.isStreaming ? 'LIVE' : 'IDLE'}</span></div>
        <svg className="study-sparkline" viewBox="0 0 300 96" preserveAspectRatio="none" role="img" aria-label="Live activity waveform">
          <line x1="0" x2="300" y1={96 - threshold * 96} y2={96 - threshold * 96} stroke="#fbbf24" strokeDasharray="5 5" opacity="0.6" />
          <polyline fill="none" stroke="#22d3ee" strokeWidth="2.5" strokeLinejoin="round" points={pointsToPolyline(activity, 300, 96, 0, 1)} />
        </svg>
        <div className="study-chart-label"><span>RAW SIGNAL</span><span>{raw.length} PTS</span></div>
        <svg className="study-sparkline raw" viewBox="0 0 300 44" preserveAspectRatio="none" role="img" aria-label="Live raw signal waveform">
          <polyline fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeLinejoin="round" points={pointsToPolyline(raw, 300, 44)} />
        </svg>
        <div className="study-node-foot"><span>{data.gestureName ?? 'Select a gesture'}</span><span>Threshold {threshold.toFixed(2)}</span></div>
      </div>
      <Handle type="source" position={Position.Right} id="signal-out" className="study-handle" />
    </div>
  );
}

function TriggerNode({ data }: NodeProps<StudyNode>) {
  const method = data.method ?? 'threshold';
  const threshold = method === 'threshold';
  const active = data.activeMethod === method;
  return (
    <div className={`study-node study-node-trigger ${threshold ? 'threshold' : 'button'} ${active ? 'active-method' : ''}`}>
      <Handle type="target" position={Position.Left} id="trigger-in" className="study-handle" />
      <div className="study-node-heading">
        <span className={`study-node-icon ${threshold ? 'cyan' : 'violet'}`}>{threshold ? <Zap size={17} /> : <Hand size={17} />}</span>
        <div><strong>{threshold ? 'Threshold capture' : 'Button capture'}</strong><small>{threshold ? 'Automatic crossing' : 'Manual press / Space'}</small></div>
      </div>
      <div className="study-node-inner">
        <div className="study-trigger-stat"><span>{data.trialCount ?? 0}</span><small>samples captured</small></div>
        <p className="study-node-note">{!data.connected ? 'Connect signal to arm this method.' : threshold ? `Starts above ${data.threshold?.toFixed(2) ?? '0.60'}` : 'Starts when participant presses the button.'}</p>
        <button className="study-node-action nodrag" type="button" onClick={data.onOpen}>
          Open capture <ArrowRight size={13} />
        </button>
        {!threshold && (
          <button className="study-node-trigger-button nodrag" type="button" onClick={data.onTrigger} disabled={!data.triggerEnabled}>
            <Hand size={13} /> Capture now
          </button>
        )}
      </div>
      <Handle type="source" position={Position.Right} id="trigger-out" className="study-handle" />
    </div>
  );
}

function ReviewNode({ data }: NodeProps<StudyNode>) {
  const latest = (data.trials ?? []).slice(-2).reverse();
  return (
    <div className="study-node study-node-review">
      <Handle type="target" position={Position.Left} id="review-in" className="study-handle" />
      <div className="study-node-heading">
        <span className="study-node-icon teal"><Activity size={17} /></span>
        <div><strong>Captured pairs</strong><small>Trigger-aligned evidence</small></div>
      </div>
      <div className="study-node-inner">
        {latest.length ? latest.map((trial) => (
          <div className="study-captured-row" key={trial.id}>
            <div className="study-chart-label"><span>{trial.method.toUpperCase()} · {trial.gestureName}</span><span>#{trial.pairIndex}</span></div>
            <svg viewBox="0 0 280 52" preserveAspectRatio="none" role="img" aria-label={`${trial.method} captured waveform`}>
              <polyline fill="none" stroke={trial.method === 'threshold' ? '#22d3ee' : '#a78bfa'} strokeWidth="2" points={pointsToPolyline(trial.points.map((point) => point.value), 280, 52)} />
            </svg>
          </div>
        )) : <div className="study-node-empty">Connect a trigger to route captured waveforms here.</div>}
        <button className="study-node-action nodrag" type="button" onClick={data.onOpen}>Inspect pairs <ArrowRight size={13} /></button>
      </div>
      <Handle type="source" position={Position.Right} id="review-out" className="study-handle" />
    </div>
  );
}

function GameNode({ data }: NodeProps<StudyNode>) {
  const trialCount = data.trials?.length ?? 0;
  return (
    <div className="study-node study-node-game">
      <Handle type="target" position={Position.Left} id="game-in" className="study-handle" />
      <div className="study-node-heading">
        <span className="study-node-icon emerald"><Gamepad2 size={17} /></span>
        <div><strong>Review game</strong><small>Three.js · in development</small></div>
      </div>
      <div className="study-node-inner">
        <div className="study-game-slot">
          <span>Reserved canvas</span>
          <small>{trialCount > 0 ? `${trialCount} captured trials ready` : 'Collected trials will load here'}</small>
        </div>
        <p className="study-node-note">Participants review captured signals against the trained model inside the game.</p>
        <button className="study-node-action nodrag" type="button" onClick={data.onOpen}>
          Open placeholder <ArrowRight size={13} />
        </button>
      </div>
      <Handle type="source" position={Position.Right} id="game-out" className="study-handle" />
    </div>
  );
}

function CompareNode({ data }: NodeProps<StudyNode>) {
  const threshold = (data.trials ?? []).filter((trial) => trial.method === 'threshold').length;
  const button = (data.trials ?? []).filter((trial) => trial.method === 'button').length;
  return (
    <div className="study-node study-node-compare">
      <Handle type="target" position={Position.Left} id="compare-in" className="study-handle" />
      <div className="study-node-heading">
        <span className="study-node-icon amber"><BarChart3 size={17} /></span>
        <div><strong>Compare methods</strong><small>Matched trial outcomes</small></div>
      </div>
      <div className="study-node-inner">
        <div className="study-compare-row"><span>Threshold</span><b>{threshold}</b></div>
        <div className="study-compare-row"><span>Button</span><b>{button}</b></div>
        <p className="study-node-note">{threshold === button && threshold > 0 ? 'Balanced sample counts' : 'Collect equal counts for a fair comparison'}</p>
        <button className="study-node-action nodrag" type="button" onClick={data.onOpen}>View analysis <ArrowRight size={13} /></button>
      </div>
    </div>
  );
}

const nodeTypes = {
  signalNode: SignalNode,
  triggerNode: TriggerNode,
  reviewNode: ReviewNode,
  gameNode: GameNode,
  compareNode: CompareNode,
};

export interface StudyFlowCanvasProps {
  signalData: SignalPoint[];
  rawData: SignalPoint[];
  isStreaming: boolean;
  isRecording: boolean;
  threshold: number;
  gestureName: string;
  activeMethod: CaptureTriggerMode;
  trials: FlowTrialPreview[];
  onOpenStage: (stage: Stage, method?: CaptureTriggerMode) => void;
  onButtonTrigger: () => void;
  onConnectivityChange: (connections: Record<CaptureTriggerMode, boolean>) => void;
  buttonTriggerEnabled: boolean;
}

export default function StudyFlowCanvas({
  signalData,
  rawData,
  isStreaming,
  isRecording,
  threshold,
  gestureName,
  activeMethod,
  trials,
  onOpenStage,
  onButtonTrigger,
  onConnectivityChange,
  buttonTriggerEnabled,
}: StudyFlowCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<StudyNode>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(STUDY_INITIAL_EDGES);
  const hasConnection = useCallback((source: string, target: string) => edges.some((edge) => edge.source === source && edge.target === target), [edges]);
  const routedTrials = useMemo(() => trials.filter((trial) => hasConnection(trial.method, 'review')), [hasConnection, trials]);
  const gameTrials = useMemo(() => (hasConnection('review', 'game') ? routedTrials : []), [hasConnection, routedTrials]);

  useEffect(() => {
    onConnectivityChange({
      threshold: hasConnection('signal', 'threshold'),
      button: hasConnection('signal', 'button'),
    });
  }, [hasConnection, onConnectivityChange]);

  useEffect(() => {
    setNodes((previous) => previous.map((node) => ({
      ...node,
      data: {
        ...node.data,
        signalData,
        rawData,
        isStreaming,
        isRecording,
        threshold,
        gestureName,
        activeMethod,
        trials: node.id === 'compare'
          ? hasConnection('game', 'compare') ? gameTrials : []
          : node.id === 'game' ? gameTrials
            : node.id === 'review' ? routedTrials : trials,
        connected: hasConnection('signal', node.id),
        trialCount: trials.filter((trial) => trial.method === node.id).length,
        triggerEnabled: buttonTriggerEnabled && hasConnection('signal', 'button'),
        onOpen: node.id === 'threshold' || node.id === 'button'
          ? () => onOpenStage('capture', node.id as CaptureTriggerMode)
          : node.id === 'review' ? () => onOpenStage('review')
            : node.id === 'game' ? () => onOpenStage('game')
              : () => onOpenStage('compare'),
        onTrigger: onButtonTrigger,
      },
    })));
  }, [activeMethod, buttonTriggerEnabled, gameTrials, gestureName, hasConnection, isRecording, isStreaming, onButtonTrigger, onOpenStage, rawData, routedTrials, setNodes, signalData, threshold, trials]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || !allowedPairs.has(`${connection.source}:${connection.target}`)) return;
    setEdges((current) => addEdge({ ...connection, type: 'smoothstep' }, current));
  }, [setEdges]);

  const validConnection = useCallback((connection: Edge | Connection) => (
    Boolean(connection.source && connection.target && allowedPairs.has(`${connection.source}:${connection.target}`))
  ), []);

  const styledEdges = useMemo(() => edges.map((edge) => ({
    ...edge,
    animated: isStreaming && edge.source === 'signal',
    style: { stroke: edge.source === 'button' ? '#a78bfa' : edge.source === 'threshold' ? '#22d3ee' : edge.source === 'game' || edge.target === 'game' ? '#6ee7b7' : '#5f7795', strokeWidth: 2.2 },
  })), [edges, isStreaming]);

  return (
    <section className="study-flow-shell" aria-label="Interactive capture workflow">
      <div className="study-flow-title">
        <div><span className="study-flow-kicker">INTERACTIVE EXPERIMENT GRAPH</span><h1>Shape the capture flow.</h1><p>Drag nodes, pan the canvas, or pull a port to reconnect the signal path.</p></div>
        <button type="button" className="study-flow-reset" onClick={() => setEdges(STUDY_INITIAL_EDGES)}><RotateCcw size={14} /> Reset connections</button>
      </div>
      <div className="study-flow-canvas">
        <ReactFlow
          nodes={nodes}
          edges={styledEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={validConnection}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => {
            if (node.id === 'threshold' || node.id === 'button') onOpenStage('capture', node.id as CaptureTriggerMode);
            else if (node.id === 'review') onOpenStage('review');
            else if (node.id === 'game') onOpenStage('game');
            else if (node.id === 'compare') onOpenStage('compare');
          }}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.45}
          maxZoom={1.5}
          deleteKeyCode={['Backspace', 'Delete']}
          proOptions={{ hideAttribution: false }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color="rgba(148,163,184,0.15)" />
          <Controls showInteractive={false} />
          <MiniMap nodeColor={(node) => node.id === 'button' ? '#a78bfa' : node.id === 'threshold' ? '#22d3ee' : node.id === 'game' ? '#6ee7b7' : '#334155'} maskColor="rgba(5,8,18,0.65)" />
        </ReactFlow>
      </div>
      <div className="study-flow-caption"><span><span className="study-flow-legend cyan" /> Signal / threshold path</span><span><span className="study-flow-legend violet" /> Button path</span><span><span className="study-flow-legend emerald" /> Review game</span><span>Delete a selected connection to disconnect; drag between ports to restore it.</span></div>
    </section>
  );
}
