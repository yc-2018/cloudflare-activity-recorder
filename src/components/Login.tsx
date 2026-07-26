import { FormEvent, useState } from "react";
import { Activity, LockKeyhole } from "lucide-react";
import { api } from "../lib/api";

interface LoginProps {
  onSuccess: () => void;
}

export function Login({ onSuccess }: LoginProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      onSuccess();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="brand-mark"><Activity size={24} /></div>
        <div>
          <p className="eyebrow">ACTIVITY RECORDER</p>
          <h1 id="login-title">查看活动记录</h1>
          <p className="muted">输入仪表盘密码继续。</p>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="password">密码</label>
          <div className="input-with-icon">
            <LockKeyhole size={17} />
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
              required
            />
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button full-width" disabled={loading}>
            {loading ? "正在验证..." : "登录"}
          </button>
        </form>
      </section>
    </main>
  );
}
