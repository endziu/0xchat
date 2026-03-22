import { createContext } from 'preact';
import { useContext, useState } from 'preact/hooks';

export type ToastType = 'success' | 'error' | 'info';

interface ToastMessage {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const useToast = (): ToastContextType => {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be called within ToastProvider');
  }
  return ctx;
};

export const ToastProvider = ({ children }: { children: any }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const toast = (message: string, type: ToastType = 'info') => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);

    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);

    return () => clearTimeout(timer);
  };

  const value: ToastContextType = { toast };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onRemove={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))} />
    </ToastContext.Provider>
  );
};

const ToastContainer = ({ toasts, onRemove }: { toasts: ToastMessage[]; onRemove: (id: string) => void }) => {
  return (
    <div class="fixed bottom-4 right-4 z-[60] space-y-2 pointer-events-none">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onRemove={onRemove} />
      ))}
    </div>
  );
};

const ToastItem = ({ toast, onRemove }: { toast: ToastMessage; onRemove: (id: string) => void }) => {
  const bgColor = {
    success: 'bg-green-500',
    error: 'bg-red-500',
    info: 'bg-blue-500',
  }[toast.type];

  const icon = {
    success: '✓',
    error: '✕',
    info: 'ℹ',
  }[toast.type];

  return (
    <div
      class={`${bgColor} text-white px-4 py-2 rounded shadow-md pointer-events-auto flex items-center gap-2 min-w-xs animate-fadeIn`}
      role="alert"
    >
      <span class="font-bold text-lg">{icon}</span>
      <span class="text-sm">{toast.message}</span>
      <button
        class="ml-2 text-white opacity-70 hover:opacity-100"
        onClick={() => onRemove(toast.id)}
        aria-label="Close"
      >
        ×
      </button>
    </div>
  );
};
