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
          safe area. On phones toasts span the width and sit above the composer,
          clear of banners and the header. */}
      <div className="fixed top-[calc(env(safe-area-inset-top)+0.75rem)] right-[calc(env(safe-area-inset-right)+0.75rem)] z-50 flex w-110 flex-col gap-1.5 max-sm:top-auto max-sm:bottom-[calc(env(safe-area-inset-bottom)+76px)] max-sm:left-[calc(env(safe-area-inset-left)+0.75rem)] max-sm:w-auto">
        {toasts.map((t) => (
          <div key={t.id} className="flex items-center gap-2 rounded-md bg-text py-1 pr-1 pl-4.5 text-sm text-bg shadow-[0_8px_24px_rgb(0_0_0/.2)]" role="alert">
            <p className="m-0 flex-1">{t.message}</p>
            <button className="icon-btn text-bg hover:bg-transparent hover:text-bg" onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))} aria-label="Close"><X size={18} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
