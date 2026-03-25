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
  if (!ctx) throw new Error('useToast must be called within ToastProvider');
  return ctx;
};

const borderColor = { success: 'border-green-900', error: 'border-red-900', info: 'border-neutral-700' };

export const ToastProvider = ({ children }: { children: any }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const toast = (message: string, type: ToastType = 'info') => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    const timer = setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000);
    return () => clearTimeout(timer);
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed top-3 right-3 flex flex-col gap-1.5 z-50">
        {toasts.map((t) => (
          <div key={t.id} className={`flex items-center gap-2 px-3 py-2 bg-neutral-900 border ${borderColor[t.type]}`} role="alert">
            <p className="m-0">{t.message}</p>
            <button className="border-0 p-0.5 ml-2" onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))} aria-label="Close">×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
