import { useState, useEffect, useCallback } from "react";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";

interface AuthState {
  isAuthenticated: boolean;
  isSetup: boolean;
  isLoading: boolean;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    isSetup: false,
    isLoading: true,
  });

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/status");
      const data = await res.json();
      setState({
        isAuthenticated: !!data.isAuthenticated,
        isSetup: data.isSetup,
        isLoading: false,
      });
    } catch {
      setState((s) => ({ ...s, isLoading: false }));
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const register = useCallback(async () => {
    const optRes = await fetch("/api/auth/register-options", { method: "POST" });
    const options = await optRes.json();
    const regResponse = await startRegistration({ optionsJSON: options });
    const verifyRes = await fetch("/api/auth/register-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: regResponse, deviceName: navigator.userAgent.slice(0, 50) }),
    });
    const result = await verifyRes.json();
    if (result.verified) {
      setState((s) => ({ ...s, isAuthenticated: true, isSetup: true }));
    }
    return result.verified;
  }, []);

  const authenticate = useCallback(async () => {
    const optRes = await fetch("/api/auth/login-options", { method: "POST" });
    const options = await optRes.json();
    const authResponse = await startAuthentication({ optionsJSON: options });
    const verifyRes = await fetch("/api/auth/login-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(authResponse),
    });
    const result = await verifyRes.json();
    if (result.verified) {
      setState((s) => ({ ...s, isAuthenticated: true }));
    }
    return result.verified;
  }, []);

  const loginWithPassword = useCallback(async (password: string) => {
    const res = await fetch("/api/auth/password-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      setState((s) => ({ ...s, isAuthenticated: true }));
      return true;
    }
    return false;
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setState((s) => ({ ...s, isAuthenticated: false }));
  }, []);

  return { ...state, register, authenticate, loginWithPassword, logout };
}
