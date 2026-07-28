import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Dashboard } from "./components/Dashboard";
import { Login } from "./components/Login";
import { api } from "./lib/api";
import type { AuthStatus } from "./types";

export default function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState("");

  const loadStatus = useCallback(async () => {
    setError("");
    try {
      setStatus(await api<AuthStatus>("/api/auth/status"));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "无法连接服务");
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  if (error) return <main className="center-state"><AlertTriangle size={28} /><h1>服务暂时不可用</h1><p>{error}</p><button className="secondary-button" onClick={loadStatus}><RefreshCw size={16} />重试</button></main>;
  if (!status) return <main className="center-state"><RefreshCw className="spin" size={24} /><p>正在连接活动记录...</p></main>;
  if (!status.configured) return <main className="center-state"><AlertTriangle size={28} /><h1>服务尚未配置完成</h1><p>已设置页面密码，但缺少 SESSION_SECRET。</p></main>;
  if (status.enabled && !status.authenticated) return <Login onSuccess={loadStatus} />;
  return (
    <Dashboard
      authEnabled={status.enabled}
      detailsAuthEnabled={status.detailsEnabled}
      detailsAuthenticated={status.detailsAuthenticated}
      onLogout={loadStatus}
      onUnauthorized={loadStatus}
    />
  );
}
