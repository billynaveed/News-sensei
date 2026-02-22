import { useState } from "react";
import { Fingerprint, Loader2 } from "lucide-react";

interface LockScreenProps {
  isSetup: boolean;
  onAuthenticate: () => Promise<boolean>;
  onRegister: () => Promise<boolean>;
}

export function LockScreen({ isSetup, onAuthenticate, onRegister }: LockScreenProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAction = async () => {
    setLoading(true);
    setError(null);
    try {
      const success = isSetup ? await onAuthenticate() : await onRegister();
      if (!success) setError("Authentication failed. Please try again.");
    } catch (e: any) {
      setError(e?.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-zinc-950">
      <div className="flex flex-col items-center gap-8 px-6 text-center">
        <div className="text-3xl font-bold tracking-tight text-white">
          Sensei
        </div>
        <div className="text-zinc-500 text-sm">
          {isSetup ? "Authentication required" : "Set up biometric access"}
        </div>

        <button
          onClick={handleAction}
          disabled={loading}
          className="group flex flex-col items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-900 px-12 py-8 transition-all hover:border-zinc-600 hover:bg-zinc-800 active:scale-95 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-16 w-16 text-blue-400 animate-spin" />
          ) : (
            <Fingerprint className="h-16 w-16 text-blue-400 transition-transform group-hover:scale-110" />
          )}
          <span className="text-sm font-medium text-zinc-300">
            {loading
              ? "Verifying..."
              : isSetup
                ? "Unlock with Face ID"
                : "Set up Face ID"}
          </span>
        </button>

        {error && (
          <div className="text-sm text-red-400 max-w-xs">{error}</div>
        )}
      </div>
    </div>
  );
}
