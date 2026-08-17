import { useEffect, useEffectEvent, useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

type ModalProps = {
  open?: boolean;
  onClose: () => void;
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  headerActions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  size?: ModalSize;
  className?: string;
  bodyClassName?: string;
  closeLabel?: string;
  dismissible?: boolean;
  role?: 'dialog' | 'alertdialog';
};

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Modal({
  open = true,
  onClose,
  title,
  eyebrow,
  description,
  icon,
  headerActions,
  footer,
  children,
  size = 'md',
  className = '',
  bodyClassName = '',
  closeLabel = 'Close dialog',
  dismissible = true,
  role = 'dialog',
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeFromKeyboard = useEffectEvent(onClose);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const dialog = dialogRef.current;
    const preferred = dialog?.querySelector<HTMLElement>('[data-autofocus]');
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    const focusFrame = window.requestAnimationFrame(() => (preferred || first || dialog)?.focus());

    function onKeyDown(event: KeyboardEvent) {
      if (!dialog) return;
      if (event.key === 'Escape' && dismissible) {
        event.preventDefault();
        closeFromKeyboard();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const firstItem = focusable[0];
      const lastItem = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [dismissible, open]);

  if (!open) return null;

  function closeFromBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (dismissible && event.target === event.currentTarget) onClose();
  }

  return createPortal(
    <div className="app-modal-backdrop" onMouseDown={closeFromBackdrop}>
      <div
        ref={dialogRef}
        className={`app-modal app-modal-${size} ${className}`.trim()}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="app-modal-header">
          {icon && <div className="app-modal-icon">{icon}</div>}
          <div className="app-modal-heading">
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <div className="app-modal-header-actions">
            {headerActions}
            {dismissible && <button className="btn-icon btn-icon-ghost app-modal-close" type="button" aria-label={closeLabel} onClick={onClose}><X /></button>}
          </div>
        </header>
        <div className={`app-modal-body ${bodyClassName}`.trim()}>{children}</div>
        {footer && <footer className="app-modal-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
