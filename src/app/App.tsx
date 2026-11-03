import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import AdminApp from './admin/AdminApp';
import FlowBasedCaptureScreen from './FlowBasedCaptureScreen';
import ParticipantGate from './study/ParticipantGate';
import ParticipantTheme from './ParticipantTheme';
import StudySession from './study/StudySession';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<ParticipantTheme />}>
          <Route path="/" element={<ParticipantGate />} />
          <Route path="/session" element={<StudySession />} />
        </Route>
        <Route path="/admin" element={<AdminApp />} />
        <Route path="/lab" element={<FlowBasedCaptureScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
