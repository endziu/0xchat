import { createContext } from 'preact';
import { X } from 'lucide-preact';
import { useContext, useState } from 'preact/hooks';

type ToastType = 'success' | 'error' | 'info';

interface ToastMessage {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  toast: (message: string, type?: ToastType, durationMs?: number) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const useToast = (): ToastContextType => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be called within ToastProvider');
  return ctx;
};

const borderColor = { success: 'border-green-900', error: 'border-red-900', info: 'border-neutral-700' };

export const ToastProvider = ({ children }: { children: any }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const toast = (message: string, type: ToastType = 'info', durationMs = 3000): void => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), durationMs);
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Clear of the notch and the rounded screen corners: offsets start at the
          safe area, and on phones toasts span the width instead of hugging a corner. */}
      <div className="fixed top-[calc(env(safe-area-inset-top)+0.75rem)] right-[calc(env(safe-area-inset-right)+0.75rem)] max-sm:left-[calc(env(safe-area-inset-left)+0.75rem)] flex flex-col gap-1.5 z-50">
        {toasts.map((t) => (
          <div key={t.id} className={`flex items-center gap-2 px-3 py-2 bg-neutral-900 border ${borderColor[t.type]}`} role="alert">
            <p className="m-0 flex-1">{t.message}</p>
            <button className="border-0 p-0.5 ml-2" onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))} aria-label="Close"><X size={14} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
