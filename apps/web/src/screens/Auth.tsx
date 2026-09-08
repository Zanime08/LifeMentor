import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Btn, Field, I, Seg, Spinner, TextInput } from '../components/ui';
import { useApp } from '../state/store';

export function AuthScreen() {
  const { app, mutate, toast } = useApp();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!app || busy) return;
    setBusy(true);
    try {
      const state = mode === 'login'
        ? await app.services.auth.signIn({ email, password })
        : await app.services.auth.signUp({ email, password, displayName: name || null });
      if (state.authenticated) {
        toast(`Готово, ${state.displayName ?? state.email}. Данные будут синхронизироваться между устройствами.`, 'ok');
        navigate('/dashboard');
      }
    } catch (error) {
      const message = error && typeof error === 'object' && 'userMessage' in error
        ? String((error as { userMessage: unknown }).userMessage)
        : error instanceof Error ? error.message : 'Ошибка сети. Сервер LifeMentor недоступен.';
      toast(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="auth-card card">
        <div className="brand" style={{ padding: '2px 0 14px' }}>
          <div className="brand-mark">LM</div>
          <div>
            <div className="brand-name">LifeMentor</div>
            <div className="brand-sub">личный ИИ-наставник и система развития</div>
          </div>
        </div>
        <div className="row mb">
          <Seg value={mode} onChange={setMode} options={[{ id: 'login', label: 'Вход' }, { id: 'register', label: 'Регистрация' }]} />
        </div>
        {mode === 'register' && (
          <Field label="Имя">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Как к вам обращаться" autoComplete="name" />
          </Field>
        )}
        <Field label="Email">
          <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
        </Field>
        <Field label="Пароль" hint={mode === 'register' ? 'Минимум 8 символов' : undefined}>
          <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </Field>
        <Btn kind="primary" style={{ width: '100%', marginTop: 6 }} onClick={() => void submit()} disabled={busy || !email || password.length < (mode === 'register' ? 8 : 1)}>
          {busy ? <Spinner /> : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
        </Btn>
        <p className="xsmall muted mt">
          Аккаунт нужен для синхронизации между устройствами и облачного ИИ.
          Все данные при этом хранятся локально на вашем устройстве.
        </p>
        <div className="divider" />
        <Btn kind="ghost" style={{ width: '100%' }} onClick={() => navigate('/onboarding')}>
          Продолжить без аккаунта (только офлайн) →
        </Btn>
      </div>
    </div>
  );
}
