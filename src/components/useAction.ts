import { useState } from "react";

import { errorMessage } from "../lib/ipc";

export interface Action {
  /** Key of the action in flight, so only its button shows progress. */
  pending: string | null;
  error: string | null;
  /** Runs `fn` unless another action is in flight; resolves true on success. */
  run: (key: string, fn: () => Promise<void>) => Promise<boolean>;
}

export function useAction(): Action {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<void>): Promise<boolean> => {
    if (pending !== null) return false;
    setPending(key);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setPending(null);
    }
  };

  return { pending, error, run };
}
