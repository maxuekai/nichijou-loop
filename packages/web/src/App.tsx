import { Routes, Route, Navigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { api } from "./api";
import { SetupWizard } from "./views/setup/SetupWizard";
import { AdminLayout } from "./views/admin/AdminLayout";
import { Dashboard } from "./views/admin/Dashboard";
import { MembersPage } from "./views/admin/MembersPage";
import { SoulEditor } from "./views/admin/SoulEditor";
import { StatusPage } from "./views/admin/StatusPage";
import { ChatPage } from "./views/admin/ChatPage";
import { WeChatPage } from "./views/admin/WeChatPage";
import { LogsPage } from "./views/admin/LogsPage";
import { RemindersPage } from "./views/admin/RemindersPage";
import { PluginsPage } from "./views/admin/PluginsPage";
import { BoardView } from "./views/board/BoardView";

export function App() {
  const [loading, setLoading] = useState(true);
  const [setupDone, setSetupDone] = useState(false);

  useEffect(() => {
    api.getStatus().then((s) => {
      setSetupDone(s.setupCompleted);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <div className="text-stone-400 text-lg">加载中...</div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/setup" element={<SetupWizard onComplete={() => setSetupDone(true)} />} />
      <Route path="/board" element={<BoardView />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="members" element={<MembersPage />} />
        <Route path="soul" element={<SoulEditor />} />
        <Route path="status" element={<StatusPage />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="wechat" element={<WeChatPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="reminders" element={<RemindersPage />} />
        <Route path="plugins" element={<PluginsPage />} />
      </Route>
      <Route path="*" element={<Navigate to={setupDone ? "/admin" : "/setup"} replace />} />
    </Routes>
  );
}
