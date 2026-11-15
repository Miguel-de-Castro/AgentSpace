import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { AppHeader } from "@/components/AppHeader";
import { Dashboard } from "@/pages/Dashboard";
import { Today } from "@/pages/Today";
import { ProjectView } from "@/pages/ProjectView";
import { ProjectSettings } from "@/pages/ProjectSettings";
import { MissionDetail } from "@/pages/MissionDetail";
import { Digest } from "@/pages/Digest";
import { TrackRecord } from "@/pages/TrackRecord";
import { ParallelSupervision } from "@/pages/ParallelSupervision";

function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-background text-foreground">
        <AppHeader />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/today" element={<Today />} />
          <Route path="/projects/:projectId" element={<ProjectView />} />
          <Route path="/projects/:projectId/settings" element={<ProjectSettings />} />
          <Route path="/missions/:missionId" element={<MissionDetail />} />
          <Route path="/digest" element={<Digest />} />
          <Route path="/track-record" element={<TrackRecord />} />
          <Route path="/supervision" element={<ParallelSupervision />} />
        </Routes>
      </div>
      <Toaster />
    </BrowserRouter>
  );
}

export default App;
