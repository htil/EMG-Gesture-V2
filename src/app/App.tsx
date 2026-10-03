import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import AdminApp from './admin/AdminApp';
import FlowBasedCaptureScreen from './FlowBasedCaptureScreen';
import ParticipantGate from './study/ParticipantGate';
import StudySession from './study/StudySession';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ParticipantGate />} />
        <Route path="/session" element={<StudySession />} />
        <Route path="/admin" element={<AdminApp />} />
        <Route path="/lab" element={<FlowBasedCaptureScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
