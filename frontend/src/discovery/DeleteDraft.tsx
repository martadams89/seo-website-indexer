import { useState } from 'react';
import { Modal } from '../components/Modal';
import { apiFetch, getActiveWorkspaceId } from '../api/client';

export function DeleteDraft({
  path,
  title,
  label,
  disabled,
  onBusy,
  onDeleted,
}: {
  path: string;
  title: string;
  label: string;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [workspace, setWorkspace] = useState<string | null>(null);
  function close() {
    if (deleting) return;
    setOpen(false);
    onBusy(false);
  }
  async function remove() {
    setDeleting(true);
    setError('');
    try {
      if (workspace !== getActiveWorkspaceId())
        throw new Error('Workspace changed. Close this dialog and select the draft again.');
      await apiFetch(`/api/platform/discovery/${path}`, { method: 'DELETE' });
      setOpen(false);
      onDeleted();
      onBusy(false);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ''));
    } finally {
      setDeleting(false);
    }
  }
  return (
    <>
      <button
        className="btn btn-danger"
        disabled={disabled}
        onClick={() => {
          setError('');
          setWorkspace(getActiveWorkspaceId());
          setOpen(true);
          onBusy(true);
        }}
      >
        {label}
      </button>
      <Modal
        open={open}
        title={label}
        onClose={close}
        size="sm"
        role="alertdialog"
        dismissible={!deleting}
        footer={
          <>
            <button className="btn btn-secondary" data-autofocus disabled={deleting} onClick={close}>
              Cancel
            </button>
            <button className="btn btn-danger" disabled={deleting} onClick={remove}>
              {deleting ? 'Deleting…' : 'Delete permanently'}
            </button>
          </>
        }
      >
        <p>
          Delete <strong style={{ overflowWrap: 'anywhere' }}>{title}</strong> and its saved revision history?
          Unsaved edits to this draft will also be discarded. This cannot be undone.
        </p>
        <p>
          This removes the local draft. Published listings, website content and existing Work items are
          unaffected.
        </p>
        {error && (
          <p role="alert" className="discovery-error">
            {error}
          </p>
        )}
      </Modal>
    </>
  );
}
