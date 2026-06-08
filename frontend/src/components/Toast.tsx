import { useApp } from '../AppContext';

export function ToastHost() {
  const { toasts, dismissToast } = useApp();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host" role="region" aria-live="polite" aria-label="Notifications">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismissToast(t.id)} role="status">
          <span className="toast-icon">{iconFor(t.kind)}</span>
          <span className="toast-msg">{t.message}</span>
          <button
            className="toast-close"
            aria-label="Dismiss"
            onClick={(e) => { e.stopPropagation(); dismissToast(t.id); }}
          >×</button>
        </div>
      ))}
    </div>
  );
}

function iconFor(kind: string): string {
  switch (kind) {
    case 'success': return '✓';
    case 'error':   return '✕';
    case 'warning': return '!';
    default:        return 'i';
  }
}
