import { useState } from 'react';

export default function Login({ onLogin }) {
  const [account, setAccount] = useState('');
  const [error, setError] = useState('');
  const [shaking, setShaking] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (account.trim().toLowerCase() === 'soyoo') {
      localStorage.setItem('blueprint_user', account.trim());
      onLogin(account.trim());
    } else {
      setError('账号不正确');
      setShaking(true);
      setTimeout(() => setShaking(false), 500);
    }
  };

  return (
    <div className="login-overlay">
      <div className={`login-box ${shaking ? 'login-shake' : ''}`}>
        <div className="login-logo">📷</div>
        <h1 className="login-title">镜头蓝图编辑器</h1>
        <p className="login-subtitle">Soyoo Playable Studio</p>
        <form onSubmit={handleSubmit}>
          <input
            className="login-input"
            type="text"
            placeholder="请输入账号"
            value={account}
            onChange={(e) => { setAccount(e.target.value); setError(''); }}
            autoFocus
          />
          {error && <div className="login-error">{error}</div>}
          <button className="login-btn" type="submit">进入</button>
        </form>
      </div>
    </div>
  );
}
