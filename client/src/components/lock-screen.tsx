import { useState, type FormEvent } from "react";
import { Lock, Loader2 } from "lucide-react";

interface LockScreenProps {
  onPasswordLogin: (password: string) => Promise<boolean>;
}

export function LockScreen({ onPasswordLogin }: LockScreenProps) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const success = await onPasswordLogin(password);
      if (!success) setError("Incorrect password. Please try again.");
    } catch (e: any) {
      setError(e?.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-zinc-950">
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-xs flex-col items-center gap-6 px-6 text-center"
      >
        <Lock className="h-12 w-12 text-blue-400" />
        <div className="text-3xl font-bold tracking-tight text-white">Sensei</div>
        <div className="text-sm text-zinc-500">Enter password to continue</div>

        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-center text-white placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
        />

        <button
          type="submit"
          disabled={loading || !password}
          className="flex w-full items-center justify-center rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-all hover:bg-blue-500 active:scale-95 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "Unlock"}
        </button>

        {error && <div className="max-w-xs text-sm text-red-400">{error}</div>}
      </form>
    </div>
  );
}
