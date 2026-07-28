import { useState, type FormEvent } from "react";
import { LockKeyhole } from "lucide-react";
import { api } from "../lib/api";

interface DetailsLoginProps {
  onSuccess: () => void;
}

export function DetailsLogin({ onSuccess }: DetailsLoginProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await api("/api/auth/details/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setPassword("");
      onSuccess();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "验证失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="details-login">
      <span className="details-login-icon"><LockKeyhole size={20} /></span>
      <div className="details-login-copy">
        <strong>采样明细已保护</strong>
        <span>输入采样明细密码后查看原始窗口记录。</span>
      </div>
      <form onSubmit={submit}>
        <label htmlFor="details-password">采样明细密码</label>
        <div className="details-login-controls">
          <input
            id="details-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
          <button className="primary-button" disabled={loading}>
            {loading ? "验证中..." : "解锁明细"}
          </button>
        </div>
        {error && <span className="form-error" role="alert">{error}</span>}
      </form>
    </div>
  );
}
